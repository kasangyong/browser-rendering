/**
 * C6 종합 — 실제 사이트 3곳을 합성(C5)과 나란히 놓는다.
 * 2배 미만 차이는 "차이 없음" 으로 읽는다.
 */
import { readFile } from 'node:fs/promises';
const FILES = [['wiki-uni','results.json'],['whatwg-dom','results-whatwg-dom.json'],['py-func','results-py-func.json']];
const NAME = { 'wiki-uni':'Wikipedia', 'whatwg-dom':'WHATWG 스펙', 'py-func':'Python 문서' };
const CV   = { 'wiki-uni':3.72, 'whatwg-dom':1.90, 'py-func':1.16 };
const mean = a => (a.length ? a.reduce((x,y)=>x+y,0)/a.length : 0);
const TOT = ['UpdateLayoutTree','Layout','PrePaint','Paint'];
const INVS = ['width-inline','item-color','root-var'];
const LAB = { 'width-inline':'컨테이너 폭만', 'item-color':'항목 스타일만', 'root-var':':root 변수' };

const data = [];
for (const [key,f] of FILES) {
  try { data.push([key, JSON.parse(await readFile(new URL('./'+f, import.meta.url),'utf8'))]); }
  catch { console.error('  (없음) '+f); }
}

console.log('\n■ 사이트 개요\n');
console.log('  사이트         블록수   DOM       문서높이     변동계수   cv 적용 후 높이   오차');
console.log('  '+'─'.repeat(88));
for (const [key,d] of data) {
  const p = d.rows.find(r=>r.mode==='plain'), c = d.rows.find(r=>r.mode==='cv-auto');
  console.log('  '+NAME[key].padEnd(14)+String(c.blocks).padStart(6)+
    String(p.domNodes).toLocaleString().padStart(10)+
    (p.heightPlain.toLocaleString()+'px').padStart(13)+
    String(CV[key]).padStart(11)+
    (c.heightMode.toLocaleString()+'px').padStart(17)+
    ((100*(1-c.heightMode/p.heightPlain)).toFixed(1)+'%').padStart(8));
}

console.log('\n■ 무효화별 전체 배율 (plain 합계 ÷ cv 합계 · 1보다 크면 cv 이득)\n');
console.log('  무효화            합성 C5    Wikipedia   WHATWG   Python');
console.log('  '+'─'.repeat(62));
const C5 = { 'width-inline':2.73, 'item-color':0.22, 'root-var':1.32 };
const ratios = {};
for (const inv of INVS) {
  let line = '  '+LAB[inv].padEnd(16)+(C5[inv].toFixed(2)+'배').padStart(9);
  ratios[inv] = {};
  for (const [key,d] of data) {
    const b = d.rows.filter(r=>r.mode==='plain'&&r.inv===inv);
    const c = d.rows.filter(r=>r.mode==='cv-auto'&&r.inv===inv);
    if (!b.length||!c.length) { line += '        —'; continue; }
    const tb = TOT.reduce((a,k)=>a+mean(b.map(r=>r.stage[k].ms)),0);
    const tc = TOT.reduce((a,k)=>a+mean(c.map(r=>r.stage[k].ms)),0);
    ratios[inv][key] = tb/tc;
    line += ((tb/tc).toFixed(2)+'배').padStart(11);
  }
  console.log(line);
}

console.log('\n■ Style 만 따로 (plain → cv)\n');
console.log('  무효화            사이트          plain Style   cv Style      변화');
console.log('  '+'─'.repeat(70));
for (const inv of INVS) {
  for (const [key,d] of data) {
    const b = mean(d.rows.filter(r=>r.mode==='plain'&&r.inv===inv).map(r=>r.stage.UpdateLayoutTree.ms));
    const c = mean(d.rows.filter(r=>r.mode==='cv-auto'&&r.inv===inv).map(r=>r.stage.UpdateLayoutTree.ms));
    if (!b&&!c) continue;
    const ch = b>0 ? (1-c/b)*100 : 0;
    console.log('  '+(inv===INVS.indexOf(inv)?'':LAB[inv]).padEnd(16)+NAME[key].padEnd(15)+
      b.toFixed(2).padStart(10)+c.toFixed(2).padStart(12)+
      ((ch>=0?'−':'+')+Math.abs(ch).toFixed(0)+'%').padStart(11));
  }
  console.log('  '+'·'.repeat(70));
}

console.log('\n■ 일관성 — 세 사이트에서 방향이 같은가\n');
for (const inv of INVS) {
  const v = Object.entries(ratios[inv]);
  const wins = v.filter(([,r])=>r>2).length, ties = v.filter(([,r])=>r>=0.5&&r<=2).length;
  console.log('  '+LAB[inv].padEnd(16)+
    v.map(([k,r])=>NAME[k]+' '+r.toFixed(1)+'배').join(' · ').padEnd(52)+
    `  →  ${wins}곳 이득 · ${ties}곳 무승부`);
}
