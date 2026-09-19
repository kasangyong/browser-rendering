/**
 * C8g — A 를 제대로 잰다
 *
 * C8f 는 셀당 3회였고, '준비' 를 rAF 폴링으로 잡았다.
 * 그 창에 프레임이 7개뿐이라 폴링 해상도가 100ms 를 넘어 A 를 과소평가한다.
 *
 * 여기서는 전부 트레이스 타임스탬프로 잡는다:
 *
 *   ResourceFinish(배너) → PaintImage(배너) → LargestImagePaint::Candidate
 *          └────────── A ──────────┘└──────── B ────────┘
 *
 * 그리고 시간과 함께 횟수를 센다 — A 구간 안의 Paint 횟수 · Layout 횟수 ·
 * 메인 스레드 점유 ms. C8f 에서 Paint 가 Layout 의 1/5 밖에 안 돈다는 걸
 * 횟수로 봐서 알았다.
 *
 * 배너는 파일명 토큰으로 args 를 훑어 찾는다 — 선택자를 추측하지 않는다.
 * 콜드 캐시 · 순서 섞음 · 엄격 격리 · 체크포인트.
 *
 * 사전 등록: PREDICTION.md 부칙 5 (V1~V4)
 * 사용: node measure-paintwait.mjs [--repeat=20] [--site=all|uk|philippines] [--resume=1]
 */
import { spawn, execFile } from 'node:child_process';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const arg = (n, d) => {
  const m = process.argv.find(a => a.startsWith(`--${n}=`));
  return m ? m.split('=')[1] : d;
};
const REPEAT = Number(arg('repeat', '20'));
const SEED = Number(arg('seed', '20260920'));
const ONLY = arg('site', 'all');
const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';

const SITES = {
  uk:          { url: 'https://en.wikivoyage.org/wiki/United_Kingdom', intrinsic: 182 },
  philippines: { url: 'https://en.wikivoyage.org/wiki/Philippines', intrinsic: 182 },
};
const BLOCKS = '.mw-parser-output section > *';
const MODES = ['plain', 'cv-auto'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
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
    if ((await chromeCount()) <= baseline) { await sleep(2500); return; }
    await sleep(500);
  }
  await sleep(2500);
}

/** LCP 항목만 받는다. 배너 식별은 트레이스 쪽에서 한다. */
const OBS = '<script>try{performance.setResourceTimingBufferSize(3000)}catch(x){}' +
  '(function(){window.__lcp=null;try{new PerformanceObserver(function(l){' +
  'l.getEntries().forEach(function(e){window.__lcp={t:+e.startTime.toFixed(1),' +
  'size:e.size,u:e.url||""};});}).observe({type:"largest-contentful-paint",' +
  'buffered:true});}catch(x){}})()</script>';

const REPORT = `(() => {
  const L = window.__lcp;
  const r = L && L.u ? performance.getEntriesByType('resource').find(x => x.name === L.u) : null;
  return { lcp: L,
    res: r ? { start: +r.startTime.toFixed(1), end: +r.responseEnd.toFixed(1) } : null,
    applied: !!document.getElementById('__c8g'),
    fcp: (performance.getEntriesByType('paint').find(x => x.name === 'first-contentful-paint') || {}).startTime ?? null };
})()`;

