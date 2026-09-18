/**
 * C7 — 초기 로드의 실제판
 *
 * C1 의 "LCP 36~39% 단축" 은 내가 만든 합성 리스트에서 나왔고,
 * C6 가 그 하네스는 리레이아웃에서 양쪽으로 틀렸다는 걸 보여줬다.
 * 같은 하네스에서 나온 LCP 숫자만 검증을 안 받고 남아 있다.
 *
 * 설계의 핵심: 네트워크가 렌더링 차이를 덮지 않게 한다.
 *   ① 첫 로드로 HTTP 캐시를 데운다 (측정 안 함)
 *   ② addScriptToEvaluateOnNewDocument 로 문서 시작 시점에 스타일을 넣는다
 *      — 로드 후에 거는 건 의미 없다. 첫 페인트가 이미 끝났다
 *   ③ 두 번째 로드를 측정한다
 *
 * 절차는 C4d 이후와 같다: 엄격 격리 + 순서 섞기.
 * 공개 페이지를 읽기만 한다.
 *
 * 사전 등록: PREDICTION.md
 * 사용: node measure.mjs [--repeat=6] [--site=all|wiki-uni|whatwg-dom|py-func] [--resume=1]
 */
import { spawn, execFile } from 'node:child_process';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const arg = (n, d) => {
  const m = process.argv.find(a => a.startsWith(`--${n}=`));
  return m ? m.split('=')[1] : d;
};
const REPEAT = Number(arg('repeat', '6'));
const SEED = Number(arg('seed', '20260918'));
const ONLY = arg('site', 'all');
const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';

/** C6 와 동일한 선택자·intrinsic 값 */
const SITES = {
  'wiki-uni': { url: 'https://en.wikipedia.org/wiki/List_of_Unicode_characters',
                blocks: '.mw-parser-output section > *', intrinsic: 81 },
  'whatwg-dom': { url: 'https://html.spec.whatwg.org/multipage/dom.html',
                blocks: 'body > *', intrinsic: 48 },
  'py-func': { url: 'https://docs.python.org/3/library/functions.html',
                blocks: '#built-in-functions > *', intrinsic: 310 },
};
const MODES = ['plain', 'cv-auto'];
const STAGES = ['ParseHTML', 'UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint', 'RasterTask'];

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
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 160));
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

async function once({ port, tag, siteKey, mode }) {
  const S = SITES[siteKey];
  const profile = path.join(SCRATCH, `c7-${tag}`);
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
    await page.send('Network.enable');

    // ── ① 캐시 데우기 (측정 안 함) ─────────────────────────
    const warm = new Promise(r => page.on('Page.loadEventFired', r));
    await page.send('Page.navigate', { url: S.url });
    await Promise.race([warm, sleep(45000)]);
    await sleep(2500);
    const probe = await page.evaluate(
      `({ blocks: document.querySelectorAll(${JSON.stringify(S.blocks)}).length,
          h: document.scrollingElement.scrollHeight,
          dom: document.querySelectorAll('*').length })`).catch(() => null);

    // ── ② HTML 응답을 가로채 <style> 을 직접 심는다 ────────
    //
    // 처음엔 addScriptToEvaluateOnNewDocument 로 넣으려 했는데 실패했다 —
    // 그 스크립트가 도는 시점에는 documentElement 가 아직 없어서 죽는다.
    // HTML 에 직접 넣으면 '사이트 작성자가 CSS 를 넣은 것' 과 동일하고,
    // 파싱 시점부터 걸리므로 첫 레이아웃에 확실히 반영된다.
    //
    // 공정성: plain 도 똑같이 가로채되 빈 스타일을 넣는다.
    // 가로채기 자체의 부하가 양쪽에 동일하게 걸리게.
    const css = mode === 'cv-auto'
      ? `${S.blocks}{content-visibility:auto;contain-intrinsic-size:auto ${S.intrinsic}px}`
      : '';
    const tag = `<style id="__c7">${css}</style>`;
    await page.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Response', resourceType: 'Document' }],
    });
    page.on('Fetch.requestPaused', async p => {
      try {
        const body = await page.send('Fetch.getResponseBody', { requestId: p.requestId });
        let html = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
        // <head> 바로 뒤에 넣는다. 없으면 맨 앞에.
        const m = html.match(/<head[^>]*>/i);
        html = m ? html.replace(m[0], m[0] + tag) : tag + html;
        await page.send('Fetch.fulfillRequest', {
          requestId: p.requestId,
          responseCode: p.responseStatusCode ?? 200,
          responseHeaders: p.responseHeaders,
          body: Buffer.from(html, 'utf8').toString('base64'),
        });
      } catch {
        await page.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
      }
    });

    // ── ③ 두 번째 로드를 측정한다 ──────────────────────────
    const evs = [];
    page.on('Tracing.dataCollected', p => { if (p.value) evs.push(...p.value); });
    const done = new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('tracingComplete 안 옴')), 120000);
      page.on('Tracing.tracingComplete', v => { clearTimeout(to); res(v); });
    });
    await page.send('Tracing.start', {
      transferMode: 'ReportEvents',
      traceConfig: { recordMode: 'recordAsMuchAsPossible',
        includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline',
                             'blink', 'loading', 'blink.user_timing'] },
    });
    await sleep(200);
    const loaded = new Promise(r => page.on('Page.loadEventFired', r));
    await page.send('Page.navigate', { url: S.url });
    await Promise.race([loaded, sleep(45000)]);
    await sleep(2500);                       // LCP 확정 대기
    await page.send('Tracing.end');
    await done;

    const dur = {}, cnt = {};
    let navStart = null, fcp = null, lcp = null;
    for (const e of evs) {
      if (e.ph === 'M') continue;
      cnt[e.name] = (cnt[e.name] || 0) + 1;
      if (typeof e.dur === 'number') dur[e.name] = (dur[e.name] || 0) + e.dur / 1000;
      if (e.name === 'navigationStart' && navStart === null) navStart = e.ts;
      if (e.name === 'firstContentfulPaint' && fcp === null) fcp = e.ts;
      if (e.name === 'largestContentfulPaint::Candidate') lcp = e.ts;
    }
    const stage = {};
    for (const s of STAGES) stage[s] = { n: cnt[s] || 0, ms: +(dur[s] || 0).toFixed(2) };
    const after = await page.evaluate(
      `({ h: document.scrollingElement.scrollHeight,
          blocks: document.querySelectorAll(${JSON.stringify(S.blocks)}).length,
          applied: !!document.getElementById('__c7') })`).catch(() => null);
    await page.send('Browser.close').catch(() => {});

    return {
      siteKey, mode,
      fcpMs: navStart && fcp ? +((fcp - navStart) / 1000).toFixed(1) : null,
      lcpMs: navStart && lcp ? +((lcp - navStart) / 1000).toFixed(1) : null,
      stage, probe, after,
      cvApplied: mode === 'cv-auto' ? !!after?.applied : null,
    };
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    try { await rm(profile, { recursive: true, force: true }); } catch {}
  }
}

