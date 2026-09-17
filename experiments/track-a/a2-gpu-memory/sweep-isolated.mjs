/**
 * A2 (재설계) — 설정마다 브라우저를 새로 띄운다
 *
 * 1차 시도(sweep.mjs)는 한 브라우저에서 설정을 바꿔가며 쟀는데,
 * GPU 리소스 풀이 설정 사이에 이월되어 값이 오염됐다.
 *   - left 값이 n=1000/2000/4000 에서 소수점까지 동일
 *   - 레이어 6개인 none 이 레이어 4006개인 transform 보다 메모리가 많음
 *
 * → 설정 하나마다 Chrome 을 새로 띄우고, 재고, 죽인다.
 *   느리지만 이월이 원천적으로 불가능하다.
 *
 * 안정성 검사: 한 설정에서 덤프를 2회 떠서 두 값의 차이를 함께 기록한다.
 *
 * 사용: node sweep-isolated.mjs [--counts=1,200,1000,4000] [--repeat=1]
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';

const arg = (n, d) => {
  const m = process.argv.find(a => a.startsWith(`--${n}=`));
  return m ? m.split('=')[1] : d;
};
const COUNTS = arg('counts', '1,200,1000,4000').split(',').map(Number);
const MODES = arg('modes', 'none,left,transform').split(',');
const REPEAT = Number(arg('repeat', '1'));
const SIZES = arg('sizes', '38x15').split(',').map(s => s.split('x').map(Number));
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROF_BASE = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad/a2prof';
const URL_ARG = 'http://127.0.0.1:8765/a1-pipeline-skip/';
const SETTLE_MS = 2500;

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

async function launch(port, tag) {
  const profile = `${PROF_BASE}-${tag}`;
  await mkdir(profile, { recursive: true });
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore', detached: false });
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return { proc, ver: await r.json() };
    } catch { /* 아직 안 뜸 */ }
  }
  throw new Error('Chrome 기동 실패');
}

/** memory-infra 덤프 1회 → 프로세스별 allocator */
async function dumpOnce(browser) {
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
  await sleep(250);
  await browser.send('Tracing.requestMemoryDump', { deterministic: true, levelOfDetail: 'detailed' });
  await sleep(500);
  await browser.send('Tracing.end');
  await complete;
  browser.handlers.delete('Tracing.dataCollected');

  const names = new Map();
  for (const e of events) if (e.ph === 'M' && e.name === 'process_name') names.set(e.pid, e.args?.name);
  const get = (d, k) => hex(d.args.dumps.allocators?.[k]?.attrs?.size?.value);

  let gpu = 0, shared = 0, tiles = 0, resource = 0, rendererCount = 0;
  for (const d of events.filter(e => e.ph === 'v' && e.args?.dumps)) {
    const n = names.get(d.pid) || '';
    if (n === 'GPU Process') {
      gpu = Math.max(gpu, get(d, 'gpu'));
      shared = Math.max(shared, get(d, 'gpu/shared_images'));
    } else if (/Renderer/.test(n)) {
      tiles += get(d, 'cc/tile_memory');
      resource += get(d, 'cc/resource_memory');
      rendererCount++;
    }
  }
  return { gpuMB: MB(gpu), sharedImagesMB: MB(shared),
           tileMemoryMB: MB(tiles), resourceMB: MB(resource), rendererCount };
}

const run = async () => {
  const rows = [];
  let port = 9400;
  let gpuInfo = null;

  console.log('    size     n mode        layers   shared_images        gpu   cc/tile_memory   (2회차 차이)');
  for (const [bw, bh] of SIZES) {
  for (const n of COUNTS) {
    for (const mode of MODES) {
      for (let rep = 0; rep < REPEAT; rep++) {
        port++;
        const tag = `${n}-${mode}-${bw}x${bh}-${rep}`;
        const { proc, ver } = await launch(port, tag);
        try {
          const browser = await connect(ver.webSocketDebuggerUrl);
          if (!gpuInfo) {
            const info = await browser.send('SystemInfo.getInfo');
            gpuInfo = { devices: (info.gpu.devices || []).map(d => d.deviceString || String(d.deviceId)),
                        featureStatus: info.gpu.featureStatus };
            const f = gpuInfo.featureStatus;
            if (!/^enabled/.test(f.gpu_compositing || '') || !/^enabled/.test(f.rasterization || '')) {
              throw new Error('GPU 가속 꺼짐 — 중단');
            }
          }
          const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(URL_ARG)}`,
            { method: 'PUT' })).json();
          const page = await connect(t.webSocketDebuggerUrl);
          await page.send('Page.enable'); await page.send('Runtime.enable');
          for (let i = 0; i < 40 && !(await page.evaluate('!!window.__A1').catch(() => false)); i++) await sleep(250);

          let layers = null;
          page.on('LayerTree.layerTreeDidChange', p => { layers = p.layers || []; });
          await page.send('LayerTree.enable');

          await page.evaluate(`__A1.setBoxSize(${bw}, ${bh})`);
          await page.evaluate(`__A1.setCount(${n})`);
          await page.evaluate(`__A1.setMode(${JSON.stringify(mode)})`);
          await sleep(SETTLE_MS);
          const layerCount = layers ? layers.length : null;

          const a = await dumpOnce(browser);
          await sleep(700);
          const b = await dumpOnce(browser);   // 안정성 확인용 2회차

          const drift = +(b.sharedImagesMB - a.sharedImagesMB).toFixed(2);
          rows.push({ boxes: n, mode, rep, boxW: bw, boxH: bh, layers: layerCount, first: a, second: b, driftMB: drift });
          console.log(
            `${bw}x${bh}`.padStart(8), String(n).padStart(5), mode.padEnd(11), String(layerCount ?? '-').padStart(6),
            `${b.sharedImagesMB}MB`.padStart(14), `${b.gpuMB}MB`.padStart(10),
            `${b.tileMemoryMB}MB`.padStart(16), `${drift >= 0 ? '+' : ''}${drift}MB`.padStart(12));
          await browser.send('Browser.close').catch(() => {});
        } catch (e) {
          console.error(`  ${n}/${mode} 실패:`, e.message);
          rows.push({ boxes: n, mode, rep, boxW: bw, boxH: bh, error: e.message });
        } finally {
          await sleep(400);
          try { proc.kill('SIGKILL'); } catch {}
          await sleep(600);
        }
      }
    }
  }
  }

  await writeFile(new URL('./isolated-results.json', import.meta.url),
    JSON.stringify({ generatedAt: new Date().toISOString(), gpu: gpuInfo,
                     settleMs: SETTLE_MS, isolation: 'browser-per-config', rows }, null, 2));
  console.log('\n✅ isolated-results.json 저장');
  process.exit(0);
};
run().catch(e => { console.error('실패:', e); process.exit(1); });
