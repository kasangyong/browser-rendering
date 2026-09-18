/**
 * ③ 재설계 — Commit 이벤트의 '개별 지속시간 분포'를 본다.
 *
 * 앞선 측정은 (Commit 총 ms / Commit 횟수) 로 프레임당 비용을 구했는데,
 * 120Hz 디스플레이에서 프레임이 vsync 배수로 양자화되는 바람에 1500 에서 꺾여 보였다.
 * 여기서는 개별 이벤트 dur 를 모아 중앙값·분위수를 직접 본다.
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * p)] ?? 0; };
function linfit(xs, ys) {
  const n = xs.length, mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const slope = sxy / sxx, intercept = my - slope * mx;
  let sr = 0, st = 0;
  for (let i = 0; i < n; i++) { sr += (ys[i] - (slope * xs[i] + intercept)) ** 2; st += (ys[i] - my) ** 2; }
  return { slope, intercept, r2: 1 - sr / st };
}

async function run(n, port, rep) {
  const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    `--user-data-dir=${path.join(SCRATCH, `pc-${n}-${rep}`)}`, '--no-first-run',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    // vsync 를 끈다. 이 디스플레이는 120Hz 라 프레임이 8.3ms 배수로 양자화되는데,
    // 그 상태에서 '프레임당 비용'을 구하면 레이어 수가 아니라 양자화 계단을 재게 된다.
    ...(process.env.NO_VSYNC ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []),
    '--hide-scrollbars', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { await sleep(300);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {} }
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${
    encodeURIComponent('http://127.0.0.1:8765/experiments/track-a/a1-pipeline-skip/?v=' + Date.now())}`,
    { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pend = new Map(); const evs = []; let done, fail;
  // 렌더러가 죽으면 소켓만 닫히고 promise 는 안 풀린다 → 이벤트 루프가 비면서 조용히 종료.
  // 1,500 레이어에서 실제로 당했다. 끊기면 전부 거절한다.
  const finished = new Promise((r, j) => { done = r; fail = j; });
  const die = why => { const e = new Error('CDP 끊김: ' + why);
    for (const [, p] of pend) p(null); pend.clear(); fail(e); };
  ws.addEventListener('close', () => die('close'), { once: true });
  ws.addEventListener('error', () => die('error'), { once: true });
  ws.addEventListener('message', e => { const m = JSON.parse(e.data);
    if (m.id !== undefined) { const p = pend.get(m.id); pend.delete(m.id); p && p(m.result); }
    else if (m.method === 'Tracing.dataCollected') evs.push(...(m.params.value || []));
    else if (m.method === 'Tracing.tracingComplete') done(); });
  const send = (method, params = {}) => { const i = ++id;
    ws.send(JSON.stringify({ id: i, method, params }));
    return new Promise(r => { const t = setTimeout(() => { pend.delete(i); r(null); }, 90000);
      pend.set(i, v => { clearTimeout(t); r(v); }); }); };
  const ev = async x => (await send('Runtime.evaluate',
    { expression: x, returnByValue: true, awaitPromise: true })).result?.value;

  await send('Runtime.enable');
  for (let i = 0; i < 40 && !(await ev('!!window.__A1')); i++) await sleep(250);
  await ev(`__A1.setCount(${n}); __A1.setMode("transform")`);
  await sleep(2500);
  await send('Tracing.start', { transferMode: 'ReportEvents',
    traceConfig: { recordMode: 'recordAsMuchAsPossible',
      includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] } });
  await sleep(3000);
  await send('Tracing.end');
  await Promise.race([finished,
    new Promise((_, j) => setTimeout(() => j(new Error('tracingComplete 안 옴')), 90000))]);
  await send('Browser.close').catch(() => {});
  try { proc.kill('SIGKILL'); } catch {}
  await sleep(400);

  const durs = evs.filter(e => e.name === 'Commit' && typeof e.dur === 'number').map(e => e.dur / 1000);
  return { n, rep, count: durs.length, mean: mean(durs), p50: q(durs, .5), p90: q(durs, .9) };
}

const LAYERS = [100, 250, 500, 750, 1000, 1500, 2000];
const rows = [];
console.log('  레이어  Commit수   평균ms    중앙값ms    p90ms');
console.log('  ' + '─'.repeat(52));
let port = 14100;
for (const n of LAYERS) {
  const r = [];
  for (let k = 0; k < 3; k++) {
    try { r.push(await run(n, port++, k)); }
    catch (e) { console.error(`    ↻ ${n}/rep${k} 실패: ${e.message}`); }
  }
  if (!r.length) { console.error(`  ${n}: 3회 모두 실패, 건너뜀`); continue; }
  const agg = { n, count: Math.round(mean(r.map(x => x.count))),
    mean: mean(r.map(x => x.mean)), p50: mean(r.map(x => x.p50)), p90: mean(r.map(x => x.p90)) };
  rows.push(agg);
  console.log(`  ${String(n).padStart(6)}${String(agg.count).padStart(10)}` +
    `${agg.mean.toFixed(3).padStart(9)}${agg.p50.toFixed(3).padStart(11)}${agg.p90.toFixed(3).padStart(9)}`);
}
for (const key of ['mean', 'p50']) {
  const f = linfit(rows.map(r => r.n), rows.map(r => r[key]));
  console.log(`\n  ${key}: commit = ${(f.slope * 1000).toFixed(4)}µs × 레이어 + ${f.intercept.toFixed(4)}ms` +
              `   R² = ${f.r2.toFixed(4)}  →  ${f.r2 >= 0.95 ? '선형' : '선형 아님'}`);
}
await writeFile(new URL(process.env.NO_VSYNC ? './results-commit-novsync.json' : './results-commit.json', import.meta.url), JSON.stringify({
  note: 'Commit 개별 이벤트 지속시간 분포 (vsync 양자화 영향을 피하려고 총합/횟수 대신 분위수를 본다)',
  generatedAt: new Date().toISOString(), rows,
  fits: Object.fromEntries(['mean', 'p50'].map(k =>
    [k, linfit(rows.map(r => r.n), rows.map(r => r[k]))])),
}, null, 2));
console.log(`
✅ ${process.env.NO_VSYNC ? 'results-commit-novsync.json' : 'results-commit.json'} 저장`);
process.exit(0);
