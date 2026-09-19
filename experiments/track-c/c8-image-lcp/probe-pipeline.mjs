/**
 * C8f — 426ms 는 파이프라인 어디인가
 *
 * C8e 가 남긴 것: 배너가 최종 크기로 레이아웃되고 complete=true 가 된 뒤에도
 * LCP 가 보고하는 renderTime 까지 262~584ms(중앙값 426ms)가 더 걸린다.
 * 그 동안 프레임은 계속 나오지만 57~84ms 간격으로 느리다.
 *
 * 추측하지 말고 **그 배너를 언급하는 트레이스 이벤트를 전부** 뽑는다.
 * 파일명 토큰(예: Stonehenge_banner)으로 args 를 통째로 훑으면
 * 요청·응답·디코드·페인트가 시간순으로 줄지어 나온다.
 *
 * 같이: 창 안의 프레임 파이프라인 이벤트(Commit · ActivateLayerTree · DrawFrame)와
 *       래스터/디코드 태스크 — 어느 단계가 창을 채우는지 본다.
 *
 * 사이트 3곳 × 2회, 콜드 캐시, plain 만. 읽기만 한다.
 * 사용: node probe-pipeline.mjs [--reps=2]
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const REPS = Number((process.argv.find(a => a.startsWith('--reps=')) || '--reps=2').split('=')[1]);

const SITES = [
  { key: 'uk',          url: 'https://en.wikivoyage.org/wiki/United_Kingdom', intrinsic: 182 },
  { key: 'philippines', url: 'https://en.wikivoyage.org/wiki/Philippines', intrinsic: 182 },
];
const BLOCKS = '.mw-parser-output section > *';
// A 가 레이아웃 때문인지 직접 검정한다 — cv 로 Layout 을 반으로 줄이면 A 가 줄어야 한다.
const MODES = ['plain', 'cv-auto'];

/** C8e 와 같은 추적기 — 배너가 최종 크기·complete 가 되는 시각을 프레임 단위로 찍는다. */
const OBS = '<script>' +
  'try{performance.setResourceTimingBufferSize(3000)}catch(x){}' +
  '(function(){window.__lcp=null;window.__ban=[];window.__ft=[];var bstate="";' +
  'try{new PerformanceObserver(function(l){l.getEntries().forEach(function(e){' +
  'window.__lcp={t:+e.startTime.toFixed(1),size:e.size,u:e.url||""};});' +
  '}).observe({type:"largest-contentful-paint",buffered:true});}catch(x){}' +
  'function tick(){window.__ft.push(+performance.now().toFixed(0));' +
  ' var bn=null,bna=0,ims=document.images;' +
  ' for(var i=0;i<ims.length;i++){var im=ims[i],r=im.getBoundingClientRect();' +
  '  var a=r.width*r.height;' +
  '  if((im.currentSrc||"").indexOf("utm_content=thumbnail")>=0&&a>bna){bna=a;bn=im;}}' +
  ' if(bn){var br=bn.getBoundingClientRect();' +
  '  var st=Math.round(br.width)+"x"+Math.round(br.height)+"/"+bn.complete;' +
  '  if(st!==bstate){bstate=st;window.__ban.push({t:+performance.now().toFixed(1),' +
  '   w:Math.round(br.width),h:Math.round(br.height),complete:bn.complete});}}' +
  ' if(performance.now()<6000)requestAnimationFrame(tick);}' +
  'requestAnimationFrame(tick);})()</script>';

const REPORT = `(() => {
  const L = window.__lcp;
  const r = L && L.u ? performance.getEntriesByType('resource').find(x => x.name === L.u) : null;
  return { lcp: L, ban: window.__ban, ft: window.__ft,
    bannerEnd: r ? +r.responseEnd.toFixed(1) : null,
    fcp: (performance.getEntriesByType('paint').find(x => x.name === 'first-contentful-paint') || {}).startTime ?? null };
})()`;

