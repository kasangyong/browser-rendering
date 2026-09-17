/**
 * A4 — content-visibility: auto 의 비용 스케일링
 *
 * DOM 생성은 트레이스 밖에서 끝내고, 강제 리레이아웃 구간만 잰다.
 * 예측은 PREDICTION.md 에 측정 전 등록됨.
 *
 * 사용: node measure.mjs [--counts=100,500,2000,8000] [--repeat=3] [--relayouts=8]
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';

const arg = (n, d) => {
  const m = process.argv.find(a => a.startsWith(`--${n}=`));
  return m ? m.split('=')[1] : d;
};
const COUNTS = arg('counts', '100,500,2000,8000').split(',').map(Number);
const MODES = arg('modes', 'plain,cv-auto,cv-nosize').split(',');
const REPEAT = Number(arg('repeat', '3'));
const RELAYOUTS = Number(arg('relayouts', '8'));
const PHASE = arg('phase', 'relayout');   // 'relayout' | 'scroll'
const SCROLL_STEPS = Number(arg('steps', '40'));
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROF_BASE = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad/a4prof';
const URL_ARG = 'http://127.0.0.1:8765/a4-content-visibility/';

const STAGES = ['UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint', 'RasterTask', 'InvalidateLayout'];
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

const run = async () => {
  const rows = [];
  let port = 9700;
  console.log(PHASE.startsWith('scroll')
    ? '   n  mode          Layout수   Layout(총ms)  Paint횟수  Style(총ms)  scrollHeight'
    : '   n  mode        relayout중  Layout(ms/회)  Paint횟수  Style(ms/회)  scrollHeight');

  for (const n of COUNTS) {
    for (const mode of MODES) {
      for (let rep = 0; rep < REPEAT; rep++) {
        port++;
        const { proc, ver } = await launch(port, `${n}-${mode}-${rep}`);
        try {
          const t = await (await fetch(
            `http://127.0.0.1:${port}/json/new?${encodeURIComponent(URL_ARG)}`, { method: 'PUT' })).json();
          const page = await connect(t.webSocketDebuggerUrl);
          await page.send('Page.enable'); await page.send('Runtime.enable');
          for (let i = 0; i < 50 && !(await page.evaluate('!!window.__A4').catch(() => false)); i++) await sleep(250);

          // ── 1) DOM 생성 (트레이스 밖) ──
          await page.evaluate(`__A4.build(${n}, ${JSON.stringify(mode)})`);
          await sleep(1500);                       // 첫 렌더 안정화
          const st = await page.evaluate('JSON.stringify(__A4.state())');

          // ── 2) 강제 리레이아웃 구간만 트레이스 ──
          const events = [];
          page.on('Tracing.dataCollected', p => { if (p.value) events.push(...p.value); });
          const complete = new Promise(res => page.on('Tracing.tracingComplete', res));
          await page.send('Tracing.start', {
            transferMode: 'ReportEvents',
            traceConfig: { recordMode: 'recordAsMuchAsPossible',
              includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink'] },
          });
          await sleep(200);
          if (PHASE === 'scroll')       await page.evaluate(`__A4.scrollThrough(${SCROLL_STEPS})`);
          else if (PHASE === 'scroll2')  await page.evaluate(`__A4.scrollLinear(300, ${SCROLL_STEPS})`);
          else                          await page.evaluate(`__A4.relayout(${RELAYOUTS})`);
          await sleep(300);
          await page.send('Tracing.end');
          await complete;

          const counts = {}, dur = {};
          for (const e of events) {
            if (e.ph === 'M') continue;
            counts[e.name] = (counts[e.name] || 0) + 1;
            if (typeof e.dur === 'number') dur[e.name] = (dur[e.name] || 0) + e.dur / 1000;
          }
          const stage = {};
          for (const s of STAGES) {
            stage[s] = { n: counts[s] || 0, ms: +(dur[s] || 0).toFixed(2),
                         perRelayout: +((dur[s] || 0) / RELAYOUTS).toFixed(3),
                         total: +(dur[s] || 0).toFixed(2) };
          }
          const state = JSON.parse(st);
          rows.push({ boxes: n, mode, rep, phase: PHASE, relayouts: RELAYOUTS, steps: SCROLL_STEPS, state, stage });
          console.log(
            String(n).padStart(5), mode.padEnd(11),
            String(stage.Layout.n).padStart(10),
            String(PHASE.startsWith('scroll') ? stage.Layout.total : stage.Layout.perRelayout).padStart(14),
            String(stage.Paint.n).padStart(10),
            String(PHASE.startsWith('scroll') ? stage.UpdateLayoutTree.total : stage.UpdateLayoutTree.perRelayout).padStart(13),
            String(state.scrollHeight).padStart(13));
          await page.send('Browser.close').catch(() => {});
        } catch (e) {
          console.error(`  ${n}/${mode}/${rep} 실패:`, e.message);
          rows.push({ boxes: n, mode, rep, error: e.message });
        } finally {
          await sleep(300);
          try { proc.kill('SIGKILL'); } catch {}
          await sleep(500);
        }
      }
    }
  }

  await writeFile(new URL(PHASE === 'relayout' ? './results.json' : `./results-${PHASE}.json`, import.meta.url),
    JSON.stringify({ generatedAt: new Date().toISOString(), phase: PHASE, relayouts: RELAYOUTS, steps: SCROLL_STEPS,
                     isolation: 'browser-per-config', rows }, null, 2));
  console.log('\n✅ results.json 저장');
  process.exit(0);
};
run().catch(e => { console.error('실패:', e); process.exit(1); });
