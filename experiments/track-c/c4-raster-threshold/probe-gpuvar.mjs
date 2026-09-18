/**
 * C4d — RasterTask.dur 이 왜 실행마다 26배 널뛰나
 *
 * 평균뿐 아니라 중앙값도 같이 움직이므로 꼬리가 아니라 '실행 전체' 가 움직인다.
 * 실행마다 Chrome 을 새로 띄우니 후보는 실행 단위 상태다.
 *
 * 같은 설정만 10회씩, 격리 조건만 바꿔 흩어짐 자체를 잰다.
 *   A 현행         kill 후 0.5초
 *   B 엄격 격리    headless chrome 0개가 될 때까지 대기 + 3초
 *   C B + 워밍업   빌드 전 5초 더
 *
 * 사전 등록: PREDICTION-gpuvar.md
 * 사용: node probe-gpuvar.mjs [--repeat=10]
 */
import { spawn, execFile } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const arg = (n, d) => {
  const m = process.argv.find(a => a.startsWith(`--${n}=`));
  return m ? m.split('=')[1] : d;
};
const REPEAT = Number(arg('repeat', '10'));
const LAYERS = Number(arg('layers', '600'));
const WINDOW = Number(arg('window', '6000'));
const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';
const URL_C3 = 'http://127.0.0.1:8765/experiments/track-c/c3-layer-cliff/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * p)] ?? 0; };

/** 살아 있는 chrome.exe 개수 — J1 의 직접 증거로 매 실행 기록한다 */
const chromeCount = () => new Promise(res => {
  execFile('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], (e, out) => {
    if (e || !out) return res(-1);
    res(out.split('\n').filter(l => /chrome\.exe/i.test(l)).length);
  });
});

/** headless chrome 이 다 사라질 때까지 기다린다 (최대 30초) */
async function waitChromeQuiet(baseline) {
  for (let i = 0; i < 60; i++) {
    const c = await chromeCount();
    if (c <= baseline) return { waitedMs: i * 500, settled: true };
    await sleep(500);
  }
  return { waitedMs: 30000, settled: false };
}

async function run({ port, rep, warmupMs }) {
  const profile = path.join(SCRATCH, `c4gv-${rep}-${Date.now()}`);
  await mkdir(profile, { recursive: true });
  const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, '--no-first-run',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-gpu-vsync', '--disable-frame-rate-limit',
    '--hide-scrollbars', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { await sleep(300);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {} }
  try {
    const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${
      encodeURIComponent(URL_C3 + '?v=' + Date.now())}`, { method: 'PUT' })).json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r, { once: true }));
    let id = 0; const pend = new Map(); const evs = []; let done, fail;
    const fin = new Promise((r, j) => { done = r; fail = j; });
    const die = () => { for (const [, p] of pend) p(null); pend.clear(); fail(new Error('CDP 끊김')); };
    ws.addEventListener('close', die, { once: true });
    ws.addEventListener('error', die, { once: true });
    ws.addEventListener('message', e => { const m = JSON.parse(e.data);
      if (m.id !== undefined) { const p = pend.get(m.id); pend.delete(m.id); p && p(m.result); }
      else if (m.method === 'Tracing.dataCollected') evs.push(...(m.params.value || []));
      else if (m.method === 'Tracing.tracingComplete') done(); });
    const send = (method, params = {}) => { const i = ++id;
      ws.send(JSON.stringify({ id: i, method, params }));
      return new Promise(r => { const to = setTimeout(() => { pend.delete(i); r(null); }, 180000);
        pend.set(i, v => { clearTimeout(to); r(v); }); }); };
    const ev = async x => (await send('Runtime.evaluate',
      { expression: x, returnByValue: true, awaitPromise: true }))?.result?.value;

    await send('Runtime.enable');
    for (let i = 0; i < 40 && !(await ev('!!window.__C3')); i++) await sleep(250);
    if (warmupMs) await sleep(warmupMs);          // 조건 C: 빌드 전에 더 기다린다

    const procsAtStart = await chromeCount();
    await send('Tracing.start', { transferMode: 'ReportEvents',
      traceConfig: { recordMode: 'recordAsMuchAsPossible',
        includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] } });
    await sleep(150);
    await ev(`__C3.build(${LAYERS}, 100, 100, {"cols":1,"text":true})`);
    await sleep(WINDOW);
    await send('Tracing.end');
    await Promise.race([fin, new Promise((_, j) => setTimeout(() => j(new Error('트레이스 미완')), 180000))]);
    await send('Browser.close').catch(() => {});

    const durs = [];
    for (const e of evs) if (e.name === 'RasterTask' && typeof e.dur === 'number') durs.push(e.dur / 1000);
    return { rep, procsAtStart, rasterN: durs.length,
             meanUs: durs.length ? +(mean(durs) * 1000).toFixed(0) : 0,
             p50Us: durs.length ? +(q(durs, .5) * 1000).toFixed(0) : 0 };
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    try { await rm(profile, { recursive: true, force: true }); } catch {}
  }
}

// 사용자가 쓰는 Chrome 은 원래 떠 있으므로 그걸 기준선으로 잡는다
const BASELINE = await chromeCount();
console.log(`\n기준선 chrome 프로세스: ${BASELINE}개 (사용자 브라우저 — 건드리지 않는다)\n`);

const CONDS = [
  { key: 'A', label: 'A 현행 (kill 후 0.5초)', strict: false, warmupMs: 0 },
  { key: 'B', label: 'B 엄격 격리 (조용해질 때까지 +3초)', strict: true, warmupMs: 0 },
  { key: 'C', label: 'C 엄격 격리 + 빌드 전 5초', strict: true, warmupMs: 5000 },
];

const rows = [];
let port = 28700;
for (const c of CONDS) {
  const r = [];
  for (let k = 0; k < REPEAT; k++) {
    if (c.strict) { await waitChromeQuiet(BASELINE); await sleep(3000); }
    else await sleep(500);
    try { r.push({ ...(await run({ port: port++, rep: k, warmupMs: c.warmupMs })), cond: c.key }); }
    catch (e) { console.error(`    ↻ ${c.key}/rep${k} 실패: ${e.message}`); }
  }
  if (!r.length) { console.log(`  ${c.label}: 전부 실패`); continue; }
  rows.push(...r);
  const p = r.map(x => x.p50Us).sort((a, b) => a - b);
  const m = r.map(x => x.meanUs).sort((a, b) => a - b);
  console.log(`\n${c.label}`);
  console.log(`  p50 (정렬): ${p.map(x => String(x).padStart(6)).join('')}`);
  console.log(`  평균(정렬): ${m.map(x => String(x).padStart(6)).join('')}`);
  console.log(`  시작 시점 chrome 수: ${r.map(x => x.procsAtStart).join(', ')}`);
  console.log(`  → p50 흩어짐 ${(p[p.length - 1] / Math.max(p[0], 1)).toFixed(1)}배` +
              ` · 평균 흩어짐 ${(m[m.length - 1] / Math.max(m[0], 1)).toFixed(1)}배`);
}

await writeFile(new URL('./results-gpuvar.json', import.meta.url), JSON.stringify({
  note: '같은 설정만 반복하고 격리 조건만 바꿔 흩어짐 자체를 잰다',
  generatedAt: new Date().toISOString(), layers: LAYERS, repeat: REPEAT,
  baselineChrome: BASELINE, rows,
}, null, 2));
console.log('\n✅ results-gpuvar.json 저장');
console.log('\n판정: B 에서 흩어짐이 줄면 잔여 프로세스(J1), C 에서만 줄면 워밍업(J2), 셋 다 그대로면 못 잡는다');
process.exit(0);
