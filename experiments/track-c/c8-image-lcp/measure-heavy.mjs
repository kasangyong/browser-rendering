/**
 * C8d — 레이아웃이 비싼데 LCP 이미지가 eager
 *
 * C8c 에서 조건이 둘로 좁혀졌는데(① LCP 이미지가 lazy ② 레이아웃이 수백 ms),
 * Wikivoyage 3곳은 둘 다 아니어서 분리해 볼 수 없었다.
 *
 * Special:LongPages 로 ②만 만족하는 페이지를 찾았다 — Turku(Layout 1,143ms) ·
 * United Kingdom(361ms) · Philippines(377ms). 셋 다 LCP 가 eager 이미지다.
 *
 * 이번 질문: 요청이 레이아웃을 안 기다리는데도 LCP 가 빨라지는가?
 * LCP 는 다운로드 완료가 아니라 '페인트' 시점이다. 레이아웃이 메인 스레드를
 * 1초 넘게 잡고 있으면 이미지가 일찍 와도 그릴 프레임이 안 나온다.
 *
 * lazy/eager 축은 없다 — 셋 다 실제로 eager 다. 콜드 캐시만.
 *
 * 사전 등록: PREDICTION.md 부칙 4 (U1~U4)
 * 사용: node measure-heavy.mjs [--repeat=6] [--site=all|turku|uk|philippines] [--resume=1]
 */
import { spawn, execFile } from 'node:child_process';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const arg = (n, d) => {
  const m = process.argv.find(a => a.startsWith(`--${n}=`));
  return m ? m.split('=')[1] : d;
};
const REPEAT = Number(arg('repeat', '6'));
const SEED = Number(arg('seed', '20260919191'));
const ONLY = arg('site', 'all');
const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';
const VIEWPORT = { w: 390, h: 844 };

/** probe-target.mjs 가 390×844 에서 확인한 값. intrinsic 은 블록 높이 중앙값. */
const SITES = {
  turku:       { url: 'https://en.wikivoyage.org/wiki/Turku',
                 blocks: '.mw-parser-output section > *', intrinsic: 202 },
  uk:          { url: 'https://en.wikivoyage.org/wiki/United_Kingdom',
                 blocks: '.mw-parser-output section > *', intrinsic: 182 },
  philippines: { url: 'https://en.wikivoyage.org/wiki/Philippines',
                 blocks: '.mw-parser-output section > *', intrinsic: 182 },
};


const MODES = ['plain', 'cv-auto'];
const CACHES = ['cold'];           // C8b 는 콜드만 — warm 에서는 lazy/eager 가 의미 없다
const LAZYS = ['asis'];            // 셋 다 실제로 eager 다. 조작하지 않는다
const STAGES = ['ParseHTML', 'UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint', 'RasterTask'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
function shuffled(arr, seed) {
  const a = [...arr]; let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const chromeCount = () => new Promise(res => {
  execFile('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], (e, out) => {
    if (e || !out) return res(-1);
    res(out.split('\n').filter(l => /chrome\.exe/i.test(l)).length);
  });
});
async function waitQuiet(baseline) {
  for (let i = 0; i < 60; i++) {
    if ((await chromeCount()) <= baseline) { await sleep(3000); return; }
    await sleep(500);
  }
  await sleep(3000);
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); this.dead = null;
    const die = why => { this.dead = new Error('CDP 끊김: ' + why);
      for (const [, p] of this.pending) p.reject(this.dead); this.pending.clear(); };
    ws.addEventListener('close', () => die('close'), { once: true });
    ws.addEventListener('error', () => die('error'), { once: true });
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) { const p = this.pending.get(m.id); if (!p) return;
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error).slice(0, 200))) : p.resolve(m.result);
      } else { const h = this.handlers.get(m.method); if (h) h(m.params); }
    });
  }
  send(method, params = {}, timeoutMs = 120000) {
    if (this.dead) return Promise.reject(this.dead);
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error('CDP 응답 없음 ' + method)); }, timeoutMs);
      this.pending.set(id, { resolve: v => { clearTimeout(t); res(v); }, reject: e => { clearTimeout(t); rej(e); } });
    });
  }
  on(m, f) { this.handlers.set(m, f); }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 160));
    return r.result.value;
  }
}
const connect = async url => {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WS 실패')), { once: true });
  });
  return new CDP(ws);
};

