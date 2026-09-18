/**
 * C3 — 2,000 레이어 절벽이 진짜인가
 *
 * C2 §4 에서 못 푼 이유는 측정이 '프레임 수'에 끌려다녔기 때문이다.
 * 여기서는 표본 수를 내가 정한다 — --tx 를 k번 토글하면 레이어 N개가 매번 새 transform 을
 * 받고 정확히 k개의 표본이 나온다. 프레임이 빠르든 느리든 k는 그대로다.
 *
 * 시간은 페이지 안에서 performance.now() 로 잰다. 트레이싱을 안 쓰므로
 * 1,400,000개 이벤트를 전송하다 타임아웃 나던 문제도 사라진다.
 * (메모리는 별도로 작은 덤프 한 번만 뜬다.)
 *
 * A. 레이어 스윕     — 절벽이 있는지, 어디인지
 * B. 박스 크기 판별  — 개수는 그대로, 타일 메모리만 4배 (16KB → 64KB)
 *
 * 사용: node measure.mjs [--part=a|b|all] [--repeat=4] [--toggles=120] [--resume=1]
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
const REPEAT = Number(arg('repeat', '4'));
const TOGGLES = Number(arg('toggles', '120'));
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';
const URL_C3 = 'http://127.0.0.1:8765/experiments/track-c/c3-layer-cliff/';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * p)] ?? 0; };

function linfit(xs, ys) {
  const n = xs.length, mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const slope = sxy / sxx, intercept = my - slope * mx;
  let sr = 0, st = 0;
  for (let i = 0; i < n; i++) { sr += (ys[i] - (slope * xs[i] + intercept)) ** 2; st += (ys[i] - my) ** 2; }
  return { slope, intercept, r2: 1 - sr / st };
}

/** CDP — 소켓이 끊기면 대기 중인 요청을 전부 거절한다 (C2 에서 두 번 조용히 죽었다) */
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
    // 120Hz vsync 양자화 제거 (C2 §4). 토글마다 rAF 2번을 기다리므로 안 끄면 하한이 16.6ms 로 깔린다
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
    const p = port + a * 137, profile = path.join(SCRATCH, `c3-${tag}-${a}`);
    const proc = await launchOnce(p, profile);
    if (proc) return { proc, port: p, profile };
    console.error(`    ↻ ${tag}: 포트 ${p} 실패, 재시도`);
    await sleep(1200);
  }
  throw new Error(`Chrome 기동 실패 (${tag})`);
}

const hex = v => (v ? parseInt(v, 16) : 0);
const MB = b => +(b / 1048576).toFixed(2);

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
    const built = await page.evaluate(`__C3.build(${layers}, ${bw}, ${bh})`);
    await sleep(2000);

    // ── 메모리 덤프 (A2 와 같은 방식). memory-infra 만 담으므로 작다 ──
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

    let tiles = 0, gpu = 0, shared = 0;
    for (const e of memEvents) {
      const al = e.args?.dumps?.allocators; if (!al) continue;
      const get = k => hex(al[k]?.attrs?.size?.value);
      tiles += get('cc/tile_memory');
      gpu += get('gpu');
      shared += get('shared_memory');
    }

    // ── 본 측정: 토글 k회. 트레이싱 없음 ──
    const pump = await page.evaluate(`__C3.pump(${TOGGLES})`);
    await page.send('Browser.close').catch(() => {});

    return {
      layers, bw, bh, boxes: built?.boxes ?? 0, layerCount,
      n: pump.n, times: pump.times,
      p10: pump.p10, p50: pump.p50, p90: pump.p90, mean: pump.mean,
      tileMB: MB(tiles), gpuMB: MB(gpu), sharedMB: MB(shared),
    };
  } finally {
    await sleep(250);
    try { proc.kill('SIGKILL'); } catch {}
    await sleep(450);
    try { await rm(profile, { recursive: true, force: true }); } catch { /* 잠김 무시 */ }
  }
}

// 같은 스크립트를 두 번 띄우면 두 프로세스가 같은 results.json 을 번갈아 덮어써서
// 설정이 뒤섞인다. 실제로 한 번 당했다 (레이어 4개짜리 행과 1004개짜리 행이 섞여 나왔다).
const LOCK = path.join(import.meta.dirname, '.measure.lock');
if (existsSync(LOCK)) {
  const old = await readFile(LOCK, 'utf8').catch(() => '?');
  console.error(`이미 실행 중인 것 같다 (${LOCK}, pid ${old.trim()}).
` +
    `정말 아니라면 그 파일을 지우고 다시 실행한다.`);
  process.exit(1);
}
await writeFile(LOCK, String(process.pid));
const unlock = () => { try { unlinkSync(LOCK); } catch {} };
process.on('exit', unlock);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { unlock(); process.exit(1); });

const OUT = path.join(import.meta.dirname, 'results.json');
const out = { experiment: 'c3-layer-cliff', generatedAt: new Date().toISOString(),
              repeat: REPEAT, toggles: TOGGLES, vsync: 'disabled',
              method: 'pump (프레임 수가 아니라 토글 수가 표본 수를 정한다)',
              isolation: 'browser-per-config', partA: [], partB: [] };
const save = () => writeFile(OUT, JSON.stringify(out, null, 2));

