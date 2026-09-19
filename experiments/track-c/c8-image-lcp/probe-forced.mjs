/**
 * C8h — Layout 은 왜 Paint 보다 3~5배 자주 도는가
 *
 * C8f·C8g 에서 A 구간 안의 횟수가 이랬다:
 *   Layout 29~38회 · Paint 6~12회 · 메인 스레드 점유 99~100%
 *
 * 1차 가설(JS 가 강제로 부르는 동기 레이아웃)은 **반증됐다.**
 * JS 가 감싼 Layout 은 매번 정확히 6회뿐이고 전부 FireIdleCallback 이었다.
 * 나머지 20~32회는 JS 밖에서 돈다.
 *
 * 그래서 기준을 바꾼다: 각 Layout 을 감싸는 **최상위 RunTask** 를 찾아
 * 그 태스크가 Paint 까지 갔는지로 가른다.
 *
 *   페인트까지 간 태스크의 Layout   → 프레임을 낳은 레이아웃
 *   페인트 없이 끝난 태스크의 Layout → 화면에 아무것도 안 남기는 레이아웃
 *
 * 그리고 그 태스크가 무엇으로 시작했는지(ParseHTML · ResourceReceiveData ·
 * FunctionCall · TimerFire · FireIdleCallback …)를 같이 센다.
 *
 * 콜드 캐시 · 2곳 × plain/cv-auto × 3회 = 12회. 읽기만 한다.
 * 사용: node probe-forced.mjs [--reps=3]
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const REPS = Number((process.argv.find(a => a.startsWith('--reps=')) || '--reps=3').split('=')[1]);

const SITES = {
  uk:          { url: 'https://en.wikivoyage.org/wiki/United_Kingdom', intrinsic: 182 },
  philippines: { url: 'https://en.wikivoyage.org/wiki/Philippines', intrinsic: 182 },
};
const BLOCKS = '.mw-parser-output section > *';
const MODES = ['plain', 'cv-auto'];
/** 이 중 하나가 Layout 을 감싸고 있으면 JS 가 강제로 부른 것이다. */
const JS_WRAP = new Set(['FunctionCall', 'EvaluateScript', 'TimerFire', 'FireIdleCallback',
                         'XHRReadyStateChange', 'EventDispatch', 'v8.callFunction', 'v8.run']);

const OBS = '<script>try{performance.setResourceTimingBufferSize(3000)}catch(x){}' +
  '(function(){window.__lcp=null;try{new PerformanceObserver(function(l){' +
  'l.getEntries().forEach(function(e){window.__lcp={t:+e.startTime.toFixed(1),' +
  'size:e.size,u:e.url||""};});}).observe({type:"largest-contentful-paint",' +
  'buffered:true});}catch(x){}})()</script>';

const REPORT = `(() => {
  const L = window.__lcp;
  const r = L && L.u ? performance.getEntriesByType('resource').find(x => x.name === L.u) : null;
  return { lcp: L, res: r ? { end: +r.responseEnd.toFixed(1) } : null };
})()`;