/** HTML 에 같이 심는 LCP 관찰자. 양쪽 팔 동일. */
const LCP_OBSERVER =
  '<script>(function(){window.__lcp=null;try{new PerformanceObserver(function(l){' +
  'var es=l.getEntries(),e=es[es.length-1];if(!e)return;window.__lcp={' +
  't:+e.startTime.toFixed(1),size:e.size,isImg:!!e.url,u:e.url||"",' +
  'tag:e.element?e.element.tagName.toLowerCase():null};' +
  '}).observe({type:"largest-contentful-paint",buffered:true});}catch(x){}})()</script>';

async function once({ port, tag, siteKey, mode, cache, lazy }) {
  const S = SITES[siteKey];
  const profile = path.join(SCRATCH, `c8-${tag}`);
  await mkdir(profile, { recursive: true });
  const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--hide-scrollbars', `--window-size=${VIEWPORT.w},${VIEWPORT.h}`, 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { await sleep(350);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {} }
  try {
    const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    const page = await connect(t.webSocketDebuggerUrl);
    await page.send('Page.enable'); await page.send('Runtime.enable');
    await page.send('Network.enable');

    // ── ① 캐시 데우기 (측정 안 함) ─────────────────────────
    // cold 에서는 이 단계를 건너뛴다. 빈 프로필의 첫 로드가 곧 측정 대상이다.
    // 이미지 LCP 에서 다운로드는 잡음이 아니라 현상이다 — PREDICTION.md 부칙 참고.
    let probe = null;
    if (cache === 'warm') {
      const warm = new Promise(r => page.on('Page.loadEventFired', r));
      await page.send('Page.navigate', { url: S.url });
      await Promise.race([warm, sleep(45000)]);
      await sleep(2500);
      probe = await page.evaluate(
        `({ blocks: document.querySelectorAll(${JSON.stringify(S.blocks)}).length,
            h: document.scrollingElement.scrollHeight,
            imgs: document.images.length,
            dom: document.querySelectorAll('*').length })`).catch(() => null);
    }

    // ── ② HTML 응답을 가로채 <style> 을 심는다 ────────────
    // plain 도 똑같이 가로채되 빈 스타일을 넣는다 — 가로채기 부하를 양쪽에 동일하게.
    const css = mode === 'cv-auto'
      ? `${S.blocks}{content-visibility:auto;contain-intrinsic-size:auto ${S.intrinsic}px}`
      : '';
    const inject = `<style id="__c8">${css}</style>` + LCP_OBSERVER;
    await page.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Response', resourceType: 'Document' }],
    });
    page.on('Fetch.requestPaused', async p => {
      try {
        const body = await page.send('Fetch.getResponseBody', { requestId: p.requestId });
        let html = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
        const m = html.match(/<head[^>]*>/i);
        html = m ? html.replace(m[0], m[0] + inject) : inject + html;
        // 대조군: loading 속성이 '없는' img 에만 lazy 를 붙인다.
        // C8b 처럼 판을 뒤집지 않는다 — Paris 기준 246개 중 67개만 바뀐다.
        if (lazy === 'forced') {
          const parts = html.split('<img ');
          for (let i = 1; i < parts.length; i++) {
            const end = parts[i].indexOf('>');
            if (end < 0) continue;
            if (parts[i].slice(0, end).includes('loading=')) continue;
            parts[i] = 'loading="lazy" ' + parts[i];
          }
          html = parts.join('<img ');
        }
        await page.send('Fetch.fulfillRequest', {
          requestId: p.requestId,
          responseCode: p.responseStatusCode ?? 200,
          responseHeaders: p.responseHeaders,
          body: Buffer.from(html, 'utf8').toString('base64'),
        });
      } catch {
        await page.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
      }
    });

    // ── ③ 두 번째 로드를 측정한다 ──────────────────────────
    const evs = [];
    page.on('Tracing.dataCollected', p => { if (p.value) evs.push(...p.value); });
    const done = new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('tracingComplete 안 옴')), 120000);
      page.on('Tracing.tracingComplete', v => { clearTimeout(to); res(v); });
    });
    await page.send('Tracing.start', {
      transferMode: 'ReportEvents',
      traceConfig: { recordMode: 'recordAsMuchAsPossible',
        includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline',
                             'blink', 'loading', 'blink.user_timing'] },
    });
    await sleep(200);
    const loaded = new Promise(r => page.on('Page.loadEventFired', r));
    await page.send('Page.navigate', { url: S.url });
    await Promise.race([loaded, sleep(45000)]);
    await sleep(2500);                       // LCP 확정 대기
    await page.send('Tracing.end');
    await done;

    const dur = {}, cnt = {};
    let navStart = null, fcp = null, lcp = null;
    for (const e of evs) {
      if (e.ph === 'M') continue;
      cnt[e.name] = (cnt[e.name] || 0) + 1;
      if (typeof e.dur === 'number') dur[e.name] = (dur[e.name] || 0) + e.dur / 1000;
      if (e.name === 'navigationStart' && navStart === null) navStart = e.ts;
      if (e.name === 'firstContentfulPaint' && fcp === null) fcp = e.ts;
      if (e.name === 'largestContentfulPaint::Candidate') lcp = e.ts;
    }
    const stage = {};
    for (const s of STAGES) stage[s] = { n: cnt[s] || 0, ms: +(dur[s] || 0).toFixed(2) };
    // LCP 이미지가 **언제 다 내려왔는지**를 같이 본다.
    // LCP 가 다운로드에 묶여 있다면 lcp.t ≈ responseEnd 일 것이다 — S6 의 직접 증거.
    const after = await page.evaluate(
      `(() => { const L = window.__lcp || null;
        let res = null;
        if (L && L.u) { const e = performance.getEntriesByType('resource').find(x => x.name === L.u);
          if (e) res = { start: +e.startTime.toFixed(1), end: +e.responseEnd.toFixed(1),
                         size: e.encodedBodySize || 0 }; }
        return { h: document.scrollingElement.scrollHeight,
                 blocks: document.querySelectorAll(${JSON.stringify(S.blocks)}).length,
                 applied: !!document.getElementById('__c8'),
                 imgLazy: [...document.images].filter(i => i.getAttribute('loading') === 'lazy').length,
                 imgTotal: document.images.length,
                 lcpLoading: (() => { if (!L || !L.u) return null;
                   for (const im of document.images) if (im.currentSrc === L.u || im.src === L.u)
                     return im.getAttribute('loading') || 'none';
                   return null; })(),
                 lcp: L, lcpRes: res }; })()`).catch(() => null);
    await page.send('Browser.close').catch(() => {});

    return {
      siteKey, mode, cache, lazy,
      fcpMs: navStart && fcp ? +((fcp - navStart) / 1000).toFixed(1) : null,
      lcpMs: navStart && lcp ? +((lcp - navStart) / 1000).toFixed(1) : null,
      lcpEl: after?.lcp ?? null,             // 요소가 이미지였나 텍스트였나
      lcpRes: after?.lcpRes ?? null,
      imgLazy: after?.imgLazy ?? null,
      lcpLoading: after?.lcpLoading ?? null,         // 그 이미지의 다운로드 완료 시각
      stage, probe, after,
      cvApplied: mode === 'cv-auto' ? !!after?.applied : null,
    };
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    try { await rm(profile, { recursive: true, force: true }); } catch {}
  }
}