async function run(site, mode, rep, port) {
  const profile = path.join(SCRATCH, `c8p-${site.key}-${mode}-${rep}`);
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
      return new Promise(r => { const to = setTimeout(() => { pend.delete(i); r(null); }, 90000);
        pend.set(i, v => { clearTimeout(to); r(v); }); }); };

    await send('Page.enable'); await send('Runtime.enable');
    await send('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Response', resourceType: 'Document' }] });
    handlers.set('Fetch.requestPaused', async p => {
      try {
        const body = await send('Fetch.getResponseBody', { requestId: p.requestId });
        let html = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
        const m = html.match(/<head[^>]*>/i);
        const css = mode === 'cv-auto'
          ? `<style id="__c8f">${BLOCKS}{content-visibility:auto;contain-intrinsic-size:auto ${site.intrinsic}px}</style>` : '';
        html = m ? html.replace(m[0], m[0] + css + OBS) : css + OBS + html;
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
                             'disabled-by-default-devtools.timeline.frame',
                             'blink.user_timing', 'loading', 'toplevel'] } });
    await sleep(200);
    await send('Page.navigate', { url: site.url });
    await Promise.race([onLoad, sleep(60000)]);
    await sleep(6500);
    await send('Tracing.end');
    await Promise.race([done, sleep(120000)]);

    const rr = await send('Runtime.evaluate', { expression: REPORT, returnByValue: true, awaitPromise: true });
    if (!rr) throw new Error('Runtime.evaluate 응답 없음');
    const v = rr.result?.value ?? {};
    if (!v.lcp || !v.lcp.u) throw new Error('LCP 이미지 항목 없음');
    if (!v.ban?.length) throw new Error('배너를 한 프레임도 못 잡았다');

    let nav = null;
    for (const e of evs) if (e.name === 'navigationStart' && nav === null) nav = e.ts;
    if (nav === null) throw new Error('navigationStart 없음');
    const rel = e => (e.ts - nav) / 1000;

    // 배너 파일명 토큰 — 이걸로 args 를 통째로 훑는다
    const file = decodeURIComponent((v.lcp.u.split('?')[0].split('/').pop() || ''));
    const token = file.replace(/^\d+px-/, '').slice(0, 26);
    const mentions = [];
    for (const e of evs) {
      if (!e.args) continue;
      let j; try { j = JSON.stringify(e.args); } catch { continue; }
      if (!j.includes(token)) continue;
      mentions.push({ name: e.name, t: +rel(e).toFixed(1), dur: e.dur ? +(e.dur / 1000).toFixed(2) : null,
                      tid: e.tid, ph: e.ph });
    }
    mentions.sort((a, b) => a.t - b.t);

    // 창: 배너가 최종 크기 + complete 가 된 시각 → LCP
    const B = v.ban.filter(x => x.w >= 470 && x.w <= 490 && x.h >= 170 && x.h <= 190);
    const ready = B.length ? (B.find(x => x.complete) || B[0]).t : null;
    const W1 = v.lcp.t;
    const inWin = (e) => {
      if (ready == null) return 0;
      const s = rel(e), en = s + (e.dur || 0) / 1000;
      return Math.max(0, Math.min(en, W1) - Math.max(s, ready));
    };
    const stage = new Map();
    const STAGES = ['Commit', 'ActivateLayerTree', 'DrawFrame', 'BeginMainThreadFrame', 'RasterTask',
                    'ImageDecodeTask', 'Decode Image', 'PaintImage', 'Paint', 'Layout',
                    'UpdateLayoutTree', 'PrePaint', 'CompositeLayers', 'NeedsBeginFrameChanged'];
    for (const e of evs) {
      if (!STAGES.includes(e.name)) continue;
      const o = inWin(e);
      const c = stage.get(e.name) || { ms: 0, n: 0, first: null, last: null };
      if (o > 0 || (ready != null && rel(e) >= ready && rel(e) <= W1)) {
        c.ms += o; c.n++;
        if (c.first == null) c.first = +rel(e).toFixed(1);
        c.last = +rel(e).toFixed(1);
        stage.set(e.name, c);
      }
    }
    // A = 준비 → 배너가 실제로 PaintImage 되는 시각, B = 그 뒤 LCP 후보까지
    const pi = mentions.find(m => m.name === 'PaintImage');
    const cand = mentions.find(m => m.name.includes('Candidate'));
    return { site: site.key, mode, rep, lcp: v.lcp, fcp: v.fcp, bannerEnd: v.bannerEnd,
      paintImageT: pi ? pi.t : null, candT: cand ? cand.t : null,
      A: pi && ready != null ? +(pi.t - ready).toFixed(1) : null,
      B: pi && cand ? +(cand.t - pi.t).toFixed(1) : null,
      layoutMs: (() => { let x = 0; for (const e of evs) if (e.name === 'Layout' && e.dur) x += e.dur / 1000; return +x.toFixed(1); })(),
      ready, win: ready != null ? +(W1 - ready).toFixed(1) : null,
      token, mentions: mentions.slice(0, 24), events: evs.length,
      stages: [...stage.entries()].map(([name, c]) => ({ name, ...c })).sort((a, b) => b.ms - a.ms),
      frames: v.ft.filter(t => ready != null && t >= ready && t <= W1).length };
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    await sleep(800);
    try { await rm(profile, { recursive: true, force: true }); } catch {}
  }
}

