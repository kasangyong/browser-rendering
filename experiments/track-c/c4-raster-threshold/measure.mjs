/**
 * C4 — Raster 가 켜지는 임계점
 *
 * C3 하네스(pump)를 그대로 쓴다. 토글 k회 = 표본 k개.
 * 상태가 이진(0.05ms vs 60ms)이라 평균이 아니라 **켜진 비율**을 본다.
 *
 * A. 임계점 정밀 탐색 — 레이어를 촘촘히, 반복 많이
 * B. 박스 크기 판별   — 레이어 개수는 그대로, 타일 1장의 바이트만 4배
 *
 * 사용: node measure.mjs [--part=a|b|all] [--repeat=6] [--toggles=15] [--resume=1]
 */
import { spawn } from 'node:child_process';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const arg = (n, d) => {
  const m = process.argv.find(a => a.startsWith(`--${n}=`));
  return m ? m.split('=')[1] : d;
};
const PART = arg('part', 'all');
const REPEAT = Number(arg('repeat', '6'));
const TOGGLES = Number(arg('toggles', '15'));
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';
// 하네스는 C3 것을 재사용한다 (transform 토글 + will-change)
const URL_C3 = 'http://127.0.0.1:8765/experiments/track-c/c3-layer-cliff/';

/** 이 값을 넘으면 "래스터 켜짐" 으로 센다. 관측된 두 무리는 ~1ms 와 ~30ms+ 로 멀리 떨어져 있다 */
const ON_THRESHOLD_MS = 5;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); this.dead = null;
    const die = why => {
      this.dead = new Error(`CDP 연결 끊김: ${why}`);
      for (const [, p] of this.pending) p.reject(this.dead);
      this.pending.clear();
    };
    ws.addEventListener('close', e => die(`close ${e.code ?? ''}`.trim()), { once: true });
    ws.addEventListener('error', () => die('error'), { once: true });
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) {
        const p = this.pending.get(m.id); if (!p) return;
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      } else { const h = this.handlers.get(m.method); if (h) h(m.params); }
    });
  }
  send(method, params = {}, timeoutMs = 180000) {
    if (this.dead) return Promise.reject(this.dead);
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP 응답 없음 (${method})`)); }, timeoutMs);
      this.pending.set(id, { resolve: v => { clearTimeout(t); res(v); },
                            reject: e => { clearTimeout(t); rej(e); } });
    });
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

async function launchOnce(port, profile) {
  await mkdir(profile, { recursive: true });
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-gpu-vsync', '--disable-frame-rate-limit',
    '--hide-scrollbars', '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    await sleep(350);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return proc; } catch { /* 대기 */ }
  }
  try { proc.kill('SIGKILL'); } catch {}
  return null;
}
async function launch(port, tag) {
  for (let a = 0; a < 4; a++) {
    const p = port + a * 137, profile = path.join(SCRATCH, `c4-${tag}-${a}`);
    const proc = await launchOnce(p, profile);
    if (proc) return { proc, port: p, profile };
    console.error(`    ↻ ${tag}: 포트 ${p} 실패, 재시도`);
    await sleep(1200);
  }
  throw new Error(`Chrome 기동 실패 (${tag})`);
}

const hex = v => (v ? parseInt(v, 16) : 0);
const MB = b => +(b / 1048576).toFixed(2);

/** 축출의 직접 증거가 될 만한 이벤트 이름들 */
const EVICT_RE = /evict|ReleaseTileResources|PrepareTiles|TileManager|OutOfMemory|memory_pressure/i;

async function once({ port, tag, layers, bw, bh }) {
  const { proc, port: p, profile } = await launch(port, tag);
  try {
    const ver = await (await fetch(`http://127.0.0.1:${p}/json/version`)).json();
    const browser = await connect(ver.webSocketDebuggerUrl);
    const t = await (await fetch(
      `http://127.0.0.1:${p}/json/new?${encodeURIComponent(URL_C3 + '?v=' + Date.now())}`,
      { method: 'PUT' })).json();
    const page = await connect(t.webSocketDebuggerUrl);
    await page.send('Page.enable'); await page.send('Runtime.enable'); await page.send('LayerTree.enable');

    let layerCount = 0;
    page.on('LayerTree.layerTreeDidChange', pr => { layerCount = (pr.layers || []).length; });

    for (let i = 0; i < 60; i++) {
      if (await page.evaluate('!!window.__C3').catch(() => false)) break;
      await sleep(250);
    }
    await page.evaluate(`__C3.build(${layers}, ${bw}, ${bh})`);
    await sleep(2000);

    // ── 메모리 덤프 ──
    const memEvents = [];
    browser.on('Tracing.dataCollected', pr => { if (pr.value) memEvents.push(...pr.value); });
    const memDone = new Promise(res => browser.on('Tracing.tracingComplete', res));
    await browser.send('Tracing.start', {
      transferMode: 'ReportEvents',
      traceConfig: { recordMode: 'recordAsMuchAsPossible',
                     includedCategories: ['disabled-by-default-memory-infra', '__metadata'] },
    });
    await sleep(300);
    await browser.send('Tracing.requestMemoryDump', { deterministic: true, levelOfDetail: 'detailed' });
    await sleep(700);
    await browser.send('Tracing.end');
    await memDone;

    let tiles = 0, gpu = 0, tileObjects = 0, tileAttrs = null;
    for (const e of memEvents) {
      const al = e.args?.dumps?.allocators; if (!al) continue;
      const get = k => hex(al[k]?.attrs?.size?.value);
      tiles += get('cc/tile_memory');
      gpu += get('gpu');
      const tm = al['cc/tile_memory'];
      if (tm) {
        tileAttrs ||= Object.keys(tm.attrs || {});
        tileObjects += hex(tm.attrs?.object_count?.value);
      }
    }

    // ── 본 측정 ──
    const evs = [];
    page.on('Tracing.dataCollected', pr => { if (pr.value) evs.push(...pr.value); });
    const done = new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('tracingComplete 안 옴')), 180000);
      page.on('Tracing.tracingComplete', v => { clearTimeout(to); res(v); });
    });
    await page.send('Tracing.start', {
      transferMode: 'ReportEvents',
      traceConfig: { recordMode: 'recordAsMuchAsPossible',
                     includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] },
    });
    await sleep(200);
    const pump = await page.evaluate(`__C3.pump(${TOGGLES})`);
    await sleep(300);
    await page.send('Tracing.end');
    await done;

    let rasterMs = 0, rasterN = 0, commitMs = 0;
    const evict = {};
    for (const e of evs) {
      if (e.ph === 'M') continue;
      if (e.name === 'RasterTask') { rasterN++; if (typeof e.dur === 'number') rasterMs += e.dur / 1000; }
      else if (e.name === 'Commit' && typeof e.dur === 'number') commitMs += e.dur / 1000;
      if (EVICT_RE.test(e.name)) evict[e.name] = (evict[e.name] || 0) + 1;
    }
    await page.send('Browser.close').catch(() => {});

    const rasterPer = +(rasterMs / TOGGLES).toFixed(3);
    return {
      layers, bw, bh, layerCount, toggles: TOGGLES,
      rasterPer, rasterN, on: rasterPer > ON_THRESHOLD_MS,
      commitPer: +(commitMs / TOGGLES).toFixed(3),
      perToggleMs: pump.mean,
      tileMB: MB(tiles), gpuMB: MB(gpu), tileObjects, tileAttrs,
      evict, traceEvents: evs.length,
    };
  } finally {
    await sleep(250);
    try { proc.kill('SIGKILL'); } catch {}
    await sleep(450);
    try { await rm(profile, { recursive: true, force: true }); } catch { /* 잠김 무시 */ }
  }
}

