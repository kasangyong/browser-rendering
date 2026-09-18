/**
 * C2 — 남겨둔 이상치 세 개를 판별한다
 *
 * ① auto 키워드가 A4 의 O(N) 원인인가   (모드 × 무효화 × N 완전 격자)
 * ② 점프형에서 정확한 값이 느렸던 건 '일을 더 해서'인가
 * ③ transform 의 commit 7배는 선형인가 임계점인가
 *
 * 설정마다 Chrome 을 새로 띄운다 (A2 에서 공유 브라우저가 오염되는 걸 겪었다)
 * 사용: node measure.mjs [--part=1|2|3|all] [--repeat=3]
 */
import { spawn } from 'node:child_process';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const arg = (n, d) => {
  const m = process.argv.find(a => a.startsWith(`--${n}=`));
  return m ? m.split('=')[1] : d;
};
const PART = arg('part', 'all');
const REPEAT = Number(arg('repeat', '3'));
const N2 = Number(arg('n2', '4000'));   // ② 의 항목 수 (A4b 와 맞추려면 8000)
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';
const BASE = 'http://127.0.0.1:8765';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/** 최소제곱 직선 적합 + 결정계수 */
function linfit(xs, ys) {
  const n = xs.length, mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const slope = sxy / sxx, intercept = my - slope * mx;
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < n; i++) {
    ssRes += (ys[i] - (slope * xs[i] + intercept)) ** 2;
    ssTot += (ys[i] - my) ** 2;
  }
  return { slope, intercept, r2: 1 - ssRes / ssTot };
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); this.dead = null;
    // 렌더러가 죽으면 소켓만 닫히고 대기 중인 promise 는 영원히 안 풀린다.
    // 그러면 이벤트 루프가 비면서 "unsettled top-level await" 로 조용히 종료된다 — 1500 레이어에서 겪었다.
    const die = why => {
      this.dead = new Error(`CDP 연결 끊김: ${why}`);
      for (const [, p] of this.pending) p.reject(this.dead);
      this.pending.clear();
    };
    ws.addEventListener('close', e => die(`close ${e.code ?? ''}`.trim()), { once: true });
    ws.addEventListener('error', () => die('error'), { once: true });
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined) {
        const p = this.pending.get(m.id); if (!p) return;
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
      } else { const h = this.handlers.get(m.method); if (h) h(m.params); }
    });
  }
  send(method, params = {}, timeoutMs = 90000) {
    if (this.dead) return Promise.reject(this.dead);
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`CDP 응답 없음 (${method}, ${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve: v => { clearTimeout(t); res(v); },
                            reject: e => { clearTimeout(t); rej(e); } });
    });
  }
  on(m, f) { this.handlers.set(m, f); }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
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

async function launchOnce(port, profile) {
  await mkdir(profile, { recursive: true });
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--hide-scrollbars', '--window-size=1280,900', 'about:blank',
  ], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    await sleep(350);
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return proc; }
    catch { /* 기동 대기 */ }
  }
  try { proc.kill('SIGKILL'); } catch {}
  return null;
}

/** 포트 충돌 등 일시적 실패가 87회 중 한 번만 나도 전체가 죽는다 — 포트를 바꿔 재시도한다 */
async function launch(port, tag) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const p = port + attempt * 137;
    const proc = await launchOnce(p, path.join(SCRATCH, `c2prof-${tag}-${attempt}`));
    if (proc) return { proc, port: p, profile: path.join(SCRATCH, `c2prof-${tag}-${attempt}`) };
    console.error(`    ↻ ${tag}: 포트 ${p} 기동 실패, 재시도`);
    await sleep(1200);
  }
  throw new Error(`Chrome 기동 실패 (${tag}, 4회 시도)`);
}

const STAGES = ['UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint',
                'RasterTask', 'Commit', 'InvalidateLayout'];

/**
 * 격리된 브라우저 하나에서 한 설정을 잰다.
 * setup 이 끝나고 안정화된 뒤에 트레이싱을 켜므로, 초기 빌드 비용은 구간에서 빠진다.
 */
async function once({ port, tag, url, hook, setup, phase, settle = 1500 }) {
  const { proc, port: p, profile } = await launch(port, tag);
  try {
    const t = await (await fetch(
      `http://127.0.0.1:${p}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
    const page = await connect(t.webSocketDebuggerUrl);
    await page.send('Page.enable'); await page.send('Runtime.enable');
    for (let i = 0; i < 60; i++) {
      if (await page.evaluate(`!!window.${hook}`).catch(() => false)) break;
      await sleep(250);
    }
    const setupResult = setup ? await page.evaluate(setup) : null;
    await sleep(settle);
    await page.evaluate(`window.${hook}.resetCount && window.${hook}.resetCount()`).catch(() => {});

    const events = [];
    page.on('Tracing.dataCollected', p => { if (p.value) events.push(...p.value); });
    const complete = new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('tracingComplete 안 옴 (90s)')), 90000);
      page.on('Tracing.tracingComplete', v => { clearTimeout(t); res(v); });
    });
    await page.send('Tracing.start', {
      transferMode: 'ReportEvents',
      traceConfig: { recordMode: 'recordAsMuchAsPossible',
        includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink'] },
    });
    await sleep(200);
    const phaseResult = await page.evaluate(phase);
    await sleep(300);
    await page.send('Tracing.end');
    await complete;

    const counts = {}, dur = {};
    for (const e of events) {
      if (e.ph === 'M') continue;
      counts[e.name] = (counts[e.name] || 0) + 1;
      if (typeof e.dur === 'number') dur[e.name] = (dur[e.name] || 0) + e.dur / 1000;
    }
    const stage = {};
    for (const s of STAGES) stage[s] = { n: counts[s] || 0, ms: +(dur[s] || 0).toFixed(2) };
    const frames = counts['Commit'] || 0;
    const stats = await page.evaluate(`window.${hook}.stats ? window.${hook}.stats() : null`)
      .catch(() => null);
    await page.send('Browser.close').catch(() => {});
    return { stage, frames, setupResult, phaseResult, stats };
  } finally {
    await sleep(250);
    try { proc.kill('SIGKILL'); } catch {}
    await sleep(450);
    // 프로필이 87개씩 쌓이면 디스크가 는다. 우리가 방금 만든 것만 지운다
    try { await rm(profile, { recursive: true, force: true }); } catch { /* 잠긴 파일 무시 */ }
  }
}

