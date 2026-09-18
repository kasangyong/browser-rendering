/**
 * C4 기전 진단 — 래스터가 켜졌을 때 '무엇을' 다시 그리는가
 *
 * A/B 는 임계점이 어디인지를 답하지만 왜인지는 답하지 않는다.
 * 여기서는 cc 내부 카테고리까지 켜서
 *   1) RasterTask 가 어느 레이어의 것인지 (args 의 tileData.layerId)
 *   2) 축출·메모리 압박 관련 이벤트가 실제로 찍히는지
 * 를 본다.
 *
 * 꺼진 조건(800)과 켜진 조건(2000)을 나란히 찍어 차이만 본다.
 *
 * 사용: node probe-why.mjs [--toggles=10]
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const arg = (n, d) => {
  const m = process.argv.find(a => a.startsWith(`--${n}=`));
  return m ? m.split('=')[1] : d;
};
const TOGGLES = Number(arg('toggles', '10'));
const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';
const URL_C3 = 'http://127.0.0.1:8765/experiments/track-c/c3-layer-cliff/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run(layers, port) {
  const profile = path.join(SCRATCH, `c4why-${layers}`);
  await mkdir(profile, { recursive: true });
  const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, '--no-first-run',
    '--disable-gpu-vsync', '--disable-frame-rate-limit',
    '--hide-scrollbars', '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { await sleep(300);
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {} }
  try {
    const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${
      encodeURIComponent(URL_C3 + '?v=' + Date.now())}`, { method: 'PUT' })).json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise(r => ws.addEventListener('open', r, { once: true }));
    let id = 0; const pend = new Map(); const evs = []; let done, fail;
    const fin = new Promise((r, j) => { done = r; fail = j; });
    const die = () => { for (const [, p] of pend) p(null); pend.clear(); fail(new Error('CDP 끊김')); };
    ws.addEventListener('close', die, { once: true });
    ws.addEventListener('error', die, { once: true });
    ws.addEventListener('message', e => { const m = JSON.parse(e.data);
      if (m.id !== undefined) { const p = pend.get(m.id); pend.delete(m.id); p && p(m.result); }
      else if (m.method === 'Tracing.dataCollected') evs.push(...(m.params.value || []));
      else if (m.method === 'Tracing.tracingComplete') done(); });
    const send = (method, params = {}) => { const i = ++id;
      ws.send(JSON.stringify({ id: i, method, params }));
      return new Promise(r => { const to = setTimeout(() => { pend.delete(i); r(null); }, 180000);
        pend.set(i, v => { clearTimeout(to); r(v); }); }); };
    const ev = async x => (await send('Runtime.evaluate',
      { expression: x, returnByValue: true, awaitPromise: true }))?.result?.value;

    await send('Runtime.enable');
    for (let i = 0; i < 40 && !(await ev('!!window.__C3')); i++) await sleep(250);
    await ev(`__C3.build(${layers}, 38, 15)`);
    await sleep(2000);

    await send('Tracing.start', { transferMode: 'ReportEvents',
      traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: [
        'devtools.timeline', 'disabled-by-default-devtools.timeline',
        'cc', 'disabled-by-default-cc.debug', 'viz', 'gpu',
      ] } });
    await sleep(200);
    await ev(`__C3.pump(${TOGGLES})`);
    await sleep(300);
    await send('Tracing.end');
    await Promise.race([fin, new Promise((_, j) => setTimeout(() => j(new Error('트레이스 미완')), 180000))]);
    await send('Browser.close').catch(() => {});

    const byName = {}, rasterLayers = {};
    let rasterMs = 0, rasterN = 0;
    const rasterTs = [];
    let t0 = Infinity, t1 = -Infinity;
    for (const e of evs) {
      if (e.ph === 'M') continue;
      byName[e.name] = (byName[e.name] || 0) + 1;
      if (typeof e.ts === 'number') { if (e.ts < t0) t0 = e.ts; if (e.ts > t1) t1 = e.ts; }
      if (e.name === 'RasterTask') {
        rasterN++;
        if (typeof e.dur === 'number') rasterMs += e.dur / 1000;
        if (typeof e.ts === 'number') rasterTs.push(e.ts);
        const lid = e.args?.tileData?.layerId ?? e.args?.data?.layerId ?? '?';
        rasterLayers[lid] = (rasterLayers[lid] || 0) + 1;
      }
    }
    // 래스터가 측정 구간 앞쪽에 몰려 있나(초기 래스터의 꼬리) 고르게 퍼져 있나(매 프레임 재래스터)
    const span = t1 - t0;
    const decile = new Array(10).fill(0);
    if (span > 0) for (const ts of rasterTs) {
      decile[Math.min(9, Math.floor(((ts - t0) / span) * 10))]++;
    }
    return { layers, events: evs.length, rasterN, rasterMs: +rasterMs.toFixed(1), byName, rasterLayers,
             decile, spanMs: +(span / 1000).toFixed(0),
             sample: evs.find(e => e.name === 'RasterTask')?.args ?? null };
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    await sleep(500);
    try { await rm(profile, { recursive: true, force: true }); } catch {}
  }
}

const out = [];
let port = 23300;
for (const n of [800, 2000]) {
  const r = await run(n, port++);
  out.push(r);
  console.log(`\n${'='.repeat(70)}\n레이어 ${n} — 이벤트 ${r.events.toLocaleString()} · RasterTask ${r.rasterN}회 / ${r.rasterMs}ms\n`);
  console.log('  상위 이벤트 20개:');
  Object.entries(r.byName).sort((a, b) => b[1] - a[1]).slice(0, 20)
    .forEach(([k, v]) => console.log(`    ${String(v).padStart(7)}  ${k}`));
  if (r.rasterN) {
    const mx = Math.max(...r.decile) || 1;
    console.log(`  측정 구간(${r.spanMs}ms) 안에서 RasterTask 가 언제 찍혔나 — 10등분:`);
    r.decile.forEach((v, i) => console.log(
      `    ${String(i * 10).padStart(3)}~${String(i * 10 + 10).padStart(3)}%  ` +
      '█'.repeat(Math.round(v / mx * 40)).padEnd(40, '·') + ' ' + v));
    console.log('    → 앞쪽에 몰렸으면 초기 래스터의 꼬리, 고르면 매 프레임 재래스터');
    console.log('');
  }
  const lids = Object.entries(r.rasterLayers).sort((a, b) => b[1] - a[1]);
  console.log(`\n  RasterTask 가 붙은 레이어: 서로 다른 ${lids.length}개`);
  lids.slice(0, 8).forEach(([k, v]) => console.log(`    layerId ${String(k).padStart(8)} : ${v}회`));
  if (r.sample) console.log('\n  RasterTask args 예시:', JSON.stringify(r.sample).slice(0, 300));
}

// 켜진 쪽에만 있는 이벤트 = 기전의 후보
if (out.length === 2) {
  const [off, on] = out;
  console.log(`\n${'='.repeat(70)}\n켜진 쪽(2000)에만 있거나 10배 이상 많은 이벤트:\n`);
  const rows = [];
  for (const [k, v] of Object.entries(on.byName)) {
    const o = off.byName[k] || 0;
    if (v >= 5 && (o === 0 || v / o >= 10)) rows.push([k, o, v]);
  }
  rows.sort((a, b) => b[2] - a[2]).slice(0, 25)
    .forEach(([k, o, v]) => console.log(`    ${String(o).padStart(7)} → ${String(v).padStart(7)}   ${k}`));
}

await writeFile(new URL('./results-why.json', import.meta.url), JSON.stringify({
  note: '꺼진 조건(800)과 켜진 조건(2000)의 cc 내부 이벤트 대조', generatedAt: new Date().toISOString(),
  toggles: TOGGLES, runs: out,
}, null, 2));
console.log('\n✅ results-why.json 저장');
process.exit(0);