const LOCK = path.join(import.meta.dirname, '.measure.lock');
if (existsSync(LOCK)) {
  console.error(`이미 실행 중인 것 같다 (${LOCK}). 아니라면 그 파일을 지우고 다시 실행한다.`);
  process.exit(1);
}
await writeFile(LOCK, String(process.pid));
const unlock = () => { try { unlinkSync(LOCK); } catch {} };
process.on('exit', unlock);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { unlock(); process.exit(1); });

const OUT = path.join(import.meta.dirname, 'results.json');
const out = { experiment: 'c4-raster-threshold', generatedAt: new Date().toISOString(),
              repeat: REPEAT, toggles: TOGGLES, onThresholdMs: ON_THRESHOLD_MS,
              harness: 'c3-layer-cliff/index.html (pump)', partA: [], partB: [] };
const save = () => writeFile(OUT, JSON.stringify(out, null, 2));

if (arg('resume', '0') === '1' && existsSync(OUT)) {
  const prev = JSON.parse(await readFile(OUT, 'utf8'));
  out.partA = prev.partA || []; out.partB = prev.partB || [];
  console.log(`↻ 재개: A ${out.partA.length} · B ${out.partB.length} 건 보유`);
}

let port = 22000 + Math.floor(Math.random() * 400);
/**
 * 반복 하나가 실패해도 설정 전체를 죽이지 않는다.
 * 2,000 레이어에서 렌더러가 죽어 build 가 던졌는데 그것 때문에 남은 설정이 전부 날아갔다.
 */
