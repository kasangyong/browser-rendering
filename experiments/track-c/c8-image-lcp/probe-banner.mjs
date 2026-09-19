/**
 * C8e-2 — 배너가 '언제 최종 크기에 도달하는가'
 *
 * probe-wait 이 밝힌 것:
 *   · LCP 요소는 Wikivoyage pagebanner (…banner.jpg?utm_campaign=index)
 *   · 배너는 832~946ms 에 다 내려오는데 LCP 후보가 되는 건 1312~1868ms
 *   · 그 사이에 <p> 가 먼저 후보가 된다 (70,970~84,783px²).
 *     최종 배너는 85,801~85,920px² — Philippines 는 **1.3% 차이**로 이긴다
 *
 * 남은 갈림길: 배너가 **늦게 커지는가**, 아니면 크기는 일찍 정해졌는데 **늦게 그려지는가**.
 *   늦게 커진다 → 원인은 늦게 오는 스타일(ResourceLoader 모듈)
 *   늦게 그려진다 → 원인은 페인트·디코드 쪽
 *
 * 매 프레임 가장 큰 이미지의 면적을 재서, 배너가 최종 크기에 닿는 시각을 찍는다.
 * 같이: load.php(ResourceLoader) 응답 시각 — 늦게 오는 스타일이 범인이면 여기 붙어야 한다.
 *
 * 사이트 3곳 × 2회, 콜드 캐시. 읽기만 한다.
 * 사용: node probe-banner.mjs [--reps=2]
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const REPS = Number((process.argv.find(a => a.startsWith('--reps=')) || '--reps=2').split('=')[1]);

const SITES = [
  { key: 'turku',       url: 'https://en.wikivoyage.org/wiki/Turku' },
  { key: 'uk',          url: 'https://en.wikivoyage.org/wiki/United_Kingdom' },
  { key: 'philippines', url: 'https://en.wikivoyage.org/wiki/Philippines' },
];

/**
 * 매 프레임 '가장 큰 이미지' 의 면적을 재고, 바뀔 때만 기록한다.
 * 배너를 선택자로 집지 않는다 — 선택자를 추측하면 또 틀린다 (C6 에서 배운 것).
 */
const OBS = '<script>' +
  'try{performance.setResourceTimingBufferSize(3000)}catch(x){}' +
  '(function(){window.__lcp=null;window.__grow=[];window.__ban=[];window.__ft=[];' +
  'try{new PerformanceObserver(function(l){l.getEntries().forEach(function(e){' +
  'window.__lcp={t:+e.startTime.toFixed(1),size:e.size,u:e.url||""};});' +
  '}).observe({type:"largest-contentful-paint",buffered:true});}catch(x){}' +
  'var best=0,bstate="";' +
  'function tick(){window.__ft.push(+performance.now().toFixed(0));' +
  ' var vh=innerHeight,b=null,ba=0,bn=null,bna=0,ims=document.images;' +
  ' for(var i=0;i<ims.length;i++){var im=ims[i],r=im.getBoundingClientRect();' +
  '  var a=r.width*r.height;' +
  // 배너 후보: thumb URL 을 쓰는 이미지 중 '가장 큰 것'. 아이콘도 같은 UTM 을 달고 있어서
  // 처음엔 20x20 아이콘까지 잡혀 기록이 수천 줄이 됐다.
  '  if((im.currentSrc||"").indexOf("utm_content=thumbnail")>=0&&a>bna){bna=a;bn=im;}' +
  // LCP 는 뷰포트 안만 센다. 이 조건을 빼서 화면 밖 큰 이미지를 잡은 적이 있다.
  '  if(r.top>=vh||r.bottom<=0)continue;' +
  '  if(a>ba){ba=a;b=im;}}' +
  ' if(bn){var br=bn.getBoundingClientRect();' +
  '  var st=Math.round(br.width)+"x"+Math.round(br.height)+"/"+bn.complete;' +
  '  if(st!==bstate){bstate=st;window.__ban.push({t:+performance.now().toFixed(1),' +
  '   w:Math.round(br.width),h:Math.round(br.height),top:Math.round(br.top),' +
  '   a:Math.round(br.width*br.height),complete:bn.complete});}}' +
  ' if(b&&ba>best*1.02){best=ba;' +
  '  window.__grow.push({t:+performance.now().toFixed(1),a:Math.round(ba),' +
  '   top:Math.round(b.getBoundingClientRect().top),' +
  '   complete:b.complete,u:(b.currentSrc||"").slice(-30)});}' +
  ' if(performance.now()<6000)requestAnimationFrame(tick);}' +
  'requestAnimationFrame(tick);})()</script>';

