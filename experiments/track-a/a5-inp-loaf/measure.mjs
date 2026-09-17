/**
 * A5 — INP와 LoAF
 *
 * 전략마다 Chrome 을 새로 띄우고, CDP 로 실제 클릭을 12회 보낸 뒤
 * Event Timing / LoAF 수치를 거둔다. 예측은 PREDICTION.md 에 측정 전 등록됨.
 *
 * 사용: node measure.mjs [--clicks=12] [--work=200] [--repeat=3]
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';

const arg = (n, d) => {
  const m = process.argv.find(a => a.startsWith(`--${n}=`));
  return m ? m.split('=')[1] : d;
};
const CLICKS = Number(arg('clicks', '12'));
const WORK = Number(arg('work', '200'));
const CHUNK = Number(arg('chunk', '5'));
const REPEAT = Number(arg('repeat', '3'));
const STRATEGIES = arg('strategies', 'sync,yield,paint-first,worker').split(',');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROF_BASE = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad/a5prof';
const URL_ARG = 'http://127.0.0.1:8765/a5-inp-loaf/';

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
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true });
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

async function launch(port, tag) {
  const profile = `${PROF_BASE}-${tag}`;
  await mkdir(profile, { recursive: true });
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    await sleep(400);
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return { proc, ver: await r.json() }; }
    catch { /* 기동 대기 */ }
  }
  throw new Error('Chrome 기동 실패');
}

/** 버튼 중심 좌표에 진짜 마우스 클릭을 보낸다 */
async function click(page, x, y) {
  await page.send('Input.dispatchMouseEvent',
    { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent',
    { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

const run = async () => {
  const rows = [];
  let port = 9800;
  console.log(`작업량 ${WORK}ms · 클릭 ${CLICKS}회 · 반복 ${REPEAT}\n`);
  console.log('전략          rep   INP p75  INP건수   화면갱신p75  화면갱신max   LoAF blocking');

  for (const strategy of STRATEGIES) {
    for (let rep = 0; rep < REPEAT; rep++) {
      port++;
      const { proc, ver } = await launch(port, `${strategy}-${rep}`);
      try {
        const t = await (await fetch(
          `http://127.0.0.1:${port}/json/new?${encodeURIComponent(URL_ARG)}`, { method: 'PUT' })).json();
        const page = await connect(t.webSocketDebuggerUrl);
        await page.send('Page.enable'); await page.send('Runtime.enable');
        for (let i = 0; i < 50 && !(await page.evaluate('!!window.__A5').catch(() => false)); i++) await sleep(250);

        const support = await page.evaluate('__A5.supportsYield()');
        await page.evaluate(`__A5.setWork(${WORK}, ${CHUNK})`);
        await page.evaluate(`__A5.setStrategy(${JSON.stringify(strategy)})`);
        await sleep(600);

        const box = await page.evaluate(
          'JSON.stringify((r => ({x: r.x + r.width/2, y: r.y + r.height/2}))' +
          '(document.getElementById("target").getBoundingClientRect()))');
        const { x, y } = JSON.parse(box);

        await page.evaluate('__A5.reset()');
        for (let i = 0; i < CLICKS; i++) {
          await click(page, x, y);
          await sleep(WORK + 350);          // 다음 클릭 전에 작업 완료 + 프레임 안정화
        }
        await sleep(600);

        const s = JSON.parse(await page.evaluate('JSON.stringify(__A5.summary())'));
        rows.push({ strategy, rep, supportsYield: support, ...s });
        console.log(
          strategy.padEnd(13), String(rep).padStart(3),
          String(s.inp_p75).padStart(9), String(s.clicks).padStart(8),
          String(s.visualUpdate_p75).padStart(13), String(s.visualUpdate_max).padStart(12),
          String(s.loafBlocking_total).padStart(16));
        await page.send('Browser.close').catch(() => {});
      } catch (e) {
        console.error(`  ${strategy}/${rep} 실패:`, e.message);
        rows.push({ strategy, rep, error: e.message });
      } finally {
        await sleep(300);
        try { proc.kill('SIGKILL'); } catch {}
        await sleep(500);
      }
    }
  }

  await writeFile(new URL('./results.json', import.meta.url),
    JSON.stringify({ generatedAt: new Date().toISOString(), workMs: WORK, chunkMs: CHUNK,
                     clicks: CLICKS, isolation: 'browser-per-strategy', rows }, null, 2));
  console.log('\n✅ results.json 저장');
  process.exit(0);
};
run().catch(e => { console.error('실패:', e); process.exit(1); });
