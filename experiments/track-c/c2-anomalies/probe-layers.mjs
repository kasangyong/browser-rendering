/**
 * ③ 진단 — 레이어 수가 정말 박스 수만큼 늘어나는지, commit 이 왜 1500 에서 꺾이는지
 * LayerTree 로 합성 레이어를 직접 세고, 프레임 간격도 같이 본다.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;

async function run(n, port) {
  const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    `--user-data-dir=${path.join(SCRATCH, 'probe-' + n)}`, '--no-first-run',
    '--hide-scrollbars', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { await sleep(300);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {} }
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${
    encodeURIComponent('http://127.0.0.1:8765/experiments/track-a/a1-pipeline-skip/?v=' + Date.now())}`,
    { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pend = new Map(); let layers = 0;
  ws.addEventListener('message', e => { const m = JSON.parse(e.data);
    if (m.id !== undefined) { const q = pend.get(m.id); pend.delete(m.id); q && q(m.result); }
    else if (m.method === 'LayerTree.layerTreeDidChange') layers = (m.params.layers || []).length; });
  const send = (method, params = {}) => { const i = ++id;
    ws.send(JSON.stringify({ id: i, method, params }));
    return new Promise(r => pend.set(i, r)); };
  const ev = async x => (await send('Runtime.evaluate',
    { expression: x, returnByValue: true, awaitPromise: true })).result?.value;

  await send('Runtime.enable'); await send('LayerTree.enable');
  for (let i = 0; i < 40 && !(await ev('!!window.__A1')); i++) await sleep(250);
  await ev(`__A1.setCount(${n}); __A1.setMode("transform")`);
  await sleep(3000);
  // 프레임 간격을 페이지 안에서 직접 잰다
  const ivs = await ev(`new Promise(res => { const t = []; let last = performance.now(), k = 0;
    const tick = () => { const now = performance.now(); t.push(now - last); last = now;
      if (++k < 90) requestAnimationFrame(tick); else res(t.slice(5)); };
    requestAnimationFrame(tick); })`);
  const boxes = await ev('document.querySelectorAll(".box").length');
  await send('Browser.close').catch(() => {});
  try { proc.kill('SIGKILL'); } catch {}
  await sleep(400);
  const s = [...ivs].sort((a, b) => a - b);
  return { n, boxes, layers, fps: +(1000 / mean(ivs)).toFixed(1),
           medianIv: +s[Math.floor(s.length / 2)].toFixed(2), p95Iv: +s[Math.floor(s.length * 0.95)].toFixed(2) };
}

console.log('  요청  실제박스   합성레이어   평균FPS   프레임간격 중앙값/p95');
console.log('  ' + '─'.repeat(62));
let port = 13400;
for (const n of [500, 750, 1000, 1500, 2000]) {
  const r = await run(n, port++);
  console.log(`  ${String(r.n).padStart(4)}${String(r.boxes).padStart(10)}${String(r.layers).padStart(13)}` +
              `${String(r.fps).padStart(10)}${(r.medianIv + ' / ' + r.p95Iv).padStart(20)}`);
}
process.exit(0);
