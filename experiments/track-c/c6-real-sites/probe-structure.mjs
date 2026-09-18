/**
 * C6 사전 조사 — 실제 사이트에 '긴 반복 구조' 가 실제로 있는지, 어떤 선택자인지
 *
 * 지금까지 16개 실험이 전부 내가 만든 합성 리스트였다.
 * 실제 DOM 에서도 같은 결론이 나오는지 보려면 먼저 '무엇을 재는지' 부터 정해야 한다.
 *
 * 공개 문서 사이트만 쓰고, 사이트당 **1회만** 로드한다. 읽기만 한다.
 *
 * 사용: node probe-structure.mjs
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SITES = [
  { key: 'mdn-css',   url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/Reference' },
  { key: 'wiki-http', url: 'https://en.wikipedia.org/wiki/List_of_HTTP_status_codes' },
  { key: 'wiki-uni',  url: 'https://en.wikipedia.org/wiki/List_of_Unicode_characters' },
  { key: 'whatwg',    url: 'https://html.spec.whatwg.org/multipage/semantics.html' },
];

/** 페이지 안에서 '긴 반복 구조' 후보를 찾는다: 같은 부모 아래 같은 태그가 많은 곳 */
const FIND = `(() => {
  const cands = [];
  const parents = new Set();
  for (const el of document.querySelectorAll('ul, ol, tbody, div, section, dl')) {
    if (el.children.length < 30) continue;
    parents.add(el);
  }
  for (const p of parents) {
    const kids = [...p.children];
    const tags = {};
    for (const k of kids) tags[k.tagName] = (tags[k.tagName] || 0) + 1;
    const [tag, n] = Object.entries(tags).sort((a, b) => b[1] - a[1])[0];
    if (n < 30) continue;
    const sample = kids.find(k => k.tagName === tag);
    const r = sample.getBoundingClientRect();
    // 부모를 식별할 간단한 선택자
    let sel = p.tagName.toLowerCase();
    if (p.id) sel = '#' + CSS.escape(p.id);
    else if (p.className && typeof p.className === 'string') {
      const c = p.className.trim().split(/\\s+/).filter(Boolean)[0];
      if (c) sel = p.tagName.toLowerCase() + '.' + CSS.escape(c);
    }
    const hs = kids.filter(k => k.tagName === tag).slice(0, 40)
      .map(k => k.getBoundingClientRect().height).filter(h => h > 0).sort((a, b) => a - b);
    cands.push({
      parentSel: sel, childTag: tag.toLowerCase(), count: n,
      sampleH: +r.height.toFixed(1),
      medianH: hs.length ? +hs[Math.floor(hs.length / 2)].toFixed(1) : 0,
      parentText: (p.textContent || '').trim().slice(0, 40),
    });
  }
  cands.sort((a, b) => b.count - a.count);
  return {
    title: document.title.slice(0, 70),
    domNodes: document.querySelectorAll('*').length,
    scrollHeight: document.scrollingElement.scrollHeight,
    candidates: cands.slice(0, 5),
  };
})()`;

async function probe(site, port) {
  const profile = path.join(SCRATCH, `c6probe-${site.key}`);
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
    await sleep(2500);                       // 늦게 붙는 스크립트까지 기다린다
    const r = await send('Runtime.evaluate',
      { expression: FIND, returnByValue: true, awaitPromise: true });
    return { ...site, ...(r?.result?.value ?? { error: '평가 실패' }) };
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    await sleep(600);
    try { await rm(profile, { recursive: true, force: true }); } catch {}
  }
}

const out = [];
let port = 33000;
for (const s of SITES) {
  process.stdout.write(`  ${s.key} …`);
  try {
    const r = await probe(s, port++);
    out.push(r);
    console.log(` DOM ${String(r.domNodes ?? '?').padStart(6)} · 높이 ${String(r.scrollHeight ?? '?').padStart(7)}px · ${r.title ?? ''}`);
    for (const c of (r.candidates || [])) {
      console.log(`      ${String(c.count).padStart(5)}× ${c.parentSel} > ${c.childTag}` +
                  `   항목 높이 중앙값 ${c.medianH}px`);
    }
  } catch (e) { console.log(` 실패: ${e.message}`); out.push({ ...s, error: e.message }); }
}

await writeFile(new URL('./structure.json', import.meta.url), JSON.stringify({
  note: '실제 사이트의 긴 반복 구조 후보. 사이트당 1회만 로드했다.',
  generatedAt: new Date().toISOString(), sites: out,
}, null, 2));
console.log('\n✅ structure.json 저장');
process.exit(0);
