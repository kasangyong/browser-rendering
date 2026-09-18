/**
 * C5 — "content-visibility 의 이득은 Style 에서 나온다" 를 현실적인 무효화로 다시
 *
 * C2 는 세 무효화가 전부 :root 커스텀 프로퍼티였다 — 상속되므로 트리 전체를
 * 무효화하는 최악 경우다. 여기서는 무효화 '범위' 가 다른 네 가지로 다시 잰다.
 *
 * 측정 절차에 C4d 의 수정을 적용한다 (이 저장소에서 처음):
 *   - 이전 브라우저가 완전히 끝날 때까지 기다린 뒤 +3초  (기존 0.5초 → 흩어짐 6.1배)
 *   - 조건 순서를 섞는다                                  (C4b 의 순서 효과 방지)
 *   - 시작 시점의 살아 있는 chrome 프로세스 수를 매번 기록
 *
 * 사전 등록: PREDICTION.md
 * 사용: node measure.mjs [--repeat=4] [--kicks=8] [--resume=1]
 */
import { spawn, execFile } from 'node:child_process';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const arg = (n, d) => {
  const m = process.argv.find(a => a.startsWith(`--${n}=`));
  return m ? m.split('=')[1] : d;
};
const REPEAT = Number(arg('repeat', '4'));
const KICKS = Number(arg('kicks', '8'));
const SEED = Number(arg('seed', '20260918'));
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';
const URL_C5 = 'http://127.0.0.1:8765/experiments/track-c/c5-realistic-invalidation/';

const INVS = ['width-inline', 'theme-padding', 'item-color', 'root-var'];
const MODES = ['plain', 'cv-auto'];
const COUNTS = [500, 4000];
const STAGES = ['UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint', 'RasterTask'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/** 재현 가능한 셔플 — 순서를 섞되 다시 돌리면 같은 순서가 나오게 */
function shuffled(arr, seed) {
  const a = [...arr];
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const chromeCount = () => new Promise(res => {
  execFile('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], (e, out) => {
    if (e || !out) return res(-1);
    res(out.split('\n').filter(l => /chrome\.exe/i.test(l)).length);
  });
});

/** C4d: 이전 실행이 완전히 끝날 때까지 기다린다. 이것만으로 흩어짐이 6.1배 → 1.6배 */
async function waitQuiet(baseline) {
  for (let i = 0; i < 60; i++) {
    if ((await chromeCount()) <= baseline) { await sleep(3000); return true; }
    await sleep(500);
  }
  await sleep(3000);
  return false;
}

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

async function launch(port, tag) {
  for (let a = 0; a < 4; a++) {
    const p = port + a * 137, profile = path.join(SCRATCH, `c5-${tag}-${a}`);
    await mkdir(profile, { recursive: true });
    const proc = spawn(CHROME, [
      '--headless=new', `--remote-debugging-port=${p}`, '--remote-allow-origins=*',
      `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
      '--hide-scrollbars', '--window-size=1280,900', 'about:blank',
    ], { stdio: 'ignore' });
    let ok = false;
    for (let i = 0; i < 60; i++) {
      await sleep(350);
      try { if ((await fetch(`http://127.0.0.1:${p}/json/version`)).ok) { ok = true; break; } } catch {}
    }
    if (ok) return { proc, port: p, profile };
    try { proc.kill('SIGKILL'); } catch {}
    console.error(`    ↻ ${tag}: 포트 ${p} 실패, 재시도`);
    await sleep(1200);
  }
  throw new Error(`Chrome 기동 실패 (${tag})`);
}

async function once({ port, tag, n, mode, inv }) {
  const { proc, port: p, profile } = await launch(port, tag);
  try {
    const t = await (await fetch(
      `http://127.0.0.1:${p}/json/new?${encodeURIComponent(URL_C5 + '?v=' + Date.now())}`,
      { method: 'PUT' })).json();
    const page = await connect(t.webSocketDebuggerUrl);
    await page.send('Page.enable'); await page.send('Runtime.enable');
    for (let i = 0; i < 60; i++) {
      if (await page.evaluate('!!window.__C5').catch(() => false)) break;
      await sleep(250);
    }
    const built = await page.evaluate(`__C5.build(${n}, ${JSON.stringify(mode)})`);
    await sleep(1800);
    const procsAtStart = await chromeCount();

    const evs = [];
    page.on('Tracing.dataCollected', pr => { if (pr.value) evs.push(...pr.value); });
    const done = new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('tracingComplete 안 옴')), 180000);
      page.on('Tracing.tracingComplete', v => { clearTimeout(to); res(v); });
    });
    await page.send('Tracing.start', {
      transferMode: 'ReportEvents',
      traceConfig: { recordMode: 'recordAsMuchAsPossible',
        includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink'] },
    });
    await sleep(200);
    await page.evaluate(`__C5.invalidate(${JSON.stringify(inv)}, ${KICKS})`);
    await sleep(300);
    await page.send('Tracing.end');
    await done;

    const dur = {}, cnt = {};
    for (const e of evs) {
      if (e.ph === 'M') continue;
      cnt[e.name] = (cnt[e.name] || 0) + 1;
      if (typeof e.dur === 'number') dur[e.name] = (dur[e.name] || 0) + e.dur / 1000;
    }
    const stage = {};
    for (const s of STAGES) stage[s] = { n: cnt[s] || 0, ms: +((dur[s] || 0) / KICKS).toFixed(3) };
    const state = await page.evaluate('__C5.state()').catch(() => null);
    await page.send('Browser.close').catch(() => {});
    return { n, mode, inv, kicks: KICKS, procsAtStart, built, state, stage };
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    try { await rm(profile, { recursive: true, force: true }); } catch {}
  }
}