async function once({ port, tag, siteKey, mode }) {
  const S = SITES[siteKey];
  const profile = path.join(SCRATCH, `c8g-${tag}`);
  await mkdir(profile, { recursive: true });
  const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--hide-scrollbars', '--window-size=390,844', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { await sleep(300);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {} }
  try {
    const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('WS 실패')), { once: true });
    });
    let id = 0; const pend = new Map(); const handlers = new Map(); let loaded;
    const onLoad = new Promise(r => { loaded = r; });
    ws.addEventListener('message', e => { const m = JSON.parse(e.data);
      if (m.id !== undefined) { const p = pend.get(m.id); pend.delete(m.id); p && p(m.result); }
      else if (m.method === 'Page.loadEventFired') loaded();
      else { const h = handlers.get(m.method); if (h) h(m.params); } });
    const send = (method, params = {}) => { const i = ++id;
      ws.send(JSON.stringify({ id: i, method, params }));
      return new Promise(r => { const to = setTimeout(() => { pend.delete(i); r(null); }, 90000);
        pend.set(i, v => { clearTimeout(to); r(v); }); }); };

    await send('Page.enable'); await send('Runtime.enable');
    await send('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Response', resourceType: 'Document' }] });
    handlers.set('Fetch.requestPaused', async p => {
      try {
        const body = await send('Fetch.getResponseBody', { requestId: p.requestId });
        let html = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
        const css = mode === 'cv-auto'
          ? `<style id="__c8g">${BLOCKS}{content-visibility:auto;contain-intrinsic-size:auto ${S.intrinsic}px}</style>`
          : '<style id="__c8g"></style>';
        const m = html.match(/<head[^>]*>/i);
        html = m ? html.replace(m[0], m[0] + css + OBS) : css + OBS + html;
        await send('Fetch.fulfillRequest', { requestId: p.requestId,
          responseCode: p.responseStatusCode ?? 200, responseHeaders: p.responseHeaders,
          body: Buffer.from(html, 'utf8').toString('base64') });
      } catch { await send('Fetch.continueRequest', { requestId: p.requestId }); }
    });

    const evs = [];
    handlers.set('Tracing.dataCollected', p => { if (p.value) evs.push(...p.value); });
    const done = new Promise(r => handlers.set('Tracing.tracingComplete', r));
    await send('Tracing.start', { transferMode: 'ReportEvents',
      traceConfig: { recordMode: 'recordAsMuchAsPossible',
        includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline',
                             'blink.user_timing', 'loading', 'toplevel'] } });
    await sleep(200);
    await send('Page.navigate', { url: S.url });
    await Promise.race([onLoad, sleep(60000)]);
    await sleep(4000);
    await send('Tracing.end');
    await Promise.race([done, sleep(90000)]);

    const rr = await send('Runtime.evaluate', { expression: REPORT, returnByValue: true, awaitPromise: true });
    await send('Browser.close').catch(() => {});
    if (!rr) throw new Error('Runtime.evaluate 응답 없음');
    const v = rr.result?.value ?? {};
    if (!v.lcp?.u) throw new Error('LCP 이미지 항목 없음');

    let nav = null;
    for (const e of evs) if (e.name === 'navigationStart' && nav === null) nav = e.ts;
    if (nav === null) throw new Error('navigationStart 없음');
    const rel = e => (e.ts - nav) / 1000;

    // 배너를 파일명 토큰으로 찾는다
    const file = decodeURIComponent(v.lcp.u.split('?')[0].split('/').pop() || '');
    const token = file.replace(/^\d+px-/, '').slice(0, 26);
    let finishT = null, paintT = null, candT = null, respT = null;
    for (const e of evs) {
      if (!e.args) continue;
      let j; try { j = JSON.stringify(e.args); } catch { continue; }
      if (!j.includes(token)) continue;
      const t = rel(e);
      if (e.name === 'ResourceFinish' && finishT === null) finishT = t;
      if (e.name === 'ResourceReceiveResponse' && respT === null) respT = t;
      if (e.name === 'PaintImage' && paintT === null) paintT = t;
      if (e.name.includes('Candidate') && (candT === null || t > candT)) candT = t;
    }
    // ResourceFinish 가 없으면 리소스 타이밍의 responseEnd 로 대신한다
    const start = finishT ?? respT ?? v.res?.end ?? null;
    if (start === null || paintT === null) throw new Error(`배너 이벤트 부족 (finish=${finishT} paint=${paintT})`);

    // 렌더러 메인 스레드 = ParseHTML·Layout 이 도는 스레드
    const mark = new Map();
    for (const e of evs) {
      if (!['ParseHTML', 'Layout', 'UpdateLayoutTree'].includes(e.name)) continue;
      const k = e.pid + ':' + e.tid; mark.set(k, (mark.get(k) || 0) + 1);
    }
    let mainTid = null, best = 0;
    for (const [k, n] of mark) if (n > best) { best = n; mainTid = k; }
    if (!mainTid) throw new Error('렌더러 메인 스레드를 못 찾음');

    const W0 = start, W1 = paintT;
    const ov = e => { const s = rel(e), en = s + (e.dur || 0) / 1000;
      return Math.max(0, Math.min(en, W1) - Math.max(s, W0)); };
    const inside = e => { const s = rel(e); return s >= W0 && s <= W1; };

    let busy = 0, paintN = 0, layoutN = 0, layoutMs = 0, styleMs = 0, rasterN = 0;
    let loadLayoutMs = 0;                       // 로드 전체(navigationStart → LCP)의 Layout
    for (const e of evs) {
      const onMain = e.pid + ':' + e.tid === mainTid;
      if (e.name === 'RunTask' && onMain && typeof e.dur === 'number') busy += ov(e);
      if (!onMain) { if (e.name === 'RasterTask' && inside(e)) rasterN++; continue; }
      if (e.name === 'Paint' && inside(e)) paintN++;
      if (e.name === 'Layout') {
        if (inside(e)) { layoutN++; layoutMs += (e.dur || 0) / 1000; }
        if (rel(e) <= (v.lcp.t ?? W1)) loadLayoutMs += (e.dur || 0) / 1000;
      }
      if (e.name === 'UpdateLayoutTree' && inside(e)) styleMs += (e.dur || 0) / 1000;
      if (e.name === 'RasterTask' && inside(e)) rasterN++;
    }
    const A = +(paintT - start).toFixed(1);
    return {
      siteKey, mode,
      fcpMs: v.fcp != null ? +v.fcp.toFixed(1) : null,
      lcpMs: v.lcp.t, lcpSize: v.lcp.size,
      resEnd: v.res ? v.res.end : null,
      finishT: finishT != null ? +finishT.toFixed(1) : null,
      paintT: +paintT.toFixed(1), candT: candT != null ? +candT.toFixed(1) : null,
      A, B: candT != null ? +(candT - paintT).toFixed(1) : null,
      paintN, layoutN, rasterN,
      layoutMs: +layoutMs.toFixed(1), styleMs: +styleMs.toFixed(1),
      mainBusy: +busy.toFixed(1), busyPct: A > 0 ? +(100 * busy / A).toFixed(0) : null,
      loadLayoutMs: +loadLayoutMs.toFixed(1),
      cvApplied: mode === 'cv-auto' ? !!v.applied : null,
      events: evs.length,
    };
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    try { await rm(profile, { recursive: true, force: true }); } catch {}
  }
}

