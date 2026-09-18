/**
 * C8c 사전 조사 — LCP 이미지가 '실제로' lazy 가 아닌 사이트를 찾는다
 *
 * C8b 의 eager 조건은 내가 HTML 을 고쳐 만든 것이다.
 * "화면 밖 이미지 60여 개가 한꺼번에 경쟁한다" 는 부작용도 그래서 생겼다.
 * 실제로 LCP 이미지만 eager 인 사이트(= 요즘 권장되는 방식)에서는 다를 수 있다.
 *
 * 조건 넷을 동시에 만족해야 쓸 수 있다:
 *   ① LCP 요소가 이미지
 *   ② 그 이미지의 loading 이 lazy 가 '아님' (eager 또는 속성 없음)
 *   ③ 문서가 충분히 길다 (≥15,000px 정도)
 *   ④ content-visibility 를 걸 블록 컨테이너가 있다 (자식 ≥40개)
 *
 * 사이트당 1회 로드. 읽기만 한다.
 * 사용: node probe-eager.mjs
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 위키 계열은 MediaWiki 가 전부 lazy 를 붙이므로 뺐다.
// 문서가 길고 히어로 이미지가 있는 공개 페이지를 종류별로 섞는다.
const SITES = [
  { key: 'wikivoyage', url: 'https://en.wikivoyage.org/wiki/Paris' },
  { key: 'britannica', url: 'https://www.britannica.com/place/Grand-Canyon' },
  { key: 'nps',        url: 'https://www.nps.gov/grca/planyourvisit/index.htm' },
  { key: 'smashing',   url: 'https://www.smashingmagazine.com/2023/09/webassembly-guide/' },
  { key: 'webdev',     url: 'https://web.dev/articles/lcp' },
  { key: 'mdn',        url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/content-visibility' },
  { key: 'wikihow',    url: 'https://www.wikihow.com/Tie-a-Tie' },
  { key: 'nasa',       url: 'https://science.nasa.gov/mars/' },
  { key: 'archdaily',  url: 'https://www.archdaily.com/office' },
  { key: 'cssTricks',  url: 'https://css-tricks.com/snippets/css/complete-guide-grid/' },
];

const LCP_HOOK = `(() => {
  window.__lcp = null;
  try {
    new PerformanceObserver(list => {
      const es = list.getEntries(); const e = es[es.length - 1]; if (!e) return;
      window.__lcp = { t: +e.startTime.toFixed(1), size: e.size, u: e.url || '',
        tag: e.element ? e.element.tagName.toLowerCase() : null };
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (err) { window.__lcpErr = String(err); }
})()`;

const REPORT = `(() => {
  const TABLE_INTERNAL = new Set(['TR','TD','TH','TBODY','THEAD','TFOOT']);
  const L = window.__lcp;
  let el = null;
  if (L && L.u) for (const i of document.images)
    if (i.currentSrc === L.u || i.src === L.u) { el = i; break; }
  const H = document.scrollingElement.scrollHeight;

  const cands = [];
  for (const node of document.querySelectorAll('*')) {
    const kids = [...node.children];
    if (kids.length < 40) continue;
    if (kids.some(k => TABLE_INTERNAL.has(k.tagName))) continue;
    const hs = kids.map(k => k.getBoundingClientRect().height).filter(h => h > 0);
    if (hs.length < 25) continue;
    const srt = [...hs].sort((a, b) => a - b);
    const m = hs.reduce((a, b) => a + b, 0) / hs.length;
    const sd = Math.sqrt(hs.reduce((a, b) => a + (b - m) ** 2, 0) / hs.length);
    let sel = node.tagName.toLowerCase();
    if (node.id) { try { sel = '#' + CSS.escape(node.id); } catch {} }
    else if (typeof node.className === 'string') {
      const c = node.className.trim().split(/\\s+/).filter(Boolean)[0];
      if (c) { try { sel = node.tagName.toLowerCase() + '.' + CSS.escape(c); } catch {} }
    }
    cands.push({ sel, count: kids.length, median: +srt[Math.floor(srt.length / 2)].toFixed(0),
      cv: +(sd / m).toFixed(2), covers: +(hs.reduce((a, b) => a + b, 0) / H).toFixed(2) });
  }
  cands.sort((a, b) => b.count - a.count);

  const lazyN = [...document.images].filter(i => i.getAttribute('loading') === 'lazy').length;
  return {
    title: document.title.slice(0, 45),
    lcp: L, lcpErr: window.__lcpErr || null,
    lcpImg: el ? { loading: el.getAttribute('loading'),
                   fetchpriority: el.getAttribute('fetchpriority'),
                   top: +el.getBoundingClientRect().top.toFixed(0) } : null,
    docHeight: H, domNodes: document.querySelectorAll('*').length,
    imgTotal: document.images.length, imgLazy: lazyN,
    cands: cands.slice(0, 3),
  };
})()`;

async function probe(site, port) {
  const profile = path.join(SCRATCH, `c8e-${site.key}`);
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
    ws.addEventListener('message', e => { const m = JSON.parse(e.data);
      if (m.id !== undefined) { const p = pend.get(m.id); pend.delete(m.id); p && p(m.result); }
      else if (m.method === 'Page.loadEventFired') loaded(); });
    const send = (method, params = {}) => { const i = ++id;
      ws.send(JSON.stringify({ id: i, method, params }));
      return new Promise(r => { const to = setTimeout(() => { pend.delete(i); r(null); }, 60000);
        pend.set(i, v => { clearTimeout(to); r(v); }); }); };
    await send('Page.enable'); await send('Runtime.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: LCP_HOOK });
    await send('Page.navigate', { url: site.url });
    await Promise.race([onLoad, sleep(40000)]);
    await sleep(3500);
    const r = await send('Runtime.evaluate', { expression: REPORT, returnByValue: true, awaitPromise: true });
    return { ...site, ...(r?.result?.value ?? { error: '평가 실패' }) };
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    await sleep(600);
    try { await rm(profile, { recursive: true, force: true }); } catch {}
  }
}

const out = [];
let port = 45000;
for (const s of SITES) {
  console.log(`\n■ ${s.key}   ${s.url}`);
  try {
    const r = await probe(s, port++);
    out.push(r);
    if (r.error) { console.log('   ', r.error); continue; }
    const L = r.lcp, I = r.lcpImg;
    const isImg = !!(L && L.u);
    const notLazy = I && I.loading !== 'lazy';
    console.log(`   문서 ${r.docHeight.toLocaleString()}px · DOM ${r.domNodes.toLocaleString()} · 이미지 ${r.imgTotal}개(lazy ${r.imgLazy})`);
    console.log(`   LCP  ${L ? `<${L.tag}> ${L.size}px² @${L.t}ms ${isImg ? '★이미지' : '(텍스트)'}` : '못 받음'}` +
      (I ? `  loading=${I.loading ?? '없음'} fetchpriority=${I.fetchpriority ?? '없음'} top=${I.top}` : ''));
    for (const c of r.cands)
      console.log(`   블록 ${String(c.count).padStart(4)}개  ${c.sel.slice(0, 32).padEnd(32)} 중앙값 ${String(c.median).padStart(5)}px  변동계수 ${c.cv}  문서의 ${(c.covers * 100).toFixed(0)}%`);
    const ok = isImg && notLazy && r.docHeight >= 15000 && r.cands.length > 0;
    console.log(`   → ${ok ? '✅ 쓸 수 있다' : '✗ ' + [
      !isImg && '이미지 LCP 아님', isImg && !notLazy && 'LCP 이미지가 lazy',
      r.docHeight < 15000 && '문서가 짧음', !r.cands.length && '블록 컨테이너 없음'].filter(Boolean).join(' · ')}`);
  } catch (e) { console.log('   실패:', e.message); out.push({ ...s, error: e.message }); }
  await sleep(1500);
}
await writeFile(new URL('./eager-candidates.json', import.meta.url), JSON.stringify({
  note: 'LCP 이미지가 실제로 lazy 가 아닌 사이트를 찾는다 (C8b 의 eager 는 내가 만든 조건이었다)',
  generatedAt: new Date().toISOString(), sites: out }, null, 2));
console.log('\n✅ eager-candidates.json 저장');
process.exit(0);
