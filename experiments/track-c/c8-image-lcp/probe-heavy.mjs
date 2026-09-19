/**
 * C8d 사전 조사 — '레이아웃이 비싼데 LCP 이미지가 eager' 인 페이지를 찾는다
 *
 * C8c 에서 조건이 둘로 좁혀졌다:
 *   ① LCP 이미지가 loading="lazy" — 아니면 요청이 레이아웃을 안 기다린다
 *   ② 레이아웃 비용이 수백 ms — 아니면 앞당길 폭이 잡음보다 작다
 *
 * 그런데 C8c 의 Wikivoyage 3곳은 ①도 ②도 아니었다(eager · Layout 104~135ms).
 * 두 조건을 '분리해서' 보려면 **②만 만족하는 페이지**가 필요하다 — 비싼데 eager.
 *
 * Wikivoyage 는 pagebanner 확장이 배너를 eager 로 내보내므로 ①은 자동으로 아니다.
 * 남은 건 ②뿐이다. 도시 이름을 찍어 맞히지 말고 Special:LongPages 로 실제 최장 문서부터 본다.
 *
 * 판정 기준은 프록시(문서 높이·DOM 수)가 아니라 **실측 Layout ms** 다.
 * C8c 에서 London(124,619px · DOM 15,415)이 135ms 밖에 안 나왔다 — 프록시는 못 믿는다.
 *
 * 콜드 캐시 1회씩. 읽기만 한다.
 * 사용: node probe-heavy.mjs [--top=12]
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TOP = Number((process.argv.find(a => a.startsWith('--top=')) || '--top=12').split('=')[1]);
const UA = 'browser-rendering-study/1.0 (read-only measurement; https://github.com/kasangyong/browser-rendering)';

/** Special:LongPages — 바이트 기준 최장 문서 목록. 한 번만 받는다. */
async function longest(limit) {
  const url = `https://en.wikivoyage.org/w/index.php?title=Special:LongPages&limit=${limit}`;
  const html = await (await fetch(url, { headers: { 'User-Agent': UA } })).text();
  const out = [];
  // <bdi ...><a href="/wiki/SLUG" title="TITLE">TITLE</a></bdi> [NNN,NNN bytes]
  for (const m of html.matchAll(/<bdi[^>]*><a href="\/wiki\/([^"#?]+)"[^>]*>([^<]+)<\/a><\/bdi>\s*\[([\d,]+)\s*bytes?\]/g)) {
    out.push({ slug: m[1], title: m[2], bytes: Number(m[3].replace(/,/g, '')) });
  }
  if (!out.length) { // 마크업이 바뀌었을 때 조용히 빈 결과로 넘어가지 않게
    throw new Error('Special:LongPages 파싱 실패 — 마크업이 바뀌었다');
  }
  return out;
}

const OBS = '<script>(function(){window.__lcp=null;try{new PerformanceObserver(function(l){' +
  'var es=l.getEntries(),e=es[es.length-1];if(!e)return;' +
  'window.__lcp={t:+e.startTime.toFixed(1),u:e.url||"",size:e.size,' +
  'tag:e.element?e.element.tagName.toLowerCase():null};' +
  '}).observe({type:"largest-contentful-paint",buffered:true});}catch(x){}})()</script>';

const REPORT = `(() => {
  const L = window.__lcp;
  let el = null;
  if (L && L.u) for (const i of document.images)
    if (i.currentSrc === L.u || i.src === L.u) { el = i; break; }
  const H = document.scrollingElement.scrollHeight;
  const blocks = [...document.querySelectorAll('.mw-parser-output section > *')];
  const hs = blocks.map(b => b.getBoundingClientRect().height).filter(h => h > 0);
  const srt = [...hs].sort((a, b) => a - b);
  const mu = hs.length ? hs.reduce((a, b) => a + b, 0) / hs.length : 0;
  const sd = hs.length ? Math.sqrt(hs.reduce((a, b) => a + (b - mu) ** 2, 0) / hs.length) : 0;
  return {
    lcp: L,
    loading: el ? (el.getAttribute('loading') || 'none') : null,
    docHeight: H, domNodes: document.querySelectorAll('*').length,
    imgTotal: document.images.length,
    imgLazy: [...document.images].filter(i => i.getAttribute('loading') === 'lazy').length,
    blocks: blocks.length,
    median: hs.length ? +srt[Math.floor(srt.length / 2)].toFixed(0) : 0,
    cv: mu ? +(sd / mu).toFixed(2) : 0,
  };
})()`;

async function probe(site, port) {
  const profile = path.join(SCRATCH, `c8h-${site.slug.slice(0, 24).replace(/[^A-Za-z0-9]/g, '_')}-${port}`);
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
      return new Promise(r => { const to = setTimeout(() => { pend.delete(i); r(null); }, 120000);
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
    await sleep(200);
    await send('Page.navigate', { url: `https://en.wikivoyage.org/wiki/${site.slug}` });
    await Promise.race([onLoad, sleep(60000)]);
    await sleep(2500);
    await send('Tracing.end');
    await Promise.race([done, sleep(90000)]);

    let nav = null, layout = 0, style = 0, n = 0;
    for (const e of evs) {
      if (e.name === 'navigationStart' && nav === null) nav = e.ts;
      if (typeof e.dur !== 'number') continue;
      if (e.name === 'Layout') { layout += e.dur / 1000; n++; }
      if (e.name === 'UpdateLayoutTree') style += e.dur / 1000;
    }
    const r = await send('Runtime.evaluate', { expression: REPORT, returnByValue: true, awaitPromise: true });
    return { ...site, ...(r?.result?.value ?? {}),
      layoutMs: +layout.toFixed(1), layoutN: n, styleMs: +style.toFixed(1), navFound: nav !== null };
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    await sleep(700);
    try { await rm(profile, { recursive: true, force: true }); } catch {}
  }
}

const ONLY = (process.argv.find(a => a.startsWith('--slugs=')) || '').split('=')[1];
const REPS = Number((process.argv.find(a => a.startsWith('--reps=')) || '--reps=1').split('=')[1]);
// --slugs 로 특정 문서만 반복해 본다 — LCP 요소가 실행마다 바뀌는지 확인용
const pages = ONLY
  ? ONLY.split(',').flatMap(x => Array.from({ length: REPS }, () => ({ slug: x, title: x, bytes: 0 })))
  : (await longest(60)).slice(0, TOP);
if (!ONLY) console.log(`\nSpecial:LongPages 상위 ${pages.length}개 (바이트 ${pages[0].bytes.toLocaleString()} ~ ${pages[pages.length - 1].bytes.toLocaleString()})\n`);
console.log('  문서                          바이트   문서높이     DOM   LCP        loading   Layout   블록');
console.log('  ' + '─'.repeat(98));

const out = [];
let port = 48000;
for (const p of pages) {
  try {
    const r = await probe(p, port++);
    out.push(r);
    if (!r.navFound) console.log('   ⚠ 트레이스 미수집');
    const isImg = !!(r.lcp && r.lcp.u);
    console.log(`  ${p.title.slice(0, 27).padEnd(28)}${p.bytes.toLocaleString().padStart(8)}` +
      `${(r.docHeight ?? 0).toLocaleString().padStart(10)}${(r.domNodes ?? 0).toLocaleString().padStart(8)}` +
      `   ${(isImg ? '이미지' : `<${r.lcp?.tag ?? '?'}>`).padEnd(9)}${String(r.loading ?? '-').padEnd(9)}` +
      `${String(r.layoutMs).padStart(8)}ms${String(r.blocks ?? 0).padStart(7)}` +
      `   ${isImg && r.loading !== 'lazy' && r.layoutMs >= 300 ? '✅ 둘 다' : isImg && r.loading !== 'lazy' ? '이미지·eager ✓ / 레이아웃 부족' : '✗'}`);
  } catch (e) { console.log(`  ${p.title.slice(0, 27).padEnd(28)} 실패: ${e.message}`); }
  await sleep(1500);
}
await writeFile(new URL('./heavy-candidates.json', import.meta.url), JSON.stringify({
  note: '레이아웃이 비싼데 LCP 이미지가 eager 인 페이지를 찾는다 (조건 ②만 만족)',
  criterion: 'LCP=이미지 · loading!=lazy · 실측 Layout >= 300ms',
  generatedAt: new Date().toISOString(), rows: out }, null, 2));
console.log('\n✅ heavy-candidates.json 저장');
process.exit(0);
