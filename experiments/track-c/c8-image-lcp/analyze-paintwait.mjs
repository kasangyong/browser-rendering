/**
 * C8g 집계 — A 를 제대로 잰 결과
 *
 * A = ResourceFinish(배너) → PaintImage(배너)
 * B = PaintImage → LargestImagePaint::Candidate
 *
 * 시간만 보면 흩어짐에 묻힌다. 횟수(Paint · Layout)와 메인 스레드 점유를 같이 본다.
 */
import { readFile } from 'node:fs/promises';
const d = JSON.parse(await readFile(new URL('./results-paintwait.json', import.meta.url), 'utf8'));
const NAME = { uk: 'United Kingdom', philippines: 'Philippines' };
const med = a => { const s = [...a].filter(x => x != null).sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null; };
const q = (a, p) => { const s = [...a].filter(x => x != null).sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const pick = (k, m) => d.rows.filter(r => r.siteKey === k && r.mode === m);
const KEYS = [...new Set(d.rows.map(r => r.siteKey))];
const pct = x => (x <= 0 ? '−' : '+') + Math.abs(x).toFixed(0) + '%';

/** 두 표본의 중앙값 차이에 부트스트랩 신뢰구간 */
function bootCI(a, b, n = 4000) {
  const out = [];
  let s = 12345;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const samp = arr => { const v = []; for (let i = 0; i < arr.length; i++) v.push(arr[Math.floor(rnd() * arr.length)]); return v; };
  for (let i = 0; i < n; i++) out.push(med(samp(b)) - med(samp(a)));
  out.sort((x, y) => x - y);
  return [out[Math.floor(0.025 * n)], out[Math.floor(0.975 * n)]];
}

console.log(`\n■ ① A — 배너가 다 내려온 뒤 실제로 그려지기까지 (ms)\n`);
console.log('  사이트           모드       n   중앙값   하위25%  상위75%  │ 변화   95% 신뢰구간');
console.log('  ' + '─'.repeat(80));
for (const k of KEYS) {
  const b = pick(k, 'plain').map(r => r.A), v = pick(k, 'cv-auto').map(r => r.A);
  if (!b.length || !v.length) continue;
  for (const [m, a] of [['plain', b], ['cv-auto', v]])
    console.log(`  ${(m === 'plain' ? NAME[k] : '').padEnd(17)}${m.padEnd(9)}${String(a.length).padStart(4)}` +
      med(a).toFixed(0).padStart(9) + q(a, 0.25).toFixed(0).padStart(9) + q(a, 0.75).toFixed(0).padStart(9) +
      (m === 'cv-auto' ? '  │' + pct((med(v) - med(b)) / med(b) * 100).padStart(6) +
        `   [${bootCI(b, v).map(x => x.toFixed(0)).join(', ')}]ms` : '  │'));
  console.log('  ' + '·'.repeat(80));
}

console.log(`\n■ ② B — 그려진 뒤 LCP 로 기록되기까지 (ms) · V4\n`);
console.log('  사이트           plain   cv-auto  │ 차이');
console.log('  ' + '─'.repeat(50));
for (const k of KEYS) {
  const b = med(pick(k, 'plain').map(r => r.B)), v = med(pick(k, 'cv-auto').map(r => r.B));
  if (b == null || v == null) continue;
  console.log(`  ${NAME[k].padEnd(17)}${b.toFixed(0).padStart(6)}${v.toFixed(0).padStart(10)}  │${(v - b).toFixed(0).padStart(7)}ms`);
}

console.log(`\n■ ③ A 구간 안에서 무슨 일이 — 횟수와 점유 (중앙값) · V2 · V3\n`);
console.log('  사이트           모드      Paint  Layout  Raster  │ Layout ms  Style ms  메인점유%');
console.log('  ' + '─'.repeat(82));
for (const k of KEYS) {
  for (const m of ['plain', 'cv-auto']) {
    const r = pick(k, m); if (!r.length) continue;
    console.log(`  ${(m === 'plain' ? NAME[k] : '').padEnd(17)}${m.padEnd(9)}` +
      String(med(r.map(x => x.paintN))).padStart(6) + String(med(r.map(x => x.layoutN))).padStart(8) +
      String(med(r.map(x => x.rasterN))).padStart(8) + '  │' +
      med(r.map(x => x.layoutMs)).toFixed(0).padStart(10) + med(r.map(x => x.styleMs)).toFixed(0).padStart(10) +
      String(med(r.map(x => x.busyPct))).padStart(11));
  }
  console.log('  ' + '·'.repeat(82));
}

console.log(`\n■ ④ 페인트 한 번에 걸리는 시간 — A / Paint 횟수 (ms · 중앙값)\n`);
console.log('  사이트           plain   cv-auto  │ 변화');
console.log('  ' + '─'.repeat(50));
for (const k of KEYS) {
  const g = m => med(pick(k, m).filter(r => r.paintN > 0).map(r => r.A / r.paintN));
  const b = g('plain'), v = g('cv-auto');
  if (b == null || v == null) continue;
  console.log(`  ${NAME[k].padEnd(17)}${b.toFixed(0).padStart(6)}${v.toFixed(0).padStart(10)}  │${pct((v - b) / b * 100).padStart(7)}`);
}

console.log(`\n■ ⑤ 전체 그림 — A 가 줄면 LCP 도 주나 (ms · 중앙값)\n`);
console.log('  사이트           모드      FCP   응답끝   PaintImage     LCP  │ 로드중 Layout');
console.log('  ' + '─'.repeat(82));
for (const k of KEYS) {
  for (const m of ['plain', 'cv-auto']) {
    const r = pick(k, m); if (!r.length) continue;
    console.log(`  ${(m === 'plain' ? NAME[k] : '').padEnd(17)}${m.padEnd(9)}` +
      med(r.map(x => x.fcpMs)).toFixed(0).padStart(7) + med(r.map(x => x.resEnd)).toFixed(0).padStart(8) +
      med(r.map(x => x.paintT)).toFixed(0).padStart(13) + med(r.map(x => x.lcpMs)).toFixed(0).padStart(8) +
      '  │' + med(r.map(x => x.loadLayoutMs)).toFixed(0).padStart(12) + 'ms');
  }
  const b = pick(k, 'plain'), v = pick(k, 'cv-auto');
  if (b.length && v.length) {
    const dl = (med(v.map(x => x.lcpMs)) - med(b.map(x => x.lcpMs))) / med(b.map(x => x.lcpMs)) * 100;
    const ci = bootCI(b.map(x => x.lcpMs), v.map(x => x.lcpMs));
    console.log(`  ${''.padEnd(17)}→ LCP ${pct(dl)}   95% 신뢰구간 [${ci.map(x => x.toFixed(0)).join(', ')}]ms`);
  }
  console.log('  ' + '·'.repeat(82));
}

console.log(`\n■ ⑥ 판정\n`);
for (const k of KEYS) {
  const b = pick(k, 'plain'), v = pick(k, 'cv-auto');
  if (!b.length || !v.length) continue;
  const dA = (med(v.map(r => r.A)) - med(b.map(r => r.A))) / med(b.map(r => r.A)) * 100;
  const ciA = bootCI(b.map(r => r.A), v.map(r => r.A));
  const dB = med(v.map(r => r.B)) - med(b.map(r => r.B));
  const pb = med(b.map(r => r.paintN)), pv = med(v.map(r => r.paintN));
  const busy = med([...b, ...v].map(r => r.busyPct));
  console.log(`  ${NAME[k]}`);
  console.log(`    V1 A 가 15% 이상 준다      ${pct(dA)}  [${ciA.map(x => x.toFixed(0)).join(', ')}]  ` +
    `${ciA[1] < 0 && dA <= -15 ? '성립' : ciA[1] < 0 ? '줄지만 15% 미만' : '판정 불가(0 포함)'}`);
  console.log(`    V2 Paint 횟수가 비슷하다   ${pb} → ${pv}  ${Math.abs(pv - pb) <= Math.max(2, pb * 0.25) ? '성립' : '반증'}`);
  console.log(`    V3 메인 점유 80% 이상      ${busy}%  ${busy >= 80 ? '성립' : '반증'}`);
  console.log(`    V4 B 가 ±20ms 안           ${dB.toFixed(0)}ms  ${Math.abs(dB) <= 20 ? '성립' : '반증'}`);
}
console.log(`\n  총 ${d.rows.length}행 · cv 주입 ` +
  `${d.rows.filter(r => r.mode === 'cv-auto' && r.cvApplied).length}/${d.rows.filter(r => r.mode === 'cv-auto').length}` +
  ` · 트레이스 이벤트 중앙값 ${med(d.rows.map(r => r.events)).toLocaleString()}개`);
