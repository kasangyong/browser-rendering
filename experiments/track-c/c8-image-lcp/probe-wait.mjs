/**
 * C8e — 이미지가 다 내려온 뒤 LCP 까지의 735ms 는 무엇인가
 *
 * C8d 에서 남은 것:
 *   · LCP 이미지의 응답 끝이 FCP 보다 **69ms 빠르다** — 이미지는 첫 페인트 즈음 이미 손에 있다
 *   · 그런데 LCP 까지 742~1,047ms 를 더 기다린다
 *   · Layout 을 절반(876→452ms)으로 줄여도 그 대기는 5~10% 밖에 안 준다 — Layout 이 아니다
 *
 * 추측하지 말고 그 창 안에서 무슨 일이 일어나는지 센다.
 * 첫 갈림길: **메인 스레드가 바쁜가, 놀고 있는가.**
 *   바쁘다 → 무엇이 잡고 있는지 이름별로 쪼갠다
 *   논다   → 메인 스레드 밖(디코드·래스터·합성)이거나 브라우저가 일부러 미루는 것
 *
 * toplevel 카테고리의 RunTask 가 메인 스레드 점유 시간이다.
 * 창 밖으로 걸친 이벤트는 창과 겹치는 만큼만 센다.
 *
 * 사이트 3곳 × 3회, plain 만(cv 는 이 대기를 거의 안 건드린다는 걸 C8d 가 보였다).
 * 콜드 캐시. 읽기만 한다.
 *
 * 사용: node probe-wait.mjs [--reps=3]
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const REPS = Number((process.argv.find(a => a.startsWith('--reps=')) || '--reps=3').split('=')[1]);

/** 껍데기 태스크 — 이름만 보고는 아무것도 못 알려준다. 안에 든 실제 일을 봐야 한다. */
const WRAPPER = new Set(['RunTask', 'ThreadControllerImpl::RunTask', 'ThreadPool_RunTask',
  'MessageLoop::RunTask', 'SequenceManager RunTask', 'ThreadControllerImpl::RunTask.MessagePumpProcessed']);

const SITES = [
  { key: 'turku',       url: 'https://en.wikivoyage.org/wiki/Turku' },
  { key: 'uk',          url: 'https://en.wikivoyage.org/wiki/United_Kingdom' },
  { key: 'philippines', url: 'https://en.wikivoyage.org/wiki/Philippines' },
];

const OBS = '<script>(function(){try{performance.setResourceTimingBufferSize(3000)}catch(x){}' +
  '(function(){window.__lcp=null;window.__all=[];try{' +
  'new PerformanceObserver(function(l){l.getEntries().forEach(function(e){' +
  'window.__all.push({t:+e.startTime.toFixed(1),size:e.size,u:e.url||"",' +
  'tag:e.element?e.element.tagName.toLowerCase():null,' +
  'cls:e.element&&typeof e.element.className==="string"?e.element.className.slice(0,24):"",' +
  'w:e.element?Math.round(e.element.getBoundingClientRect().width):0,' +
  'h:e.element?Math.round(e.element.getBoundingClientRect().height):0});window.__lcp={' +
  't:+e.startTime.toFixed(1),size:e.size,u:e.url||"",' +
  'tag:e.element?e.element.tagName.toLowerCase():null};});' +
  '}).observe({type:"largest-contentful-paint",buffered:true});}catch(x){}})()})()</script>';

const REPORT = `(() => {
  const L = window.__lcp;
  let el = null, res = null;
  if (L && L.u) {
    for (const i of document.images) if (i.currentSrc === L.u || i.src === L.u) { el = i; break; }
    const e = performance.getEntriesByType('resource').find(x => x.name === L.u);
    if (e) res = { start: +e.startTime.toFixed(1), end: +e.responseEnd.toFixed(1),
                   bytes: e.encodedBodySize || 0 };
  }
  const p = performance.getEntriesByType('paint');
  return {
    lcp: L, candidates: window.__all || [], res,
    // 큰 이미지는 디코드가 오래 걸린다. 원본 픽셀 수를 같이 본다.
    img: el ? { natW: el.naturalWidth, natH: el.naturalHeight,
                dispW: Math.round(el.getBoundingClientRect().width),
                dispH: Math.round(el.getBoundingClientRect().height),
                decoding: el.getAttribute('decoding'), loading: el.getAttribute('loading') || 'none',
                type: (el.currentSrc || '').split('.').pop().slice(0, 8) } : null,
    fcp: (p.find(x => x.name === 'first-contentful-paint') || {}).startTime ?? null,
    fp: (p.find(x => x.name === 'first-paint') || {}).startTime ?? null,
  };
})()`;

