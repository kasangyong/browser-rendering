/**
 * C6 사전 조사 ③ — 실제 페이지에서 쓸 만한 '단위' 를 고른다
 *
 * ②에서 본문 직계 자식이 19개(wiki) · 3개(MDN) 뿐이고 높이가 21~74,180px 로 제각각이었다.
 * 내 합성 리스트는 4,000개가 전부 109px 였다 — 전제가 완전히 다르다.
 *
 * 한 단계씩 내려가며 후보 선택자들의 개수와 높이 분포를 본다.
 * 변동계수(표준편차/평균)가 작을수록 contain-intrinsic-size 를 하나로 주기 쉽다.
 *
 * 사이트당 1회 로드.
 * 사용: node probe-granularity.mjs
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SITES = [
  { key: 'wiki-uni', url: 'https://en.wikipedia.org/wiki/List_of_Unicode_characters',
    sels: ['.mw-parser-output > *', '.mw-parser-output section > *',
           '.mw-parser-output table', '.mw-parser-output section > table',
           '.mw-parser-output p, .mw-parser-output table, .mw-parser-output h3'] },
  { key: 'mdn-css', url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/Reference',
    sels: ['main > *', '.main-page-content > *', '.main-page-content section',
           '.main-page-content ul', '.main-page-content li'] },
];

const ANALYZE = sels => `(() => {
  const out = [];
  for (const sel of ${JSON.stringify(sels)}) {
    let els = [];
    try { els = [...document.querySelectorAll(sel)]; } catch { continue; }
    if (!els.length) { out.push({ sel, count: 0 }); continue; }
    const hs = els.map(e => e.getBoundingClientRect().height).filter(h => h > 0);
    if (!hs.length) { out.push({ sel, count: els.length, allZero: true }); continue; }
    const s = [...hs].sort((a, b) => a - b);
    const mean = hs.reduce((a, b) => a + b, 0) / hs.length;
    const sd = Math.sqrt(hs.reduce((a, b) => a + (b - mean) ** 2, 0) / hs.length);
    out.push({
      sel, count: els.length,
      median: +s[Math.floor(s.length / 2)].toFixed(0),
      mean: +mean.toFixed(0), min: +s[0].toFixed(0), max: +s[s.length - 1].toFixed(0),
      cv: +(sd / mean).toFixed(2),          // 변동계수 — 작을수록 균일
      total: +hs.reduce((a, b) => a + b, 0).toFixed(0),
    });
  }
  return { docHeight: document.scrollingElement.scrollHeight, rows: out };
})()`;

async function probe(site, port) {
  const profile = path.join(SCRATCH, `c6g-${site.key}`);
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
      { expression: ANALYZE(site.sels), returnByValue: true, awaitPromise: true });
    return { ...site, ...(r?.result?.value ?? { error: '평가 실패' }) };
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    await sleep(600);
    try { await rm(profile, { recursive: true, force: true }); } catch {}
  }
}

const out = [];
let port = 35000;
for (const s of SITES) {
  console.log(`\n■ ${s.key}`);
  const r = await probe(s, port++);
  out.push(r);
  if (r.error) { console.log('  ', r.error); continue; }
  console.log(`  문서 높이 ${r.docHeight.toLocaleString()}px`);
  console.log('  선택자                                     개수   중앙값   최소~최대        변동계수');
  console.log('  ' + '─'.repeat(88));
  for (const x of r.rows) {
    if (!x.count) { console.log(`  ${x.sel.padEnd(42)}      0`); continue; }
    if (x.allZero) { console.log(`  ${x.sel.padEnd(42)}${String(x.count).padStart(7)}   (높이 0)`); continue; }
    console.log(`  ${x.sel.padEnd(42)}${String(x.count).padStart(7)}${String(x.median).padStart(9)}px` +
      `${(x.min + '~' + x.max).padStart(16)}px${String(x.cv).padStart(12)}`);
  }
}

await writeFile(new URL('./granularity.json', import.meta.url), JSON.stringify({
  note: '실제 페이지에서 content-visibility 를 걸 단위 후보. 변동계수가 작을수록 균일해서 다루기 쉽다.',
  generatedAt: new Date().toISOString(), sites: out,
}, null, 2));
console.log('\n✅ granularity.json 저장');
process.exit(0);
