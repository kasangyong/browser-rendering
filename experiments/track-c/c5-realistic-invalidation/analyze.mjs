/**
 * C5 집계 — 표를 손으로 옮겨 적지 않으려고 원자료에서 직접 계산한다.
 *
 * C4d 에서 배운 대로 **반복별 값을 먼저** 보여주고 평균은 그 다음이다.
 * 2배 미만 차이는 "차이 없음" 으로 읽는다 (엄격 격리에서 잰 흩어짐이 1.6배).
 */
import { readFile } from 'node:fs/promises';

const d = JSON.parse(await readFile(new URL('./results.json', import.meta.url), 'utf8'));
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const INVS = ['width-inline', 'theme-padding', 'item-color', 'root-var'];
const LABEL = {
  'width-inline': '컨테이너 폭만',
  'theme-padding': '항목 스타일+레이아웃',
  'item-color': '항목 스타일만',
  'root-var': ':root 변수 (C2 방식)',
};
const pick = (n, mode, inv) => d.rows.filter(r => r.n === n && r.mode === mode && r.inv === inv);
const st = (rows, k, f = 'ms') => mean(rows.map(r => r.stage[k][f]));

const N = 4000;

console.log(`\n■ 무효화 범위별 — N=${N.toLocaleString()} · 무효화 1회당 ms · 반복 ${d.repeat}회\n`);
console.log('  무효화                모드      Style   Layout  PrePaint   Paint │   합계   plain 대비');
console.log('  ' + '─'.repeat(90));
const summary = {};
for (const inv of INVS) {
  const base = pick(N, 'plain', inv), cv = pick(N, 'cv-auto', inv);
  if (!base.length || !cv.length) { console.log(`  ${LABEL[inv]} — 데이터 없음`); continue; }
  const tot = rows => ['UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint'].reduce((a, k) => a + st(rows, k), 0);
  const tb = tot(base), tc = tot(cv);
  summary[inv] = {
    styleBase: st(base, 'UpdateLayoutTree'), styleCv: st(cv, 'UpdateLayoutTree'),
    layoutBase: st(base, 'Layout'), layoutCv: st(cv, 'Layout'),
    totBase: tb, totCv: tc,
  };
  for (const [tag, rows] of [['plain', base], ['cv-auto', cv]]) {
    const t = tot(rows);
    console.log(`  ${(tag === 'plain' ? LABEL[inv] : '').padEnd(22)}${tag.padEnd(10)}` +
      st(rows, 'UpdateLayoutTree').toFixed(2).padStart(7) +
      st(rows, 'Layout').toFixed(2).padStart(9) +
      st(rows, 'PrePaint').toFixed(2).padStart(10) +
      st(rows, 'Paint').toFixed(2).padStart(8) + ' │' +
      t.toFixed(2).padStart(8) +
      (tag === 'plain' ? '        —' : `   ${(tb / t).toFixed(2)}배 ${tb > t ? '이득' : '손해'}`));
  }
  console.log('  ' + '·'.repeat(90));
}

console.log('\n■ 핵심 — Style 절감이 무효화 범위에 따라 달라지나\n');
console.log('  무효화                  plain Style   cv Style    절감    │  Layout plain → cv       전체');
console.log('  ' + '─'.repeat(92));
for (const inv of INVS) {
  const s = summary[inv]; if (!s) continue;
  const cut = (1 - s.styleCv / s.styleBase) * 100;
  const lay = s.layoutCv / Math.max(s.layoutBase, 0.001);
  console.log(`  ${LABEL[inv].padEnd(24)}${s.styleBase.toFixed(2).padStart(9)}` +
    `${s.styleCv.toFixed(2).padStart(11)}` +
    `${(cut >= 0 ? '−' : '+') + Math.abs(cut).toFixed(0) + '%'}`.padStart(9) + '   │' +
    `${(s.layoutBase.toFixed(2) + ' → ' + s.layoutCv.toFixed(2)).padStart(17)}` +
    `${(lay > 1 ? (lay.toFixed(1) + '배 증가') : ((1 / lay).toFixed(1) + '배 감소')).padStart(12)}` +
    `${((s.totBase / s.totCv).toFixed(2) + '배').padStart(9)}`);
}

console.log('\n■ 반복별 값 (평균 뒤에 숨은 흩어짐 — 2배 미만은 차이 없음으로 읽는다)\n');
for (const inv of INVS) {
  for (const mode of ['plain', 'cv-auto']) {
    const rows = pick(N, mode, inv); if (!rows.length) continue;
    const v = rows.map(r => r.stage.UpdateLayoutTree.ms).sort((a, b) => a - b);
    const sp = v[0] > 0 ? (v[v.length - 1] / v[0]).toFixed(1) + '배' : '—';
    console.log(`  ${LABEL[inv].padEnd(22)}${mode.padEnd(9)} Style: ` +
      v.map(x => x.toFixed(2).padStart(8)).join('') + `   흩어짐 ${sp}`);
  }
}

const procs = d.rows.map(r => r.procsAtStart).filter(x => x > 0);
console.log(`\n  측정 시작 시점 chrome 프로세스: ${Math.min(...procs)}~${Math.max(...procs)}개 ` +
            `(엄격 격리 · C4d 적용)`);

// N=500 과 비교해 스케일링도 남긴다
console.log(`\n■ N=500 → 4,000 스케일링 (Style ms)\n`);
console.log('  무효화                  plain          cv-auto');
console.log('  ' + '─'.repeat(52));
for (const inv of INVS) {
  const f = (n, m) => st(pick(n, m, inv), 'UpdateLayoutTree');
  const a = f(500, 'plain'), b = f(4000, 'plain'), c = f(500, 'cv-auto'), e = f(4000, 'cv-auto');
  if (!b || !e) continue;
  console.log(`  ${LABEL[inv].padEnd(22)}${(a.toFixed(2) + ' → ' + b.toFixed(2)).padStart(16)}` +
    `${('(' + (b / Math.max(a, .001)).toFixed(1) + '배)').padStart(9)}` +
    `${(c.toFixed(2) + ' → ' + e.toFixed(2)).padStart(16)}` +
    `${('(' + (e / Math.max(c, .001)).toFixed(1) + '배)').padStart(9)}`);
}