const LOCK = path.join(import.meta.dirname, '.measure.lock');
if (existsSync(LOCK)) {
  const pid = Number((await readFile(LOCK, 'utf8')).trim());
  let alive = false; try { process.kill(pid, 0); alive = true; } catch {}
  if (alive) { console.error(`이미 실행 중 (pid ${pid})`); process.exit(1); }
}
await writeFile(LOCK, String(process.pid));
const unlock = () => { try { unlinkSync(LOCK); } catch {} };
process.on('exit', unlock);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { unlock(); process.exit(1); });

const OUT = path.join(import.meta.dirname, 'results.json');
const out = { experiment: 'c7-real-initial-load', generatedAt: new Date().toISOString(),
              repeat: REPEAT, sites: SITES, method: '캐시 데운 뒤 2차 로드 측정 · cv 는 문서 시작 시점 주입',
              isolation: 'strict', order: 'shuffled', rows: [] };
const save = () => writeFile(OUT, JSON.stringify(out, null, 2));
if (arg('resume', '0') === '1' && existsSync(OUT)) {
  out.rows = (JSON.parse(await readFile(OUT, 'utf8')).rows) || [];
  console.log(`↻ 재개: ${out.rows.length}건 보유`);
}

const keys = ONLY === 'all' ? Object.keys(SITES) : [ONLY];
const plan = [];
for (const k of keys) for (const m of MODES) for (let r = 0; r < REPEAT; r++) plan.push({ siteKey: k, mode: m, rep: r });
const order = shuffled(plan, SEED);
const BASELINE = await chromeCount();
console.log(`\n초기 로드 측정 — 사이트 ${keys.length}곳 · 설정마다 ${REPEAT}회 · 총 ${order.length}회 측정`);
console.log(`(측정마다 캐시 데우기 1회 + 측정 1회 = 실제 로드 ${order.length * 2}회)`);
console.log(`기준선 chrome ${BASELINE}개 · 순서 섞음\n`);

let port = 39000 + Math.floor(Math.random() * 300);
let i = 0;
for (const job of order) {
  i++;
  const key = `${job.siteKey}|${job.mode}|${job.rep}`;
  if (out.rows.some(r => `${r.siteKey}|${r.mode}|${r.rep}` === key)) continue;
  await waitQuiet(BASELINE);
  port++;
  try {
    const v = await once({ port, tag: `${job.siteKey}-${job.mode}-${job.rep}`, ...job });
    out.rows.push({ ...v, rep: job.rep });
    await save();
    console.log(`  ${String(i).padStart(2)}/${order.length}  ${job.siteKey.padEnd(11)}${job.mode.padEnd(9)}` +
      `FCP ${String(v.fcpMs ?? '-').padStart(6)}  LCP ${String(v.lcpMs ?? '-').padStart(6)}` +
      `  Layout ${String(v.stage.Layout.ms).padStart(7)}  Style ${String(v.stage.UpdateLayoutTree.ms).padStart(7)}` +
      (v.mode === 'cv-auto' ? `  주입 ${v.cvApplied ? 'OK' : '❌'}` : ''));
  } catch (e) {
    console.error(`  ${i}/${order.length} 실패 (${key}): ${e.message}`);
  }
}
await save();
console.log('\n✅ results.json 저장 —  node analyze.mjs');
process.exit(0);
