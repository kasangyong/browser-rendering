/**
 * C4 판별 — 래스터가 "켜지는" 게 아니라 "아직 안 끝난" 것 아닌가
 *
 * 하네스는 build 후 2초 기다린 뒤 측정을 시작한다.
 * 레이어가 많으면 초기 래스터가 2초 안에 안 끝날 수 있고,
 * 그 꼬리가 측정 창으로 새어 들어오면 "래스터가 켜졌다"로 보인다.
 *
 * 그렇다면 **기다리는 시간만 늘려도 사라져야 한다.** 축출이라면 안 사라진다.
 *
 * 같은 레이어 수(기본 2,000)에서 settle 만 바꿔가며 잰다.
 * 사용: node probe-settle.mjs [--layers=2000] [--repeat=4]
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const arg = (n, d) => {
  const m = process.argv.find(a => a.startsWith(`--${n}=`));
  return m ? m.split('=')[1] : d;
};
const LAYERS = Number(arg('layers', '2000'));
const REPEAT = Number(arg('repeat', '4'));
const TOGGLES = 15;
const SETTLES = arg('settles', '1000,2000,4000,8000,16000').split(',').map(Number);
const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';
const URL_C3 = 'http://127.0.0.1:8765/experiments/track-c/c3-layer-cliff/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

async function run({ layers, settle, port, rep }) {
  const profile = path.join(SCRATCH, `c4s-${settle}-${rep}`);
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
    let id = 0; const pend = new Map(); let evs = []; let done, fail;
    let fin = new Promise((r, j) => { done = r; fail = j; });
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
    const rasterOf = list => {
      let ms = 0, n = 0;
      for (const e of list) if (e.name === 'RasterTask') { n++; if (typeof e.dur === 'number') ms += e.dur / 1000; }
      return { ms: +ms.toFixed(1), n };
    };

    await send('Runtime.enable');
    for (let i = 0; i < 40 && !(await ev('!!window.__C3')); i++) await sleep(250);

    // settle 동안은 트레이싱을 켜지 않는다.
    // 처음엔 초기 래스터 총량도 같이 재려고 여기서 한 번 더 트레이싱했는데,
    // 두 트레이스 사이의 전송 지연(20만 이벤트면 수 초)이 settle 에 몰래 더해져서
    // settle 1초짜리가 사실상 수 초가 됐다. 그래서 래스터가 안 새는 것처럼 보였다.
    // 지금은 measure.mjs 와 똑같은 조건으로 두고 settle 만 바꾼다.
    await ev(`__C3.build(${layers}, 38, 15)`);
    await sleep(settle);
    const during = { ms: 0, n: 0 };

    await send('Tracing.start', { transferMode: 'ReportEvents',
      traceConfig: { recordMode: 'recordAsMuchAsPossible',
        includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] } });
    await sleep(200);
    const pump = await ev(`__C3.pump(${TOGGLES})`);
    await sleep(300);
    await send('Tracing.end');
    await Promise.race([fin, new Promise((_, j) => setTimeout(() => j(new Error('트레이스2 미완')), 180000))]);
    const after = rasterOf(evs);
    await send('Browser.close').catch(() => {});

    return { layers, settle, rep,
             settleRasterMs: during.ms, settleRasterN: during.n,
             pumpRasterMs: after.ms, pumpRasterN: after.n,
             pumpRasterPerToggle: +(after.ms / TOGGLES).toFixed(3),
             perToggleMs: pump.mean };
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    await sleep(500);
    try { await rm(profile, { recursive: true, force: true }); } catch {}
  }
}

const rows = [];
console.log(`\n기다리는 시간만 바꾼다 — 레이어 ${LAYERS.toLocaleString()} 고정 · ${REPEAT}회 반복\n`);
console.log('  settle   settle 중 래스터      pump 중 래스터       토글당      켜진 횟수');
console.log('  ' + '─'.repeat(76));
let port = 24200;
for (const s of SETTLES) {
  const r = [];
  for (let k = 0; k < REPEAT; k++) {
    try { r.push(await run({ layers: LAYERS, settle: s, port: port++, rep: k })); }
    catch (e) { console.error(`    ↻ settle ${s}/rep${k} 실패: ${e.message}`); }
  }
  if (!r.length) { console.log(`  ${s}ms: 전부 실패`); continue; }
  rows.push(...r);
  const on = r.filter(x => x.pumpRasterPerToggle > 5).length;
  console.log(`  ${(s / 1000 + '초').padStart(7)}` +
    `${(mean(r.map(x => x.settleRasterMs)).toFixed(0) + 'ms / ' + Math.round(mean(r.map(x => x.settleRasterN))) + '회').padStart(20)}` +
    `${(mean(r.map(x => x.pumpRasterMs)).toFixed(0) + 'ms / ' + Math.round(mean(r.map(x => x.pumpRasterN))) + '회').padStart(20)}` +
    `${mean(r.map(x => x.pumpRasterPerToggle)).toFixed(2).padStart(12)}${(on + '/' + r.length).padStart(13)}`);
}

await writeFile(new URL('./results-settle.json', import.meta.url), JSON.stringify({
  note: 'settle 만 바꿔 래스터가 사라지는지 본다. 사라지면 축출이 아니라 초기 래스터의 꼬리다.',
  generatedAt: new Date().toISOString(), layers: LAYERS, toggles: TOGGLES, repeat: REPEAT, rows,
}, null, 2));
console.log('\n✅ results-settle.json 저장');
console.log('\n판정: settle 을 늘렸을 때 pump 중 래스터가 0 으로 가면 → 축출이 아니라 초기 래스터의 꼬리');
process.exit(0);
