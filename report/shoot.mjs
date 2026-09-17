/**
 * 리포트와 실험 하네스를 PNG 로 캡처한다.
 * 사용: node shoot.mjs
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROF = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad/shotprof';
const OUT = path.resolve(import.meta.dirname, 'images');
const PORT = 9911;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SHOTS = [
  { name: '00-pipeline-diagram',  url: 'http://127.0.0.1:8765/report/diagram-pipeline.html', w: 1100, h: 620, full: false },
  { name: '01-track-a-results',   url: 'http://127.0.0.1:8765/report/',                      w: 1180, full: true },
  { name: 'chart-a1-stage-skip',  url: 'http://127.0.0.1:8765/report/charts/a1-stage-skip.html',  w: 660, full: true },
  { name: 'chart-a1b-ceiling',    url: 'http://127.0.0.1:8765/report/charts/a1b-ceiling.html',    w: 660, full: true },
  { name: 'chart-a2-tile-memory', url: 'http://127.0.0.1:8765/report/charts/a2-tile-memory.html', w: 660, full: true },
  { name: 'chart-a3-dom-order',   url: 'http://127.0.0.1:8765/report/charts/a3-dom-order.html',   w: 660, full: true },
  { name: 'chart-a4-scaling',     url: 'http://127.0.0.1:8765/report/charts/a4-scaling.html',     w: 660, full: true },
  { name: 'chart-a5-inp',         url: 'http://127.0.0.1:8765/report/charts/a5-inp.html',         w: 660, full: true },
  { name: '02-a1-pipeline-harness',   url: 'http://127.0.0.1:8765/experiments/track-a/a1-pipeline-skip/',      w: 1180, full: true,
    setup: '__A1.setCount(400); __A1.setMode("transform")' },
  { name: '03-a3-layerization',       url: 'http://127.0.0.1:8765/experiments/track-a/a3-paint-chunks/',       w: 1180, full: true,
    setup: '__A3.setScenario("s5-interleaved")' },
  { name: '04-a4-content-visibility', url: 'http://127.0.0.1:8765/experiments/track-a/a4-content-visibility/', w: 1180, full: false,
    setup: '__A4.build(500, "cv-auto")' },
  { name: '05-a5-inp-loaf',           url: 'http://127.0.0.1:8765/experiments/track-a/a5-inp-loaf/',           w: 1180, full: false,
    setup: '__A5.setStrategy("paint-first+yield")' },
];

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id === undefined) return;
      const p = this.pending.get(m.id); if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej }));
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  }
}
const connect = async url => {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WS 실패')), { once: true });
  });
  return new CDP(ws);
};

const run = async () => {
  await mkdir(OUT, { recursive: true });
  await mkdir(PROF, { recursive: true });
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
    `--user-data-dir=${PROF}`, '--no-first-run', '--no-default-browser-check',
    '--force-color-profile=srgb', '--hide-scrollbars',
    '--window-size=1180,1200', 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    await sleep(400);
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch {}
  }

  for (const s of SHOTS) {
    const t = await (await fetch(
      `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(s.url)}`, { method: 'PUT' })).json();
    const page = await connect(t.webSocketDebuggerUrl);
    await page.send('Page.enable'); await page.send('Runtime.enable');
    await page.send('Emulation.setDeviceMetricsOverride',
      { width: s.w, height: s.h || 1200, deviceScaleFactor: 2, mobile: false });
    await sleep(1400);
    if (s.setup) { await page.evaluate(s.setup).catch(e => console.error(`  setup 실패(${s.name}):`, e.message)); await sleep(1200); }

    const shot = await page.send('Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: !!s.full, fromSurface: true });
    const file = path.join(OUT, `${s.name}.png`);
    await writeFile(file, Buffer.from(shot.data, 'base64'));
    const kb = (Buffer.from(shot.data, 'base64').length / 1024).toFixed(0);
    console.log(`  ✅ ${s.name}.png  (${kb} KB)`);
    await page.send('Page.close').catch(() => {});
  }

  try { proc.kill('SIGKILL'); } catch {}
  console.log(`\n저장 위치: ${OUT}`);
  process.exit(0);
};
run().catch(e => { console.error('실패:', e); process.exit(1); });