const OUTPATH = path.join(import.meta.dirname, 'results.json');
const out = { experiment: 'c2-anomalies', generatedAt: new Date().toISOString(),
              repeat: REPEAT, isolation: 'browser-per-config',
              part1: [], part2: [], part3: [], fits: {} };

// 설정 하나가 끝날 때마다 저장한다 — 87번째에서 죽어도 앞의 86개를 잃지 않는다
const save = () => writeFile(OUTPATH, JSON.stringify(out, null, 2));

// --resume: 이미 받아둔 설정은 건너뛴다
if (arg('resume', '0') === '1' && existsSync(OUTPATH)) {
  const prev = JSON.parse(await readFile(OUTPATH, 'utf8'));
  for (const k of ['part1', 'part2', 'part3']) out[k] = prev[k] || [];
  out.fits = prev.fits || {};
  console.log(`↻ 재개: part1 ${out.part1.length} · part2 ${out.part2.length} · part3 ${out.part3.length} 건 보유`);
}
let port = 11000 + Math.floor(Math.random() * 400);
const bust = Date.now();
const C2 = `${BASE}/experiments/track-c/c2-anomalies/?v=${bust}`;
const A1 = `${BASE}/experiments/track-a/a1-pipeline-skip/?v=${bust}`;

const rep = async (n, fn) => { const v = []; for (let i = 0; i < n; i++) v.push(await fn(i)); return v; };

// ── ① auto 키워드 판별 — 모드 × 무효화 × N ──────────────────
if (PART === 'all' || PART === '1') {
  const KICKS = 8;
  console.log('\n① auto 키워드가 A4 의 O(N) 원인인가 — 무효화 ' + KICKS + '회\n');
  console.log('  무효화   모드       N=500 Layout   N=4000 Layout    배율   (ms/회)');
  console.log('  ' + '─'.repeat(64));
  for (const inv of ['width', 'offset', 'color']) {
    for (const m of ['plain', 'cv-auto', 'cv-fixed']) {
      const per = {};
      for (const n of [500, 4000]) {
        const done = out.part1.filter(x => x.invalidation === inv && x.mode === m && x.n === n);
        const vals = done.length >= REPEAT ? done : await rep(REPEAT, async r => {
          port++;
          const v = await once({ port, tag: `p1-${inv}-${m}-${n}-${r}`, url: C2, hook: '__C2',
            setup: `__C2.build(${n}, ${JSON.stringify(m)})`,
            phase: `__C2.relayout(${JSON.stringify(inv)}, ${KICKS})` });
          out.part1.push({ invalidation: inv, mode: m, n, rep: r, kicks: KICKS, ...v });
          await save();
          return v;
        });
        per[n] = mean(vals.map(v => v.stage.Layout.ms)) / KICKS;
      }
      const ratio = per[500] > 0.01 ? (per[4000] / per[500]).toFixed(1) + '배' : '—';
      console.log(`  ${inv.padEnd(9)}${m.padEnd(11)}${per[500].toFixed(3).padStart(13)}` +
                  `${per[4000].toFixed(3).padStart(16)}${ratio.padStart(9)}`);
    }
    console.log('  ' + '·'.repeat(64));
  }
}

