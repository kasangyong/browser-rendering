/**
 * A3 — paint chunk 경계와 레이어화
 *
 * 시나리오마다 Chrome 을 새로 띄워(A2 교훈) 합성 레이어 수와 승격 사유를 잰다.
 * 예측은 PREDICTION.md 에 측정 전 등록됨.
 *
 * 사용: node measure.mjs [--repeat=3]
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';

const arg = (n, d) => {
  const m = process.argv.find(a => a.startsWith(`--${n}=`));
  return m ? m.split('=')[1] : d;
};
const REPEAT = Number(arg('repeat', '3'));
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROF_BASE = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad/a3prof';
const URL_ARG = 'http://127.0.0.1:8765/a3-paint-chunks/';
const SETTLE_MS = 1800;

const SCENARIOS = ['s1-plain', 's2-promoted-last', 's3-promoted-first-overlap',
                   's4-promoted-first-nooverlap', 's5-interleaved', 's6-grouped'];

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
  const profile = `${PROF_BASE}-${tag}`;
  await mkdir(profile, { recursive: true });
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return { proc, ver: await r.json() }; }
    catch { /* 기동 대기 */ }
  }
  throw new Error('Chrome 기동 실패');
}

const run = async () => {
  const rows = [];
  let port = 9600;
  console.log('scenario                       rep  layers  Δ(s1)  주요 compositing reasons');

  const s1ByRep = {};
  for (const scenario of SCENARIOS) {
    for (let rep = 0; rep < REPEAT; rep++) {
      port++;
      const { proc, ver } = await launch(port, `${scenario}-${rep}`);
      try {
        const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(URL_ARG)}`,
          { method: 'PUT' })).json();
        const page = await connect(t.webSocketDebuggerUrl);
        await page.send('Page.enable'); await page.send('Runtime.enable');
        for (let i = 0; i < 40 && !(await page.evaluate('!!window.__A3').catch(() => false)); i++) await sleep(250);

        let layers = null;
        page.on('LayerTree.layerTreeDidChange', p => { layers = p.layers || []; });
        await page.send('LayerTree.enable');

        await page.evaluate(`__A3.setScenario(${JSON.stringify(scenario)})`);
        layers = null;
        await sleep(SETTLE_MS);

        const list = layers || [];
        // 레이어별 승격 사유
        const reasons = {};
        for (const l of list) {
          const r = await page.send('LayerTree.compositingReasons', { layerId: l.layerId })
                              .catch(() => null);
          const ids = r?.compositingReasonIds || [];
          for (const id of ids) reasons[id] = (reasons[id] || 0) + 1;
        }
        const counts = await page.evaluate('JSON.stringify(__A3.counts())');
        if (scenario === 's1-plain') s1ByRep[rep] = list.length;
        const delta = s1ByRep[rep] !== undefined ? list.length - s1ByRep[rep] : null;

        rows.push({ scenario, rep, layers: list.length, delta,
                    elements: JSON.parse(counts), reasons,
                    drawsContent: list.filter(l => l.drawsContent).length });
        const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 3)
                          .map(([k, v]) => `${k}×${v}`).join(' ');
        console.log(scenario.padEnd(30), String(rep).padStart(3),
                    String(list.length).padStart(7),
                    String(delta === null ? '-' : (delta >= 0 ? '+' + delta : delta)).padStart(6),
                    '  ' + (top || '(없음)'));
        await page.send('Browser.close').catch(() => {});
      } catch (e) {
        console.error(`  ${scenario}/${rep} 실패:`, e.message);
        rows.push({ scenario, rep, error: e.message });
      } finally {
        await sleep(300);
        try { proc.kill('SIGKILL'); } catch {}
        await sleep(500);
      }
    }
  }

  await writeFile(new URL('./results.json', import.meta.url),
    JSON.stringify({ generatedAt: new Date().toISOString(), settleMs: SETTLE_MS,
                     isolation: 'browser-per-scenario', rows }, null, 2));
  console.log('\n✅ results.json 저장');
  process.exit(0);
};
run().catch(e => { console.error('실패:', e); process.exit(1); });
