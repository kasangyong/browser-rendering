/**
 * C7 집계 — 초기 로드
 *
 * 핵심 질문은 두 개이고 **따로** 봐야 한다:
 *   ① 렌더링 일이 줄었나        → Layout · Style 총량
 *   ② 사용자가 보는 게 빨라졌나  → FCP · LCP
 * 둘이 갈릴 수 있고, 갈리는 것 자체가 결과다.
 *
 * 네트워크가 섞이므로 평균 대신 **중앙값**을 쓰고 반복별 값을 같이 보여준다.
 */
import { readFile } from 'node:fs/promises';
const d = JSON.parse(await readFile(new URL('./results.json', import.meta.url), 'utf8'));
const NAME = { 'wiki-uni': 'Wikipedia', 'whatwg-dom': 'WHATWG 스펙', 'py-func': 'Python 문서' };
const med = a => { const s = [...a].filter(x => x != null).sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null; };
const pick = (k, m) => d.rows.filter(r => r.siteKey === k && r.mode === m);
const KEYS = [...new Set(d.rows.map(r => r.siteKey))];

console.log(`\n■ 렌더링 일 — cv 가 실제로 건너뛰나 (로드 중 총 ms · 중앙값)\n`);
console.log('  사이트         모드       ParseHTML    Style   Layout  PrePaint    Paint');
console.log('  ' + '─'.repeat(76));
const work = {};
for (const k of KEYS) {
  for (const m of ['plain', 'cv-auto']) {
    const r = pick(k, m); if (!r.length) continue;
    const g = s => med(r.map(x => x.stage[s].ms));
    work[k + '|' + m] = { style: g('UpdateLayoutTree'), layout: g('Layout') };
    console.log(`  ${(m === 'plain' ? NAME[k] : '').padEnd(14)}${m.padEnd(10)}` +
      g('ParseHTML').toFixed(1).padStart(10) + g('UpdateLayoutTree').toFixed(1).padStart(9) +
      g('Layout').toFixed(1).padStart(9) + g('PrePaint').toFixed(1).padStart(10) +
      g('Paint').toFixed(1).padStart(9));
  }
  const b = work[k + '|plain'], c = work[k + '|cv-auto'];
  if (b && c) console.log(`  ${''.padEnd(14)}→ Style ${((1 - c.style / b.style) * 100).toFixed(0)}% 절감 · ` +
    `Layout ${((1 - c.layout / b.layout) * 100).toFixed(0)}% 절감`);
  console.log('  ' + '·'.repeat(76));
}

console.log(`\n■ 사용자가 보는 것 — FCP · LCP (ms · 중앙값)\n`);
console.log('  사이트         모드          FCP      LCP   │   FCP 변화   LCP 변화');
console.log('  ' + '─'.repeat(72));
const ux = {};
for (const k of KEYS) {
  const b = pick(k, 'plain'), c = pick(k, 'cv-auto');
  if (!b.length || !c.length) continue;
  const bf = med(b.map(x => x.fcpMs)), bl = med(b.map(x => x.lcpMs));
  const cf = med(c.map(x => x.fcpMs)), cl = med(c.map(x => x.lcpMs));
  ux[k] = { bf, bl, cf, cl };
  console.log(`  ${NAME[k].padEnd(14)}${'plain'.padEnd(10)}${bf.toFixed(0).padStart(8)}${bl.toFixed(0).padStart(9)}   │`);
  const df = (cf - bf) / bf * 100, dl = (cl - bl) / bl * 100;
  console.log(`  ${''.padEnd(14)}${'cv-auto'.padEnd(10)}${cf.toFixed(0).padStart(8)}${cl.toFixed(0).padStart(9)}   │` +
    `${((df <= 0 ? '−' : '+') + Math.abs(df).toFixed(0) + '%').padStart(11)}` +
    `${((dl <= 0 ? '−' : '+') + Math.abs(dl).toFixed(0) + '%').padStart(11)}` +
    `   ${dl <= -10 ? '빨라짐' : dl >= 10 ? '느려짐' : '차이 없음'}`);
  console.log('  ' + '·'.repeat(72));
}

console.log(`\n■ 합성(C1)과 대조\n`);
console.log('  지표                        합성 C1        실제 C7');
console.log('  ' + '─'.repeat(58));
const dl = KEYS.map(k => ux[k] ? (ux[k].cl - ux[k].bl) / ux[k].bl * 100 : null).filter(x => x != null);
const lay = KEYS.map(k => {
  const b = work[k + '|plain'], c = work[k + '|cv-auto'];
  return b && c ? (1 - c.layout / b.layout) * 100 : null;
}).filter(x => x != null);
console.log(`  초기 Layout 절감            82%            ${lay.map(x => x.toFixed(0) + '%').join(' · ')}`);
console.log(`  LCP 변화                   −36~39%        ${dl.map(x => (x <= 0 ? '−' : '+') + Math.abs(x).toFixed(0) + '%').join(' · ')}`);

console.log(`\n■ 반복별 LCP (네트워크가 섞이므로 흩어짐을 같이 본다)\n`);
for (const k of KEYS) for (const m of ['plain', 'cv-auto']) {
  const v = pick(k, m).map(x => x.lcpMs).filter(x => x != null).sort((a, b) => a - b);
  if (!v.length) continue;
  console.log(`  ${NAME[k].padEnd(14)}${m.padEnd(9)}` + v.map(x => String(Math.round(x)).padStart(7)).join('') +
    `   흩어짐 ${(v[v.length - 1] / v[0]).toFixed(1)}배`);
}

const applied = d.rows.filter(r => r.mode === 'cv-auto');
const okN = applied.filter(r => r.cvApplied).length;
console.log(`\n  cv 주입 성공 ${okN}/${applied.length}` +
  `  ·  문서 높이 ${KEYS.map(k => {
    const c = pick(k, 'cv-auto')[0], b = pick(k, 'plain')[0];
    return c?.after && b?.after ? `${NAME[k]} ${(100 * (1 - c.after.h / b.after.h)).toFixed(0)}% 축소` : '';
  }).filter(Boolean).join(' · ')}`);
