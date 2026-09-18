/**
 * C6 사전 조사 ② — 실제 페이지에서 content-visibility 를 '어디에' 걸 수 있나
 *
 * 1차 조사에서 나온 반복 단위가 대부분 <tr> 이었다.
 * 그런데 `contain: size` 는 테이블 내부 요소(tr/td)에 **적용되지 않는다** —
 * content-visibility:auto 를 걸어도 size 컨테인먼트가 안 붙으면 효과가 다르다.
 *
 * 그래서 실제 권장 방식대로 **본문 컨테이너의 직계 자식 블록**에 거는 쪽을 본다.
 * 그리고 "정말 걸렸는지" 를 scrollHeight 변화로 확인한다 —
 * C1 에서 contain-intrinsic-size 없이 걸면 문서가 1/3 로 쪼그라드는 걸 봤다.
 *
 * 사이트당 1회 로드. 읽기만 한다.
 * 사용: node probe-target.mjs
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SITES = [
  { key: 'wiki-uni',  url: 'https://en.wikipedia.org/wiki/List_of_Unicode_characters',
    main: ['.mw-parser-output', '#mw-content-text', 'main'] },
  { key: 'mdn-css',   url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/Reference',
    main: ['.main-page-content', 'article', 'main'] },
  { key: 'whatwg',    url: 'https://html.spec.whatwg.org/multipage/semantics.html',
    main: ['body > .head ~ *', 'main', 'body'] },
];

const ANALYZE = mains => `(() => {
  const pick = ${JSON.stringify(mains)};
  let main = null, usedSel = null;
  for (const s of pick) { try { const e = document.querySelector(s); if (e) { main = e; usedSel = s; break; } } catch {} }
  if (!main) return { error: '본문 컨테이너 못 찾음' };

  const kids = [...main.children].filter(e => e.nodeType === 1);
  const tagCount = {};
  for (const k of kids) tagCount[k.tagName.toLowerCase()] = (tagCount[k.tagName.toLowerCase()] || 0) + 1;
  const heights = kids.map(k => k.getBoundingClientRect().height).filter(h => h > 0).sort((a, b) => a - b);
  const before = document.scrollingElement.scrollHeight;

  // ① 크기 지정 없이 걸어본다 — 정말 적용되는지 확인 (문서가 줄어들면 걸린 것)
  const st = document.createElement('style');
  st.textContent = usedSel + ' > * { content-visibility: auto }';
  document.head.appendChild(st);
  document.scrollingElement.scrollHeight;              // 강제 레이아웃
  const afterNoSize = document.scrollingElement.scrollHeight;

  // ② 중앙값 높이를 intrinsic size 로 주고 다시
  const med = heights.length ? heights[Math.floor(heights.length / 2)] : 0;
  st.textContent = usedSel + ' > * { content-visibility: auto; contain-intrinsic-size: auto ' + Math.round(med) + 'px }';
  document.scrollingElement.scrollHeight;
  const afterSized = document.scrollingElement.scrollHeight;
  st.remove();
  document.scrollingElement.scrollHeight;

  return {
    usedSel, childCount: kids.length, tagCount,
    medianChildH: +med.toFixed(1),
    maxChildH: heights.length ? +heights[heights.length - 1].toFixed(1) : 0,
    before, afterNoSize, afterSized,
    shrinkNoSize: +(1 - afterNoSize / before).toFixed(3),
    shrinkSized: +(1 - afterSized / before).toFixed(3),
    tableRows: main.querySelectorAll('tr').length,
    domNodes: document.querySelectorAll('*').length,
  };
})()`;

async function probe(site, port) {
  const profile = path.join(SCRATCH, `c6t-${site.key}`);
  await mkdir(profile, { recursive: true });
  const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, '--no-first-run',
    '--hide-scrollbars', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
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
    await send('Page.navigate', { url: site.url });
    await Promise.race([onLoad, sleep(30000)]);
    await sleep(2500);
    const r = await send('Runtime.evaluate',
      { expression: ANALYZE(site.main), returnByValue: true, awaitPromise: true });
    return { ...site, ...(r?.result?.value ?? { error: '평가 실패' }) };
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    await sleep(600);
    try { await rm(profile, { recursive: true, force: true }); } catch {}
  }
}

const out = [];
let port = 34000;
for (const s of SITES) {
  console.log(`\n■ ${s.key}  ${s.url}`);
  try {
    const r = await probe(s, port++);
    out.push(r);
    if (r.error) { console.log('  ', r.error); continue; }
    console.log(`  본문 선택자      ${r.usedSel}`);
    console.log(`  직계 자식        ${r.childCount}개  (${Object.entries(r.tagCount).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([k,v])=>k+'×'+v).join(', ')})`);
    console.log(`  자식 높이        중앙값 ${r.medianChildH}px · 최대 ${r.maxChildH}px`);
    console.log(`  테이블 행        ${r.tableRows}개 · DOM ${r.domNodes}노드`);
    console.log(`  scrollHeight     원본 ${r.before}`);
    console.log(`    cv 만 걸면      ${r.afterNoSize}  (${(r.shrinkNoSize*100).toFixed(1)}% 축소 ← 걸렸다는 증거)`);
    console.log(`    크기까지 주면    ${r.afterSized}  (${(r.shrinkSized*100).toFixed(1)}% 축소)`);
  } catch (e) { console.log('  실패:', e.message); out.push({ ...s, error: e.message }); }
}

await writeFile(new URL('./target.json', import.meta.url), JSON.stringify({
  note: '실제 페이지에서 content-visibility 를 걸 지점과, 실제로 걸리는지 확인',
  generatedAt: new Date().toISOString(), sites: out,
}, null, 2));
console.log('\n✅ target.json 저장');
process.exit(0);
