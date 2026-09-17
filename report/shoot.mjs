/**
 * 리포트와 실험 하네스를 PNG 로 캡처한다.
 *
 * 각 페이지의 '실제 내용 높이'를 재서 뷰포트를 거기에 맞춘 뒤 찍는다.
 * 고정 높이로 찍으면 내용이 짧은 페이지(차트 등)는 아래가 통째로 여백이 된다.
 *
 * 사용: node shoot.mjs [이름조각]
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROF = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad/shotprof';
const OUT = path.resolve(import.meta.dirname, 'images');
const PORT = 9911;
const BASE = 'http://127.0.0.1:8765';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// maxH: 내용이 아주 긴 페이지(리스트 등)에서 잘라낼 지점
const SHOTS = [
  { name: '00-pipeline-diagram', url: `${BASE}/report/diagram-pipeline.html`, w: 1100 },
  { name: '01-track-a-results',  url: `${BASE}/report/`,                      w: 1180 },

  { name: 'chart-a1-stage-skip',  url: `${BASE}/report/charts/a1-stage-skip.html`,  w: 660 },
  { name: 'chart-a1b-ceiling',    url: `${BASE}/report/charts/a1b-ceiling.html`,    w: 660 },
  { name: 'chart-a2-tile-memory', url: `${BASE}/report/charts/a2-tile-memory.html`, w: 660 },
  { name: 'chart-a3-dom-order',   url: `${BASE}/report/charts/a3-dom-order.html`,   w: 660 },
  { name: 'chart-a4-scaling',     url: `${BASE}/report/charts/a4-scaling.html`,     w: 660 },
  { name: 'chart-a5-inp',         url: `${BASE}/report/charts/a5-inp.html`,         w: 660 },

  { name: '02-a1-pipeline-harness', url: `${BASE}/experiments/track-a/a1-pipeline-skip/`, w: 1180,
    setup: '__A1.setCount(400); __A1.setMode("transform")' },
  { name: '03-a3-layerization', url: `${BASE}/experiments/track-a/a3-paint-chunks/`, w: 1180,
    setup: '__A3.setScenario("s5-interleaved")' },
  { name: '04-a4-content-visibility', url: `${BASE}/experiments/track-a/a4-content-visibility/`, w: 1180,
    setup: '__A4.build(500, "cv-auto")', maxH: 980 },
  { name: '05-a5-inp-loaf', url: `${BASE}/experiments/track-a/a5-inp-loaf/`, w: 1180,
    setup: '__A5.setStrategy("paint-first+yield")',
    // 합성 클릭(isTrusted=false)은 Event Timing 에 안 잡힌다. 진짜 마우스 이벤트를 보낸다.
    clicks: { selector: '#target', n: 8, gapMs: 560 } },
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

/** 실제로 무언가 그려진 마지막 지점. scrollHeight 는 body 여백까지 포함해 과대평가된다. */
const MEASURE = `(() => {
  let bottom = 0;
  for (const el of document.body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    bottom = Math.max(bottom, r.bottom + window.scrollY);
  }
  const pb = parseFloat(getComputedStyle(document.body).paddingBottom || 0);
  return Math.ceil(bottom + pb + 8);
})()`;

const run = async () => {
  const only = process.argv[2];
  const list = only ? SHOTS.filter(s => s.name.includes(only)) : SHOTS;
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
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch {}
  }

  // 프로필 디스크 캐시 때문에 수정한 파일이 반영되지 않는 일이 있어 매번 무효화한다
  const bust = Date.now();
  for (const s of list) {
    const url = s.url + (s.url.includes('?') ? '&' : '?') + 'v=' + bust;
    const t = await (await fetch(
      `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
    const page = await connect(t.webSocketDebuggerUrl);
    await page.send('Page.enable'); await page.send('Runtime.enable');

    // 1) 넉넉한 높이로 먼저 띄워 레이아웃을 완성시킨다
    await page.send('Emulation.setDeviceMetricsOverride',
      { width: s.w, height: 1400, deviceScaleFactor: 2, mobile: false });
    await sleep(1400);
    if (s.setup) {
      await page.evaluate(s.setup).catch(e => console.error(`  setup 실패(${s.name}):`, e.message));
      await sleep(1200);
    }

    // 1-b) 필요하면 진짜 클릭을 보내 계측값을 채운다
    if (s.clicks) {
      const box = JSON.parse(await page.evaluate(
        `JSON.stringify((r => ({x: r.x + r.width/2, y: r.y + r.height/2}))` +
        `(document.querySelector(${JSON.stringify(s.clicks.selector)}).getBoundingClientRect()))`));
      for (let i = 0; i < s.clicks.n; i++) {
        await page.send('Input.dispatchMouseEvent',
          { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
        await page.send('Input.dispatchMouseEvent',
          { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
        await sleep(s.clicks.gapMs);
      }
      await sleep(700);
    }

    // 2) 실제 내용 높이에 뷰포트를 맞춘다
    let h = await page.evaluate(MEASURE);
    if (s.maxH) h = Math.min(h, s.maxH);
    h = Math.max(120, Math.ceil(h));
    await page.send('Emulation.setDeviceMetricsOverride',
      { width: s.w, height: h, deviceScaleFactor: 2, mobile: false });
    await sleep(700);

    const shot = await page.send('Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: false, fromSurface: true });
    const buf = Buffer.from(shot.data, 'base64');
    await writeFile(path.join(OUT, `${s.name}.png`), buf);
    console.log(`  ✅ ${s.name}.png  ${s.w}×${h}  (${(buf.length / 1024).toFixed(0)} KB)`);
    await page.send('Page.close').catch(() => {});
  }

  try { proc.kill('SIGKILL'); } catch {}
  console.log(`\n저장 위치: ${OUT}`);
  process.exit(0);
};
run().catch(e => { console.error('실패:', e); process.exit(1); });