const reps = async (n, fn) => {
  const v = [];
  for (let i = 0; i < n; i++) {
    try { v.push(await fn(i)); }
    catch (e) { console.error(`    ↻ rep${i} 실패, 건너뜀: ${e.message}`); }
  }
  return v;
};

const summarize = rows => {
  const on = rows.filter(r => r.on);
  const off = rows.filter(r => !r.on);
  return {
    onRate: on.length / rows.length,
    onN: on.length, offN: off.length, total: rows.length,
    offMs: mean(off.map(r => r.rasterPer)), onMs: mean(on.map(r => r.rasterPer)),
    tileMB: mean(rows.map(r => r.tileMB)), gpuMB: mean(rows.map(r => r.gpuMB)),
    layerCount: Math.round(mean(rows.map(r => r.layerCount))),
  };
};
const bar = rate => '█'.repeat(Math.round(rate * 10)).padEnd(10, '·');

// ── A. 임계점 정밀 탐색 ───────────────────────────────────
if (PART === 'all' || PART === 'a') {
  const LAYERS = [800, 1000, 1100, 1200, 1300, 1400, 1500, 1750, 2000];
  console.log(`\nA. 임계점 정밀 탐색 — 토글 ${TOGGLES}회 × ${REPEAT}회 · 켜짐 기준 ${ON_THRESHOLD_MS}ms\n`);
  console.log('  레이어  합성레이어   켜진 비율              꺼짐 ms   켜짐 ms   타일MB   GPU MB');
  console.log('  ' + '─'.repeat(82));
  for (const n of LAYERS) {
    const done = out.partA.filter(r => r.layers === n);
    const rows = done.length >= REPEAT ? done : await reps(REPEAT, async r => {
      port++;
      const v = await once({ port, tag: `a-${n}-${r}`, layers: n, bw: 38, bh: 15 });
      out.partA.push({ ...v, rep: r }); await save(); return v;
    });
    if (!rows.length) { console.log(`  ${String(n).padStart(6)}   — 전부 실패`); continue; }
    const s = summarize(rows);
    console.log(`  ${String(n).padStart(6)}${String(s.layerCount).padStart(12)}   ` +
      `${bar(s.onRate)} ${s.onN}/${s.total}`.padEnd(20) +
      `${(s.offN === 0 ? '—' : s.offMs.toFixed(2)).padStart(9)}` +
      `${(s.onN ? s.onMs.toFixed(1) : '—').padStart(10)}` +
      `${s.tileMB.toFixed(1).padStart(9)}${s.gpuMB.toFixed(1).padStart(9)}`);
  }
}

// ── B. 박스 크기 판별 ─────────────────────────────────────
if (PART === 'all' || PART === 'b') {
  const SIZES = [
    { bw: 38, bh: 15, label: '38×15 (16KB/타일)', layers: [1000, 1200, 1400, 1600, 2000] },
    { bw: 100, bh: 100, label: '100×100 (64KB/타일)', layers: [250, 400, 600, 1000, 1400] },
  ];
  console.log(`\nB. 박스 크기 판별 — 개수는 그대로, 타일 1장의 바이트만 4배\n`);
  console.log('  박스                  레이어   켜진 비율              타일MB  레이어당KB');
  console.log('  ' + '─'.repeat(80));
  for (const s of SIZES) {
    for (const n of s.layers) {
      const done = out.partB.filter(r => r.layers === n && r.bw === s.bw);
      const rows = done.length >= REPEAT ? done : await reps(REPEAT, async r => {
        port++;
        const v = await once({ port, tag: `b-${s.bw}-${n}-${r}`, layers: n, bw: s.bw, bh: s.bh });
        out.partB.push({ ...v, rep: r }); await save(); return v;
      });
      if (!rows.length) { console.log(`  ${s.label.padEnd(22)}${String(n).padStart(6)}   — 전부 실패`); continue; }
      const g = summarize(rows);
      console.log(`  ${s.label.padEnd(22)}${String(n).padStart(6)}   ` +
        `${bar(g.onRate)} ${g.onN}/${g.total}`.padEnd(20) +
        `${g.tileMB.toFixed(1).padStart(8)}${(g.tileMB * 1024 / n).toFixed(1).padStart(12)}`);
    }
    console.log('  ' + '·'.repeat(80));
  }
}

await save();
console.log('\n✅ results.json 저장');
process.exit(0);
