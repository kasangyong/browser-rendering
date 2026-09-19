/**
 * C8d 집계 — 레이아웃이 비싼데 LCP 이미지가 eager
 *
 * 질문: 요청이 레이아웃을 안 기다리는데도(eager) LCP 가 빨라지는가?
 *
 * LCP 는 다운로드 완료가 아니라 '페인트' 시점이다. 그래서 세 구간을 나눠 본다:
 *   ① 요청 시작        — eager 면 cv 와 무관해야 한다 (U2)
 *   ② 응답 끝          — 다운로드
 *   ③ 응답 끝 → LCP    — 그리기까지의 대기. 레이아웃이 막고 있다면 여기가 길다 (U4)
 */
import { readFile } from 'node:fs/promises';
const d = JSON.parse(await readFile(new URL('./results-heavy.json', import.meta.url), 'utf8'));
const NAME = { turku: 'Turku', uk: 'United Kingdom', philippines: 'Philippines' };
const med = a => { const s = [...a].filter(x => x != null).sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null; };
const pick = (k, m) => d.rows.filter(r => r.siteKey === k && r.mode === m);
const KEYS = ['turku', 'uk', 'philippines'].filter(k => d.rows.some(r => r.siteKey === k));
const pct = x => (x <= 0 ? '−' : '+') + Math.abs(x).toFixed(0) + '%';

console.log(`\n■ ① 렌더링 일 (로드 중 총 ms · 중앙값) — U1\n`);
console.log('  사이트           모드         Style   Layout    Paint  │ Layout 절감');
console.log('  ' + '─'.repeat(68));
for (const k of KEYS) {
  const b = pick(k, 'plain'), v = pick(k, 'cv-auto');
  if (!b.length || !v.length) continue;
  const g = (r, s) => med(r.map(x => x.stage[s].ms));
  for (const [m, r] of [['plain', b], ['cv-auto', v]])
    console.log(`  ${(m === 'plain' ? NAME[k] : '').padEnd(16)}${m.padEnd(10)}` +
      g(r, 'UpdateLayoutTree').toFixed(1).padStart(9) + g(r, 'Layout').toFixed(1).padStart(9) +
      g(r, 'Paint').toFixed(1).padStart(9) + '  │' +
      (m === 'cv-auto' ? pct(-(1 - g(v, 'Layout') / g(b, 'Layout')) * 100).padStart(9) : ''));
  console.log('  ' + '·'.repeat(68));
}

console.log(`\n■ ② 사용자가 보는 것 (ms · 중앙값) — U3\n`);
console.log('  사이트           모드          FCP      LCP  │  FCP 변화   LCP 변화   판정');
console.log('  ' + '─'.repeat(74));
for (const k of KEYS) {
  const b = pick(k, 'plain'), v = pick(k, 'cv-auto');
  if (!b.length || !v.length) continue;
  const bf = med(b.map(x => x.fcpMs)), bl = med(b.map(x => x.lcpMs));
  const cf = med(v.map(x => x.fcpMs)), cl = med(v.map(x => x.lcpMs));
  const dl = (cl - bl) / bl * 100;
  console.log(`  ${NAME[k].padEnd(16)}${'plain'.padEnd(10)}${bf.toFixed(0).padStart(9)}${bl.toFixed(0).padStart(9)}  │`);
  console.log(`  ${''.padEnd(16)}${'cv-auto'.padEnd(10)}${cf.toFixed(0).padStart(9)}${cl.toFixed(0).padStart(9)}  │` +
    pct((cf - bf) / bf * 100).padStart(10) + pct(dl).padStart(11) +
    `   ${dl <= -10 ? '빨라짐' : dl >= 10 ? '느려짐' : '차이 없음'}`);
  console.log('  ' + '·'.repeat(74));
}

console.log(`\n■ ③ LCP 를 세 구간으로 쪼갠다 (ms · 중앙값) — U2 · U4\n`);
console.log('  사이트           모드       요청시작    응답끝  응답끝→LCP      LCP');
console.log('  ' + '─'.repeat(70));
const seg = {};
for (const k of KEYS) {
  for (const m of ['plain', 'cv-auto']) {
    const r = pick(k, m).filter(x => x.lcpRes && x.lcpMs != null);
    if (!r.length) continue;
    const s = med(r.map(x => x.lcpRes.start)), e = med(r.map(x => x.lcpRes.end));
    const L = med(r.map(x => x.lcpMs));
    seg[k + '|' + m] = { s, e, wait: L - e, L };
    console.log(`  ${(m === 'plain' ? NAME[k] : '').padEnd(16)}${m.padEnd(10)}` +
      s.toFixed(0).padStart(9) + e.toFixed(0).padStart(10) + (L - e).toFixed(0).padStart(12) + L.toFixed(0).padStart(9));
  }
  const b = seg[k + '|plain'], v = seg[k + '|cv-auto'];
  // 앞당김 = plain 요청시작 − cv 요청시작. 양수면 cv 가 더 일찍 요청했다는 뜻.
  if (b && v) console.log(`  ${''.padEnd(16)}→ 요청 앞당김 ${((b.s - v.s >= 0 ? '+' : '−') + Math.abs(b.s - v.s).toFixed(0)).padStart(5)}ms` +
    `   ·   응답끝→LCP 대기 ${b.wait.toFixed(0)} → ${v.wait.toFixed(0)}ms (${pct((v.wait - b.wait) / b.wait * 100)})`);
  console.log('  ' + '·'.repeat(70));
}

console.log(`\n■ ④ 판정\n`);
for (const k of KEYS) {
  const b = seg[k + '|plain'], v = seg[k + '|cv-auto'];
  if (!b || !v) continue;
  const dReq = b.s - v.s, dL = (v.L - b.L) / b.L * 100, dW = (v.wait - b.wait) / b.wait * 100;
  console.log(`  ${NAME[k].padEnd(16)}` +
    `U2 요청 ${(Math.abs(dReq) <= 50 ? '안 움직임' : (dReq > 0 ? '앞당겨짐 ' : '밀림 ') + Math.abs(dReq).toFixed(0) + 'ms').padEnd(16)}` +
    `U3 LCP ${(Math.abs(dL) < 10 ? '차이 없음' : pct(dL)).padEnd(11)}` +
    `U4 대기 ${Math.abs(dW) < 10 ? '차이 없음' : pct(dW)}`);
}

console.log(`\n■ ⑤ 반복별 (ms, 정렬)\n`);
for (const k of KEYS) for (const m of ['plain', 'cv-auto']) {
  const v = pick(k, m).map(x => x.lcpMs).filter(x => x != null).sort((a, b) => a - b);
  if (!v.length) continue;
  console.log(`  ${NAME[k].padEnd(16)}${m.padEnd(9)}` + v.map(x => String(Math.round(x)).padStart(7)).join('') +
    `   흩어짐 ${(v[v.length - 1] / v[0]).toFixed(1)}배`);
}
const el = d.rows.filter(r => r.lcpEl);
console.log(`\n  총 ${d.rows.length}행 · LCP 이미지 ${el.filter(r => r.lcpEl.isImg).length}/${el.length}` +
  ` · LCP 이미지 loading ${[...new Set(d.rows.map(r => r.lcpLoading))].join(',')}` +
  ` · cv 주입 ${d.rows.filter(r => r.mode === 'cv-auto' && r.cvApplied).length}/${d.rows.filter(r => r.mode === 'cv-auto').length}`);
