/**
 * C8o — cv 가 첫 페인트에 까는 바닥은 무엇이 정하나
 *
 * C8n: cv FCP 는 524~776ms(1.5배)로 plain FCP(300~800ms, 2.7배)보다 안정적이다.
 * 그 바닥값을 무엇이 정하는지 2곳으로는 못 봤다. 8곳으로 늘린다.
 *
 * FCP 는 LCP 와 무관하므로 "이미지 LCP" 조건이 필요 없다 — 후보가 넓어진다.
 * DOM 수와 블록 수가 서로 안 묶인 8곳을 골랐다(r = 0.53).
 * Buffalo(DOM 12,517·블록 447)와 India(DOM 7,656·블록 954)가 두 예측자를 가른다.
 *
 * warm 캐시 · 8곳 × 2모드 × 5회 = 80회.
 *
 * 사전 등록: PREDICTION.md 부칙 9 (Z1~Z4)
 * 사용: node probe-floor.mjs [--repeat=5] [--resume=1]
 */
import { spawn, execFile } from 'node:child_process';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const arg = (n, d) => {
  const m = process.argv.find(a => a.startsWith(`--${n}=`));
  return m ? m.split('=')[1] : d;
};
const REPEAT = Number(arg('repeat', '5'));
const SEED = Number(arg('seed', '20260920'));
const ONLY = arg('site', 'all');
const WARM = true;   // 이 실험은 항상 warm — 네트워크를 빼야 선행 비용이 보인다
const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';

const SITES = {
  interstate: { url: 'https://en.wikivoyage.org/wiki/Interstate_5', intrinsic: 64 },
  e8:         { url: 'https://en.wikivoyage.org/wiki/E8_through_Finland_and_Norway', intrinsic: 182 },
  eurovelo:   { url: 'https://en.wikivoyage.org/wiki/EuroVelo_10', intrinsic: 156 },
  uk:         { url: 'https://en.wikivoyage.org/wiki/United_Kingdom', intrinsic: 182 },
  india:      { url: 'https://en.wikivoyage.org/wiki/India', intrinsic: 182 },
  buffaloE:   { url: 'https://en.wikivoyage.org/wiki/Buffalo/East_Side', intrinsic: 234 },
  london:     { url: 'https://en.wikivoyage.org/wiki/London', intrinsic: 182 },
  turku:      { url: 'https://en.wikivoyage.org/wiki/Turku', intrinsic: 202 },
};

