/**
 * C3 보강 — 토글 1회의 비용을 단계별로 쪼갠다
 *
 * measure.mjs 의 perToggleMs 는 style + commit + draw 를 합친 값이라
 * "commit 에 절벽이 있는가" 를 직접 답하지 못한다.
 *
 * 트레이스를 켜면 이벤트가 레이어 수 × 프레임 수로 늘어난다 —
 * 1,000 레이어 × 120 토글에서 54만~140만 개가 나와 전송이 타임아웃 났다.
 * 그래서 여기서는 **토글을 20회로 줄인다.** 표본은 적지만 단계별 귀속이 목적이고,
 * 분포는 measure.mjs 쪽(표본 120 × 4회)이 이미 갖고 있다.
 *
 * 사용: node probe-stages.mjs [--repeat=3] [--toggles=20]
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const arg = (n, d) => {
  const m = process.argv.find(a => a.startsWith(`--${n}=`));
  return m ? m.split('=')[1] : d;
};
const REPEAT = Number(arg('repeat', '3'));
const TOGGLES = Number(arg('toggles', '20'));
const LAYERS = arg('layers', '500,1000,1500,2000,2500,3000').split(',').map(Number);
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';
const URL_C3 = 'http://127.0.0.1:8765/experiments/track-c/c3-layer-cliff/';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * p)] ?? 0; };

async function run({ layers, port, rep }) {
  const profile = path.join(SCRATCH, `c3s-${layers}-${rep}`);
  await mkdir(profile, { recursive: true });
  const proc = spawn(CHROME, [
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
    await ev(`__C3.build(${layers}, 38, 15)`);
    await sleep(2000);

    await send('Tracing.start', { transferMode: 'ReportEvents',
      traceConfig: { recordMode: 'recordAsMuchAsPossible',
        includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] } });
    await sleep(200);
    const pump = await ev(`__C3.pump(${TOGGLES})`);
    await sleep(300);
    await send('Tracing.end');
    await Promise.race([fin, new Promise((_, j) => setTimeout(() => j(new Error('트레이스 미완')), 180000))]);
    await send('Browser.close').catch(() => {});

    const dur = {};
    for (const e of evs) {
      if (e.ph === 'M' || typeof e.dur !== 'number') continue;
      (dur[e.name] ||= []).push(e.dur / 1000);
    }
    const sum = k => (dur[k] || []).reduce((a, b) => a + b, 0);
    const per = k => sum(k) / TOGGLES;   // 토글 1회당 해당 단계에 쓴 시간
    return {
      layers, rep, traceEvents: evs.length, toggles: TOGGLES,
      perToggleMs: pump.mean,
      commitPer: +per('Commit').toFixed(3), commitN: (dur.Commit || []).length,
      commitP50: +q(dur.Commit || [], .5).toFixed(4),
      stylePer: +per('UpdateLayoutTree').toFixed(3),
      rasterPer: +per('RasterTask').toFixed(3),
      layoutPer: +per('Layout').toFixed(3),
      paintPer: +per('Paint').toFixed(3),
    };
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    await sleep(500);
    try { await rm(profile, { recursive: true, force: true }); } catch {}
  }
}

const rows = [];
console.log(`\n토글 1회의 비용 분해 — 토글 ${TOGGLES}회 × ${REPEAT}회 · vsync 끔\n`);
console.log('  레이어  트레이스수   토글당ms │  Style   Commit   Raster │ Commit중앙값  레이어당µs');
console.log('  ' + '─'.repeat(84));
let port = 19100;
for (const n of LAYERS) {
  const r = [];
  for (let k = 0; k < REPEAT; k++) {
    try { r.push(await run({ layers: n, port: port++, rep: k })); }
    catch (e) { console.error(`    ↻ ${n}/rep${k} 실패: ${e.message}`); }
  }
  if (!r.length) { console.log(`  ${n}: 전부 실패`); continue; }
  rows.push(...r);
  const m = f => mean(r.map(f));
  console.log(`  ${String(n).padStart(6)}${Math.round(m(x => x.traceEvents)).toLocaleString().padStart(12)}` +
    `${m(x => x.perToggleMs).toFixed(2).padStart(11)} │${m(x => x.stylePer).toFixed(2).padStart(7)}` +
    `${m(x => x.commitPer).toFixed(2).padStart(9)}${m(x => x.rasterPer).toFixed(2).padStart(9)} │` +
    `${m(x => x.commitP50).toFixed(3).padStart(13)}${(m(x => x.commitP50) / n * 1000).toFixed(2).padStart(12)}`);
}

await writeFile(new URL('./results-stages.json', import.meta.url), JSON.stringify({
  note: '토글 1회를 단계별로 쪼갠다. 트레이스 이벤트가 레이어×프레임으로 늘어나 토글을 20회로 줄였다.',
  generatedAt: new Date().toISOString(), toggles: TOGGLES, repeat: REPEAT, rows,
}, null, 2));
console.log('\n✅ results-stages.json 저장');
process.exit(0);
