/**
 * C8b 집계 — lazy 를 끄면 cv 의 LCP 개선이 사라지는가
 *
 * 가설: LCP 개선은 cv 가 레이아웃을 줄여 **lazy 이미지의 요청 시점을 앞당긴** 결과다.
 * 맞으면 eager 에서 cv 의 LCP 개선이 사라져야 한다 (S8).
 *
 * 세션 간 네트워크 드리프트가 있으므로 **같은 실행 안에서만** 비교한다.
 * lazy 팔과 eager 팔이 섞인 순서로 돌았으므로 드리프트는 양쪽에 똑같이 걸린다.
 */
import { readFile } from 'node:fs/promises';
const d = JSON.parse(await readFile(new URL('./results-lazy.json', import.meta.url), 'utf8'));
const NAME = { canyon: 'Grand Canyon', milky: 'Milky Way', everest: 'Mount Everest' };
const med = a => { const s = [...a].filter(x => x != null).sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null; };
const pick = (k, m, z) => d.rows.filter(r => r.siteKey === k && r.mode === m && r.lazy === z);
const KEYS = [...new Set(d.rows.map(r => r.siteKey))];
const pct = x => (x <= 0 ? '−' : '+') + Math.abs(x).toFixed(0) + '%';

console.log(`\n■ ① 핵심 — eager 에서 cv 의 LCP 개선이 사라지는가 (ms · 중앙값)\n`);
console.log('  사이트          이미지    plain   cv-auto  │ LCP 변화   판정');
console.log('  ' + '─'.repeat(66));
const L = {};
for (const k of KEYS) {
  for (const z of ['lazy', 'eager']) {
    const b = pick(k, 'plain', z), v = pick(k, 'cv-auto', z);
    if (!b.length || !v.length) continue;
    const bl = med(b.map(x => x.lcpMs)), cl = med(v.map(x => x.lcpMs));
    L[`${k}|${z}`] = { bl, cl, d: (cl - bl) / bl * 100 };
    console.log(`  ${(z === 'lazy' ? NAME[k] : '').padEnd(15)}${z.padEnd(8)}` +
      bl.toFixed(0).padStart(7) + cl.toFixed(0).padStart(10) + '  │' + pct(L[`${k}|${z}`].d).padStart(9) +
      `   ${Math.abs(L[`${k}|${z}`].d) < 10 ? '차이 없음' : L[`${k}|${z}`].d < 0 ? '빨라짐' : '느려짐'}`);
  }
  const a = L[`${k}|lazy`], e = L[`${k}|eager`];
  if (a && e) console.log(`  ${''.padEnd(15)}→ lazy 에서 ${pct(a.d)} · eager 에서 ${pct(e.d)}` +
    `   ${Math.abs(e.d) < 10 && a.d < -10 ? '★ 개선이 사라졌다 (S8 성립)' :
         Math.abs(e.d) >= 10 ? '개선이 남아 있다 (S8 반증)' : '판정 보류'}`);
  console.log('  ' + '·'.repeat(66));
}

console.log(`\n■ ② eager 가 plain 을 앞당기는가 (S9) — 같은 모드끼리 lazy vs eager\n`);
console.log('  사이트          모드        lazy    eager  │ 변화');
console.log('  ' + '─'.repeat(58));
for (const k of KEYS) for (const m of ['plain', 'cv-auto']) {
  const a = med(pick(k, m, 'lazy').map(x => x.lcpMs));
  const e = med(pick(k, m, 'eager').map(x => x.lcpMs));
  if (a == null || e == null) continue;
  console.log(`  ${(m === 'plain' ? NAME[k] : '').padEnd(15)}${m.padEnd(9)}` +
    a.toFixed(0).padStart(7) + e.toFixed(0).padStart(9) + '  │' + pct((e - a) / a * 100).padStart(9));
}

console.log(`\n■ ③ 요청 시작 시각 — 가설의 심장 (ms · 중앙값)\n`);
console.log('  사이트          이미지  모드       요청시작   응답끝      LCP  │ 요청이 앞당겨진 폭');
console.log('  ' + '─'.repeat(80));
for (const k of KEYS) for (const z of ['lazy', 'eager']) {
  const b = pick(k, 'plain', z).filter(x => x.lcpRes), v = pick(k, 'cv-auto', z).filter(x => x.lcpRes);
  if (!b.length || !v.length) continue;
  const bs = med(b.map(x => x.lcpRes.start)), vs = med(v.map(x => x.lcpRes.start));
  const be = med(b.map(x => x.lcpRes.end)), ve = med(v.map(x => x.lcpRes.end));
  console.log(`  ${(z === 'lazy' ? NAME[k] : '').padEnd(15)}${z.padEnd(7)}${'plain'.padEnd(9)}` +
    bs.toFixed(0).padStart(9) + be.toFixed(0).padStart(9) + med(b.map(x => x.lcpMs)).toFixed(0).padStart(9) + '  │');
  console.log(`  ${''.padEnd(15)}${''.padEnd(7)}${'cv-auto'.padEnd(9)}` +
    vs.toFixed(0).padStart(9) + ve.toFixed(0).padStart(9) + med(v.map(x => x.lcpMs)).toFixed(0).padStart(9) +
    '  │' + (bs - vs).toFixed(0).padStart(10) + 'ms');
  console.log('  ' + '·'.repeat(80));
}

console.log(`\n■ ④ Layout 절감은 이미지 정책과 무관한가 (S10)\n`);
console.log('  사이트          이미지   plain Layout  cv-auto Layout  │ 절감');
console.log('  ' + '─'.repeat(62));
for (const k of KEYS) for (const z of ['lazy', 'eager']) {
  const b = med(pick(k, 'plain', z).map(x => x.stage.Layout.ms));
  const v = med(pick(k, 'cv-auto', z).map(x => x.stage.Layout.ms));
  if (b == null || v == null) continue;
  console.log(`  ${(z === 'lazy' ? NAME[k] : '').padEnd(15)}${z.padEnd(8)}` +
    b.toFixed(1).padStart(11) + v.toFixed(1).padStart(16) + '  │' + pct(-(1 - v / b) * 100).padStart(8));
}

console.log(`\n■ ⑤ 치환이 실제로 먹었나 · 반복별 LCP\n`);
for (const k of KEYS) for (const z of ['lazy', 'eager']) for (const m of ['plain', 'cv-auto']) {
  const r = pick(k, m, z);
  const v = r.map(x => x.lcpMs).filter(x => x != null).sort((a, b) => a - b);
  if (!v.length) continue;
  console.log(`  ${NAME[k].padEnd(15)}${z.padEnd(7)}${m.padEnd(9)}` +
    v.map(x => String(Math.round(x)).padStart(6)).join('') +
    `   lazy남음 ${med(r.map(x => x.imgLazy))}/${r[0]?.after?.imgTotal ?? '?'}`);
}
console.log(`\n  총 ${d.rows.length}행 · cv 주입 성공 ` +
  `${d.rows.filter(r => r.mode === 'cv-auto' && r.cvApplied).length}/${d.rows.filter(r => r.mode === 'cv-auto').length}`);