const out = [];
let port = 52000;
const plan = [];
for (const st of SITES) for (const m of MODES) for (let r = 0; r < REPS; r++) plan.push({ st, m, r });
let seed = 20260920;
for (let i = plan.length - 1; i > 0; i--) {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  const j = Math.floor((seed / 0x7fffffff) * (i + 1));
  [plan[i], plan[j]] = [plan[j], plan[i]];
}
console.log(`
파이프라인 분해 — ${SITES.length}곳 × ${MODES.length}모드 × ${REPS}회 = ${plan.length}회 (순서 섞음)
`);
for (const job of plan) {
  try {
    const r = await run(job.st, job.m, job.r, port++);
    out.push(r);
    console.log(`  ${job.st.key.padEnd(12)}${job.m.padEnd(9)}#${job.r}  준비 ${String(r.ready).padStart(7)}  PaintImage ${String(r.paintImageT).padStart(7)}  LCP후보 ${String(r.candT).padStart(7)}` +
      `  │ A ${String(r.A).padStart(7)}ms  B ${String(r.B).padStart(6)}ms  │ Layout ${String(r.layoutMs).padStart(7)}ms`);
  } catch (e) { console.log(`  ${job.st.key} ${job.m} #${job.r} 실패: ${e.message}`); }
  await sleep(1500);
}
const med = a => { const x = [...a].filter(v => v != null).sort((p, q) => p - q);
  return x.length ? x[Math.floor(x.length / 2)] : null; };
console.log('\n' + '사이트        모드       A 중앙값   B 중앙값   Layout 중앙값');
console.log('  ' + '-'.repeat(58));
for (const st of SITES) for (const m of MODES) {
  const rs = out.filter(r => r.site === st.key && r.mode === m);
  if (!rs.length) continue;
  console.log('  ' + st.key.padEnd(14) + m.padEnd(10) +
    String(med(rs.map(r => r.A))).padStart(9) + String(med(rs.map(r => r.B))).padStart(11) +
    String(med(rs.map(r => r.layoutMs))).padStart(14));
}
await writeFile(new URL('./pipeline.json', import.meta.url), JSON.stringify({
  note: '배너가 준비된 뒤 LCP 까지의 426ms 안에서 무슨 일이 일어나는지 센다',
  generatedAt: new Date().toISOString(), reps: REPS, rows: out }, null, 2));
console.log('\n✅ pipeline.json 저장');
process.exit(0);