const LOCK = path.join(import.meta.dirname, '.measure.lock');
if (existsSync(LOCK)) {
  const pid = Number((await readFile(LOCK, 'utf8')).trim());
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch {}
  if (alive) { console.error(`이미 실행 중이다 (pid ${pid}).`); process.exit(1); }
  console.error(`↻ 죽은 프로세스의 락 (pid ${pid}) — 무시한다`);
}
await writeFile(LOCK, String(process.pid));
const unlock = () => { try { unlinkSync(LOCK); } catch {} };
process.on('exit', unlock);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { unlock(); process.exit(1); });

const OUT = path.join(import.meta.dirname, 'results.json');
const out = { experiment: 'c5-realistic-invalidation', generatedAt: new Date().toISOString(),
              repeat: REPEAT, kicks: KICKS, seed: SEED,
              isolation: 'strict (이전 브라우저 완전 종료 + 3초)', order: 'shuffled', rows: [] };
const save = () => writeFile(OUT, JSON.stringify(out, null, 2));
if (arg('resume', '0') === '1' && existsSync(OUT)) {
  out.rows = (JSON.parse(await readFile(OUT, 'utf8')).rows) || [];
  console.log(`↻ 재개: ${out.rows.length} 건 보유`);
}

// 전체 실행 목록을 만들고 순서를 섞는다 (C4b 의 순서 효과 방지)
const plan = [];
for (const n of COUNTS) for (const mode of MODES) for (const inv of INVS)
  for (let r = 0; r < REPEAT; r++) plan.push({ n, mode, inv, rep: r });
const order = shuffled(plan, SEED);

const BASELINE = await chromeCount();
console.log(`\n기준선 chrome 프로세스 ${BASELINE}개 · 실행 ${order.length}건 (순서 섞음, seed ${SEED})\n`);

let port = 30000 + Math.floor(Math.random() * 400);
let i = 0;
for (const job of order) {
  i++;
  const key = `${job.n}|${job.mode}|${job.inv}|${job.rep}`;
  if (out.rows.some(r => `${r.n}|${r.mode}|${r.inv}|${r.rep}` === key)) continue;
  await waitQuiet(BASELINE);
  port++;
  try {
    const v = await once({ port, tag: `${job.inv}-${job.mode}-${job.n}-${job.rep}`, ...job });
    out.rows.push({ ...v, rep: job.rep });
    await save();
    if (i % 8 === 0 || i === order.length) {
      console.log(`  ${String(i).padStart(3)}/${order.length}  ${job.inv} · ${job.mode} · N=${job.n}` +
        `  Style ${v.stage.UpdateLayoutTree.ms}ms · Layout ${v.stage.Layout.ms}ms · chrome ${v.procsAtStart}`);
    }
  } catch (e) {
    console.error(`  ${i}/${order.length} 실패 (${key}): ${e.message}`);
  }
}

await save();
console.log('\n✅ results.json 저장 —  node analyze.mjs 로 집계');
process.exit(0);
