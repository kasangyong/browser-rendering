/**
 * C8 사전 조사 ③ — 안정적인 선택자로 확정
 *
 * 자동 탐색이 찾아준 #mwBoQ · #mwDBU 는 Parsoid 가 매 렌더마다 새로 만드는 ID라
 * 측정에 쓸 수 없다. C6 에서 쓴 안정적인 선택자로 같은 걸 얻는지 확인한다.
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SITES = [
  { key: 'canyon', url: 'https://en.wikipedia.org/wiki/Grand_Canyon' },
  { key: 'milky',  url: 'https://en.wikipedia.org/wiki/Milky_Way' },
  { key: 'everest', url: 'https://en.wikipedia.org/wiki/Mount_Everest' },
];
const SEL = '.mw-parser-output section > *';
const HOOK = `(()=>{window.__lcp=null;try{new PerformanceObserver(l=>{const e=l.getEntries().pop();
 if(e)window.__lcp={t:+e.startTime.toFixed(0),size:e.size,url:e.url||'',tag:e.element?e.element.tagName.toLowerCase():null};
}).observe({type:'largest-contentful-paint',buffered:true})}catch{}})()`;
const REPORT = `(() => {
  const els = [...document.querySelectorAll(${JSON.stringify(SEL)})];
  const hs = els.map(e => e.getBoundingClientRect().height).filter(h => h > 0).sort((a,b)=>a-b);
  const m = hs.reduce((a,b)=>a+b,0)/(hs.length||1);
  const sd = Math.sqrt(hs.reduce((a,b)=>a+(b-m)**2,0)/(hs.length||1));
  return { lcp: window.__lcp, docH: document.scrollingElement.scrollHeight,
    dom: document.querySelectorAll('*').length, imgs: document.images.length,
    count: els.length, median: hs.length ? +hs[Math.floor(hs.length/2)].toFixed(0) : 0,
    cv: +(sd/m).toFixed(2), covers: +(hs.reduce((a,b)=>a+b,0)/document.scrollingElement.scrollHeight).toFixed(2) };
})()`;
async function probe(site, port) {
  const profile = path.join(SCRATCH, `c8t-${site.key}`);
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
    await send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK });
    await send('Page.navigate', { url: site.url });
    await Promise.race([onLoad, sleep(30000)]);
    await sleep(3000);
    const r = await send('Runtime.evaluate', { expression: REPORT, returnByValue: true, awaitPromise: true });
    return { ...site, ...(r?.result?.value ?? {}) };
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    await sleep(600);
    try { await rm(profile, { recursive: true, force: true }); } catch {}
  }
}
const out = [];
let port = 42500;
console.log(`\n선택자: ${SEL}   (뷰포트 390×844)\n`);
console.log('  사이트     문서높이    DOM   이미지   LCP                블록   중앙값  변동계수  커버리지');
console.log('  ' + '─'.repeat(92));
for (const s of SITES) {
  const r = await probe(s, port++);
  out.push(r);
  const L = r.lcp;
  console.log(`  ${s.key.padEnd(10)}${(r.docH||0).toLocaleString().padStart(9)}${String(r.dom||0).padStart(8)}` +
    `${String(r.imgs||0).padStart(7)}   ${(L ? `<${L.tag}> ${L.url ? '★이미지' : '텍스트'} @${L.t}ms` : '못받음').padEnd(20)}` +
    `${String(r.count||0).padStart(5)}${String(r.median||0).padStart(8)}px${String(r.cv||0).padStart(9)}${((r.covers||0)*100).toFixed(0).padStart(8)}%`);
}
await writeFile(new URL('./target.json', import.meta.url), JSON.stringify({
  note: '안정적인 선택자(.mw-parser-output section > *)로 확정. 모바일 폭 390×844.',
  selector: SEL, viewport: '390x844', generatedAt: new Date().toISOString(), sites: out }, null, 2));
console.log('\n✅ target.json 저장');
process.exit(0);
