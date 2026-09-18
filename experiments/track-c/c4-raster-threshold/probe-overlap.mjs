/**
 * C4c — 겹침이 왜 타일당 래스터 비용을 10배로 만드나
 *
 * 타일에 담기는 내용은 같은데 RasterTask 의 dur 이 10배다.
 * 그 시간이 '그리는 일'이 아니라 '기다리는 일'이라면 다음이 보여야 한다:
 *   - 겹침 깊이에 따라 매끄럽게 변한다
 *   - GPU 래스터를 끄면 격차가 줄어든다
 *   - 합계/벽시계 비(병렬도)가 달라진다
 *
 * 사전 등록: PREDICTION-overlap.md
 * 사용: node probe-overlap.mjs [--layers=600] [--repeat=4]
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const arg = (n, d) => {
  const m = process.argv.find(a => a.startsWith(`--${n}=`));
  return m ? m.split('=')[1] : d;
};
const LAYERS = Number(arg('layers', '600'));
const REPEAT = Number(arg('repeat', '4'));
const WINDOW = Number(arg('window', '6000'));
const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';
const URL_C3 = 'http://127.0.0.1:8765/experiments/track-c/c3-layer-cliff/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * p)] ?? 0; };

async function run({ layers, cols, gpuRaster, port, rep }) {
  const tag = `${cols}-${gpuRaster ? 'gpu' : 'sw'}-${rep}`;
  const profile = path.join(SCRATCH, `c4ov-${tag}`);
  await mkdir(profile, { recursive: true });
  const args = ['--headless=new', `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, '--no-first-run',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-gpu-vsync', '--disable-frame-rate-limit',
    '--hide-scrollbars', '--window-size=1280,900'];
  if (!gpuRaster) args.push('--disable-gpu-rasterization');
  args.push('about:blank');
  const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', args, { stdio: 'ignore' });
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
    let layerCount = 0;
    ws.addEventListener('message', e => { const m = JSON.parse(e.data);
      if (m.id !== undefined) { const p = pend.get(m.id); pend.delete(m.id); p && p(m.result); }
      else if (m.method === 'Tracing.dataCollected') evs.push(...(m.params.value || []));
      else if (m.method === 'Tracing.tracingComplete') done();
      else if (m.method === 'LayerTree.layerTreeDidChange') layerCount = (m.params.layers || []).length; });
    const send = (method, params = {}) => { const i = ++id;
      ws.send(JSON.stringify({ id: i, method, params }));
      return new Promise(r => { const to = setTimeout(() => { pend.delete(i); r(null); }, 180000);
        pend.set(i, v => { clearTimeout(to); r(v); }); }); };
    const ev = async x => (await send('Runtime.evaluate',
      { expression: x, returnByValue: true, awaitPromise: true }))?.result?.value;

    await send('Runtime.enable'); await send('LayerTree.enable');
    for (let i = 0; i < 40 && !(await ev('!!window.__C3')); i++) await sleep(250);

    await send('Tracing.start', { transferMode: 'ReportEvents',
      traceConfig: { recordMode: 'recordAsMuchAsPossible',
        includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] } });
    await sleep(150);
    const built = await ev(`__C3.build(${layers}, 100, 100, ${JSON.stringify({ cols, text: true })})`);
    await sleep(WINDOW);
    await send('Tracing.end');
    await Promise.race([fin, new Promise((_, j) => setTimeout(() => j(new Error('트레이스 미완')), 180000))]);
    await send('Browser.close').catch(() => {});

    const durs = [], tids = new Set();
    let first = Infinity, last = -Infinity;
    for (const e of evs) {
      if (e.name !== 'RasterTask' || typeof e.dur !== 'number') continue;
      durs.push(e.dur / 1000);
      if (e.tid !== undefined) tids.add(e.tid);
      if (e.ts < first) first = e.ts;
      if (e.ts + e.dur > last) last = e.ts + e.dur;
    }
    const total = durs.reduce((a, b) => a + b, 0);
    const span = durs.length ? (last - first) / 1000 : 0;
    return { layers, cols: built?.cols ?? cols, depth: built?.depth ?? 0, gpuRaster, rep, layerCount,
             rasterN: durs.length,
             perTileUs: durs.length ? +(mean(durs) * 1000).toFixed(0) : 0,
             p50Us: durs.length ? +(q(durs, .5) * 1000).toFixed(0) : 0,
             totalMs: +total.toFixed(0), spanMs: +span.toFixed(0),
             parallelism: span > 0 ? +(total / span).toFixed(2) : 0,
             threads: tids.size };
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    await sleep(500);
    try { await rm(profile, { recursive: true, force: true }); } catch {}
  }
}

const rows = [];
let port = 27600;

console.log(`\nA. 겹침 깊이 스윕 — 레이어 ${LAYERS} · 100×100 · GPU 래스터 켬 · ${REPEAT}회\n`);
console.log('  cols  깊이  합성레이어  래스터수  타일당µs   p50   합계ms  벽시계ms  병렬도  스레드');
console.log('  ' + '─'.repeat(88));
for (const cols of [1, 2, 4, 8, 12]) {
  const r = [];
  for (let k = 0; k < REPEAT; k++) {
    try { r.push(await run({ layers: LAYERS, cols, gpuRaster: true, port: port++, rep: k })); }
    catch (e) { console.error(`    ↻ cols=${cols}/rep${k} 실패: ${e.message}`); }
  }
  if (!r.length) { console.log(`  ${String(cols).padStart(5)}  — 전부 실패`); continue; }
  rows.push(...r);
  const m = f => mean(r.map(f));
  console.log(`  ${String(cols).padStart(5)}${Math.round(m(x => x.depth)).toString().padStart(6)}` +
    `${Math.round(m(x => x.layerCount)).toString().padStart(12)}` +
    `${Math.round(m(x => x.rasterN)).toString().padStart(10)}` +
    `${Math.round(m(x => x.perTileUs)).toString().padStart(10)}` +
    `${Math.round(m(x => x.p50Us)).toString().padStart(6)}` +
    `${Math.round(m(x => x.totalMs)).toString().padStart(9)}` +
    `${Math.round(m(x => x.spanMs)).toString().padStart(10)}` +
    `${m(x => x.parallelism).toFixed(2).padStart(8)}` +
    `${Math.round(m(x => x.threads)).toString().padStart(8)}`);
}

console.log(`\nB. GPU 래스터를 끄고 — 소프트웨어 래스터\n`);
console.log('  cols  깊이  래스터수  타일당µs   p50   합계ms  벽시계ms  병렬도  스레드');
console.log('  ' + '─'.repeat(76));
for (const cols of [1, 12]) {
  const r = [];
  for (let k = 0; k < REPEAT; k++) {
    try { r.push(await run({ layers: LAYERS, cols, gpuRaster: false, port: port++, rep: k })); }
    catch (e) { console.error(`    ↻ sw cols=${cols}/rep${k} 실패: ${e.message}`); }
  }
  if (!r.length) { console.log(`  ${String(cols).padStart(5)}  — 전부 실패`); continue; }
  rows.push(...r);
  const m = f => mean(r.map(f));
  console.log(`  ${String(cols).padStart(5)}${Math.round(m(x => x.depth)).toString().padStart(6)}` +
    `${Math.round(m(x => x.rasterN)).toString().padStart(10)}` +
    `${Math.round(m(x => x.perTileUs)).toString().padStart(10)}` +
    `${Math.round(m(x => x.p50Us)).toString().padStart(6)}` +
    `${Math.round(m(x => x.totalMs)).toString().padStart(9)}` +
    `${Math.round(m(x => x.spanMs)).toString().padStart(10)}` +
    `${m(x => x.parallelism).toFixed(2).padStart(8)}` +
    `${Math.round(m(x => x.threads)).toString().padStart(8)}`);
}

await writeFile(new URL('./results-overlap.json', import.meta.url), JSON.stringify({
  note: '겹침 깊이를 연속 변수로 두고, GPU 래스터 on/off 로 역압 가설을 가른다',
  generatedAt: new Date().toISOString(), layers: LAYERS, repeat: REPEAT, windowMs: WINDOW, rows,
}, null, 2));
console.log('\n✅ results-overlap.json 저장');
console.log('\n판정: GPU 를 끄니 cols=1 과 cols=12 격차가 사라지면 → GPU 역압(H1)');
process.exit(0);
