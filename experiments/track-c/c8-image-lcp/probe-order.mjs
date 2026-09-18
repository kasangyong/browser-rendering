/**
 * C8c 후속 — 시간 차이 대신 '순서'로 잰다
 *
 * C8c 본 측정은 검정력이 없었다. 기전이 쓸 수 있는 예산(Layout 절감)이 30~70ms 인데
 * 같은 조건 반복의 요청 시작 흩어짐이 1.08~4.41배(수백 ms)였다.
 * C8 본측정의 예산은 330~400ms 로 6배 컸다 — 그래서 거기선 보였다.
 *
 * 기전은 시간 차이가 아니라 **순서**를 예측한다:
 *
 *   LCP 이미지가 eager  →  요청이 첫 레이아웃 '전에' 나간다 (파싱 시점)
 *   LCP 이미지가 lazy   →  요청이 첫 레이아웃 '뒤에' 나간다 (뷰포트 안인지 알아야 하니까)
 *
 * 이건 네트워크가 빠르든 느리든 부호가 안 바뀐다. 30ms 차이를 잡을 필요가 없다.
 *
 * 대상: Wikivoyage 3곳 × (asis · forced) + 양성 대조로 C8 의 Wikipedia 1곳(실제 lazy).
 * 설정마다 2회, 콜드 캐시. 총 14회 로드. 읽기만 한다.
 *
 * 사용: node probe-order.mjs
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const REPS = 2;

const CONFIGS = [
  { key: 'paris',  url: 'https://en.wikivoyage.org/wiki/Paris',  arm: 'asis' },
  { key: 'paris',  url: 'https://en.wikivoyage.org/wiki/Paris',  arm: 'forced' },
  { key: 'rome',   url: 'https://en.wikivoyage.org/wiki/Rome',   arm: 'asis' },
  { key: 'rome',   url: 'https://en.wikivoyage.org/wiki/Rome',   arm: 'forced' },
  { key: 'london', url: 'https://en.wikivoyage.org/wiki/London', arm: 'asis' },
  { key: 'london', url: 'https://en.wikivoyage.org/wiki/London', arm: 'forced' },
  // 양성 대조 — C8 에서 쓴 Wikipedia. 이 페이지는 LCP 이미지가 '실제로' lazy 다.
  { key: 'canyon', url: 'https://en.wikipedia.org/wiki/Grand_Canyon', arm: 'asis' },
];

const OBS = '<script>(function(){window.__lcp=null;try{new PerformanceObserver(function(l){' +
  'var es=l.getEntries(),e=es[es.length-1];if(!e)return;' +
  'window.__lcp={t:+e.startTime.toFixed(1),u:e.url||"",size:e.size};' +
  '}).observe({type:"largest-contentful-paint",buffered:true});}catch(x){}})()</script>';

const REPORT = `(() => {
  const L = window.__lcp;
  let el = null, res = null;
  if (L && L.u) {
    for (const i of document.images) if (i.currentSrc === L.u || i.src === L.u) { el = i; break; }
    const e = performance.getEntriesByType('resource').find(x => x.name === L.u);
    if (e) res = { start: +e.startTime.toFixed(1), end: +e.responseEnd.toFixed(1) };
  }
  return { lcp: L, res, loading: el ? (el.getAttribute('loading') || 'none') : null,
           imgLazy: [...document.images].filter(i => i.getAttribute('loading') === 'lazy').length,
           imgTotal: document.images.length };
})()`;

async function run(cfg, rep, port) {
  const profile = path.join(SCRATCH, `c8o-${cfg.key}-${cfg.arm}-${rep}`);
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
        const m = html.match(/<head[^>]*>/i);
        html = m ? html.replace(m[0], m[0] + OBS) : OBS + html;
        if (cfg.arm === 'forced') {
          const parts = html.split('<img ');
          for (let i = 1; i < parts.length; i++) {
            const end = parts[i].indexOf('>');
            if (end < 0) continue;
            if (parts[i].slice(0, end).includes('loading=')) continue;
            parts[i] = 'loading="lazy" ' + parts[i];
          }
          html = parts.join('<img ');
        }
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
                             'blink', 'loading', 'blink.user_timing'] } });
    // 처음에 blink.user_timing 을 빼먹어 navigationStart 를 못 받았고,
    // 그러면 Layout 이 전부 걸러져 layoutCount 가 0 으로 조용히 나온다. 아래에서 잡는다.
    await sleep(200);
    await send('Page.navigate', { url: cfg.url });
    await Promise.race([onLoad, sleep(45000)]);
    await sleep(2500);
    await send('Tracing.end');
    await Promise.race([done, sleep(60000)]);

    let nav = null;
    // 조용한 실패 방지
    for (const e of evs) if (e.name === 'navigationStart' && nav === null) nav = e.ts;
    // Layout 이벤트를 시각순으로. 기준은 navigationStart.
    const layouts = evs.filter(e => e.name === 'Layout' && typeof e.dur === 'number' && nav !== null)
      .map(e => ({ start: (e.ts - nav) / 1000, end: (e.ts + e.dur - nav) / 1000 }))
      .sort((a, b) => a.start - b.start);
    const r = await send('Runtime.evaluate', { expression: REPORT, returnByValue: true, awaitPromise: true });
    const v = r?.result?.value ?? {};
    const reqStart = v.res ? v.res.start : null;
    return {
      ...cfg, rep, loading: v.loading, imgLazy: v.imgLazy, imgTotal: v.imgTotal,
      reqStart, lcpMs: v.lcp ? v.lcp.t : null,
      firstLayoutEnd: layouts.length ? +layouts[0].end.toFixed(1) : null,
      layoutCount: layouts.length,
      // 요청이 나가기 전에 끝난 Layout 이 몇 개인가
      layoutsBeforeReq: reqStart == null ? null : layouts.filter(l => l.end <= reqStart).length,
      navFound: nav !== null,
    };
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    await sleep(800);
    try { await rm(profile, { recursive: true, force: true }); } catch {}
  }
}

const out = [];
let port = 47000;
console.log('\n  사이트   팔      회  LCP이미지  첫Layout끝   요청시작   차이  │ 요청 전 Layout  판정');
console.log('  ' + '─'.repeat(92));
for (const cfg of CONFIGS) {
  for (let rep = 0; rep < REPS; rep++) {
    try {
      const r = await run(cfg, rep, port++);
      out.push(r);
      if (!r.navFound || !r.layoutCount) console.log('   ⚠ 트레이스 미수집 — navigationStart ' + r.navFound + ', Layout ' + r.layoutCount);
      const gap = (r.reqStart != null && r.firstLayoutEnd != null) ? r.reqStart - r.firstLayoutEnd : null;
      console.log(`  ${(rep === 0 ? r.key : '').padEnd(9)}${(rep === 0 ? r.arm : '').padEnd(8)}${rep}   ` +
        `${String(r.loading ?? '?').padEnd(9)}${String(r.firstLayoutEnd ?? '-').padStart(9)}` +
        `${String(r.reqStart ?? '-').padStart(11)}${(gap == null ? '-' : (gap > 0 ? '+' : '') + gap.toFixed(0)).padStart(7)}  │` +
        `${String(r.layoutsBeforeReq ?? '-').padStart(10)}/${String(r.layoutCount).padStart(4)}` +
        `   ${gap == null ? '' : gap > 0 ? '레이아웃 뒤' : '레이아웃 전'}`);
    } catch (e) { console.log(`  ${cfg.key} ${cfg.arm} ${rep} 실패: ${e.message}`); }
    await sleep(1500);
  }
  console.log('  ' + '·'.repeat(92));
}
await writeFile(new URL('./order.json', import.meta.url), JSON.stringify({
  note: '기전은 시간 차이가 아니라 순서를 예측한다 — eager 면 첫 레이아웃 전, lazy 면 뒤',
  generatedAt: new Date().toISOString(), reps: REPS, rows: out }, null, 2));
console.log('\n✅ order.json 저장');
process.exit(0);
