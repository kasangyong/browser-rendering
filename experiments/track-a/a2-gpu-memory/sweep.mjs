/**
 * A2 — 합성 레이어의 GPU 메모리 비용
 *
 * 질문: 레이어 하나가 GPU 메모리를 얼마나 먹는가? 무한정 늘어나는가?
 *
 * 계측: memory-infra 트레이싱 + Tracing.requestMemoryDump
 *   - GPU 프로세스 `gpu/shared_images` = 합성 레이어의 텍스처
 *   - 렌더러     `cc/tile_memory`      = 래스터 타일
 *   - 레이어 수  LayerTree.layerTreeDidChange (푸시형 — 메인 스레드에 안 걸림)
 *
 * 대조군 `none`(애니메이션 없음) 기준으로 증분을 본다.
 *
 * 사용: node sweep.mjs [--counts=1,50,200,500,1000,2000,4000]
 */
import { writeFile } from 'node:fs/promises';

const arg = (n, d) => {
  const m = process.argv.find(a => a.startsWith(`--${n}=`));
  return m ? m.split('=')[1] : d;
};
const PORT = Number(arg('port', '9222'));
const COUNTS = arg('counts', '1,50,200,500,1000,2000,4000').split(',').map(Number);
const MODES = ['none', 'left', 'transform'];
const URL_ARG = 'http://127.0.0.1:8765/a1-pipeline-skip/';
const SETTLE_MS = 2200;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hex = h => (typeof h === 'string' ? parseInt(h, 16) : Number(h)) || 0;
const MB = b => +(b / 1048576).toFixed(2);

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

/** 한 번의 메모리 덤프를 떠서 프로세스별 allocator 를 뽑는다 */
async function dumpMemory(browser) {
  const events = [];
  const onData = p => { if (p.value) events.push(...p.value); };
  browser.on('Tracing.dataCollected', onData);
  const complete = new Promise(res => browser.on('Tracing.tracingComplete', res));

  await browser.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: {
      recordMode: 'recordAsMuchAsPossible',
      includedCategories: ['disabled-by-default-memory-infra', '__metadata'],
      memoryDumpConfig: { triggers: [] },
    },
  });
  await sleep(300);
  // 두 번 뜬다 — 첫 덤프는 워밍업, 두 번째를 쓴다
  await browser.send('Tracing.requestMemoryDump', { deterministic: true, levelOfDetail: 'detailed' });
  await sleep(500);
  const second = await browser.send('Tracing.requestMemoryDump',
    { deterministic: true, levelOfDetail: 'detailed' });
  await sleep(600);
  await browser.send('Tracing.end');
  await complete;
  browser.handlers.delete('Tracing.dataCollected');

  const names = new Map();
  for (const e of events) if (e.ph === 'M' && e.name === 'process_name') names.set(e.pid, e.args?.name);

  const dumps = events.filter(e => e.ph === 'v' && e.args?.dumps);
  // 마지막 덤프 guid 만 사용
  const lastGuid = second.dumpGuid;
  const use = dumps.filter(d => d.id === lastGuid || d.args.dumps.guid === lastGuid);
  const rows = (use.length ? use : dumps);

  const get = (d, key) => hex(d.args.dumps.allocators?.[key]?.attrs?.size?.value);
  let gpuTotal = 0, gpuShared = 0, ccTiles = 0, ccResource = 0;
  for (const d of rows) {
    const n = names.get(d.pid) || '';
    if (n === 'GPU Process') {
      gpuTotal  = Math.max(gpuTotal,  get(d, 'gpu'));
      gpuShared = Math.max(gpuShared, get(d, 'gpu/shared_images'));
    } else if (/Renderer/.test(n)) {
      ccTiles    += get(d, 'cc/tile_memory');
      ccResource += get(d, 'cc/resource_memory');
    }
  }
  return { gpuTotalMB: MB(gpuTotal), gpuSharedImagesMB: MB(gpuShared),
           ccTileMemoryMB: MB(ccTiles), ccResourceMB: MB(ccResource), dumpEvents: rows.length };
}

const run = async () => {
  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const browser = await connect(ver.webSocketDebuggerUrl);
  const info = await browser.send('SystemInfo.getInfo');
  const fsx = info?.gpu?.featureStatus || {};
  const accelerated = /^enabled/.test(fsx.gpu_compositing || '') && /^enabled/.test(fsx.rasterization || '');
  console.log(`GPU: compositing=${fsx.gpu_compositing} rasterization=${fsx.rasterization}` +
              ` → ${accelerated ? '✅' : '❌ 소프트웨어'}`);
  if (!accelerated) { console.error('GPU 가속이 꺼져 있어 중단한다.'); process.exit(2); }

  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_ARG)}`,
    { method: 'PUT' })).json();
  const page = await connect(t.webSocketDebuggerUrl);
  await page.send('Page.enable'); await page.send('Runtime.enable');
  for (let i = 0; i < 40 && !(await page.evaluate('!!window.__A1').catch(() => false)); i++) await sleep(250);

  let layers = null;
  page.on('LayerTree.layerTreeDidChange', p => { layers = p.layers || []; });
  await page.send('LayerTree.enable');
  await sleep(500);

  const rows = [];
  console.log('\nn      mode        layers   gpu/shared_images   gpu(total)   cc/tile_memory');
  for (const n of COUNTS) {
    for (const mode of MODES) {
      await page.evaluate(`__A1.setCount(${n})`);
      await page.evaluate(`__A1.setMode(${JSON.stringify(mode)})`);
      layers = null;
      await sleep(SETTLE_MS);
      const layerCount = layers ? layers.length : null;
      const mem = await dumpMemory(browser);
      rows.push({ boxes: n, mode, layers: layerCount, ...mem });
      console.log(
        String(n).padStart(5), mode.padEnd(11),
        String(layerCount ?? '-').padStart(6),
        `${mem.gpuSharedImagesMB}MB`.padStart(18),
        `${mem.gpuTotalMB}MB`.padStart(12),
        `${mem.ccTileMemoryMB}MB`.padStart(16));
    }
  }

  await writeFile(new URL('./sweep-results.json', import.meta.url), JSON.stringify({
    generatedAt: new Date().toISOString(), browser: ver.Browser,
    gpu: { devices: (info.gpu.devices || []).map(d => d.deviceString || String(d.deviceId)),
           featureStatus: fsx },
    settleMs: SETTLE_MS, rows,
  }, null, 2));
  console.log('\n✅ sweep-results.json 저장');
  await browser.send('Browser.close').catch(() => {});
  process.exit(0);
};
run().catch(e => { console.error('실패:', e); process.exit(1); });
