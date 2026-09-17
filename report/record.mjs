/**
 * CDP Page.startScreencast 로 프레임을 받아 GIF 로 만든다.
 *
 * 먼저 확인할 것: 메인 스레드가 막힌 동안에도 screencast 프레임이 오는가?
 * (Page.captureScreenshot 은 메인에 걸린다 — A1에서 확인)
 *
 * 사용: node record.mjs <url> <출력이름> [--sec=6] [--block=1500] [--fps=20] [--w=900] [--h=330]
 */
import { spawn, spawnSync } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const FFMPEG = 'C:/Users/SSAFY/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.1-full_build/bin/ffmpeg.exe';
const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';
const OUT = path.resolve(import.meta.dirname, 'images');

const arg = (n, d) => { const m = process.argv.find(a => a.startsWith(`--${n}=`)); return m ? Number(m.split('=')[1]) : d; };
const [, , URL_ARG, NAME] = process.argv;
const SEC = arg('sec', 6), BLOCK = arg('block', 1500), FPS = arg('fps', 20);
const W = arg('w', 900), H = arg('h', 330), PORT = arg('port', 9955);
const sleep = ms => new Promise(r => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) {
        const p = this.pending.get(m.id); if (!p) return;
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      } else { const h = this.handlers.get(m.method); if (h) h(m.params); }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { resolve: res, reject: rej }));
  }
  on(m, f) { this.handlers.set(m, f); }
  fire(expression) { this.ws.send(JSON.stringify({ id: ++this.id, method: 'Runtime.evaluate', params: { expression } })); }
}

const run = async () => {
  await mkdir(OUT, { recursive: true });
  const frameDir = path.join(SCRATCH, `frames-${NAME}`);
  await rm(frameDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(frameDir, { recursive: true });

  const prof = path.join(SCRATCH, `recprof-${NAME}`);
  await mkdir(prof, { recursive: true });
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*',
    `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--force-color-profile=srgb',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    `--window-size=${W},${H}`, 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { await sleep(400); try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch {} }

  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_ARG)}`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  const page = new CDP(ws);
  await page.send('Page.enable'); await page.send('Runtime.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await sleep(1500);

  let n = 0;
  const marks = [];           // 프레임이 도착한 시각 — 블로킹 중에도 오는지 확인용
  page.on('Page.screencastFrame', async p => {
    marks.push(Date.now());
    const f = path.join(frameDir, `f${String(++n).padStart(4, '0')}.png`);
    await writeFile(f, Buffer.from(p.data, 'base64')).catch(() => {});
    page.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
  });

  await page.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: W, maxHeight: H });

  // 타임라인: 정상 → 블록 → 정상 (반복)
  const t0 = Date.now();
  await sleep(1200);
  const blockStart = Date.now();
  page.fire(`__DEMO.block(${BLOCK})`);
  await sleep(BLOCK + 900);
  const blockEnd = Date.now();
  page.fire(`__DEMO.block(${BLOCK})`);
  await sleep(BLOCK + 900);
  while (Date.now() - t0 < SEC * 1000) await sleep(200);

  await page.send('Page.stopScreencast').catch(() => {});
  await sleep(400);

  const during = marks.filter(m => m > blockStart + 150 && m < blockEnd - 150).length;
  console.log(`  프레임 ${n}장 수신 · 그중 메인 블로킹 구간(${BLOCK}ms)에 도착한 것 ${during}장`);
  console.log(`  → screencast 는 메인 스레드에 ${during > 3 ? '걸리지 않는다 ✅' : '걸린다 ❌'}`);

  try { proc.kill('SIGKILL'); } catch {}

  // 실제 캡처 속도를 입력 프레임레이트로 써야 GIF 시간이 실제와 같아진다
  const capturedSec = (marks.at(-1) - marks[0]) / 1000;
  const inFps = (n / capturedSec).toFixed(3);
  console.log(`  캡처 ${capturedSec.toFixed(1)}초 · 입력 ${inFps}fps → 출력 ${FPS}fps`);

  const pal = path.join(frameDir, 'palette.png');
  const gif = path.join(OUT, `${NAME}.gif`);
  const vf = `fps=${FPS},scale=${W}:-1:flags=lanczos`;
  spawnSync(FFMPEG, ['-y', '-framerate', inFps, '-i', path.join(frameDir, 'f%04d.png'),
                     '-vf', `${vf},palettegen=stats_mode=diff`, pal], { stdio: 'ignore' });
  const r = spawnSync(FFMPEG, ['-y', '-framerate', inFps, '-i', path.join(frameDir, 'f%04d.png'),
                     '-i', pal, '-lavfi', `${vf} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=3`,
                     '-loop', '0', gif], { stdio: 'ignore' });
  const { statSync } = await import('node:fs');
  if (r.status === 0) console.log(`  ✅ ${NAME}.gif (${(statSync(gif).size / 1024).toFixed(0)} KB)`);
  else console.error('  ❌ ffmpeg 실패', r.status);
  process.exit(0);
};
run().catch(e => { console.error('실패:', e); process.exit(1); });
