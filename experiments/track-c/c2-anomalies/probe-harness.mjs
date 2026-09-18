/**
 * ② 판별 — A4b 의 "점프형에서 정확한 값이 2배 나쁘다"가 C2 에서 재현되지 않는다.
 * 두 하네스의 스크롤 함수는 바이트 단위로 같다. 다른 건 런치 인자 하나뿐이었다:
 *   A4  measure.mjs : --hide-scrollbars 없음
 *   C2  measure.mjs : --hide-scrollbars 있음
 * 하네스 × 스크롤바 2×2 로 교차시켜 어느 쪽이 원인인지 가린다.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

// 같은 CSS(auto 73px / auto 118px)를 두 하네스에서 각각 돌린다.
// 모드 이름만 다르고 선언은 동일하다.
const HARNESS = {
  a4: { url: 'http://127.0.0.1:8765/experiments/track-a/a4-content-visibility/', hook: '__A4',
        mode: { exact: 'cv-exact', over: 'cv-auto' },
        build: (n, m) => `__A4.build(${n}, "${m}")`, scroll: '__A4.scrollThrough(40)' },
  c2: { url: 'http://127.0.0.1:8765/experiments/track-c/c2-anomalies/', hook: '__C2',
        mode: { exact: 'cv-auto', over: 'cv-over' },
        build: (n, m) => `__C2.build(${n}, "${m}")`, scroll: '__C2.scrollJump(40)' },
};

async function run({ harness, hideScrollbars, mode, n, port, rep }) {
  const h = HARNESS[harness];
  const args = ['--headless=new', `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    `--user-data-dir=${path.join(SCRATCH, `sb-${harness}-${mode}-${rep}`)}`,
    '--no-first-run', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--window-size=1280,900'];
  if (hideScrollbars) args.push('--hide-scrollbars');
  args.push('about:blank');
  const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', args, { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { await sleep(300);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {} }
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${
    encodeURIComponent(h.url + '?v=' + Date.now())}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pend = new Map(); const evs = []; let done, fail;
  const finished = new Promise((r, j) => { done = r; fail = j; });
  const die = () => { for (const [, p] of pend) p(null); pend.clear(); fail(new Error('CDP 끊김')); };
  ws.addEventListener('close', die, { once: true });
  ws.addEventListener('error', die, { once: true });
  ws.addEventListener('message', e => { const m = JSON.parse(e.data);
    if (m.id !== undefined) { const p = pend.get(m.id); pend.delete(m.id); p && p(m.result); }
    else if (m.method === 'Tracing.dataCollected') evs.push(...(m.params.value || []));
    else if (m.method === 'Tracing.tracingComplete') done(); });
  const send = (method, params = {}) => { const i = ++id;
    ws.send(JSON.stringify({ id: i, method, params }));
    return new Promise(r => { const to = setTimeout(() => { pend.delete(i); r(null); }, 90000);
      pend.set(i, v => { clearTimeout(to); r(v); }); }); };
  const ev = async x => (await send('Runtime.evaluate',
    { expression: x, returnByValue: true, awaitPromise: true }))?.result?.value;

  await send('Runtime.enable');
  for (let i = 0; i < 40 && !(await ev(`!!window.${h.hook}`)); i++) await sleep(250);
  await ev(h.build(n, h.mode[mode]));
  await sleep(1800);
  const innerW = await ev('innerWidth');
  const clientW = await ev('document.scrollingElement.clientWidth');
  await send('Tracing.start', { transferMode: 'ReportEvents',
    traceConfig: { recordMode: 'recordAsMuchAsPossible',
      includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] } });
  await sleep(200);
  await ev(h.scroll);
  await sleep(300);
  await send('Tracing.end');
  await Promise.race([finished, new Promise((_, j) => setTimeout(() => j(new Error('트레이스 미완')), 90000))]);
  const scrollH = await ev('document.scrollingElement.scrollHeight').catch(() => 0);
  await send('Browser.close').catch(() => {});
  try { proc.kill('SIGKILL'); } catch {}
  await sleep(400);
  const c = {}, d = {};
  for (const e of evs) { if (e.ph === 'M') continue;
    c[e.name] = (c[e.name] || 0) + 1;
    if (typeof e.dur === 'number') d[e.name] = (d[e.name] || 0) + e.dur / 1000; }
  return { paintN: c.Paint || 0, layoutMs: +(d.Layout || 0).toFixed(1),
           styleMs: +(d.UpdateLayoutTree || 0).toFixed(1),
           rasterN: c.RasterTask || 0, innerW, clientW, scrollH };
}

console.log('  하네스  추정값     Layout ms   Style ms   Paint회   Raster회   scrollHeight');
console.log('  ' + '─'.repeat(74));
let port = 15200;
const res = {};
for (const harness of ['a4', 'c2']) {
  for (const mode of ['over', 'exact']) {
    const r = [];
    for (let k = 0; k < 2; k++) {
      try { r.push(await run({ harness, hideScrollbars: true, mode, n: 8000, port: port++, rep: k })); }
      catch (e) { console.error('   실패:', e.message); }
    }
    if (!r.length) { console.log(`  ${harness}   ${mode}   — 전부 실패`); continue; }
    const L = mean(r.map(x => x.layoutMs));
    res[harness + '.' + mode] = L;
    console.log(`  ${harness.padEnd(8)}${(mode === 'over' ? '118px' : '73px').padEnd(11)}` +
      L.toFixed(1).padStart(10) +
      mean(r.map(x => x.styleMs)).toFixed(1).padStart(11) +
      mean(r.map(x => x.paintN)).toFixed(0).padStart(10) +
      mean(r.map(x => x.rasterN)).toFixed(0).padStart(11) +
      Math.round(mean(r.map(x => x.scrollH))).toLocaleString().padStart(15));
  }
}
console.log('');
for (const h of ['a4', 'c2']) {
  const o = res[h + '.over'], e = res[h + '.exact'];
  if (o && e) console.log(`  ${h}: 118px → 73px = ${(o / e).toFixed(2)}배 ` +
    (e < o ? '(정확한 값이 빠름)' : '(정확한 값이 느림)'));
}
process.exit(0);
