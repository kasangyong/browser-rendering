/**
 * A1 · 파이프라인 단계 스킵 — CDP 트레이싱 계측
 *
 * 프레임 시간에서 "추론"하는 대신, Chromium 트레이스에서
 * UpdateLayoutTree / Layout / PrePaint / Paint 이벤트를 직접 센다.
 *
 * 의존성 없음 (Node 22+ 내장 WebSocket 사용).
 *
 * 사용: node trace-bench.mjs [url] [--boxes=600] [--run=4000]
 */

const URL_ARG = process.argv.find(a => a.startsWith('http')) ||
                'http://127.0.0.1:8765/a1-pipeline-skip/';
const argNum = (name, dflt) => {
  const m = process.argv.find(a => a.startsWith(`--${name}=`));
  return m ? Number(m.split('=')[1]) : dflt;
};
const BOXES  = argNum('boxes', 600);
const RUN_MS = argNum('run', 4000);
const WARM_MS = 1500;
const PORT = argNum('port', 9222);

const MODES = ['left', 'transform', 'willchange'];

// 세고 싶은 파이프라인 단계 (devtools.timeline 이벤트 이름)
const STAGES = [
  'ParseHTML',
  'UpdateLayoutTree',   // = style recalc
  'Layout',
  'PrePaint',
  'Paint',
  'Commit',
  'UpdateLayerTree',
  'RasterTask',
  'CompositeLayers',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 최소 CDP 클라이언트 ----------
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      } else {
        const h = this.handlers.get(msg.method);
        if (h) h(msg.params);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(method, fn) { this.handlers.set(method, fn); }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + expression);
    return r.result.value;
  }
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', e => rej(new Error('WS 연결 실패: ' + url)), { once: true });
  });
  return new CDP(ws);
}

// ---------- 트레이스 수집 ----------
async function traceFor(cdp, ms) {
  const events = [];
  cdp.on('Tracing.dataCollected', p => { if (p.value) events.push(...p.value); });
  const done = new Promise(res => cdp.on('Tracing.tracingComplete', res));

  await cdp.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: {
      recordMode: 'recordAsMuchAsPossible',
      includedCategories: [
        'devtools.timeline',
        'disabled-by-default-devtools.timeline',
        'blink',
      ],
    },
  });
  await sleep(ms);
  await cdp.send('Tracing.end');
  await done;
  return events;
}

function summarize(events, elapsedMs) {
  const counts = {};
  const durations = {};
  for (const e of events) {
    if (e.ph === 'M') continue;            // 메타데이터 제외
    counts[e.name] = (counts[e.name] || 0) + 1;
    if (typeof e.dur === 'number') {
      durations[e.name] = (durations[e.name] || 0) + e.dur / 1000; // µs → ms
    }
  }
  const stages = {};
  for (const s of STAGES) {
    stages[s] = { count: counts[s] || 0, totalMs: +(durations[s] || 0).toFixed(2) };
  }
  // 프레임 수 추정: DrawFrame / BeginFrame 계열
  const frames = counts['DrawFrame'] || counts['PipelineReporter'] || 0;
  return { elapsedMs, frames, stages, rawTopNames: topN(counts, 12) };
}

const topN = (obj, n) =>
  Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, v]) => `${k}:${v}`);

// ---------- 메인 ----------
const run = async () => {
  // 1) 브라우저 엔드포인트
  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  console.log('브라우저:', ver.Browser);

  // 2) 페이지 타깃 생성
  const target = await (await fetch(
    `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_ARG)}`,
    { method: 'PUT' }
  )).json();
  const cdp = await connect(target.webSocketDebuggerUrl);

  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 3) 로드 대기 + 하네스 훅 확인
  for (let i = 0; i < 40; i++) {
    const ok = await cdp.evaluate('!!window.__A1').catch(() => false);
    if (ok) break;
    await sleep(250);
  }
  const hidden = await cdp.evaluate('document.hidden');
  const rafOk = await cdp.evaluate(`
    (async () => { let n = 0; const t0 = performance.now();
      await new Promise(res => { (function f(){ n++;
        if (performance.now() - t0 > 600) return res();
        requestAnimationFrame(f); })(); });
      return n; })()
  `);
  console.log(`document.hidden=${hidden} · 600ms 동안 rAF ${rafOk}프레임`);
  if (rafOk < 10) {
    console.error('\n❌ rAF가 돌지 않는다. 측정 불가 — 헤드리스 플래그를 확인할 것.');
    process.exit(2);
  }

  await cdp.evaluate(`__A1.setCount(${BOXES})`);

  // 4) 모드별 트레이싱
  const out = [];
  for (const mode of MODES) {
    await cdp.evaluate(`__A1.setMode(${JSON.stringify(mode)})`);
    await sleep(WARM_MS);
    const t0 = Date.now();
    const events = await traceFor(cdp, RUN_MS);
    const sum = summarize(events, Date.now() - t0);
    const rafStats = await cdp.evaluate('JSON.stringify(__A1.stats())');
    out.push({ mode, ...sum, raf: JSON.parse(rafStats) });
    console.log(`\n── ${mode} ───────────────────────────────`);
    for (const s of STAGES) {
      const { count, totalMs } = sum.stages[s];
      if (count) console.log(`  ${s.padEnd(18)} ${String(count).padStart(6)}회  ${totalMs.toFixed(2).padStart(9)}ms`);
    }
    console.log(`  (프레임 ≈ ${sum.frames})`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    browser: ver.Browser,
    url: URL_ARG, boxes: BOXES, runMs: RUN_MS, warmupMs: WARM_MS,
    modes: out,
  };
  const fs = await import('node:fs/promises');
  await fs.writeFile(new URL('./trace-results.json', import.meta.url),
                     JSON.stringify(report, null, 2));
  console.log('\n✅ trace-results.json 저장');

  await cdp.send('Browser.close').catch(() => {});
  process.exit(0);
};

run().catch(e => { console.error('실패:', e); process.exit(1); });
