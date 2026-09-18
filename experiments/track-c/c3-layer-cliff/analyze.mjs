/**
 * C3 집계 — 표를 손으로 옮겨 적지 않으려고 원자료에서 직접 계산한다.
 *
 * 반복별 중앙값을 다시 평균내지 않는다. 반복 4회의 원시 표본(각 120개)을 전부 합쳐서
 * 분위수를 내고, 부트스트랩으로 중앙값의 95% 구간을 붙인다.
 * 구간이 겹치면 "차이 있다"고 말하지 않기 위해서다.
 */
import { readFile } from 'node:fs/promises';

const d = JSON.parse(await readFile(new URL('./results.json', import.meta.url), 'utf8'));
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * p)] ?? 0; };

/** 중앙값의 부트스트랩 95% 구간 */
function bootCI(xs, iters = 2000) {
  if (!xs.length) return [0, 0];
  const meds = [];
  for (let i = 0; i < iters; i++) {
    const s = new Array(xs.length);
    for (let j = 0; j < xs.length; j++) s[j] = xs[(Math.random() * xs.length) | 0];
    meds.push(q(s, .5));
  }
  meds.sort((a, b) => a - b);
  return [meds[Math.floor(iters * .025)], meds[Math.floor(iters * .975)]];
}

function linfit(xs, ys) {
  const n = xs.length, mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const slope = sxy / sxx, intercept = my - slope * mx;
  let sr = 0, st = 0;
  for (let i = 0; i < n; i++) { sr += (ys[i] - (slope * xs[i] + intercept)) ** 2; st += (ys[i] - my) ** 2; }
  return { slope, intercept, r2: 1 - sr / st };
}

const group = (rows, key) => {
  const g = new Map();
  for (const r of rows) { const k = key(r); if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
  return g;
};

console.log('\n■ A. 레이어 스윕 — 반복 4회 표본을 합쳐서 (설정당 480개)\n');
console.log('  레이어  표본   p50 ms   95% 구간        레이어당µs   앞 구간 대비   반복간편차');
console.log('  ' + '─'.repeat(82));
const A = [...group(d.partA, r => r.layers).entries()].sort((a, b) => a[0] - b[0]);
const xs = [], ys = [];
let prev = null;
for (const [n, rows] of A) {
  const all = rows.flatMap(r => r.times || []);
  const p50 = q(all, .5), [lo, hi] = bootCI(all);
  const spread = Math.max(...rows.map(r => r.p50)) / Math.min(...rows.map(r => r.p50));
  xs.push(n); ys.push(p50);
  const step = prev ? `${(p50 / prev.p50).toFixed(2)}배 / 레이어 ${(n / prev.n).toFixed(2)}배` : '—';
  console.log(`  ${String(n).padStart(6)}${String(all.length).padStart(6)}${p50.toFixed(2).padStart(9)}` +
    `   [${lo.toFixed(1)}–${hi.toFixed(1)}]`.padEnd(17) +
    `${(p50 / n * 1000).toFixed(2).padStart(9)}${step.padStart(24)}${(spread.toFixed(2) + '배').padStart(11)}`);
  prev = { p50, n };
}
const f = linfit(xs, ys);
console.log(`\n  고정비 + 선형 모델: p50 = ${f.intercept.toFixed(2)}ms + ${(f.slope * 1000).toFixed(2)}µs × 레이어   R² = ${f.r2.toFixed(3)}`);
console.log('  잔차:');
xs.forEach((n, i) => {
  const pred = f.slope * n + f.intercept;
  console.log(`    ${String(n).padStart(5)}  실측 ${ys[i].toFixed(1).padStart(6)}  적합 ${pred.toFixed(1).padStart(6)}  잔차 ${(ys[i] - pred).toFixed(1).padStart(6)}  (${((ys[i] / pred - 1) * 100).toFixed(0)}%)`);
});

// 절벽 판정: 인접 구간의 증가율이 레이어 증가율을 크게 넘는 지점이 있는가
console.log('\n  절벽 판정 — 인접 구간 기울기(시간 배율 ÷ 레이어 배율)');
for (let i = 1; i < xs.length; i++) {
  const r = (ys[i] / ys[i - 1]) / (xs[i] / xs[i - 1]);
  const flag = r > 1.5 ? '  ← 급증' : '';
  console.log(`    ${String(xs[i - 1]).padStart(5)} → ${String(xs[i]).padStart(5)}  ${r.toFixed(2)}${flag}`);
}

if (d.partB?.length) {
  console.log('\n\n■ B. 박스 크기 판별 — 레이어 개수는 그대로, 타일 메모리만 바꿨다\n');
  console.log('  박스              레이어  표본   p50 ms   95% 구간       타일MB  레이어당KB');
  console.log('  ' + '─'.repeat(78));
  const byBw = [...group(d.partB, r => r.bw).entries()].sort((a, b) => a[0] - b[0]);
  const store = {};
  for (const [bw, rows] of byBw) {
    const byN = [...group(rows, r => r.layers).entries()].sort((a, b) => a[0] - b[0]);
    for (const [n, rr] of byN) {
      const all = rr.flatMap(r => r.times || []);
      const p50 = q(all, .5), [lo, hi] = bootCI(all);
      const tile = mean(rr.map(r => r.tileMB));
      store[`${bw}|${n}`] = { p50, lo, hi, tile };
      console.log(`  ${(bw === 38 ? '38×15 (64×64 타일)' : '100×100 (128×128)').padEnd(18)}${String(n).padStart(6)}` +
        `${String(all.length).padStart(6)}${p50.toFixed(2).padStart(9)}   [${lo.toFixed(1)}–${hi.toFixed(1)}]`.padEnd(17) +
        `${tile.toFixed(1).padStart(9)}${(tile * 1024 / n).toFixed(1).padStart(12)}`);
    }
    console.log('  ' + '·'.repeat(78));
  }
  console.log('  같은 레이어 수에서 타일 메모리만 늘렸을 때:');
  for (const n of [500, 1000, 1500, 2000]) {
    const a = store[`38|${n}`], b = store[`100|${n}`];
    if (!a || !b) continue;
    const overlap = a.lo <= b.hi && b.lo <= a.hi;
    console.log(`    ${String(n).padStart(5)} 레이어 · 타일 ${a.tile.toFixed(0)}MB → ${b.tile.toFixed(0)}MB ` +
      `(${(b.tile / a.tile).toFixed(1)}배) · p50 ${a.p50.toFixed(1)} → ${b.p50.toFixed(1)}ms ` +
      `(${(b.p50 / a.p50).toFixed(2)}배)${overlap ? '  ← 95% 구간 겹침(차이 없음)' : ''}`);
  }
}
