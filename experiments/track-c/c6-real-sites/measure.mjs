/**
 * C6 — 실제 웹사이트에서 C5 를 다시
 *
 * 지금까지 16개 실험이 전부 내가 만든 합성 리스트였다.
 * 실제 페이지(Wikipedia, 블록 698개, 높이 변동계수 3.72)에서 같은 결론이 나오는지 본다.
 *
 * 절차는 C4d·C5 와 같다: 엄격 격리 + 순서 섞기 + 2배 미만은 차이 없음.
 * 공개 페이지를 읽기만 하고, 총 로드 수를 제한한다.
 *
 * 사전 등록: PREDICTION.md
 * 사용: node measure.mjs [--repeat=3] [--kicks=8] [--resume=1]
 */
import { spawn, execFile } from 'node:child_process';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const arg = (n, d) => {
  const m = process.argv.find(a => a.startsWith(`--${n}=`));
  return m ? m.split('=')[1] : d;
};
const REPEAT = Number(arg('repeat', '3'));
const KICKS = Number(arg('kicks', '8'));
const SEED = Number(arg('seed', '20260918'));
const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';

/**
 * 사이트별 설정. container 는 폭을 바꿀 대상, blocks 는 content-visibility 를 걸 대상.
 * intrinsic 은 사전 조사에서 관측한 블록 높이 중앙값이다 (probe-candidates.mjs).
 */
const SITES = {
  'wiki-uni': {
    url: 'https://en.wikipedia.org/wiki/List_of_Unicode_characters',
    container: '.mw-parser-output', blocks: '.mw-parser-output section > *', intrinsic: 81 },
  'whatwg-dom': {
    url: 'https://html.spec.whatwg.org/multipage/dom.html',
    container: 'body', blocks: 'body > *', intrinsic: 48 },
  'py-func': {
    url: 'https://docs.python.org/3/library/functions.html',
    container: '#built-in-functions', blocks: '#built-in-functions > *', intrinsic: 310 },
};
const SITE_KEY = arg('site', 'wiki-uni');
const SITE = SITES[SITE_KEY];
if (!SITE) { console.error('알 수 없는 사이트: ' + SITE_KEY + ' (' + Object.keys(SITES).join(', ') + ')'); process.exit(1); }
const MODES = ['plain', 'cv-auto'];
const INVS = ['width-inline', 'item-color', 'root-var'];
const STAGES = ['UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

function shuffled(arr, seed) {
  const a = [...arr]; let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const chromeCount = () => new Promise(res => {
  execFile('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], (e, out) => {
    if (e || !out) return res(-1);
    res(out.split('\n').filter(l => /chrome\.exe/i.test(l)).length);
  });
});
async function waitQuiet(baseline) {
  for (let i = 0; i < 60; i++) {
    if ((await chromeCount()) <= baseline) { await sleep(3000); return; }
    await sleep(500);
  }
  await sleep(3000);
}

/** 페이지에 주입할 제어기 — 모드 적용과 무효화를 페이지 안에서 한다 */
const SETUP = (site, mode) => `(() => {
  const S = ${JSON.stringify(site)};
  let st = document.getElementById('__c6_mode');
  if (!st) { st = document.createElement('style'); st.id = '__c6_mode'; document.head.appendChild(st); }
  st.textContent = ${JSON.stringify(mode)} === 'cv-auto'
    ? S.blocks + '{content-visibility:auto;contain-intrinsic-size:auto ' + S.intrinsic + 'px}'
    : '';

  let iv = document.getElementById('__c6_inv');
  if (!iv) { iv = document.createElement('style'); iv.id = '__c6_inv'; document.head.appendChild(iv); }
  iv.textContent = '';

  const el = document.querySelector(S.container);
  el.style.width = '';
  document.documentElement.style.removeProperty('--c6bg');
  document.scrollingElement.scrollHeight;          // 강제 레이아웃

  window.__C6 = {
    // 무효화 세 가지 — C5 와 같은 구조, 대상만 실제 페이지다
    inv: {
      'width-inline': i => { el.style.width = (i % 2 ? '900px' : '') ; },
      'item-color':   i => { iv.textContent = i % 2 ? S.blocks + '{background:#fffdf8}' : ''; },
      'root-var':     i => { document.documentElement.style.setProperty('--c6bg', i % 2 ? '#fffdf8' : '#fff');
                             iv.textContent = S.blocks + '{background:var(--c6bg,#fff)}'; },
    },
    reset: () => { el.style.width = ''; iv.textContent = '';
                   document.documentElement.style.removeProperty('--c6bg'); },
    stats: () => ({
      blocks: document.querySelectorAll(S.blocks).length,
      scrollHeight: document.scrollingElement.scrollHeight,
      domNodes: document.querySelectorAll('*').length,
    }),
  };
  return window.__C6.stats();
})()`;

const RUN_INV = (kind, k) => `(async () => {
  const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const f = window.__C6.inv[${JSON.stringify(kind)}];
  for (let i = 0; i < ${k}; i++) { f(i); await frame(); }
  window.__C6.reset();
  await frame();
  return window.__C6.stats();
})()`;

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); this.dead = null;
    const die = why => { this.dead = new Error('CDP 끊김: ' + why);
      for (const [, p] of this.pending) p.reject(this.dead); this.pending.clear(); };
    ws.addEventListener('close', () => die('close'), { once: true });
    ws.addEventListener('error', () => die('error'), { once: true });
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) { const p = this.pending.get(m.id); if (!p) return;
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error).slice(0, 200))) : p.resolve(m.result);
      } else { const h = this.handlers.get(m.method); if (h) h(m.params); }
    });
  }
  send(method, params = {}, timeoutMs = 120000) {
    if (this.dead) return Promise.reject(this.dead);
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error('CDP 응답 없음 ' + method)); }, timeoutMs);
      this.pending.set(id, { resolve: v => { clearTimeout(t); res(v); }, reject: e => { clearTimeout(t); rej(e); } });
    });
  }
  on(m, f) { this.handlers.set(m, f); }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 200));
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

