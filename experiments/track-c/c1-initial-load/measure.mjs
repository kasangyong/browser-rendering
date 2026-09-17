/**
 * C1 — 초기 로드 비용
 *
 * 내비게이션 '전에' 트레이싱을 켜고, LCP 가 확정될 때까지 담는다.
 * 그래야 파싱·첫 레이아웃·첫 페인트가 전부 구간 안에 들어온다.
 *
 * 사용: node measure.mjs [--repeat=3]
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const arg = (n, d) => {
  const m = process.argv.find(a => a.startsWith(`--${n}=`));
  return m ? m.split('=')[1] : d;
};
const REPEAT = Number(arg('repeat', '3'));
const COUNTS = arg('counts', '200,1000,4000').split(',').map(Number);
const MODES = arg('modes', 'plain,cv-auto,cv-nosize').split(',');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';
const BASE = 'http://127.0.0.1:8765/experiments/track-c/c1-initial-load/pages';

const STAGES = ['ParseHTML', 'UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint',
                'RasterTask', 'Commit', 'InvalidateLayout'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

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
  off(m) { this.handlers.delete(m); }
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

async function launch(port, tag) {
  const profile = path.join(SCRATCH, `c1prof-${tag}`);
  await mkdir(profile, { recursive: true });
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--hide-scrollbars', '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    await sleep(350);
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return { proc, ver: await r.json() }; }
    catch { /* 기동 대기 */ }
  }
  try { proc.kill('SIGKILL'); } catch {}
  throw new Error('Chrome 기동 실패');
}

const run = async () => {
  const rows = [];
  let port = 10600 + Math.floor(Math.random() * 500);
  const bust = Date.now();

  console.log('  n    모드         Parse   Style  Layout PrePaint   Paint  Raster |    FCP    LCP');
  console.log('  ' + '─'.repeat(86));

  for (const n of COUNTS) {
    for (const mode of MODES) {
      for (let rep = 0; rep < REPEAT; rep++) {
        port++;
        const { proc } = await launch(port, `${mode}-${n}-${rep}`);
        try {
          // about:blank 탭에서 시작 → 트레이싱 켠 뒤 내비게이션
          const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
          const page = await connect(t.webSocketDebuggerUrl);
          await page.send('Page.enable');
          await page.send('Runtime.enable');
          await page.send('Network.enable');
          await page.send('Network.setCacheDisabled', { cacheDisabled: true });
          await sleep(400);

          const events = [];
          page.on('Tracing.dataCollected', p => { if (p.value) events.push(...p.value); });
          const complete = new Promise(res => page.on('Tracing.tracingComplete', res));
          await page.send('Tracing.start', {
            transferMode: 'ReportEvents',
            traceConfig: {
              recordMode: 'recordAsMuchAsPossible',
              includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline',
                                   'blink', 'loading', 'blink.user_timing'],
            },
          });
          await sleep(200);

          // ── 여기부터가 측정 구간 ──
          const url = `${BASE}/${mode}-${n}.html?v=${bust}-${rep}`;
          const loaded = new Promise(res => page.on('Page.loadEventFired', res));
          await page.send('Page.navigate', { url });
          await loaded;
          await sleep(1400);            // LCP 확정 대기
          await page.send('Tracing.end');
          await complete;

          const counts = {}, dur = {};
          let navStart = null, fcp = null, lcp = null;
          for (const e of events) {
            if (e.ph === 'M') continue;
            counts[e.name] = (counts[e.name] || 0) + 1;
            if (typeof e.dur === 'number') dur[e.name] = (dur[e.name] || 0) + e.dur / 1000;
            if (e.name === 'navigationStart' && navStart === null) navStart = e.ts;
            if (e.name === 'firstContentfulPaint' && fcp === null) fcp = e.ts;
            if (e.name === 'largestContentfulPaint::Candidate') lcp = e.ts;  // 마지막 후보
          }
          const stage = {};
          for (const s of STAGES) stage[s] = { n: counts[s] || 0, ms: +(dur[s] || 0).toFixed(2) };
          const fcpMs = navStart && fcp ? +((fcp - navStart) / 1000).toFixed(1) : null;
          const lcpMs = navStart && lcp ? +((lcp - navStart) / 1000).toFixed(1) : null;

          const scrollH = await page.evaluate('document.documentElement.scrollHeight');
          rows.push({ boxes: n, mode, rep, stage, fcpMs, lcpMs, scrollH });

          const c = s => String(stage[s].ms).padStart(7);
          console.log(`  ${String(n).padStart(4)} ${mode.padEnd(11)}` +
            `${c('ParseHTML')}${c('UpdateLayoutTree')}${c('Layout')}${c('PrePaint')}${c('Paint')}${c('RasterTask')} |` +
            `${String(fcpMs ?? '-').padStart(7)}${String(lcpMs ?? '-').padStart(7)}`);

          await page.send('Browser.close').catch(() => {});
        } catch (e) {
          console.error(`  ${n}/${mode}/${rep} 실패: ${e.message}`);
          rows.push({ boxes: n, mode, rep, error: e.message });
        } finally {
          await sleep(250);
          try { proc.kill('SIGKILL'); } catch {}
          await sleep(450);
        }
      }
    }
  }

  await writeFile(path.join(import.meta.dirname, 'results.json'), JSON.stringify({
    experiment: 'c1-initial-load', generatedAt: new Date().toISOString(),
    repeat: REPEAT, isolation: 'browser-per-config', cacheDisabled: true, rows,
  }, null, 2));
  console.log('\n✅ results.json 저장');
  process.exit(0);
};
run().catch(e => { console.error('실패:', e); process.exit(1); });
