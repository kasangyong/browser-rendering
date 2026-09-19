/**
 * C8i — cv 를 걸면 배너가 왜 더 늦게 내려오나
 *
 * C8g 에서 나온 것: cv 가 A 를 420~506ms 줄였는데 LCP 는 안 움직였다.
 * 배너 응답끝이 129~142ms 밀렸기 때문이다.
 *
 * 배너는 loading="eager" 라 파싱 시점에 요청이 나가야 하고,
 * content-visibility 는 네트워크를 건드리지 않는다. 그런데 왜 밀리나.
 *
 * 후보 셋을 가른다:
 *   (a) 요청이 늦게 나간다              → 요청 시작 시각이 밀린다
 *   (b) 우선순위가 늦게 올라간다        → ResourceChangePriority 시각·값이 다르다
 *   (c) 경쟁이 세진다                   → 같은 시점에 떠 있는 요청 수·바이트가 다르다
 *
 * (b)가 유력하다. Chrome 은 레이아웃이 "화면 안" 이라고 알려줘야 이미지 우선순위를 올린다.
 * cv 는 첫 레이아웃을 바꾸므로 그 판정 시점이 달라질 수 있다 —
 * [C8 에서 lazy 이미지에 대해 본 것](RESULTS.md#4-왜-빨라졌나--다운로드가-빨라진-게-아니다)과 같은 계열이다.
 *
 * 콜드 캐시 · 2곳 × plain/cv-auto × 6회 = 24회. 읽기만 한다.
 * 사용: node probe-priority.mjs [--reps=6]
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const REPS = Number((process.argv.find(a => a.startsWith('--reps=')) || '--reps=6').split('=')[1]);

const SITES = {
  uk:          { url: 'https://en.wikivoyage.org/wiki/United_Kingdom', intrinsic: 182 },
  philippines: { url: 'https://en.wikivoyage.org/wiki/Philippines', intrinsic: 182 },
};
const BLOCKS = '.mw-parser-output section > *';
const MODES = ['plain', 'cv-auto'];

const OBS = '<script>try{performance.setResourceTimingBufferSize(3000)}catch(x){}' +
  '(function(){window.__lcp=null;try{new PerformanceObserver(function(l){' +
  'l.getEntries().forEach(function(e){window.__lcp={t:+e.startTime.toFixed(1),' +
  'u:e.url||""};});}).observe({type:"largest-contentful-paint",' +
  'buffered:true});}catch(x){}})()</script>';

const REPORT = `(() => {
  const L = window.__lcp;
  const all = performance.getEntriesByType('resource');
  const r = L && L.u ? all.find(x => x.name === L.u) : null;
  const imgs = all.filter(x => x.initiatorType === 'img');
  // 배너가 다 내려오기 전에 '떠 있던' 이미지 요청 수와 바이트 — 경쟁 가설(c)
  const before = r ? imgs.filter(x => x.startTime < r.responseEnd) : [];
  return {
    lcp: L,
    res: r ? { start: +r.startTime.toFixed(1), end: +r.responseEnd.toFixed(1),
               req: +r.requestStart.toFixed(1), resp: +r.responseStart.toFixed(1),
               bytes: r.encodedBodySize || 0 } : null,
    imgN: imgs.length, imgBytes: imgs.reduce((a, b) => a + (b.encodedBodySize || 0), 0),
    beforeN: before.length, beforeBytes: before.reduce((a, b) => a + (b.encodedBodySize || 0), 0),
    resN: all.length,
    fcp: (performance.getEntriesByType('paint').find(x => x.name === 'first-contentful-paint') || {}).startTime ?? null,
  };
})()`;

async function run(siteKey, mode, rep, port) {
  const S = SITES[siteKey];
  const profile = path.join(SCRATCH, `c8i-${siteKey}-${mode}-${rep}`);
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
          ? `<style id="__c8i">${BLOCKS}{content-visibility:auto;contain-intrinsic-size:auto ${S.intrinsic}px}</style>`
          : '<style id="__c8i"></style>';
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
    if (!v.lcp?.u || !v.res) throw new Error('LCP 이미지/리소스 타이밍 없음');

    let nav = null;
    for (const e of evs) if (e.name === 'navigationStart' && nav === null) nav = e.ts;
    if (nav === null) throw new Error('navigationStart 없음');
    const rel = e => (e.ts - nav) / 1000;

    const file = decodeURIComponent(v.lcp.u.split('?')[0].split('/').pop() || '');
    const token = file.replace(/^\d+px-/, '').slice(0, 26);
    let sendT = null, respT = null, finishT = null, prio0 = null;
    const prioChanges = [];
    for (const e of evs) {
      if (!e.args) continue;
      let j; try { j = JSON.stringify(e.args); } catch { continue; }
      if (!j.includes(token)) continue;
      const t = +rel(e).toFixed(1);
      if (e.name === 'ResourceSendRequest' && sendT === null) {
        sendT = t; prio0 = e.args?.data?.priority ?? null;
      }
      if (e.name === 'ResourceReceiveResponse' && respT === null) respT = t;
      if (e.name === 'ResourceFinish' && finishT === null) finishT = t;
      if (e.name === 'ResourceChangePriority') prioChanges.push({ t, to: e.args?.data?.priority ?? '?' });
    }
    // 배너 요청이 나간 시점에 '이미 요청됐고 아직 안 끝난' 리소스 수 — 경쟁 가설(c)
    let inflight = 0;
    if (sendT != null) {
      const starts = new Map();
      for (const e of evs) {
        if (e.name === 'ResourceSendRequest') starts.set(e.args?.data?.requestId, rel(e));
        if (e.name === 'ResourceFinish') {
          const id0 = e.args?.data?.requestId;
          if (starts.has(id0)) {
            const s = starts.get(id0), en = rel(e);
            if (s <= sendT && en >= sendT) inflight++;
            starts.delete(id0);
          }
        }
      }
      for (const [, s] of starts) if (s <= sendT) inflight++;
    }
    return { siteKey, mode, rep,
      sendT, respT, finishT, prio0, prioChanges,
      reqStart: v.res.start, reqEnd: v.res.end, bytes: v.res.bytes,
      transfer: +(v.res.end - v.res.start).toFixed(1),
      fcp: v.fcp != null ? +v.fcp.toFixed(1) : null, lcp: v.lcp.t,
      imgN: v.imgN, imgBytes: v.imgBytes, beforeN: v.beforeN, beforeBytes: v.beforeBytes,
      resN: v.resN, inflight };
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    await sleep(700);
    try { await rm(profile, { recursive: true, force: true }); } catch {}
  }
}

const out = [];
let port = 55000;
const plan = [];
for (const k of Object.keys(SITES)) for (const m of MODES) for (let r = 0; r < REPS; r++) plan.push({ k, m, r });
let seed = 4242;
for (let i = plan.length - 1; i > 0; i--) {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  const j = Math.floor((seed / 0x7fffffff) * (i + 1));
  [plan[i], plan[j]] = [plan[j], plan[i]];
}
console.log('\nC8i — cv 가 배너 다운로드를 왜 늦추나 (' + plan.length + '회, 순서 섞음)\n');
console.log('  사이트        모드      요청나감  우선순위   응답옴   응답끝   전송   │ 동시요청  이미지요청');
console.log('  ' + '─'.repeat(92));
for (const job of plan) {
  try {
    const r = await run(job.k, job.m, job.r, port++);
    out.push(r);
    console.log(`  ${job.k.padEnd(13)}${job.m.padEnd(9)}${String(r.sendT).padStart(8)}  ${String(r.prio0).padEnd(9)}` +
      `${String(r.respT).padStart(7)}${String(r.finishT).padStart(9)}${String(r.transfer).padStart(7)}   │` +
      `${String(r.inflight).padStart(8)}${String(r.beforeN).padStart(11)}` +
      (r.prioChanges.length ? '   승급 ' + r.prioChanges.map(p => `${p.t}ms→${p.to}`).join(',') : ''));
  } catch (e) { console.log(`  ${job.k} ${job.m} #${job.r} 실패: ${e.message}`); }
  await sleep(1200);
}
await writeFile(new URL('./priority.json', import.meta.url), JSON.stringify({
  note: 'cv 가 배너 다운로드를 늦추는 이유 — 요청 시각 / 우선순위 / 경쟁 중 무엇인가',
  generatedAt: new Date().toISOString(), reps: REPS, rows: out }, null, 2));
console.log('\n✅ priority.json 저장');
process.exit(0);
