/**
 * C8 사전 조사 — LCP 가 실제로 '이미지' 인 페이지를 찾는다
 *
 * C7 의 3곳은 전부 문서 사이트라 FCP = LCP 였다 (첫 페인트에 나온 텍스트가 그대로 LCP).
 * 실제 웹에서 LCP 는 대개 이미지다. 거기서도 같은 결론이 나오는지 보려면
 * 먼저 **LCP 요소가 진짜 이미지인 페이지**를 골라야 한다. 추측하면 안 된다.
 *
 * PerformanceObserver 로 LCP 항목을 직접 받아 element·url·size 를 확인하고,
 * 동시에 content-visibility 를 걸 블록 컨테이너도 찾는다.
 *
 * 사이트당 1회 로드. 읽기만 한다.
 * 사용: node probe-lcp.mjs
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 1차에서 위키 본문 4곳이 전부 '텍스트 LCP' 였다 — 썸네일이 작아서 문단이 더 크다.
// 큰 이미지가 화면 위쪽에 오는 갤러리·포토 페이지로 바꾼다.
// 데스크톱(1280×900)에서는 긴 페이지 8곳이 전부 텍스트 LCP 였다.
// 모바일 폭에서는 문단 면적이 줄고 이미지가 전체 폭을 차지하므로 뒤집힐 수 있다.
// 실제 트래픽 대부분이 모바일이기도 하다.
const SITES = [
  { key: 'everest-m', url: 'https://en.wikipedia.org/wiki/Mount_Everest' },
  { key: 'canyon-m',  url: 'https://en.wikipedia.org/wiki/Grand_Canyon' },
  { key: 'milky-m',   url: 'https://en.wikipedia.org/wiki/Milky_Way' },
  { key: 'commonsfp-m', url: 'https://commons.wikimedia.org/wiki/Commons:Featured_pictures/Animals' },
];

/** LCP 항목을 PerformanceObserver 로 직접 받는다. buffered:true 라 이미 지난 것도 온다. */
const LCP_HOOK = `(() => {
  window.__lcp = null;
  try {
    new PerformanceObserver(list => {
      const es = list.getEntries();
      const e = es[es.length - 1];
      if (!e) return;
      window.__lcp = {
        startTime: +e.startTime.toFixed(1),
        size: e.size,
        url: e.url || '',
        tag: e.element ? e.element.tagName.toLowerCase() : null,
        cls: e.element && typeof e.element.className === 'string'
             ? e.element.className.slice(0, 40) : '',
      };
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (err) { window.__lcpErr = String(err); }
})()`;

const REPORT = `(() => {
  const TABLE_INTERNAL = new Set(['TR','TD','TH','TBODY','THEAD','TFOOT']);
  const imgs = [...document.images];
  const vh = innerHeight;
  const cands = [];
  for (const el of document.querySelectorAll('*')) {
    const kids = [...el.children];
    if (kids.length < 40) continue;
    if (kids.some(k => TABLE_INTERNAL.has(k.tagName))) continue;
    const hs = kids.map(k => k.getBoundingClientRect().height).filter(h => h > 0);
    if (hs.length < 25) continue;
    const s = [...hs].sort((a, b) => a - b);
    const m = hs.reduce((a, b) => a + b, 0) / hs.length;
    const sd = Math.sqrt(hs.reduce((a, b) => a + (b - m) ** 2, 0) / hs.length);
    let sel = el.tagName.toLowerCase();
    if (el.id) { try { sel = '#' + CSS.escape(el.id); } catch {} }
    else if (typeof el.className === 'string') {
      const c = el.className.trim().split(/\\s+/).filter(Boolean)[0];
      if (c) { try { sel = el.tagName.toLowerCase() + '.' + CSS.escape(c); } catch {} }
    }
    cands.push({ sel, count: kids.length,
      median: +s[Math.floor(s.length / 2)].toFixed(0), cv: +(sd / m).toFixed(2),
      covers: +(hs.reduce((a, b) => a + b, 0) / document.scrollingElement.scrollHeight).toFixed(2) });
  }
  cands.sort((a, b) => b.count - a.count);
  return {
    title: document.title.slice(0, 55),
    lcp: window.__lcp, lcpErr: window.__lcpErr || null,
    docHeight: document.scrollingElement.scrollHeight,
    domNodes: document.querySelectorAll('*').length,
    imgCount: imgs.length,
    imgBelowFold: imgs.filter(i => i.getBoundingClientRect().top > vh).length,
    biggestImg: (() => {
      let best = null;
      for (const i of imgs) {
        const r = i.getBoundingClientRect();
        const a = r.width * r.height;
        if (!best || a > best.area) best = { area: +a.toFixed(0), w: +r.width.toFixed(0),
          h: +r.height.toFixed(0), top: +r.top.toFixed(0), src: (i.currentSrc || '').slice(-50) };
      }
      return best;
    })(),
    cands: cands.slice(0, 3),
  };
})()`;

async function probe(site, port) {
  const profile = path.join(SCRATCH, `c8p-${site.key}`);
  await mkdir(profile, { recursive: true });
  const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, '--no-first-run',
    '--hide-scrollbars', '--window-size=390,844', 'about:blank'], { stdio: 'ignore' });
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
    // LCP 관찰자를 문서 시작 시점에 걸어둔다
    await send('Page.addScriptToEvaluateOnNewDocument', { source: LCP_HOOK });
    await send('Page.navigate', { url: site.url });
    await Promise.race([onLoad, sleep(30000)]);
    await sleep(3000);
    const r = await send('Runtime.evaluate', { expression: REPORT, returnByValue: true, awaitPromise: true });
    return { ...site, ...(r?.result?.value ?? { error: '평가 실패' }) };
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    await sleep(600);
    try { await rm(profile, { recursive: true, force: true }); } catch {}
  }
}

const out = [];
let port = 41000;
for (const s of SITES) {
  console.log(`\n■ ${s.key}   ${s.url}`);
  try {
    const r = await probe(s, port++);
    out.push(r);
    if (r.error) { console.log('   ', r.error); continue; }
    const L = r.lcp;
    console.log(`   문서 ${r.docHeight.toLocaleString()}px · DOM ${r.domNodes.toLocaleString()} · 이미지 ${r.imgCount}개(화면밖 ${r.imgBelowFold})`);
    console.log(`   LCP  ${L ? `<${L.tag}> ${L.size}px² @ ${L.startTime}ms ${L.url ? '★이미지' : '(텍스트)'}` : '못 받음 ' + (r.lcpErr || '')}`);
    if (r.biggestImg) console.log(`   최대 이미지  ${r.biggestImg.w}×${r.biggestImg.h} top ${r.biggestImg.top}px`);
    for (const c of r.cands) {
      console.log(`   블록  ${String(c.count).padStart(4)}개  ${c.sel.slice(0, 36).padEnd(36)} 중앙값 ${String(c.median).padStart(5)}px  변동계수 ${c.cv}  문서의 ${(c.covers*100).toFixed(0)}%`);
    }
  } catch (e) { console.log('   실패:', e.message); out.push({ ...s, error: e.message }); }
}

await writeFile(new URL('./lcp-candidates.json', import.meta.url), JSON.stringify({
  note: 'LCP 가 이미지인 페이지를 PerformanceObserver 로 확인하고, cv 를 걸 블록도 같이 찾는다',
  generatedAt: new Date().toISOString(), sites: out,
}, null, 2));
console.log('\n✅ lcp-candidates.json 저장');
process.exit(0);