async function once({ port, tag, mode, inv }) {
  const profile = path.join(SCRATCH, `c6-${tag}`);
  await mkdir(profile, { recursive: true });
  const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--hide-scrollbars', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { await sleep(350);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {} }
  try {
    const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    const page = await connect(t.webSocketDebuggerUrl);
    await page.send('Page.enable'); await page.send('Runtime.enable');
    const loaded = new Promise(r => page.on('Page.loadEventFired', r));
    await page.send('Page.navigate', { url: SITE.url });
    await Promise.race([loaded, sleep(45000)]);
    await sleep(3000);                                   // 늦게 붙는 스크립트까지

    const before = await page.evaluate(SETUP(SITE, 'plain'));
    const after = await page.evaluate(SETUP(SITE, mode));
    await sleep(1500);
    const procsAtStart = await chromeCount();

    const evs = [];
    page.on('Tracing.dataCollected', p => { if (p.value) evs.push(...p.value); });
    const done = new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('tracingComplete 안 옴')), 120000);
      page.on('Tracing.tracingComplete', v => { clearTimeout(to); res(v); });
    });
    await page.send('Tracing.start', { transferMode: 'ReportEvents',
      traceConfig: { recordMode: 'recordAsMuchAsPossible',
        includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] } });
    await sleep(200);
    await page.evaluate(RUN_INV(inv, KICKS));
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
    await page.send('Browser.close').catch(() => {});
    return { mode, inv, kicks: KICKS, procsAtStart, heightPlain: before.scrollHeight,
             heightMode: after.scrollHeight, blocks: after.blocks, domNodes: after.domNodes, stage };
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    try { await rm(profile, { recursive: true, force: true }); } catch {}
  }
}

const LOCK = path.join(import.meta.dirname, `.measure-${SITE_KEY}.lock`);
if (existsSync(LOCK)) {
  const pid = Number((await readFile(LOCK, 'utf8')).trim());
  let alive = false; try { process.kill(pid, 0); alive = true; } catch {}
  if (alive) { console.error(`이미 실행 중 (pid ${pid})`); process.exit(1); }
}
await writeFile(LOCK, String(process.pid));
const unlock = () => { try { unlinkSync(LOCK); } catch {} };
process.on('exit', unlock);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { unlock(); process.exit(1); });

const OUT = path.join(import.meta.dirname, SITE_KEY === 'wiki-uni' ? 'results.json' : `results-${SITE_KEY}.json`);
const out = { experiment: 'c6-real-sites', siteKey: SITE_KEY, generatedAt: new Date().toISOString(),
              site: SITE, repeat: REPEAT, kicks: KICKS,
              isolation: 'strict', order: 'shuffled', rows: [] };
const save = () => writeFile(OUT, JSON.stringify(out, null, 2));
if (arg('resume', '0') === '1' && existsSync(OUT)) {
  out.rows = (JSON.parse(await readFile(OUT, 'utf8')).rows) || [];
  console.log(`↻ 재개: ${out.rows.length}건 보유`);
}

const plan = [];
for (const mode of MODES) for (const inv of INVS) for (let r = 0; r < REPEAT; r++) plan.push({ mode, inv, rep: r });
const order = shuffled(plan, SEED);
const BASELINE = await chromeCount();
console.log(`\n실제 사이트 측정 — ${SITE.url}`);
console.log(`블록 ${SITE.blocks} · intrinsic ${SITE.intrinsic}px`);
console.log(`기준선 chrome ${BASELINE}개 · 총 ${order.length}회 로드 (순서 섞음)\n`);

let port = 36000 + Math.floor(Math.random() * 300);
let i = 0;
for (const job of order) {
  i++;
  const key = `${job.mode}|${job.inv}|${job.rep}`;
  if (out.rows.some(r => `${r.mode}|${r.inv}|${r.rep}` === key)) continue;
  await waitQuiet(BASELINE);
  port++;
  try {
    const v = await once({ port, tag: `${job.mode}-${job.inv}-${job.rep}`, ...job });
    out.rows.push({ ...v, rep: job.rep });
    await save();
    console.log(`  ${String(i).padStart(2)}/${order.length}  ${job.mode.padEnd(8)}${job.inv.padEnd(14)}` +
      `Style ${String(v.stage.UpdateLayoutTree.ms).padStart(8)}  Layout ${String(v.stage.Layout.ms).padStart(8)}` +
      `  높이 ${v.heightMode.toLocaleString()}`);
  } catch (e) {
    console.error(`  ${i}/${order.length} 실패 (${key}): ${e.message}`);
  }
}
await save();
console.log('\n✅ results.json 저장 —  node analyze.mjs');
process.exit(0);