if (arg('resume', '0') === '1' && existsSync(OUT)) {
  const prev = JSON.parse(await readFile(OUT, 'utf8'));
  out.partA = prev.partA || []; out.partB = prev.partB || [];
  console.log(`↻ 재개: A ${out.partA.length} · B ${out.partB.length} 건 보유`);
}

let port = 18000 + Math.floor(Math.random() * 400);
const reps = async (n, fn) => { const v = []; for (let i = 0; i < n; i++) v.push(await fn(i)); return v; };

/**
 * 유효성 검사 — 요청한 만큼 실제로 합성 레이어가 생겼는가.
 * 하네스에서 will-change 를 빼먹었을 때 레이어가 4개만 생겼는데도
 * 측정값은 그럴듯해서(500 레이어에 31.5ms) 한참 못 알아챘다. 자동으로 걸리게 둔다.
 */
const checkLayers = rows => {
  const bad = rows.filter(r => r.layerCount !== r.layers + 4);
  if (bad.length) {
    console.error(`  ⚠️  레이어 승격 불일치 ${bad.length}건 — ` +
      bad.map(r => `요청 ${r.layers} → 실제 ${r.layerCount}`).join(', '));
  }
  return bad.length === 0;
};

/** 반복별 중앙값을 다시 평균내지 않는다. 원시 표본을 전부 합쳐서 분위수를 낸다 */
const pooled = rows => {
  const all = rows.flatMap(r => r.times || []);
  return {
    n: all.length, p10: q(all, .1), p50: q(all, .5), p90: q(all, .9), mean: mean(all),
    spread: rows.length > 1 ? Math.max(...rows.map(r => r.p50)) / Math.min(...rows.map(r => r.p50)) : 1,
    tileMB: mean(rows.map(r => r.tileMB)), gpuMB: mean(rows.map(r => r.gpuMB)),
    layerCount: Math.round(mean(rows.map(r => r.layerCount))),
  };
};

// ── A. 레이어 스윕 ────────────────────────────────────────
if (PART === 'all' || PART === 'a') {
  const LAYERS = [500, 1000, 1500, 1750, 2000, 2250, 2500, 3000];
  console.log(`\nA. 레이어 스윕 — 토글 ${TOGGLES}회 × ${REPEAT}회 반복 · vsync 끔\n`);
  console.log('  레이어  합성레이어  표본   p50 ms   p90 ms  레이어당µs   반복간편차   타일MB');
  console.log('  ' + '─'.repeat(78));
  const xs = [], ys = [];
  for (const n of LAYERS) {
    const done = out.partA.filter(r => r.layers === n);
    const rows = done.length >= REPEAT ? done : await reps(REPEAT, async r => {
      port++;
      const v = await once({ port, tag: `a-${n}-${r}`, layers: n, bw: 38, bh: 15 });
      out.partA.push({ ...v, rep: r }); await save(); return v;
    });
    checkLayers(rows);
    const a = pooled(rows); xs.push(n); ys.push(a.p50);
    console.log(`  ${String(n).padStart(6)}${String(a.layerCount).padStart(12)}${String(a.n).padStart(7)}` +
      `${a.p50.toFixed(2).padStart(9)}${a.p90.toFixed(2).padStart(9)}` +
      `${(a.p50 / n * 1000).toFixed(2).padStart(12)}${(a.spread.toFixed(2) + '배').padStart(13)}` +
      `${a.tileMB.toFixed(1).padStart(9)}`);
  }
  const f = linfit(xs, ys);
  out.fitA = { layers: xs, p50: ys, ...f };
  console.log(`\n  선형 적합: p50 = ${(f.slope * 1000).toFixed(3)}µs × 레이어 + ${f.intercept.toFixed(3)}ms  ·  R² = ${f.r2.toFixed(4)}`);
  console.log(`  판정: ${f.r2 >= 0.95 ? '선형 — 절벽 없음' : '선형 아님'}`);
}

// ── B. 박스 크기 판별 ─────────────────────────────────────
if (PART === 'all' || PART === 'b') {
  const SIZES = [{ bw: 38, bh: 15, label: '38×15 (16KB)' }, { bw: 100, bh: 100, label: '100×100 (64KB)' }];
  console.log(`\nB. 박스 크기 판별 — 레이어 개수는 그대로, 타일 메모리만 4배\n`);
  console.log('  박스             레이어  합성레이어   p50 ms  레이어당µs    타일MB  레이어당KB');
  console.log('  ' + '─'.repeat(78));
  for (const s of SIZES) {
    for (const n of [500, 1000, 1500, 2000]) {
      const done = out.partB.filter(r => r.layers === n && r.bw === s.bw);
      const rows = done.length >= REPEAT ? done : await reps(REPEAT, async r => {
        port++;
        const v = await once({ port, tag: `b-${s.bw}-${n}-${r}`, layers: n, bw: s.bw, bh: s.bh });
        out.partB.push({ ...v, rep: r }); await save(); return v;
      });
      checkLayers(rows);
      const a = pooled(rows);
      console.log(`  ${s.label.padEnd(17)}${String(n).padStart(6)}${String(a.layerCount).padStart(12)}` +
        `${a.p50.toFixed(2).padStart(9)}${(a.p50 / n * 1000).toFixed(2).padStart(12)}` +
        `${a.tileMB.toFixed(1).padStart(10)}${(a.tileMB * 1024 / n).toFixed(1).padStart(12)}`);
    }
    console.log('  ' + '·'.repeat(78));
  }
}

await save();
console.log('\n✅ results.json 저장');
process.exit(0);