async function run(siteKey, mode, rep, port) {
  const S = SITES[siteKey];
  const profile = path.join(SCRATCH, `c8h-${siteKey}-${mode}-${rep}`);
  await mkdir(profile, { recursive: true });
  const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars',
    '--window-size=390,844', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { await sleep(300);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {} }
  try {
    const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r, { once: true }));
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
          ? `<style id="__c8h">${BLOCKS}{content-visibility:auto;contain-intrinsic-size:auto ${S.intrinsic}px}</style>`
          : '<style id="__c8h"></style>';
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

    const file = decodeURIComponent(v.lcp.u.split('?')[0].split('/').pop() || '');
    const token = file.replace(/^\d+px-/, '').slice(0, 26);
    let finishT = null, paintT = null;
    for (const e of evs) {
      if (!e.args) continue;
      let j; try { j = JSON.stringify(e.args); } catch { continue; }
      if (!j.includes(token)) continue;
      if (e.name === 'ResourceFinish' && finishT === null) finishT = rel(e);
      if (e.name === 'PaintImage' && paintT === null) paintT = rel(e);
    }
    if (finishT === null) finishT = v.res?.end ?? null;
    if (finishT === null || paintT === null) throw new Error('배너 이벤트 부족');

    const mark = new Map();
    for (const e of evs) {
      if (!['ParseHTML', 'Layout', 'UpdateLayoutTree'].includes(e.name)) continue;
      const k = e.pid + ':' + e.tid; mark.set(k, (mark.get(k) || 0) + 1);
    }
    let mainTid = null, best = 0;
    for (const [k, n] of mark) if (n > best) { best = n; mainTid = k; }
    if (!mainTid) throw new Error('렌더러 메인 스레드를 못 찾음');

    const onMain = e => e.pid + ':' + e.tid === mainTid;
    const main = evs.filter(e => onMain(e) && typeof e.dur === 'number')
      .map(e => ({ name: e.name, s: rel(e), e: rel(e) + e.dur / 1000, dur: e.dur / 1000, args: e.args }));
    const W0 = finishT, W1 = paintT;
    const inWin = x => x.s >= W0 && x.s <= W1;

    const wraps = main.filter(x => JS_WRAP.has(x.name));
    /** 이 이벤트를 완전히 감싸는 JS 이벤트가 있나 */
    const wrappedBy = x => wraps.find(w => w !== x && w.s <= x.s + 0.001 && w.e >= x.e - 0.001);

    const layouts = main.filter(x => x.name === 'Layout' && inWin(x));
    const paints = main.filter(x => x.name === 'Paint' && inWin(x));
    let forced = 0, forcedMs = 0, lifecycle = 0, lifecycleMs = 0;
    const callers = new Map();
    for (const L of layouts) {
      const w = wrappedBy(L);
      if (w) {
        forced++; forcedMs += L.dur;
        const u = w.args?.data?.url || w.args?.data?.functionName || w.name;
        const key = String(u).split('/').pop().slice(0, 42);
        const c = callers.get(key) || { n: 0, ms: 0 };
        c.n++; c.ms += L.dur; callers.set(key, c);
      } else { lifecycle++; lifecycleMs += L.dur; }
    }

    // 2차 기준: 각 Layout 을 감싸는 최상위 RunTask 가 Paint 까지 갔는가.
    // 1차 기준(JS 가 감쌌나)은 반증됐다 — 6회뿐이었다.
    const tasks = main.filter(x => x.name === 'RunTask');
    const encl = x => tasks.find(t => t.s <= x.s + 0.001 && t.e >= x.e - 0.001);
    const TRIGGER = ['ParseHTML', 'ResourceReceiveData', 'ResourceReceiveResponse', 'ResourceFinish',
                     'FunctionCall', 'EvaluateScript', 'TimerFire', 'FireIdleCallback',
                     'FireAnimationFrame', 'EventDispatch', 'ParseAuthorStyleSheet'];
    const taskOf = new Map();
    for (const t of tasks) taskOf.set(t.s + ':' + t.e, { paint: false, layout: 0, trig: null });
    for (const P of paints) { const t = encl(P); if (t) taskOf.get(t.s + ':' + t.e).paint = true; }
    for (const L of layouts) { const t = encl(L); if (t) taskOf.get(t.s + ':' + t.e).layout++; }
    for (const e of main) {
      if (!TRIGGER.includes(e.name)) continue;
      const t = encl(e); if (!t) continue;
      const rec = taskOf.get(t.s + ':' + t.e);
      if (rec && rec.trig === null) rec.trig = e.name;
    }
    let painted = 0, unpainted = 0;
    const trigN = new Map();
    for (const [, rec] of taskOf) {
      if (!rec.layout) continue;
      if (rec.paint) painted += rec.layout; else unpainted += rec.layout;
      const key = (rec.paint ? '페인트○ ' : '페인트✗ ') + (rec.trig ?? '(없음)');
      trigN.set(key, (trigN.get(key) || 0) + rec.layout);
    }
    const longTasks = main.filter(x => x.name === 'RunTask' && inWin(x) && x.dur >= 50);
    return {
      siteKey, mode, rep, A: +(W1 - W0).toFixed(1),
      layoutN: layouts.length, paintN: paints.length,
      forced, forcedMs: +forcedMs.toFixed(1), lifecycle, lifecycleMs: +lifecycleMs.toFixed(1),
      paintsWrapped: paints.filter(p => wrappedBy(p)).length,
      painted, unpainted,
      trig: [...trigN.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, n]) => ({ k, n })),
      longTaskN: longTasks.length, longTaskMs: +longTasks.reduce((a, b) => a + b.dur, 0).toFixed(1),
      maxTask: longTasks.length ? +Math.max(...longTasks.map(x => x.dur)).toFixed(1) : 0,
      callers: [...callers.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 5)
        .map(([k, c]) => ({ who: k, n: c.n, ms: +c.ms.toFixed(1) })),
    };
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    await sleep(700);
    try { await rm(profile, { recursive: true, force: true }); } catch {}
  }
}

const out = [];
let port = 54000;
const plan = [];
for (const k of Object.keys(SITES)) for (const m of MODES) for (let r = 0; r < REPS; r++) plan.push({ k, m, r });
let seed = 777;
for (let i = plan.length - 1; i > 0; i--) {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  const j = Math.floor((seed / 0x7fffffff) * (i + 1));
  [plan[i], plan[j]] = [plan[j], plan[i]];
}
console.log('\nC8h — A 구간 안 Layout 을 강제/수명주기로 가른다  (' + plan.length + '회)\n');
console.log('  사이트        모드      A      Layout  강제 / 수명주기      Paint  긴태스크(≥50ms)');
console.log('  ' + '─'.repeat(88));
for (const job of plan) {
  try {
    const r = await run(job.k, job.m, job.r, port++);
    out.push(r);
    console.log(`  ${job.k.padEnd(13)}${job.m.padEnd(9)}${String(r.A).padStart(7)}` +
      String(r.layoutN).padStart(9) + `  ${String(r.forced).padStart(3)} / ${String(r.lifecycle).padStart(3)}` +
      `   (${String(r.forcedMs).padStart(6)}ms / ${String(r.lifecycleMs).padStart(6)}ms)` +
      String(r.paintN).padStart(6) + `   ${r.longTaskN}개 ${r.longTaskMs}ms 최대 ${r.maxTask}ms`);
    console.log(`     페인트까지 간 태스크의 Layout ${r.painted}회 / 페인트 없이 끝난 태스크 ${r.unpainted}회` +
      (r.callers.length ? `   (JS 가 감싼 것 ${r.forced}회: ` + r.callers.map(c => `${c.who}`).join(',') + ')' : ''));
    console.log('     태스크 시작 이벤트별: ' + r.trig.map(t => `${t.k} ${t.n}`).join(' · '));
  } catch (e) { console.log(`  ${job.k} ${job.m} #${job.r} 실패: ${e.message}`); }
  await sleep(1500);
}
await writeFile(new URL('./forced.json', import.meta.url), JSON.stringify({
  note: 'A 구간 안 Layout 을 JS 강제 레이아웃과 수명주기 레이아웃으로 가른다',
  generatedAt: new Date().toISOString(), reps: REPS, rows: out }, null, 2));
console.log('\n✅ forced.json 저장');
process.exit(0);
