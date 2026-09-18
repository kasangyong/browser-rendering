/**
 * C6 집계 — 실제 사이트 결과를 C5(합성)와 나란히 놓는다.
 * 반복별 값을 먼저 보여주고, 2배 미만 차이는 "차이 없음" 으로 읽는다.
 */
import { readFile } from 'node:fs/promises';
const d = JSON.parse(await readFile(new URL('./results.json', import.meta.url), 'utf8'));
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const INVS = ['width-inline', 'item-color', 'root-var'];
const LABEL = { 'width-inline': '컨테이너 폭만', 'item-color': '항목 스타일만', 'root-var': ':root 변수' };
const pick = (m, i) => d.rows.filter(r => r.mode === m && r.inv === i);
const st = (rows, k) => mean(rows.map(r => r.stage[k].ms));
const TOT = ['UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint'];

console.log(`\n■ 실제 사이트 — ${d.site.url}`);
console.log(`  블록 ${d.rows[0]?.blocks ?? '?'}개 · DOM ${d.rows[0]?.domNodes?.toLocaleString() ?? '?'} 노드 · 무효화 1회당 ms · ${d.repeat}회\n`);
console.log('  무효화            모드       Style   Layout  PrePaint   Paint │   합계   plain 대비');
console.log('  ' + '─'.repeat(84));
const S = {};
for (const inv of INVS) {
  const b = pick('plain', inv), c = pick('cv-auto', inv);
  if (!b.length || !c.length) continue;
  const tb = TOT.reduce((a, k) => a + st(b, k), 0), tc = TOT.reduce((a, k) => a + st(c, k), 0);
  S[inv] = { sb: st(b, 'UpdateLayoutTree'), sc: st(c, 'UpdateLayoutTree'),
             lb: st(b, 'Layout'), lc: st(c, 'Layout'), tb, tc };
  for (const [tag, rows] of [['plain', b], ['cv-auto', c]]) {
    const t = TOT.reduce((a, k) => a + st(rows, k), 0);
    console.log(`  ${(tag === 'plain' ? LABEL[inv] : '').padEnd(16)}${tag.padEnd(10)}` +
      st(rows, 'UpdateLayoutTree').toFixed(1).padStart(8) + st(rows, 'Layout').toFixed(1).padStart(9) +
      st(rows, 'PrePaint').toFixed(1).padStart(10) + st(rows, 'Paint').toFixed(1).padStart(8) + ' │' +
      t.toFixed(1).padStart(8) + (tag === 'plain' ? '        —' : `   ${(tb / t).toFixed(2)}배 ${tb > t ? '이득' : '손해'}`));
  }
  console.log('  ' + '·'.repeat(84));
}

console.log('\n■ 합성(C5) vs 실제(C6) — 전체 배율\n');
const C5 = { 'width-inline': 2.73, 'item-color': 0.22, 'root-var': 1.32 };
console.log('  무효화            합성 C5        실제 C6        방향');
console.log('  ' + '─'.repeat(62));
for (const inv of INVS) {
  if (!S[inv]) continue;
  const real = S[inv].tb / S[inv].tc, syn = C5[inv];
  const same = (real > 1) === (syn > 1);
  console.log(`  ${LABEL[inv].padEnd(16)}${(syn.toFixed(2) + '배').padStart(10)}${(real.toFixed(2) + '배').padStart(14)}` +
    `     ${same ? '같음' : '⚠ 다름'}`);
}

console.log('\n■ 문서 높이 — contain-intrinsic-size 를 한 값으로 줄 수 있나\n');
const hp = d.rows.find(r => r.mode === 'plain')?.heightPlain;
const hc = d.rows.find(r => r.mode === 'cv-auto')?.heightMode;
console.log(`  원본(plain)          ${hp?.toLocaleString()} px`);
console.log(`  cv-auto(81px)        ${hc?.toLocaleString()} px`);
console.log(`  오차                 ${((1 - hc / hp) * 100).toFixed(1)}% 축소  ← 스크롤바가 깨진다`);
console.log(`  (합성 C1 에서는 73px 하나로 오차 1.3% 였다)`);

console.log('\n■ 반복별 Style (평균 뒤에 숨은 흩어짐)\n');
for (const inv of INVS) for (const m of ['plain', 'cv-auto']) {
  const v = pick(m, inv).map(r => r.stage.UpdateLayoutTree.ms).sort((a, b) => a - b);
  if (!v.length) continue;
  console.log(`  ${LABEL[inv].padEnd(16)}${m.padEnd(9)}` + v.map(x => x.toFixed(1).padStart(9)).join('') +
    `    흩어짐 ${(v[v.length - 1] / Math.max(v[0], .001)).toFixed(1)}배`);
}
const p = d.rows.map(r => r.procsAtStart).filter(x => x > 0);
console.log(`\n  시작 시점 chrome ${Math.min(...p)}~${Math.max(...p)}개 (엄격 격리)`);
