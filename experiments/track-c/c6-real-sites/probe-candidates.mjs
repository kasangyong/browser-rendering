/**
 * C6b 사전 조사 — 사이트 2곳을 더 고른다
 *
 * C6 에서 선택자를 내가 추측하다 세 번 헛발질했다(tr 은 contain:size 가 안 붙고,
 * 본문 직계 자식은 3~19개뿐이었다). 이번엔 DOM 을 훑어 **자동으로** 후보를 찾는다.
 *
 * 조건: 같은 부모 아래 블록 자식이 50개 이상 · 테이블 내부가 아님 · 높이가 0이 아님
 * 그리고 변동계수(작을수록 균일)를 같이 재서 contain-intrinsic-size 를 줄 수 있는지 본다.
 *
 * 사이트당 1회 로드. 읽기만 한다.
 * 사용: node probe-candidates.mjs
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SITES = [
  { key: 'mdn-http',   url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers' },
  { key: 'whatwg-dom', url: 'https://html.spec.whatwg.org/multipage/dom.html' },
  { key: 'py-func',    url: 'https://docs.python.org/3/library/functions.html' },
  { key: 'wiki-elem',  url: 'https://en.wikipedia.org/wiki/List_of_chemical_elements' },
  { key: 'mdn-events', url: 'https://developer.mozilla.org/en-US/docs/Web/Events' },
];

const FIND = `(() => {
  const TABLE_INTERNAL = new Set(['TR','TD','TH','TBODY','THEAD','TFOOT','COL','COLGROUP']);
  const seen = [];
  const cssPath = el => {
    if (el.id) { try { return '#' + CSS.escape(el.id); } catch { } }
    const parts = [];
    let cur = el;
    for (let d = 0; cur && cur.nodeType === 1 && d < 4; d++) {
      let p = cur.tagName.toLowerCase();
      const cls = (typeof cur.className === 'string' ? cur.className : '').trim().split(/\\s+/).filter(Boolean);
      if (cls.length) { try { p += '.' + CSS.escape(cls[0]); } catch {} }
      parts.unshift(p);
      if (cur.id) { try { parts[0] = '#' + CSS.escape(cur.id); break; } catch {} }
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };

  for (const el of document.querySelectorAll('*')) {
    const kids = [...el.children];
    if (kids.length < 50) continue;
    // 테이블 내부는 contain:size 가 적용되지 않으므로 후보에서 뺀다
    const inTable = kids.some(k => TABLE_INTERNAL.has(k.tagName));
    const hs = kids.map(k => k.getBoundingClientRect().height).filter(h => h > 0);
    if (hs.length < 30) continue;
    const s = [...hs].sort((a, b) => a - b);
    const m = hs.reduce((a, b) => a + b, 0) / hs.length;
    const sd = Math.sqrt(hs.reduce((a, b) => a + (b - m) ** 2, 0) / hs.length);
    seen.push({
      sel: cssPath(el), tag: el.tagName.toLowerCase(),
      count: kids.length, withHeight: hs.length, inTable,
      median: +s[Math.floor(s.length / 2)].toFixed(0),
      min: +s[0].toFixed(0), max: +s[s.length - 1].toFixed(0),
      cv: +(sd / m).toFixed(2),
      covers: +(hs.reduce((a, b) => a + b, 0) / document.scrollingElement.scrollHeight).toFixed(2),
    });
  }
  seen.sort((a, b) => (a.inTable - b.inTable) || (b.count - a.count));
  return {
    title: document.title.slice(0, 60),
    docHeight: document.scrollingElement.scrollHeight,
    domNodes: document.querySelectorAll('*').length,
    tableRows: document.querySelectorAll('tr').length,
    cands: seen.filter(x => !x.inTable).slice(0, 4),
    tableCands: seen.filter(x => x.inTable).slice(0, 2),
  };
})()`;

async function probe(site, port) {
  const profile = path.join(SCRATCH, `c6c-${site.key}`);
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
    const r = await send('Runtime.evaluate', { expression: FIND, returnByValue: true, awaitPromise: true });
    return { ...site, ...(r?.result?.value ?? { error: '평가 실패' }) };
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    await sleep(600);
    try { await rm(profile, { recursive: true, force: true }); } catch {}
  }
}

const out = [];
let port = 37000;
for (const s of SITES) {
  console.log(`\n■ ${s.key}   ${s.url}`);
  try {
    const r = await probe(s, port++);
    out.push(r);
    if (r.error) { console.log('   ', r.error); continue; }
    console.log(`   문서 ${r.docHeight.toLocaleString()}px · DOM ${r.domNodes.toLocaleString()} · tr ${r.tableRows}`);
    if (!r.cands.length) console.log('   쓸 수 있는 후보 없음 (블록 자식 50개 이상인 컨테이너가 없다)');
    for (const c of r.cands) {
      console.log(`   ${String(c.count).padStart(5)}개  ${c.sel.slice(0, 46).padEnd(46)}` +
        ` 중앙값 ${String(c.median).padStart(5)}px  ${String(c.min)}~${String(c.max)}px  변동계수 ${c.cv}  문서의 ${(c.covers*100).toFixed(0)}%`);
    }
    for (const c of r.tableCands) {
      console.log(`   (테이블) ${String(c.count).padStart(5)}개 ${c.sel.slice(0, 40)} — contain:size 적용 안 됨`);
    }
  } catch (e) { console.log('   실패:', e.message); out.push({ ...s, error: e.message }); }
}

await writeFile(new URL('./candidates.json', import.meta.url), JSON.stringify({
  note: 'DOM 을 훑어 content-visibility 를 걸 수 있는 컨테이너를 자동으로 찾는다. 테이블 내부는 제외.',
  generatedAt: new Date().toISOString(), sites: out,
}, null, 2));
console.log('\n✅ candidates.json 저장');
process.exit(0);
