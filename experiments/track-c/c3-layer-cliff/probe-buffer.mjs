/**
 * C3 검증 — probe-stages 의 단계 합계를 믿어도 되는가
 *
 * 트레이스 이벤트 수가 1,500·2,000·2,500 에서 197K·196K·189K 로 평평해졌다.
 * 레이어가 느는데 이벤트가 안 느는 건 이상하다 — 버퍼가 차서 버려지고 있을 가능성.
 * 그렇다면 그 구간의 Style/Commit/Raster 합계는 과소 집계다.
 *
 * Tracing.bufferUsage 로 percentFull 을 직접 본다. 1.0 에 닿으면 버퍼가 찬 것이다.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run(layers, port) {
  const profile = path.join(SCRATCH, `c3buf-${layers}`);
  const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, '--no-first-run',
    '--disable-gpu-vsync', '--disable-frame-rate-limit',
    '--hide-scrollbars', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { await sleep(300);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {} }
  try {
    const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${
      encodeURIComponent('http://127.0.0.1:8765/experiments/track-c/c3-layer-cliff/?v=' + Date.now())}`,
      { method: 'PUT' })).json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r, { once: true }));
    let id = 0; const pend = new Map(); const evs = []; let done;
    let maxFull = 0, sawFull = false;
    const fin = new Promise(r => done = r);
    ws.addEventListener('message', e => { const m = JSON.parse(e.data);
      if (m.id !== undefined) { const p = pend.get(m.id); pend.delete(m.id); p && p(m.result); }
      else if (m.method === 'Tracing.dataCollected') evs.push(...(m.params.value || []));
      else if (m.method === 'Tracing.bufferUsage') {
        const v = m.params.percentFull ?? m.params.value ?? 0;
        maxFull = Math.max(maxFull, v);
        if (v >= 0.99) sawFull = true;
      }
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
    await send('Tracing.start', {
      transferMode: 'ReportEvents',
      bufferUsageReportingInterval: 200,      // 버퍼가 얼마나 찼는지 주기적으로 알려달라
      traceConfig: { recordMode: 'recordAsMuchAsPossible',
        includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] },
    });
    await sleep(200);
    await ev('__C3.pump(20)');
    await sleep(300);
    await send('Tracing.end');
    await Promise.race([fin, new Promise(r => setTimeout(r, 180000))]);
    await send('Browser.close').catch(() => {});

    let commit = 0, style = 0;
    for (const e of evs) {
      if (typeof e.dur !== 'number') continue;
      if (e.name === 'Commit') commit += e.dur / 1000;
      if (e.name === 'UpdateLayoutTree') style += e.dur / 1000;
    }
    return { layers, events: evs.length, maxFull, sawFull,
             commitPerToggle: +(commit / 20).toFixed(2), stylePerToggle: +(style / 20).toFixed(2) };
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    await sleep(500);
  }
}

console.log('\n트레이스 버퍼가 차서 이벤트를 버리고 있는가\n');
console.log('  레이어   이벤트수   버퍼 최대  가득참?   Commit/토글   Style/토글');
console.log('  ' + '─'.repeat(70));
let port = 21100;
for (const n of [500, 1500, 2000, 2500]) {
  const r = await run(n, port++);
  console.log(`  ${String(r.layers).padStart(6)}${r.events.toLocaleString().padStart(11)}` +
    `${(r.maxFull * 100).toFixed(0).padStart(10)}%${(r.sawFull ? '  예 ⚠️' : '  아니오').padEnd(10)}` +
    `${r.commitPerToggle.toFixed(2).padStart(12)}${r.stylePerToggle.toFixed(2).padStart(13)}`);
}
console.log('\n버퍼가 가득 찼다면 그 구간의 단계 합계는 과소 집계다.');
process.exit(0);