// 락은 내가 만든 안전장치다. 손으로 치우지 않는다 (방법론 20조 — C7 에서 그래서 12행만 남았다).
const LOCK = path.join(import.meta.dirname, '.measure-heavy.lock');
if (existsSync(LOCK)) {
  const pid = Number((await readFile(LOCK, 'utf8')).trim());
  let alive = false; try { process.kill(pid, 0); alive = true; } catch {}
  if (alive) { console.error(`이미 실행 중 (pid ${pid})`); process.exit(1); }
}
await writeFile(LOCK, String(process.pid));
const unlock = () => { try { unlinkSync(LOCK); } catch {} };
process.on('exit', unlock);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { unlock(); process.exit(1); });

const OUT = path.join(import.meta.dirname, 'results-heavy.json');
const out = { experiment: 'c8d-heavy-eager', generatedAt: new Date().toISOString(),
              repeat: REPEAT, sites: SITES, viewport: VIEWPORT,
              caches: CACHES, lazys: LAZYS,
              method: 'warm=캐시 데운 뒤 2차 로드 / cold=빈 프로필 첫 로드 · cv 는 HTML 파싱 시점 주입 · LCP 요소·다운로드 시각 동시 기록',
              isolation: 'strict', order: 'shuffled', rows: [] };
const save = () => writeFile(OUT, JSON.stringify(out, null, 2));
if (arg('resume', '0') === '1' && existsSync(OUT)) {
  out.rows = (JSON.parse(await readFile(OUT, 'utf8')).rows) || [];
  console.log(`↻ 재개: ${out.rows.length}건 보유`);
}