const BLOCKS = '.mw-parser-output section > *';
const MODES = ['plain', 'cv-all'];
/** K 개 섹션까지만 건다. 중첩 섹션마다 걸리므로 실제 개수는 따로 잰다. */
const SEL = {
  'cv-k2':  '.mw-parser-output section:nth-of-type(-n+2) > *',
  'cv-k5':  '.mw-parser-output section:nth-of-type(-n+5) > *',
  'cv-k10': '.mw-parser-output section:nth-of-type(-n+10) > *',
  'cv-all': '.mw-parser-output section > *',
};

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
    applied: !!document.getElementById('__c8k'),
    matched: window.__sel ? document.querySelectorAll(window.__sel).length : 0,
    dcl: (() => { const n = performance.getEntriesByType('navigation')[0];
      return n ? +n.domContentLoadedEventStart.toFixed(1) : null; })(),
    domNodes: document.querySelectorAll('*').length,
    fcp: (performance.getEntriesByType('paint').find(x => x.name === 'first-contentful-paint') || {}).startTime ?? null };
})()`;

async function once({ port, tag, siteKey, mode }) {
  const S = SITES[siteKey];
  const profile = path.join(SCRATCH, `c8o-${tag}`);
  await mkdir(profile, { recursive: true });
  const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--hide-scrollbars', '--window-size=390,844', 'about:blank'], { stdio: 'ignore' });
  // C2 에서 겪은 것: 기동이 가끔 안 붙는다. 여기 처음 돌렸을 때 60회 중 24회가
  // 'fetch failed' 로 날아갔다(한 셀은 2/10). 기다리는 시간을 늘리고 한 번 더 띄운다.
  let up = false;
  for (let i = 0; i < 100; i++) { await sleep(300);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) { up = true; break; } } catch {} }
  if (!up) throw new Error(`Chrome 기동 실패 (port ${port})`);
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
        const rule = SEL[mode]
          ? `${SEL[mode]}{content-visibility:auto;contain-intrinsic-size:auto ${S.intrinsic}px}`
          : '';
        const css = `<style id="__c8k">${rule}</style>`;
        const m = html.match(/<head[^>]*>/i);
        const tell = `<script>window.__sel=${JSON.stringify(SEL[mode] || BLOCKS)}</scr`+`ipt>`;
        html = m ? html.replace(m[0], m[0] + css + tell + OBS) : css + tell + OBS + html;
        await send('Fetch.fulfillRequest', { requestId: p.requestId,
          responseCode: p.responseStatusCode ?? 200, responseHeaders: p.responseHeaders,
          body: Buffer.from(html, 'utf8').toString('base64') });
      } catch { await send('Fetch.continueRequest', { requestId: p.requestId }); }
    });

    // 캐시 데우기 — 측정 안 함. 주입은 양쪽 로드에 동일하게 걸린다.
    if (WARM) {
      const wl = new Promise(r => { const prev = loaded; loaded = () => { prev(); r(); }; });
      await send('Page.navigate', { url: S.url });
      await Promise.race([wl, sleep(60000)]);
      await sleep(2500);
    }

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
    // 이 실험은 FCP 바닥을 보는 것이라 LCP 가 이미지일 필요가 없다.
    // (C8g 계보에서 딸려온 검사였고, 텍스트 LCP 인 Interstate 5 가 통째로 날아갔다.)
    if (!v.lcp) throw new Error('LCP 항목 없음');

    let nav = null;
    for (const e of evs) if (e.name === 'navigationStart' && nav === null) nav = e.ts;
    if (nav === null) throw new Error('navigationStart 없음');
    const rel = e => (e.ts - nav) / 1000;

    // 배너를 파일명 토큰으로 찾는다
    // 이미지 LCP 일 때만 배너 타임라인을 잡는다
    const file = v.lcp.u ? decodeURIComponent(v.lcp.u.split('?')[0].split('/').pop() || '') : '';
    const token = file ? file.replace(/^\d+px-/, '').slice(0, 26) : null;
    let finishT = null, paintT = null, candT = null, respT = null;
    for (const e of evs) {
      if (!token || !e.args) continue;
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
    const hasBanner = start !== null && paintT !== null;   // 없으면 A·B 만 비운다

    // 렌더러 메인 스레드 = ParseHTML·Layout 이 도는 스레드
    const mark = new Map();
    for (const e of evs) {
      if (!['ParseHTML', 'Layout', 'UpdateLayoutTree'].includes(e.name)) continue;
      const k = e.pid + ':' + e.tid; mark.set(k, (mark.get(k) || 0) + 1);
    }
    let mainTid = null, best = 0;
    for (const [k, n] of mark) if (n > best) { best = n; mainTid = k; }
    if (!mainTid) throw new Error('렌더러 메인 스레드를 못 찾음');

    const W0 = hasBanner ? start : 0, W1 = hasBanner ? paintT : 0;
    const ov = e => { const s = rel(e), en = s + (e.dur || 0) / 1000;
      return Math.max(0, Math.min(en, W1) - Math.max(s, W0)); };
    const inside = e => { const s = rel(e); return s >= W0 && s <= W1; };

    // FCP 이전 구간 (C8k~C8m 과 비교용으로 계속 남긴다)
    const pre = { ParseHTML: 0, UpdateLayoutTree: 0, Layout: 0, PrePaint: 0, Paint: 0,
                  EvaluateScript: 0, FunctionCall: 0, ParseAuthorStyleSheet: 0 };
    const preN = { ParseHTML: 0, UpdateLayoutTree: 0, Layout: 0, PrePaint: 0, Paint: 0 };
    // DCL 까지의 구간 — 이 실험의 본체. 두 팔 모두 문서를 끝까지 파싱한 같은 지점이다.
    const dclS = { ParseHTML: 0, UpdateLayoutTree: 0, Layout: 0, PrePaint: 0, Paint: 0,
                   EvaluateScript: 0, FunctionCall: 0 };
    const dclN = { Layout: 0, UpdateLayoutTree: 0, Paint: 0 };
    const FCP = v.fcp ?? 0;
    const DCL = v.dcl ?? 0;
    for (const e of evs) {
      if (e.pid + ':' + e.tid !== mainTid || typeof e.dur !== 'number') continue;
      const t = rel(e);
      if (t <= FCP) {
        if (pre[e.name] !== undefined) pre[e.name] += e.dur / 1000;
        if (preN[e.name] !== undefined) preN[e.name]++;
      }
      if (DCL && t <= DCL) {
        if (dclS[e.name] !== undefined) dclS[e.name] += e.dur / 1000;
        if (dclN[e.name] !== undefined) dclN[e.name]++;
      }
    }
    for (const k of Object.keys(pre)) pre[k] = +pre[k].toFixed(1);
    for (const k of Object.keys(dclS)) dclS[k] = +dclS[k].toFixed(1);

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
    const A = hasBanner ? +(paintT - start).toFixed(1) : null;
    return {
      siteKey, mode,
      fcpMs: v.fcp != null ? +v.fcp.toFixed(1) : null,
      lcpMs: v.lcp.t, lcpSize: v.lcp.size,
      resEnd: v.res ? v.res.end : null,
      finishT: finishT != null ? +finishT.toFixed(1) : null,
      paintT: hasBanner ? +paintT.toFixed(1) : null, candT: candT != null ? +candT.toFixed(1) : null,
      A, B: hasBanner && candT != null ? +(candT - paintT).toFixed(1) : null,
      lcpIsImg: !!v.lcp.u,
      paintN, layoutN, rasterN,
      layoutMs: +layoutMs.toFixed(1), styleMs: +styleMs.toFixed(1),
      mainBusy: +busy.toFixed(1), busyPct: A > 0 ? +(100 * busy / A).toFixed(0) : null,
      loadLayoutMs: +loadLayoutMs.toFixed(1), pre, preN, matched: v.matched ?? 0,
      dcl: v.dcl, domNodes: v.domNodes, dclS, dclN,
      cvApplied: mode === 'plain' ? null : !!v.applied,
      events: evs.length,
    };
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    try { await rm(profile, { recursive: true, force: true }); } catch {}
  }
}

const LOCK = path.join(import.meta.dirname, '.floor.lock');
if (existsSync(LOCK)) {
  const pid = Number((await readFile(LOCK, 'utf8')).trim());
  let alive = false; try { process.kill(pid, 0); alive = true; } catch {}
  if (alive) { console.error(`이미 실행 중 (pid ${pid})`); process.exit(1); }
}
await writeFile(LOCK, String(process.pid));
const unlock = () => { try { unlinkSync(LOCK); } catch {} };
process.on('exit', unlock);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { unlock(); process.exit(1); });

const OUT = path.join(import.meta.dirname, 'results-floor.json');
const out = { experiment: 'c8o-fcp-floor', generatedAt: new Date().toISOString(),
              repeat: REPEAT, sites: SITES,
              warm: WARM,
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
console.log(`\nC8o FCP 바닥 — ${keys.length}곳 × ${MODES.length}모드 × ${REPEAT}회 = ${order.length}회`);
console.log(`기준선 chrome ${BASELINE}개 · 순서 섞음 · ${WARM ? '캐시 데운 뒤 2차 로드' : '콜드 캐시'}\n`);

let port = 40400 + Math.floor(Math.random() * 200);   // 임시 포트 범위(49152+)를 피한다
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
    console.log(`  ${String(i).padStart(3)}/${order.length}  ${job.siteKey.padEnd(11)}${job.mode.padEnd(10)}` +
      `A ${String(v.A ?? '-').padStart(7)}  B ${String(v.B ?? '-').padStart(6)}  │ Paint ${String(v.paintN).padStart(3)}회` +
      `  Layout ${String(v.layoutN).padStart(3)}회 ${String(v.layoutMs).padStart(6)}ms` +
      `  │ cv요소 ${String(v.matched).padStart(4)}  FCP ${String(v.fcpMs).padStart(6)}  DCL ${String(v.dcl).padStart(6)}` +
      `  DCL까지 Parse ${String(v.dclS.ParseHTML).padStart(6)} Layout ${String(v.dclS.Layout).padStart(7)}` +
      `  전Style ${String(v.pre.UpdateLayoutTree).padStart(6)}  전Layout ${String(v.pre.Layout).padStart(6)}` +
      `  전JS ${String((v.pre.EvaluateScript + v.pre.FunctionCall).toFixed(1)).padStart(6)}`);
  } catch (e) {
    console.error(`  ${i}/${order.length} 1차 실패 (${key}): ${e.message} — 한 번 더`);
    await waitQuiet(BASELINE);
    port += 7;
    try {
      const v = await once({ port, tag: `${job.siteKey}-${job.mode}-${job.rep}r`, ...job });
      out.rows.push({ ...v, rep: job.rep, retried: true });
      await save();
      console.log(`  ${String(i).padStart(3)}/${order.length}  ${job.siteKey.padEnd(11)}${job.mode.padEnd(10)}` +
        `재시도 성공  FCP ${String(v.fcpMs).padStart(6)}  전Layout ${String(v.pre.Layout).padStart(6)}`);
    } catch (e2) {
      fail++;
      console.error(`  ${i}/${order.length} 재시도도 실패 (${key}): ${e2.message}`);
    }
  }
}
await save();
console.log(`\n✅ ${path.basename(OUT)} — ${out.rows.length}행 · 실패 ${fail}건`);
process.exit(0);
