/** C2 결과 요약 — RESULTS.md 의 표를 손으로 옮겨 적지 않기 위해 원자료에서 계산한다 */
import { readFile } from 'node:fs/promises';
const d = JSON.parse(await readFile(new URL('./results.json', import.meta.url), 'utf8'));
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const S = ['UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint'];

const pick = (inv, m, n) => d.part1.filter(x => x.invalidation === inv && x.mode === m && x.n === n);
const avg = (rows, f) => +mean(rows.map(f)).toFixed(2);

console.log('\n■ ① 무효화 × 모드 (N=4,000, 8회 무효화 총합 ms)\n');
console.log('  무효화  모드      Layout회  Style   Layout  PrePaint  Paint |  합계   plain 대비');
console.log('  ' + '─'.repeat(80));
for (const inv of ['width', 'offset', 'color']) {
  const base = pick(inv, 'plain', 4000);
  const baseTot = S.reduce((a, s) => a + avg(base, x => x.stage[s].ms), 0);
  for (const m of ['plain', 'cv-auto', 'cv-fixed']) {
    const r = pick(inv, m, 4000); if (!r.length) continue;
    const tot = S.reduce((a, s) => a + avg(r, x => x.stage[s].ms), 0);
    console.log(`  ${inv.padEnd(8)}${m.padEnd(10)}${avg(r, x => x.stage.Layout.n).toFixed(0).padStart(6)}` +
      S.map(s => avg(r, x => x.stage[s].ms).toFixed(1).padStart(8)).join('') +
      ` |${tot.toFixed(1).padStart(7)}` +
      (m === 'plain' ? '     —' : `   ${(baseTot / tot).toFixed(2)}배 ${baseTot > tot ? '이득' : '손해'}`));
  }
  console.log('  ' + '·'.repeat(80));
}

console.log('\n■ ① 스케일링 지수  (배율 = (N4000/N500), 지수 = log(배율)/log(8))\n');
for (const inv of ['width', 'offset', 'color']) {
  for (const m of ['plain', 'cv-auto', 'cv-fixed']) {
    const a = avg(pick(inv, m, 500), x => x.stage.Layout.ms);
    const b = avg(pick(inv, m, 4000), x => x.stage.Layout.ms);
    if (!a || !b) { console.log(`  ${inv.padEnd(8)}${m.padEnd(10)} —`); continue; }
    console.log(`  ${inv.padEnd(8)}${m.padEnd(10)}${(b / a).toFixed(2).padStart(7)}배   지수 ${(Math.log(b / a) / Math.log(8)).toFixed(2)}`);
  }
}

if (d.part2?.length) {
  console.log('\n■ ② 스크롤 패턴별 통과 항목 수 (N=4,000)\n');
  console.log('      N  추정값       패턴     Layout ms  Paint회  Raster회  렌더된 항목  이동거리');
  console.log('  ' + '─'.repeat(80));
  const Ns = [...new Set(d.part2.map(x => x.n ?? 4000))].sort((a, b) => a - b);
  for (const N of Ns) for (const m of ['cv-over', 'cv-auto']) for (const p of ['jump', 'linear']) {
    const r = d.part2.filter(x => (x.n ?? 4000) === N && x.mode === m && x.pattern === p);
    if (!r.length) continue;
    const trav = p === 'jump' ? avg(r, x => x.phaseResult?.scrollHeight ?? 0) : 18000;
    console.log(`  ${String(N).padStart(5)}  ${(m === 'cv-over' ? '118px 과대' : '73px 정확').padEnd(12)}${p.padEnd(9)}` +
      avg(r, x => x.stage.Layout.ms).toFixed(1).padStart(10) +
      avg(r, x => x.stage.Paint.n).toFixed(0).padStart(9) +
      avg(r, x => x.stage.RasterTask.n).toFixed(0).padStart(10) +
      avg(r, x => x.phaseResult?.becameVisible ?? 0).toFixed(0).padStart(13) +
      Math.round(trav).toLocaleString().padStart(12));
  }
}

if (d.fits?.commit) {
  const f = d.fits.commit;
  console.log('\n■ ③ commit 선형성\n');
  console.log(`  commit(ms/프레임) = ${(f.slope * 1000).toFixed(4)}µs × 레이어 + ${f.intercept.toFixed(4)}ms`);
  console.log(`  R² = ${f.r2.toFixed(4)}  →  ${f.r2 >= 0.95 ? 'H3 채택 (선형)' : "H3′ (비선형)"}`);
  f.layers.forEach((n, i) => {
    const pred = f.slope * n + f.intercept;
    console.log(`   ${String(n).padStart(5)}  실측 ${f.msPerFrame[i].toFixed(3)}  적합 ${pred.toFixed(3)}  잔차 ${(f.msPerFrame[i] - pred).toFixed(3)}`);
  });
}
