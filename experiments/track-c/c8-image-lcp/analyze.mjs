/**
 * C8 집계 — LCP 가 이미지일 때
 *
 * C7 과 달리 질문이 셋이다:
 *   ① 렌더링 일이 줄었나        → Layout · Style
 *   ② FCP 와 LCP 가 갈라지나    → C7 에서 못 본 것
 *   ③ LCP 가 뭘 기다리고 있나   → 이미지 responseEnd 와 비교
 *
 * 네트워크가 섞이므로 평균 대신 중앙값. 반복별 값도 같이 본다.
 */
import { readFile } from 'node:fs/promises';
const d = JSON.parse(await readFile(new URL('./results.json', import.meta.url), 'utf8'));
const NAME = { canyon: 'Grand Canyon', milky: 'Milky Way', everest: 'Mount Everest' };
const med = a => { const s = [...a].filter(x => x != null).sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null; };
const pick = (k, m, c) => d.rows.filter(r => r.siteKey === k && r.mode === m && r.cache === c);
const KEYS = [...new Set(d.rows.map(r => r.siteKey))];
const CACHES = ['cold', 'warm'];
const pct = x => (x <= 0 ? '−' : '+') + Math.abs(x).toFixed(0) + '%';

console.log(`\n■ ① 렌더링 일 — cv 가 실제로 건너뛰나 (로드 중 총 ms · 중앙값)\n`);
console.log('  사이트          캐시   모드         Style   Layout    Paint  │ Layout 절감');
console.log('  ' + '─'.repeat(74));
const work = {};
for (const k of KEYS) {
  for (const c of CACHES) {
    for (const m of ['plain', 'cv-auto']) {
      const r = pick(k, m, c); if (!r.length) continue;
      const g = s => med(r.map(x => x.stage[s].ms));
      work[`${k}|${m}|${c}`] = { style: g('UpdateLayoutTree'), layout: g('Layout') };
      const b = work[`${k}|plain|${c}`], cur = work[`${k}|${m}|${c}`];
      const save = m === 'cv-auto' && b ? pct(-(1 - cur.layout / b.layout) * 100) : '';
      console.log(`  ${(m === 'plain' ? NAME[k] : '').padEnd(15)}${(m === 'plain' ? c : '').padEnd(7)}${m.padEnd(9)}` +
        g('UpdateLayoutTree').toFixed(1).padStart(9) + g('Layout').toFixed(1).padStart(9) +
        g('Paint').toFixed(1).padStart(9) + '  │' + save.padStart(9));
    }
  }
  console.log('  ' + '·'.repeat(74));
}

console.log(`\n■ ② 사용자가 보는 것 — FCP · LCP 가 갈라지나 (ms · 중앙값)\n`);
console.log('  사이트          캐시   모드          FCP      LCP   LCP−FCP  │  FCP 변화  LCP 변화');
console.log('  ' + '─'.repeat(82));
const ux = {};
for (const k of KEYS) {
  for (const c of CACHES) {
    const b = pick(k, 'plain', c), v = pick(k, 'cv-auto', c);
    if (!b.length || !v.length) continue;
    const bf = med(b.map(x => x.fcpMs)), bl = med(b.map(x => x.lcpMs));
    const cf = med(v.map(x => x.fcpMs)), cl = med(v.map(x => x.lcpMs));
    ux[`${k}|${c}`] = { bf, bl, cf, cl };
    console.log(`  ${NAME[k].padEnd(15)}${c.padEnd(7)}${'plain'.padEnd(9)}` +
      bf.toFixed(0).padStart(9) + bl.toFixed(0).padStart(9) + (bl - bf).toFixed(0).padStart(10) + '  │');
    console.log(`  ${''.padEnd(15)}${''.padEnd(7)}${'cv-auto'.padEnd(9)}` +
      cf.toFixed(0).padStart(9) + cl.toFixed(0).padStart(9) + (cl - cf).toFixed(0).padStart(10) + '  │' +
      pct((cf - bf) / bf * 100).padStart(10) + pct((cl - bl) / bl * 100).padStart(10) +
      `   ${(cl - bl) / bl <= -0.1 ? '빨라짐' : (cl - bl) / bl >= 0.1 ? '느려짐' : '차이 없음'}`);
    console.log('  ' + '·'.repeat(82));
  }
}