const keys = ONLY === 'all' ? Object.keys(SITES) : [ONLY];
const plan = [];
for (const k of keys) for (const m of MODES) for (const c of CACHES) for (const z of LAZYS)
  for (let r = 0; r < REPEAT; r++) plan.push({ siteKey: k, mode: m, cache: c, lazy: z, rep: r });
const order = shuffled(plan, SEED);
const BASELINE = await chromeCount();
console.log(`\nC8d 비싼 레이아웃 + eager — 사이트 ${keys.length}곳 × 모드 ${MODES.length} × ${REPEAT}회 = ${order.length}회 (콜드)`);
console.log(`뷰포트 ${VIEWPORT.w}×${VIEWPORT.h} (모바일) · 기준선 chrome ${BASELINE}개 · 순서 섞음\n`);

let port = 49000 + Math.floor(Math.random() * 300);
let i = 0;
for (const job of order) {
  i++;
  const key = `${job.siteKey}|${job.mode}|${job.lazy}|${job.rep}`;
  if (out.rows.some(r => `${r.siteKey}|${r.mode}|${r.lazy}|${r.rep}` === key)) continue;
  await waitQuiet(BASELINE);
  port++;
  try {
    const v = await once({ port, tag: `${job.siteKey}-${job.mode}-${job.lazy}-${job.rep}`, ...job });
    out.rows.push({ ...v, rep: job.rep });
    await save();
    console.log(`  ${String(i).padStart(2)}/${order.length}  ${job.siteKey.padEnd(9)}${job.mode.padEnd(9)}${job.lazy.padEnd(7)}` +
      `FCP ${String(v.fcpMs ?? '-').padStart(7)}  LCP ${String(v.lcpMs ?? '-').padStart(7)}` +
      `  ${(v.lcpEl ? (v.lcpEl.isImg ? '이미지' : '텍스트') : 'LCP?').padEnd(7)}` +
      `내려받음 ${String(v.lcpRes ? Math.round(v.lcpRes.end) : '-').padStart(6)}` +
      `  Layout ${String(v.stage.Layout.ms).padStart(7)}` +
      `  LCP이미지 ${String(v.lcpLoading ?? '?').padEnd(5)} lazy ${v.after ? v.after.imgLazy + '/' + v.after.imgTotal : '?'}` +
      (v.mode === 'cv-auto' ? `  주입 ${v.cvApplied ? 'OK' : '❌'}` : ''));
  } catch (e) {
    console.error(`  ${i}/${order.length} 실패 (${key}): ${e.message}`);
  }
}
await save();
console.log('\n✅ results-heavy.json 저장 —  node analyze-heavy.mjs');
process.exit(0);
