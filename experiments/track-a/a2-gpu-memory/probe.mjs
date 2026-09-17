/**
 * A2 사전 검증 — 계측기부터 확인한다 (A1 교훈 #2)
 *
 * 세 가지를 확인하기 전에는 본 실험을 시작하지 않는다.
 *   P1. GPU 가속이 실제로 켜져 있는가?      → SystemInfo.getInfo().gpu.featureStatus
 *   P2. 메모리 덤프가 나오는가?             → Tracing.requestMemoryDump
 *   P3. 덤프에 GPU 관련 allocator 가 있는가? → gpu/ · skia/ · cc/ 항목 존재 여부
 *
 * 사용: node probe.mjs [--port=9222]
 */
const argNum = (n, d) => {
  const m = process.argv.find(a => a.startsWith(`--${n}=`));
  return m ? Number(m.split('=')[1]) : d;
};
const PORT = argNum('port', 9222);
const URL_ARG = 'http://127.0.0.1:8765/a1-pipeline-skip/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hexToNum = h => (typeof h === 'string' ? parseInt(h, 16) : Number(h)) || 0;

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
    ws.addEventListener('error', () => rej(new Error('WS 실패: ' + url)), { once: true });
  });
  return new CDP(ws);
};

const run = async () => {
  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  console.log('브라우저:', ver.Browser);

  // ── P1. GPU 상태 (브라우저 엔드포인트에서만 SystemInfo 사용 가능) ──
  const browser = await connect(ver.webSocketDebuggerUrl);
  const info = await browser.send('SystemInfo.getInfo').catch(e => ({ error: String(e) }));
  const fs = info?.gpu?.featureStatus || {};
  const devices = (info?.gpu?.devices || [])
    .map(d => `${d.vendorString || d.vendorId} ${d.deviceString || d.deviceId}`.trim());

  console.log('\n[P1] GPU 상태');
  console.log('  장치:', devices.length ? devices.join(' / ') : '(없음)');
  const keys = ['gpu_compositing', 'rasterization', 'canvas', 'webgl', 'video_decode', 'skia_graphite'];
  for (const k of keys) if (fs[k]) console.log(`  ${k.padEnd(18)} ${fs[k]}`);
  const accelerated = /^enabled/.test(fs.gpu_compositing || '') && /^enabled/.test(fs.rasterization || '');
  console.log(`  → ${accelerated ? '✅ GPU 가속 켜짐' : '❌ 소프트웨어 — GPU 메모리 측정 의미 없음'}`);

  // ── P2/P3. 메모리 덤프 ──
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_ARG)}`,
    { method: 'PUT' })).json();
  const page = await connect(t.webSocketDebuggerUrl);
  await page.send('Page.enable'); await page.send('Runtime.enable');
  for (let i = 0; i < 40 && !(await page.evaluate('!!window.__A1').catch(() => false)); i++) await sleep(250);
  await page.evaluate('__A1.setCount(300); __A1.setMode("transform")');
  await sleep(2000);

  const events = [];
  browser.on('Tracing.dataCollected', p => { if (p.value) events.push(...p.value); });
  const complete = new Promise(res => browser.on('Tracing.tracingComplete', res));
  await browser.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: {
      recordMode: 'recordAsMuchAsPossible',
      includedCategories: ['disabled-by-default-memory-infra', '__metadata'],
      memoryDumpConfig: { triggers: [] },
    },
  });
  await sleep(500);
  const t0 = Date.now();
  const dump = await browser.send('Tracing.requestMemoryDump',
    { deterministic: true, levelOfDetail: 'detailed' }).catch(e => ({ error: String(e) }));
  const dumpMs = Date.now() - t0;
  await sleep(700);
  await browser.send('Tracing.end');
  await complete;

  console.log(`\n[P2] requestMemoryDump: success=${dump.success} (${dumpMs}ms)` +
              (dump.error ? ` error=${dump.error}` : ''));

  const procNames = new Map();
  for (const e of events) {
    if (e.ph === 'M' && e.name === 'process_name') procNames.set(e.pid, e.args?.name);
  }
  const dumps = events.filter(e => e.ph === 'v' && e.args?.dumps);
  console.log(`[P3] 덤프 이벤트 ${dumps.length}개 · 프로세스 ${new Set(dumps.map(d => d.pid)).size}개`);

  for (const d of dumps) {
    const name = procNames.get(d.pid) || `pid${d.pid}`;
    const allocs = d.args.dumps.allocators || {};
    const rss = hexToNum(d.args.dumps.process_totals?.resident_set_bytes);
    const interesting = Object.entries(allocs)
      .filter(([k]) => /^(gpu|skia|cc|shared_memory|malloc|partition_alloc)(\/|$)/.test(k))
      .map(([k, v]) => [k, hexToNum(v.attrs?.size?.value)])
      .filter(([, sz]) => sz > 512 * 1024)
      .sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (!interesting.length && !rss) continue;
    console.log(`\n  ── ${name} (pid ${d.pid}) · RSS ${(rss / 1048576).toFixed(1)}MB`);
    for (const [k, sz] of interesting) console.log(`     ${k.padEnd(42)} ${(sz / 1048576).toFixed(2)}MB`);
  }

  const hasGpuAlloc = dumps.some(d =>
    Object.keys(d.args.dumps.allocators || {}).some(k => /^(gpu|skia\/gpu)/.test(k)));
  console.log(`\n  → GPU allocator 존재: ${hasGpuAlloc ? '✅ 있음' : '❌ 없음'}`);

  console.log('\n판정:', accelerated && dump.success && hasGpuAlloc
    ? '✅ A2 본실험 진행 가능'
    : '❌ 본실험 조건 미충족 — 위 항목 확인 필요');

  await browser.send('Browser.close').catch(() => {});
  process.exit(0);
};
run().catch(e => { console.error('실패:', e); process.exit(1); });
