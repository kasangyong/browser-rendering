/**
 * C4 후속 — part B 가 예상과 반대로 나왔다. 왜인가
 *
 * 기전이 "초기 래스터가 정해진 시간 안에 끝나느냐" 라면
 * 타일 픽셀이 4배인 100×100 이 **더 잘** 켜져야 한다. 그런데 1,000 레이어에서도 0/6 이다.
 * (같은 1,000 레이어에서 38×15 는 3/6 이었다.)
 *
 * 가설: 박스를 키우면 서로 **완전히 가려진다**. 가려진 레이어의 타일은 래스터할 필요가 없다.
 * 즉 박스 크기는 타일 바이트만 바꾸는 게 아니라 **실제로 래스터하는 타일 수**도 바꾼다.
 * → part B 의 판별 설계에 교란 변수가 있었다는 뜻이다.
 *
 * 확인: build 직후부터 트레이싱해서 **초기 래스터 총량**을 두 크기에서 비교한다.
 * 가림이 원인이면 100×100 쪽이 레이어 수는 같은데 래스터 횟수가 훨씬 적어야 한다.
 *
 * 사용: node probe-occlusion.mjs [--layers=1000] [--repeat=3]
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const arg = (n, d) => {
  const m = process.argv.find(a => a.startsWith(`--${n}=`));
  return m ? m.split('=')[1] : d;
};
const LAYERS = Number(arg('layers', '1000'));
const REPEAT = Number(arg('repeat', '3'));
const WINDOW = Number(arg('window', '6000'));
const SCRATCH = 'C:/Users/SSAFY/AppData/Local/Temp/claude/C--Users-SSAFY-Desktop-ka---------/98619a68-f164-4f9c-b502-a270a38bb41e/scratchpad';
const URL_C3 = 'http://127.0.0.1:8765/experiments/track-c/c3-layer-cliff/';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

async function run({ layers, bw, bh, port, rep }) {
  const profile = path.join(SCRATCH, `c4occ-${bw}-${rep}`);
  await mkdir(profile, { recursive: true });
  const proc = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, '--no-first-run',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
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

    await send('Runtime.enable'); await send('LayerTree.enable');
    let layerCount = 0;
    ws.addEventListener('message', e => { const m = JSON.parse(e.data);
      if (m.method === 'LayerTree.layerTreeDidChange') layerCount = (m.params.layers || []).length; });
    for (let i = 0; i < 40 && !(await ev('!!window.__C3')); i++) await sleep(250);

    // build '전에' 트레이싱을 켜서 초기 래스터를 통째로 담는다
    await send('Tracing.start', { transferMode: 'ReportEvents',
      traceConfig: { recordMode: 'recordAsMuchAsPossible',
        includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'] } });
    await sleep(150);
    await ev(`__C3.build(${layers}, ${bw}, ${bh})`);
    await sleep(WINDOW);
    await send('Tracing.end');
    await Promise.race([fin, new Promise((_, j) => setTimeout(() => j(new Error('트레이스 미완')), 180000))]);
    await send('Browser.close').catch(() => {});

    let rasterMs = 0, rasterN = 0;
    const rasterLayers = new Set();
    for (const e of evs) {
      if (e.name !== 'RasterTask') continue;
      rasterN++;
      if (typeof e.dur === 'number') rasterMs += e.dur / 1000;
      const lid = e.args?.tileData?.layerId;
      if (lid !== undefined) rasterLayers.add(lid);
    }
    return { layers, bw, bh, rep, layerCount,
             rasterN, rasterMs: +rasterMs.toFixed(1), rasterLayers: rasterLayers.size };
  } finally {
    try { proc.kill('SIGKILL'); } catch {}
    await sleep(500);
    try { await rm(profile, { recursive: true, force: true }); } catch {}
  }
}

const rows = [];
console.log(`\n초기 래스터 총량 — 레이어 ${LAYERS.toLocaleString()} 고정, 박스 크기만 바꿈 (${REPEAT}회)\n`);
console.log('  박스        합성레이어   래스터 횟수   래스터한 레이어   레이어당   래스터 ms');
console.log('  ' + '─'.repeat(76));
let port = 25400;
for (const s of [{ bw: 38, bh: 15 }, { bw: 100, bh: 100 }]) {
  const r = [];
  for (let k = 0; k < REPEAT; k++) {
    try { r.push(await run({ layers: LAYERS, ...s, port: port++, rep: k })); }
    catch (e) { console.error(`    ↻ ${s.bw}/rep${k} 실패: ${e.message}`); }
  }
  if (!r.length) { console.log(`  ${s.bw}×${s.bh}: 전부 실패`); continue; }
  rows.push(...r);
  console.log(`  ${(s.bw + '×' + s.bh).padEnd(12)}${Math.round(mean(r.map(x => x.layerCount))).toString().padStart(10)}` +
    `${Math.round(mean(r.map(x => x.rasterN))).toString().padStart(14)}` +
    `${Math.round(mean(r.map(x => x.rasterLayers))).toString().padStart(17)}` +
    `${(mean(r.map(x => x.rasterN)) / LAYERS).toFixed(2).padStart(11)}` +
    `${mean(r.map(x => x.rasterMs)).toFixed(0).padStart(12)}`);
}

await writeFile(new URL('./results-occlusion.json', import.meta.url), JSON.stringify({
  note: '박스 크기가 타일 바이트만 바꾸는 게 아니라 실제로 래스터하는 타일 수도 바꾸는지 확인',
  generatedAt: new Date().toISOString(), layers: LAYERS, windowMs: WINDOW, repeat: REPEAT, rows,
}, null, 2));
console.log('\n✅ results-occlusion.json 저장');
console.log('\n판정: 100×100 쪽 래스터 횟수가 훨씬 적으면 → 큰 박스가 서로 가려서 래스터를 건너뛴 것');
process.exit(0);
