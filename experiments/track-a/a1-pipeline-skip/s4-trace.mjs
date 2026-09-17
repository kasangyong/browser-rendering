/**
 * A1 · S4 (재시도) — 메인 스레드가 막힌 구간에서 다른 스레드가 일하는가?
 *
 * captureScreenshot 은 메인 스레드에 걸려서 관찰 도구로 못 쓴다(s4-probe.mjs 로 확인).
 * 대신 트레이스를 떠서, 메인 스레드의 긴 busy task 구간 안에
 * "컴포지터 스레드가 프레임을 계속 만들었는지"를 센다.
 *
 * 사용: node s4-trace.mjs [--boxes=1] [--block=1500]
 */
import { writeFile } from 'node:fs/promises';

const argNum = (n, d) => {
  const m = process.argv.find(a => a.startsWith(`--${n}=`));
  return m ? Number(m.split('=')[1]) : d;
};
const PORT = argNum('port', 9222);
const BOXES = argNum('boxes', 1);
const BLOCK_MS = argNum('block', 1500);
const URL_ARG = 'http://127.0.0.1:8765/a1-pipeline-skip/';
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
  evaluate(e) { return this.send('Runtime.evaluate', { expression: e, returnByValue: true }).then(r => r.result?.value); }
  fire(e) { this.ws.send(JSON.stringify({ id: ++this.id, method: 'Runtime.evaluate', params: { expression: e } })); }
}

const run = async () => {
  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_ARG)}`,
    { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  const cdp = new CDP(ws);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  for (let i = 0; i < 40 && !(await cdp.evaluate('!!window.__A1')); i++) await sleep(250);
  await cdp.evaluate(`__A1.setCount(${BOXES})`);

  const out = [];
  for (const mode of ['left', 'transform', 'willchange']) {
    await cdp.evaluate(`__A1.setMode(${JSON.stringify(mode)})`);
    await sleep(1500);

    const events = [];
    cdp.on('Tracing.dataCollected', p => { if (p.value) events.push(...p.value); });
    const complete = new Promise(res => cdp.on('Tracing.tracingComplete', res));
    await cdp.send('Tracing.start', {
      transferMode: 'ReportEvents',
      traceConfig: {
        recordMode: 'recordAsMuchAsPossible',
        includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline',
                             'cc', 'viz', 'benchmark', '__metadata'],
      },
    });
    await sleep(300);
    cdp.fire(`(()=>{const t=performance.now();while(performance.now()-t<${BLOCK_MS});})()`);
    await sleep(BLOCK_MS + 800);
    await cdp.send('Tracing.end');
    await complete;

    // tid → 스레드 이름
    const names = new Map();
    for (const e of events) {
      if (e.ph === 'M' && e.name === 'thread_name') names.set(`${e.pid}:${e.tid}`, e.args?.name);
    }
    // 메인 스레드의 가장 긴 task = busy loop 구간
    let blockEv = null;
    for (const e of events) {
      if (e.ph === 'M' || typeof e.dur !== 'number') continue;
      if (names.get(`${e.pid}:${e.tid}`) !== 'CrRendererMain') continue;
      if (e.dur > (BLOCK_MS * 900) && (!blockEv || e.dur > blockEv.dur)) blockEv = e;
    }
    if (!blockEv) { out.push({ mode, error: 'busy task 구간을 트레이스에서 못 찾음' });
                    console.log(`${mode}: ❌ busy 구간 미검출`); continue; }

    const t0 = blockEv.ts, t1 = blockEv.ts + blockEv.dur;
    const byThread = {};
    for (const e of events) {
      if (e.ph === 'M' || e.ts < t0 || e.ts > t1) continue;
      const key = names.get(`${e.pid}:${e.tid}`) || `tid${e.tid}`;
      byThread[key] ??= { total: 0, names: {} };
      byThread[key].total++;
      byThread[key].names[e.name] = (byThread[key].names[e.name] || 0) + 1;
    }
    // 컴포지터가 만든 프레임 수 = 해당 구간의 draw/swap 계열
    const comp = byThread['Compositor'] || { total: 0, names: {} };
    const frameish = Object.entries(comp.names)
      .filter(([n]) => /Draw|Swap|BeginImplFrame|OnBeginImplFrame|ActivateSyncTree/i.test(n))
      .sort((a, b) => b[1] - a[1]);

    out.push({
      mode,
      blockDurMs: +(blockEv.dur / 1000).toFixed(0),
      compositorEvents: comp.total,
      compositorFrameish: Object.fromEntries(frameish.slice(0, 6)),
      threads: Object.fromEntries(Object.entries(byThread)
        .sort((a, b) => b[1].total - a[1].total).slice(0, 6)
        .map(([k, v]) => [k, v.total])),
    });
    console.log(`\n── ${mode} (메인 블록 ${(blockEv.dur / 1000).toFixed(0)}ms) ─────────`);
    console.log('  스레드별 이벤트:', out.at(-1).threads);
    console.log('  Compositor 프레임 계열:', out.at(-1).compositorFrameish);
    await sleep(400);
  }

  await writeFile(new URL('./s4-trace-results.json', import.meta.url),
    JSON.stringify({ generatedAt: new Date().toISOString(), browser: ver.Browser,
                     boxes: BOXES, blockMs: BLOCK_MS, modes: out }, null, 2));
  console.log('\n✅ s4-trace-results.json 저장');
  await cdp.send('Browser.close').catch(() => {});
  process.exit(0);
};
run().catch(e => { console.error('실패:', e); process.exit(1); });