console.log(`\n■ ③ LCP 는 무엇을 기다리고 있나 — 이미지 다운로드 완료와 비교 (ms · 중앙값)\n`);
console.log('  사이트          캐시   모드        LCP   이미지 내려받음    차이  │ 판정');
console.log('  ' + '─'.repeat(76));
for (const k of KEYS) for (const c of CACHES) for (const m of ['plain', 'cv-auto']) {
  const r = pick(k, m, c).filter(x => x.lcpRes && x.lcpMs != null);
  if (!r.length) continue;
  const L = med(r.map(x => x.lcpMs)), E = med(r.map(x => x.lcpRes.end));
  const gap = L - E;
  console.log(`  ${(m === 'plain' ? NAME[k] : '').padEnd(15)}${(m === 'plain' ? c : '').padEnd(7)}${m.padEnd(9)}` +
    L.toFixed(0).padStart(7) + E.toFixed(0).padStart(15) + gap.toFixed(0).padStart(8) + '  │ ' +
    (Math.abs(gap) < 0.15 * L ? '다운로드가 결정' : gap > 0 ? '다운로드 뒤에 더 기다림' : '다운로드 전에 확정(캐시)'));
}

console.log(`\n■ ④ LCP 요소가 바뀌었나 — cv 가 무엇을 LCP 로 만드나\n`);
console.log('  사이트          캐시   모드       이미지 / 텍스트 / 못받음    크기(px²)');
console.log('  ' + '─'.repeat(70));
for (const k of KEYS) for (const c of CACHES) for (const m of ['plain', 'cv-auto']) {
  const r = pick(k, m, c); if (!r.length) continue;
  const img = r.filter(x => x.lcpEl?.isImg).length;
  const txt = r.filter(x => x.lcpEl && !x.lcpEl.isImg).length;
  const non = r.filter(x => !x.lcpEl).length;
  const sz = med(r.map(x => x.lcpEl?.size).filter(Boolean));
  console.log(`  ${(m === 'plain' ? NAME[k] : '').padEnd(15)}${(m === 'plain' ? c : '').padEnd(7)}${m.padEnd(9)}` +
    `${String(img).padStart(9)} / ${String(txt).padStart(4)} / ${String(non).padStart(5)}` +
    (sz ? String(sz).padStart(14) : ''.padStart(14)));
}

console.log(`\n■ ⑤ 반복별 LCP — 흩어짐 (ms, 정렬)\n`);
for (const k of KEYS) for (const c of CACHES) for (const m of ['plain', 'cv-auto']) {
  const v = pick(k, m, c).map(x => x.lcpMs).filter(x => x != null).sort((a, b) => a - b);
  if (!v.length) continue;
  console.log(`  ${NAME[k].padEnd(15)}${c.padEnd(6)}${m.padEnd(9)}` +
    v.map(x => String(Math.round(x)).padStart(6)).join('') + `   흩어짐 ${(v[v.length - 1] / v[0]).toFixed(1)}배`);
}

console.log(`\n■ ⑥ C7(텍스트 LCP)과 대조\n`);
console.log('  지표                          C7 문서 사이트          C8 이미지 LCP');
console.log('  ' + '─'.repeat(66));
const lay = c => KEYS.map(k => {
  const b = work[`${k}|plain|${c}`], v = work[`${k}|cv-auto|${c}`];
  return b && v ? (1 - v.layout / b.layout) * 100 : null; }).filter(x => x != null);
const dlcp = c => KEYS.map(k => ux[`${k}|${c}`]
  ? (ux[`${k}|${c}`].cl - ux[`${k}|${c}`].bl) / ux[`${k}|${c}`].bl * 100 : null).filter(x => x != null);
console.log(`  Layout 절감 (warm)            84~99%                 ${lay('warm').map(x => x.toFixed(0) + '%').join(' · ')}`);
console.log(`  Layout 절감 (cold)            —                      ${lay('cold').map(x => x.toFixed(0) + '%').join(' · ')}`);
console.log(`  LCP 변화 (warm)               −91% · −6% · +4%       ${dlcp('warm').map(pct).join(' · ')}`);
console.log(`  LCP 변화 (cold)               —                      ${dlcp('cold').map(pct).join(' · ')}`);

const applied = d.rows.filter(r => r.mode === 'cv-auto');
console.log(`\n  cv 주입 성공 ${applied.filter(r => r.cvApplied).length}/${applied.length}` +
  `  ·  총 ${d.rows.length}행` +
  `  ·  문서 축소 ${KEYS.map(k => {
    const v = pick(k, 'cv-auto', 'warm')[0], b = pick(k, 'plain', 'warm')[0];
    return v?.after && b?.after ? `${NAME[k]} ${(100 * (1 - v.after.h / b.after.h)).toFixed(0)}%` : '';
  }).filter(Boolean).join(' · ')}`);