// ── ② 점프형에서 통과 항목 수 ──────────────────────────────
if (PART === 'all' || PART === '2') {
  console.log(`\n② 점프형에서 "정확한 값"이 느렸던 건 일을 더 해서인가 (N=${N2.toLocaleString()})\n`);
  console.log('  추정값        패턴     Layout ms   Paint회   렌더된 항목   이동거리/scrollH');
  console.log('  ' + '─'.repeat(74));
  for (const m of ['cv-over', 'cv-auto']) {      // 118px(41% 과대) vs 73px(정확)
    for (const pat of ['jump', 'linear']) {
      const phase = pat === 'jump' ? '__C2.scrollJump(40)' : '__C2.scrollLinear(300, 60)';
      const done2 = out.part2.filter(x => x.mode === m && x.pattern === pat && x.n === N2);
      const vals = done2.length >= REPEAT ? done2 : await rep(REPEAT, async r => {
        port++;
        const v = await once({ port, tag: `p2-${m}-${pat}-${N2}-${r}`, url: C2, hook: '__C2',
          setup: `__C2.build(${N2}, ${JSON.stringify(m)})`, phase });
        out.part2.push({ mode: m, pattern: pat, n: N2, rep: r, ...v });
        await save();
        return v;
      });
      const L = mean(vals.map(v => v.stage.Layout.ms));
      const P = mean(vals.map(v => v.stage.Paint.n));
      const V = mean(vals.map(v => v.phaseResult?.becameVisible ?? 0));
      const H = mean(vals.map(v => v.phaseResult?.scrollHeight ?? 0));
      const trav = pat === 'jump' ? H : 18000;
      const label = m === 'cv-over' ? '118px 과대' : '73px 정확';
      console.log(`  ${label.padEnd(13)}${pat.padEnd(9)}${L.toFixed(1).padStart(10)}` +
        `${P.toFixed(0).padStart(10)}${V.toFixed(0).padStart(14)}` +
        `${(Math.round(trav).toLocaleString() + ' / ' + Math.round(H).toLocaleString()).padStart(20)}`);
    }
  }
}

// ── ③ commit 이 선형인가 ──────────────────────────────────
if (PART === 'all' || PART === '3') {
  const LAYERS = [100, 250, 500, 750, 1000, 1500, 2000];
  console.log('\n③ transform 의 commit 비용은 선형인가 임계점이 있는가\n');
  console.log('  레이어   프레임   Commit ms/프레임   프레임당 레이어 1개 비용');
  console.log('  ' + '─'.repeat(62));
  const xs = [], ys = [];
  for (const n of LAYERS) {
    const done3 = out.part3.filter(x => x.layers === n);
    const vals = done3.length >= REPEAT ? done3 : await rep(REPEAT, async r => {
      port++;
      const v = await once({ port, tag: `p3-${n}-${r}`, url: A1, hook: '__A1',
        setup: `__A1.setCount(${n}); __A1.setMode("transform"); 1`,
        phase: 'new Promise(r => setTimeout(() => r({ok:1}), 2500))', settle: 2000 });
      out.part3.push({ layers: n, rep: r, ...v });
      await save();
      return v;
    });
    const fr = mean(vals.map(v => v.frames)) || 1;
    const C = mean(vals.map(v => v.stage.Commit.ms)) / fr;
    xs.push(n); ys.push(C);
    console.log(`  ${String(n).padStart(6)}${Math.round(fr).toString().padStart(9)}` +
      `${C.toFixed(4).padStart(19)}${(C / n * 1000).toFixed(3).padStart(24)} µs`);
  }
  const fit = linfit(xs, ys);
  out.fits.commit = { layers: xs, msPerFrame: ys, ...fit };
  console.log(`\n  선형 적합: commit = ${(fit.slope * 1000).toFixed(4)} µs × 레이어 + ` +
              `${fit.intercept.toFixed(4)} ms   ·   R² = ${fit.r2.toFixed(4)}`);
  console.log(`  판정: ${fit.r2 >= 0.95 ? 'H3 채택 (선형, 임계점 없음)' : 'H3′ — 선형이 아니다'}`);
}

await writeFile(path.join(import.meta.dirname, 'results.json'), JSON.stringify(out, null, 2));
console.log('\n✅ results.json 저장');
process.exit(0);