async function run(site, rep, port) {
  const profile = path.join(SCRATCH, `c8w-${site.key}-${rep}`);
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
                             'loading', 'blink.user_timing', 'toplevel'] } });
    await sleep(200);
    await send('Page.navigate', { url: site.url });
    await Promise.race([onLoad, sleep(60000)]);
    await sleep(2500);
    await send('Tracing.end');
    await Promise.race([done, sleep(90000)]);

    const r = await send('Runtime.evaluate', { expression: REPORT, returnByValue: true, awaitPromise: true });
    if (!r) throw new Error('Runtime.evaluate 응답 없음 — 트레이스 전송에 밀렸을 것');
    const v = r.result?.value ?? {};
    if (!v.lcp) throw new Error('LCP 항목 없음 (관찰자 미작동?)');
    if (!v.res) throw new Error(`LCP 이미지의 리소스 타이밍 없음 (버퍼 초과?) url=${(v.lcp.u||'').slice(-40)}`);

    let nav = null;
    for (const e of evs) if (e.name === 'navigationStart' && nav === null) nav = e.ts;
    if (nav === null) throw new Error('navigationStart 없음 — 트레이스 미수집');

    const W0 = v.res.end, W1 = v.lcp.t;          // 창: 응답 끝 → LCP
    const win = W1 - W0;
    const overlap = e => {
      const s = (e.ts - nav) / 1000, en = s + (e.dur || 0) / 1000;
      return Math.max(0, Math.min(en, W1) - Math.max(s, W0));
    };

    // 렌더러 메인 스레드 = ParseHTML·Layout 이 도는 스레드.
    // 처음엔 RunTask 총량으로 골랐다가 엉뚱한 스레드를 집어서 분해가 통째로 비었다.
    const mark = new Map();
    for (const e of evs) {
      if (e.name !== 'ParseHTML' && e.name !== 'Layout' && e.name !== 'UpdateLayoutTree') continue;
      const k = e.pid + ':' + e.tid;
      mark.set(k, (mark.get(k) || 0) + 1);
    }
    let mainTid = null, best = 0;
    for (const [k, n] of mark) if (n > best) { best = n; mainTid = k; }
    if (!mainTid) throw new Error('렌더러 메인 스레드를 못 찾음');
    // 그 스레드의 RunTask 점유가 곧 메인 스레드 점유 시간
    let busiest = 0;
    for (const e of evs) {
      if (e.name !== 'RunTask' || typeof e.dur !== 'number') continue;
      if (e.pid + ':' + e.tid !== mainTid) continue;
      busiest += overlap(e);
    }

    // 창 안에서 이름별로 쪼갠다 (메인 스레드만)
    const byName = new Map();
    for (const e of evs) {
      if (typeof e.dur !== 'number' || e.ph === 'M') continue;
      if (mainTid && e.pid + ':' + e.tid !== mainTid) continue;
      if (WRAPPER.has(e.name)) continue;
      const o = overlap(e);
      if (o <= 0) continue;
      const c = byName.get(e.name) || { ms: 0, n: 0 };
      c.ms += o; c.n++; byName.set(e.name, c);
    }
    // 창 안에서 '메인 스레드 밖' 에서 일어난 일도 본다 (디코드·래스터)
    const offMain = new Map();
    for (const e of evs) {
      if (typeof e.dur !== 'number' || e.ph === 'M') continue;
      if (!mainTid || e.pid + ':' + e.tid === mainTid) continue;
      const o = overlap(e);
      if (o <= 0) continue;
      const c = offMain.get(e.name) || { ms: 0, n: 0 };
      c.ms += o; c.n++; offMain.set(e.name, c);
    }
    const top = m => [...m.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 10)
      .map(([name, c]) => ({ name, ms: +c.ms.toFixed(1), n: c.n }));

    return { site: site.key, rep, win: +win.toFixed(1), W0: +W0.toFixed(1), W1: +W1.toFixed(1),
      fcp: v.fcp != null ? +v.fcp.toFixed(1) : null, fp: v.fp != null ? +v.fp.toFixed(1) : null,
      mainBusy: +busiest.toFixed(1), img: v.img, bytes: v.res.bytes,
      candidates: v.candidates, main: top(byName), off: top(offMain) };
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    await sleep(800);
    try { await rm(profile, { recursive: true, force: true }); } catch {}
  }
}

const out = [];
let port = 50000;
for (const s of SITES) {
  for (let rep = 0; rep < REPS; rep++) {
    try {
      const r = await run(s, rep, port++);
      out.push(r);
      const idle = r.win - r.mainBusy;
      console.log(`\n■ ${r.site} #${rep}   창 ${r.W0.toFixed(0)} → ${r.W1.toFixed(0)}ms  (${r.win.toFixed(0)}ms)   FCP ${r.fcp?.toFixed(0)}`);
      console.log(`   메인 스레드 점유 ${r.mainBusy.toFixed(0)}ms (${(100 * r.mainBusy / r.win).toFixed(0)}%)` +
        `   유휴 ${idle.toFixed(0)}ms (${(100 * idle / r.win).toFixed(0)}%)` +
        `   → ${idle > r.win * 0.5 ? '메인 스레드는 놀고 있다' : '메인 스레드가 잡고 있다'}`);
      if (r.img) console.log(`   LCP 이미지 원본 ${r.img.natW}×${r.img.natH} → 표시 ${r.img.dispW}×${r.img.dispH}` +
        `  ${(r.bytes / 1024).toFixed(0)}KB  decoding=${r.img.decoding ?? '없음'}  loading=${r.img.loading}`);
      console.log(`   LCP 후보 ${r.candidates.length}개:`);
      for (const c of r.candidates) console.log(`     ${c.t.toFixed(0).padStart(6)}ms  <${c.tag}>`.padEnd(22) +
        `${String(c.size).padStart(8)}px²  ${String(c.w) + '×' + String(c.h)}`.padEnd(22) +
        (c.u ? '★ …' + c.u.slice(-34) : `.${c.cls}`));
      console.log('   창 안 메인 스레드 상위: ' + r.main.slice(0, 5).map(x => `${x.name} ${x.ms}ms(${x.n})`).join(' · '));
      console.log('   창 안 그 외 스레드 상위: ' + r.off.slice(0, 5).map(x => `${x.name} ${x.ms}ms(${x.n})`).join(' · '));
    } catch (e) { console.log(`\n■ ${s.key} #${rep} 실패: ${e.message}`); }
    await sleep(1500);
  }
}
await writeFile(new URL('./wait.json', import.meta.url), JSON.stringify({
  note: '응답 끝 → LCP 사이 735ms 를 창으로 잡고 그 안을 이름별로 쪼갠다',
  generatedAt: new Date().toISOString(), reps: REPS, rows: out }, null, 2));
console.log('\n✅ wait.json 저장');
process.exit(0);