const REPORT = `(() => {
  const res = performance.getEntriesByType('resource');
  const rl = res.filter(r => r.name.includes('load.php'))
    .map(r => ({ end: +r.responseEnd.toFixed(1), kind: /modules=([^&]*)/.exec(r.name)?.[1]?.slice(0, 46) ?? '',
                 only: /only=(\\w+)/.exec(r.name)?.[1] ?? '' }))
    .sort((a, b) => a.end - b.end);
  const L = window.__lcp;
  const banner = L && L.u ? res.find(r => r.name === L.u) : null;
  return {
    lcp: L, grow: window.__grow, ban: window.__ban, frames: window.__ft.length, ft: window.__ft,
    bannerEnd: banner ? +banner.responseEnd.toFixed(1) : null,
    rl: rl.slice(0, 8),
    fcp: (performance.getEntriesByType('paint').find(x => x.name === 'first-contentful-paint') || {}).startTime ?? null,
    styleSheets: document.styleSheets.length,
  };
})()`;

async function run(site, rep, port) {
  const profile = path.join(SCRATCH, `c8b-${site.key}-${rep}`);
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
      return new Promise(r => { const to = setTimeout(() => { pend.delete(i); r(null); }, 60000);
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
    await send('Page.navigate', { url: site.url });
    await Promise.race([onLoad, sleep(60000)]);
    await sleep(7000);                       // rAF 추적이 6초까지 돈다
    const r = await send('Runtime.evaluate', { expression: REPORT, returnByValue: true, awaitPromise: true });
    if (!r) throw new Error('Runtime.evaluate 응답 없음');
    const v = r.result?.value ?? {};
    if (!v.frames) throw new Error('rAF 추적이 안 돌았다 — 주입 실패');
    if (!v.ban || !v.ban.length) throw new Error('배너를 한 프레임도 못 잡았다 — 선택 조건 확인');
    return { site: site.key, rep, ...v };
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    await sleep(700);
    try { await rm(profile, { recursive: true, force: true }); } catch {}
  }
}

const out = [];
let port = 51000;
for (const s of SITES) {
  for (let rep = 0; rep < REPS; rep++) {
    try {
      const r = await run(s, rep, port++);
      out.push(r);
      console.log(`\n■ ${r.site} #${rep}   FCP ${r.fcp?.toFixed(0)}ms · 배너 응답끝 ${r.bannerEnd}ms · LCP ${r.lcp?.t}ms · rAF ${r.frames}프레임 · 스타일시트 ${r.styleSheets}`);
      console.log('   가장 큰 이미지의 면적이 커지는 시각:');
      for (const g of r.grow)
        console.log(`     ${String(g.t).padStart(7)}ms  ${String(g.a).padStart(7)}px²  top ${String(g.top).padStart(5)}  complete=${g.complete}  …${g.u}`);
      // 배너가 준비된 뒤 LCP 까지 프레임이 얼마나 나왔나 — 멈춰 있었다면 여기서 드러난다
      console.log('   배너 자체의 크기 변화:');
      for (const g of r.ban.slice(0, 8)) console.log(`     ${String(g.t).padStart(7)}ms  ${(g.w + '×' + g.h).padEnd(9)} ${String(g.a).padStart(7)}px²  top ${String(g.top).padStart(5)}  complete=${g.complete}`);
      const ready = (r.ban[r.ban.length - 1] || {}).t;
      if (ready != null && r.lcp) {
        const between = r.ft.filter(t => t >= ready && t <= r.lcp.t);
        let maxGap = 0, at = 0;
        for (let i = 1; i < between.length; i++)
          if (between[i] - between[i - 1] > maxGap) { maxGap = between[i] - between[i - 1]; at = between[i - 1]; }
        console.log(`   배너 준비 ${ready}ms → LCP ${r.lcp.t}ms 사이 프레임 ${between.length}개` +
          `   최대 공백 ${maxGap}ms (${at}ms 부터)`);
      }
      console.log('   ResourceLoader 응답:');
      for (const x of r.rl.slice(0, 4)) console.log(`     ${String(x.end).padStart(7)}ms  only=${(x.only || '-').padEnd(8)} ${x.kind}`);
    } catch (e) { console.log(`\n■ ${s.key} #${rep} 실패: ${e.message}`); }
    await sleep(1500);
  }
}
await writeFile(new URL('./banner.json', import.meta.url), JSON.stringify({
  note: '배너가 최종 크기에 닿는 시각을 프레임 단위로 추적한다',
  generatedAt: new Date().toISOString(), reps: REPS, rows: out }, null, 2));
console.log('\n✅ banner.json 저장');
process.exit(0);
