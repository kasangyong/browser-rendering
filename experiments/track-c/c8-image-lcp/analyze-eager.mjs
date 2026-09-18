/**
 * C8c 집계 — eager 가 '실제'인 사이트에서도 같은가
 *
 * Wikivoyage 3곳은 히어로 배너에 lazy 가 안 붙는다(실제 eager).
 * 같은 실행 안에 forced 팔(히어로에 lazy 를 붙인 것)을 대조군으로 뒀다.
 *
 * 기전이 맞으면: asis 에서는 cv 의 요청 앞당김이 0 근처, forced 에서는 양수.
 * LCP 는 잡음이 크므로 요청 시작 시각을 같이 본다 (방법론 21조).
 */
import { readFile } from 'node:fs/promises';
const d = JSON.parse(await readFile(new URL('./results-eager.json', import.meta.url), 'utf8'));
const NAME = { paris: 'Paris', rome: 'Rome', london: 'London' };
const med = a => { const s = [...a].filter(x => x != null).sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null; };
const pick = (k, m, z) => d.rows.filter(r => r.siteKey === k && r.mode === m && r.lazy === z);
const KEYS = [...new Set(d.rows.map(r => r.siteKey))];
const pct = x => (x <= 0 ? '−' : '+') + Math.abs(x).toFixed(0) + '%';

console.log(`\n■ ① LCP — 실제 eager(asis) 와 강제 lazy(forced) 에서 cv 효과 (ms · 중앙값)\n`);
console.log('  사이트          팔        plain   cv-auto  │ LCP 변화   판정');
console.log('  ' + '─'.repeat(66));
const L = {};
for (const k of KEYS) {
  for (const z of ['asis', 'forced']) {
    const b = pick(k, 'plain', z), v = pick(k, 'cv-auto', z);
    if (!b.length || !v.length) continue;
    const bl = med(b.map(x => x.lcpMs)), cl = med(v.map(x => x.lcpMs));
    L[`${k}|${z}`] = { bl, cl, d: (cl - bl) / bl * 100 };
    console.log(`  ${(z === 'asis' ? NAME[k] : '').padEnd(15)}${z.padEnd(8)}` +
      bl.toFixed(0).padStart(7) + cl.toFixed(0).padStart(10) + '  │' + pct(L[`${k}|${z}`].d).padStart(9) +
      `   ${Math.abs(L[`${k}|${z}`].d) < 10 ? '차이 없음' : L[`${k}|${z}`].d < 0 ? '빨라짐' : '느려짐'}`);
  }
  const a = L[`${k}|lazy`], e = L[`${k}|eager`];
  if (a && e) console.log(`  ${''.padEnd(15)}→ asis 에서 ${pct(a.d)} · forced 에서 ${pct(e.d)}` +
    `   ${Math.abs(a.d) < 10 && e.d < -10 ? '★ 예측대로 (T1·T2 성립)' :
         a.d < -10 ? 'asis 에서도 빨라졌다 (T1 반증)' : '판정 보류'}`);
  console.log('  ' + '·'.repeat(66));
}

console.log(`\n■ ② 히어로에 lazy 를 붙이면 느려지는가 — 같은 모드끼리 asis vs forced\n`);
console.log('  사이트          모드        asis   forced  │ 변화');
console.log('  ' + '─'.repeat(58));
for (const k of KEYS) for (const m of ['plain', 'cv-auto']) {
  const a = med(pick(k, m, 'asis').map(x => x.lcpMs));
  const e = med(pick(k, m, 'forced').map(x => x.lcpMs));
  if (a == null || e == null) continue;
  console.log(`  ${(m === 'plain' ? NAME[k] : '').padEnd(15)}${m.padEnd(9)}` +
    a.toFixed(0).padStart(7) + e.toFixed(0).padStart(9) + '  │' + pct((e - a) / a * 100).padStart(9));
}

console.log(`\n■ ③ 요청 시작 시각 — 기전이 직접 예측하는 양 (ms · 중앙값) ★T3\n`);
console.log('  사이트          팔     모드       요청시작   응답끝      LCP  │ 요청이 앞당겨진 폭');
console.log('  ' + '─'.repeat(80));
for (const k of KEYS) for (const z of ['asis', 'forced']) {
  const b = pick(k, 'plain', z).filter(x => x.lcpRes), v = pick(k, 'cv-auto', z).filter(x => x.lcpRes);
  if (!b.length || !v.length) continue;
  const bs = med(b.map(x => x.lcpRes.start)), vs = med(v.map(x => x.lcpRes.start));
  const be = med(b.map(x => x.lcpRes.end)), ve = med(v.map(x => x.lcpRes.end));
  console.log(`  ${(z === 'asis' ? NAME[k] : '').padEnd(15)}${z.padEnd(7)}${'plain'.padEnd(9)}` +
    bs.toFixed(0).padStart(9) + be.toFixed(0).padStart(9) + med(b.map(x => x.lcpMs)).toFixed(0).padStart(9) + '  │');
  console.log(`  ${''.padEnd(15)}${''.padEnd(7)}${'cv-auto'.padEnd(9)}` +
    vs.toFixed(0).padStart(9) + ve.toFixed(0).padStart(9) + med(v.map(x => x.lcpMs)).toFixed(0).padStart(9) +
    '  │' + (bs - vs).toFixed(0).padStart(10) + 'ms');
  console.log('  ' + '·'.repeat(80));
}

console.log(`\n■ ④ Layout 절감은 이미지 정책과 무관한가 (T4)\n`);
console.log('  사이트          팔       plain Layout  cv-auto Layout  │ 절감');
console.log('  ' + '─'.repeat(62));
for (const k of KEYS) for (const z of ['asis', 'forced']) {
  const b = med(pick(k, 'plain', z).map(x => x.stage.Layout.ms));
  const v = med(pick(k, 'cv-auto', z).map(x => x.stage.Layout.ms));
  if (b == null || v == null) continue;
  console.log(`  ${(z === 'asis' ? NAME[k] : '').padEnd(15)}${z.padEnd(8)}` +
    b.toFixed(1).padStart(11) + v.toFixed(1).padStart(16) + '  │' + pct(-(1 - v / b) * 100).padStart(8));
}

console.log(`\n■ ⑤ 치환이 실제로 먹었나 (LCP 이미지의 loading) · 반복별 LCP\n`);
for (const k of KEYS) for (const z of ['asis', 'forced']) for (const m of ['plain', 'cv-auto']) {
  const r = pick(k, m, z);
  const v = r.map(x => x.lcpMs).filter(x => x != null).sort((a, b) => a - b);
  if (!v.length) continue;
  console.log(`  ${NAME[k].padEnd(15)}${z.padEnd(7)}${m.padEnd(9)}` +
    v.map(x => String(Math.round(x)).padStart(6)).join('') +
    `   LCP이미지 ${[...new Set(r.map(x => x.lcpLoading))].join(',')}  lazy ${med(r.map(x => x.imgLazy))}/${r[0]?.after?.imgTotal ?? '?'}`);
}
console.log(`\n  총 ${d.rows.length}행 · cv 주입 성공 ` +
  `${d.rows.filter(r => r.mode === 'cv-auto' && r.cvApplied).length}/${d.rows.filter(r => r.mode === 'cv-auto').length}`);
