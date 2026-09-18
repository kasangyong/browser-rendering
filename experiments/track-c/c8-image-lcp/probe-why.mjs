/**
 * C8 후속 — LCP 가 왜 빨라졌나
 *
 * 본 측정에서 예측 S2·S6 이 반증됐다. LCP 가 cv 로 12~38% 빨라졌다.
 * 그런데 다운로드가 빨라진 게 아니었다 — 바이트도 전송시간도 같고,
 * **요청 시작 시각**이 400~580ms 앞당겨졌다.
 *
 *   Grand Canyon cold   plain   요청시작 1835  전송 276ms  → LCP 2224
 *                       cv-auto 요청시작 1256  전송 120ms  → LCP 1597
 *
 * 이미지 요청이 1.8초나 뒤에 나가는 게 이상하다. 프리로드 스캐너가 있으면
 * 훨씬 일찍 나갔어야 한다. 가설: **LCP 이미지가 loading="lazy" 다.**
 * 그러면 "뷰포트 안인가" 를 알아야 요청할 수 있고, 그건 레이아웃을 해야 안다.
 * 즉 레이아웃이 요청의 선행 조건이 되고, cv 가 레이아웃을 줄이면 요청이 앞당겨진다.
 *
 * 같이 확인: cv 가 화면 밖 이미지 요청을 **줄이는지** (경쟁 완화 가설의 대안).
 *
 * 콜드 캐시 1회씩. 사이트 3곳 × 2모드 = 6회 로드. 읽기만 한다.
 * 사용: node probe-why.mjs
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SITES = {
  canyon:  { url: 'https://en.wikipedia.org/wiki/Grand_Canyon', intrinsic: 208 },
  milky:   { url: 'https://en.wikipedia.org/wiki/Milky_Way', intrinsic: 234 },
  everest: { url: 'https://en.wikipedia.org/wiki/Mount_Everest', intrinsic: 200 },
};
const BLOCKS = '.mw-parser-output section > *';

const OBS = '<script>(function(){window.__lcp=null;try{new PerformanceObserver(function(l){' +
  'var es=l.getEntries(),e=es[es.length-1];if(!e)return;' +
  'window.__lcp={t:+e.startTime.toFixed(1),u:e.url||"",size:e.size};' +
  '}).observe({type:"largest-contentful-paint",buffered:true});}catch(x){}})()</script>';

const REPORT = `(() => {
  const L = window.__lcp;
  const res = performance.getEntriesByType('resource');
  const imgRes = res.filter(r => r.initiatorType === 'img');
  let el = null;
  if (L && L.u) {
    for (const i of document.images) if (i.currentSrc === L.u || i.src === L.u) { el = i; break; }
  }
  const r = el ? el.getBoundingClientRect() : null;
  return {
    lcp: L,
    lcpImg: el ? {
      loading: el.getAttribute('loading'),
      fetchpriority: el.getAttribute('fetchpriority'),
      decoding: el.getAttribute('decoding'),
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 40),
      // 레이아웃 후 좌표. 초기 뷰포트 안인지.
      top: r ? +r.top.toFixed(0) : null, h: r ? +r.height.toFixed(0) : null,
    } : null,
    // 문서 전체 img 중 lazy 비율
    imgTotal: document.images.length,
    imgLazy: [...document.images].filter(i => i.getAttribute('loading') === 'lazy').length,
    // 실제로 요청이 나간 이미지 수 — cv 가 화면 밖 요청을 줄이는지
    imgRequested: imgRes.length,
    imgBytes: imgRes.reduce((a, b) => a + (b.encodedBodySize || 0), 0),
    docHeight: document.scrollingElement.scrollHeight,
  };
})()`;

async function run(key, mode, port) {
  const S = SITES[key];
  const profile = path.join(SCRATCH, `c8w-${key}-${mode}`);
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
    let id = 0; const pend = new Map(); let loaded;
    const onLoad = new Promise(r => { loaded = r; });
    const handlers = new Map();
    ws.addEventListener('message', e => { const m = JSON.parse(e.data);
      if (m.id !== undefined) { const p = pend.get(m.id); pend.delete(m.id); p && p(m.result); }
      else if (m.method === 'Page.loadEventFired') loaded();
      else { const h = handlers.get(m.method); if (h) h(m.params); } });
    const send = (method, params = {}) => { const i = ++id;
      ws.send(JSON.stringify({ id: i, method, params }));
      return new Promise(r => { const to = setTimeout(() => { pend.delete(i); r(null); }, 60000);
        pend.set(i, v => { clearTimeout(to); r(v); }); }); };

    await send('Page.enable'); await send('Runtime.enable');
    const css = mode === 'cv-auto'
      ? `${BLOCKS}{content-visibility:auto;contain-intrinsic-size:auto ${S.intrinsic}px}` : '';
    const inject = `<style id="__c8">${css}</style>` + OBS;
    await send('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Response', resourceType: 'Document' }] });
    handlers.set('Fetch.requestPaused', async p => {
      try {
        const body = await send('Fetch.getResponseBody', { requestId: p.requestId });
        let html = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
        const m = html.match(/<head[^>]*>/i);
        html = m ? html.replace(m[0], m[0] + inject) : inject + html;
        await send('Fetch.fulfillRequest', { requestId: p.requestId,
          responseCode: p.responseStatusCode ?? 200, responseHeaders: p.responseHeaders,
          body: Buffer.from(html, 'utf8').toString('base64') });
      } catch { await send('Fetch.continueRequest', { requestId: p.requestId }); }
    });
    await send('Page.navigate', { url: S.url });
    await Promise.race([onLoad, sleep(45000)]);
    await sleep(3000);
    const r = await send('Runtime.evaluate', { expression: REPORT, returnByValue: true, awaitPromise: true });
    return { key, mode, ...(r?.result?.value ?? { error: '평가 실패' }) };
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    await sleep(600);
    try { await rm(profile, { recursive: true, force: true }); } catch {}
  }
}

const out = [];
let port = 43100;
console.log('\n  사이트     모드      LCP이미지 loading  priority   top     h   │ img 요청/전체(lazy)   바이트');
console.log('  ' + '─'.repeat(92));
for (const k of Object.keys(SITES)) {
  for (const m of ['plain', 'cv-auto']) {
    const r = await run(k, m, port++);
    out.push(r);
    const I = r.lcpImg;
    console.log(`  ${(m === 'plain' ? k : '').padEnd(11)}${m.padEnd(9)}` +
      `${String(I?.loading ?? '없음').padEnd(9)}${String(I?.fetchpriority ?? '없음').padEnd(10)}` +
      `${String(I?.top ?? '-').padStart(6)}${String(I?.h ?? '-').padStart(6)}   │ ` +
      `${String(r.imgRequested).padStart(4)}/${String(r.imgTotal).padStart(4)}(${String(r.imgLazy).padStart(4)})` +
      `${(r.imgBytes / 1024).toFixed(0).padStart(11)}KB`);
    await sleep(2000);
  }
  console.log('  ' + '·'.repeat(92));
}
await writeFile(new URL('./why.json', import.meta.url), JSON.stringify({
  note: 'LCP 가 cv 로 빨라진 이유 — 요청 시작이 앞당겨진 원인을 찾는다',
  generatedAt: new Date().toISOString(), rows: out }, null, 2));
console.log('\n✅ why.json 저장');
process.exit(0);
