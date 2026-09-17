/**
 * 초기 로드 측정용 정적 HTML 생성기
 *
 * 항목을 JS 로 만들면 파싱 비용이 빠진다.
 * 브라우저가 진짜 문서를 파싱·레이아웃·페인트하는 전 과정을 재려면
 * N개 항목이 HTML 에 그대로 들어 있어야 한다.
 *
 * 사용: node gen.mjs
 */
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const OUT = path.join(import.meta.dirname, 'pages');
const COUNTS = [200, 1000, 4000];
const MODES = {
  // A4 에서 유도한 값: 실제 항목 109px = content 73 + padding 24 + border 2 + margin 10
  'plain':     '',
  'cv-auto':   '.item{content-visibility:auto;contain-intrinsic-size:auto 73px}',
  'cv-nosize': '.item{content-visibility:auto}',
};

const WORDS = ('렌더링 파이프라인 레이아웃 페인트 합성 타일 래스터 프로퍼티 트리 ' +
               'display list paint chunk compositor viz blink skia').split(' ');
const text = (seed, k) =>
  Array.from({ length: k }, (_, i) => WORDS[(seed * 7 + i * 3) % WORDS.length]).join(' ');

const page = (mode, n) => `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8">
<title>C1 ${mode} n=${n}</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#fbfaf8;color:#1a1a1a;padding:0 16px 48px;width:100%;
       font:15px/1.55 system-ui,-apple-system,"Segoe UI","Malgun Gothic",sans-serif}
  #list{width:760px;margin:0 auto}
  .item{border:1px solid #e3e0da;border-radius:6px;background:#fff;
        padding:12px 14px;margin-bottom:10px}
  .item h3{margin:0 0 6px;font-size:15px}
  .item p{margin:0 0 6px;font-size:13px;color:#6b6b6b}
  .item .row{display:flex;gap:8px;flex-wrap:wrap}
  .item .tag{font:11px ui-monospace,Consolas,monospace;padding:2px 7px;
             border-radius:99px;border:1px solid #e3e0da}
  ${MODES[mode]}
</style></head>
<body><div id="list">
${Array.from({ length: n }, (_, i) =>
`<div class="item"><h3>항목 ${i}</h3><p>${text(i, 14)}</p><div class="row">` +
`<span class="tag">${text(i + 1, 2)}</span><span class="tag">${text(i + 2, 2)}</span>` +
`<span class="tag">${text(i + 3, 2)}</span></div></div>`).join('\n')}
</div></body></html>`;

await mkdir(OUT, { recursive: true });
let total = 0;
for (const mode of Object.keys(MODES)) {
  for (const n of COUNTS) {
    const html = page(mode, n);
    const f = path.join(OUT, `${mode}-${n}.html`);
    await writeFile(f, html);
    total += html.length;
    console.log(`  ${path.basename(f).padEnd(22)} ${(html.length / 1024).toFixed(0)} KB`);
  }
}
console.log(`\n✅ ${Object.keys(MODES).length * COUNTS.length}개 · 합계 ${(total / 1048576).toFixed(1)} MB`);