const LOCK = path.join(import.meta.dirname, '.paintwait.lock');
if (existsSync(LOCK)) {
  const pid = Number((await readFile(LOCK, 'utf8')).trim());
  let alive = false; try { process.kill(pid, 0); alive = true; } catch {}
  if (alive) { console.error(`이미 실행 중 (pid ${pid})`); process.exit(1); }
}
await writeFile(LOCK, String(process.pid));
const unlock = () => { try { unlinkSync(LOCK); } catch {} };
process.on('exit', unlock);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { unlock(); process.exit(1); });

const OUT = path.join(import.meta.dirname, 'results-paintwait.json');
const out = { experiment: 'c8g-paint-wait', generatedAt: new Date().toISOString(),
              repeat: REPEAT, sites: SITES,
              method: '트레이스 타임스탬프로 ResourceFinish → PaintImage → LCP후보 를 잡고, A 구간 안의 횟수와 메인 스레드 점유를 같이 센다',
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
console.log(`\nC8g A 측정 — ${keys.length}곳 × ${MODES.length}모드 × ${REPEAT}회 = ${order.length}회`);
console.log(`기준선 chrome ${BASELINE}개 · 순서 섞음 · 콜드 캐시\n`);

let port = 53000 + Math.floor(Math.random() * 300);
let i = 0, fail = 0;
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
    console.log(`  ${String(i).padStart(3)}/${order.length}  ${job.siteKey.padEnd(12)}${job.mode.padEnd(9)}` +
      `A ${String(v.A).padStart(7)}  B ${String(v.B ?? '-').padStart(6)}  │ Paint ${String(v.paintN).padStart(3)}회` +
      `  Layout ${String(v.layoutN).padStart(3)}회 ${String(v.layoutMs).padStart(6)}ms` +
      `  메인점유 ${String(v.busyPct ?? '-').padStart(3)}%  │ LCP ${String(v.lcpMs).padStart(7)}`);
  } catch (e) {
    fail++;
    console.error(`  ${i}/${order.length} 실패 (${key}): ${e.message}`);
  }
}
await save();
console.log(`\n✅ results-paintwait.json — ${out.rows.length}행 · 실패 ${fail}건`);
process.exit(0);
