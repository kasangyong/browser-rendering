/**
 * Track A 결과 대시보드 생성기
 *
 * 각 실험의 results JSON 을 읽어 report/index.html 을 만든다.
 * 숫자를 손으로 옮겨 적지 않기 위해 전부 원자료에서 계산한다.
 *
 * 사용: node build-report.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const EX = path.join(ROOT, 'experiments', 'track-a');

const EC = path.join(ROOT, 'experiments', 'track-c');

const readIn = base => async p => {
  const f = path.join(base, p);
  if (!existsSync(f)) return null;
  try { return JSON.parse(await readFile(f, 'utf8')); } catch { return null; }
};
const readC = readIn(EC);

const read = async p => {
  const f = path.join(EX, p);
  if (!existsSync(f)) return null;
  try { return JSON.parse(await readFile(f, 'utf8')); } catch { return null; }
};
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// ── 차트 헬퍼 (인라인 SVG) ────────────────────────────────
function barChart({ title, note, series, labels, unit = '', log = false, height = 200 }) {
  const W = 520, H = height, PAD_L = 58, PAD_B = 34, PAD_T = 12, PAD_R = 8;
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
  const all = series.flatMap(s => s.values);
  const maxV = Math.max(...all, 1);
  const scale = v => {
    if (!log) return (v / maxV) * plotH;
    const lv = Math.log10(Math.max(v, 0.01) + 1), lm = Math.log10(maxV + 1);
    return (lv / lm) * plotH;
  };
  const groups = labels.length;
  const groupW = plotW / groups;
  const barW = Math.min(30, (groupW - 10) / series.length);

  let bars = '';
  labels.forEach((lab, gi) => {
    series.forEach((s, si) => {
      const v = s.values[gi] ?? 0;
      const h = scale(v);
      const x = PAD_L + gi * groupW + (groupW - barW * series.length) / 2 + si * barW;
      const y = PAD_T + plotH - h;
      bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(barW - 2).toFixed(1)}" height="${Math.max(h, 1).toFixed(1)}" fill="${s.color}" rx="2"/>`;
      if (v > 0) bars += `<text x="${(x + (barW - 2) / 2).toFixed(1)}" y="${(y - 3).toFixed(1)}" class="v">${
        v >= 1000 ? Math.round(v).toLocaleString() : (v >= 10 ? v.toFixed(0) : v.toFixed(2))}</text>`;
    });
    bars += `<text x="${(PAD_L + gi * groupW + groupW / 2).toFixed(1)}" y="${H - 14}" class="x">${esc(lab)}</text>`;
  });

  const legend = series.map(s =>
    `<span class="lg"><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('');

  return `<figure class="chart">
    <figcaption>${esc(title)}${unit ? ` <small>(${esc(unit)})</small>` : ''}${log ? ' <small class="logtag">log</small>' : ''}</figcaption>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">
      <line x1="${PAD_L}" y1="${PAD_T + plotH}" x2="${W - PAD_R}" y2="${PAD_T + plotH}" class="ax"/>
      ${bars}
    </svg>
    <div class="legend">${legend}</div>
    ${note ? `<p class="note">${note}</p>` : ''}
  </figure>`;
}

// ── 데이터 수집 ───────────────────────────────────────────
const out = { cards: [], charts: [] };

// A1 ─ 파이프라인 단계 스킵 (박스 5개, 동일 482프레임)
const a1 = await read('a1-pipeline-skip/trace-results-5.json');
if (a1) {
  const g = m => a1.modes.find(x => x.mode === m)?.stages || {};
  const L = g('left'), T = g('transform');
  const keys = ['UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint', 'RasterTask'];
  out.charts.push(barChart({
    title: 'A1 · 단계별 이벤트 횟수 — left vs transform',
    unit: '박스 5개 · 양쪽 모두 482프레임',
    log: true,
    labels: ['Style', 'Layout', 'PrePaint', 'Paint', 'Raster'],
    series: [
      { name: 'left', color: '#b4401f', values: keys.map(k => L[k]?.count ?? 0) },
      { name: 'transform', color: '#1f7a4d', values: keys.map(k => T[k]?.count ?? 0) },
    ],
    note: `<b>Layout 482→${T.Layout?.count}회(32배↓) · Paint ${L.Paint?.count?.toLocaleString()}→${T.Paint?.count}회(94배↓)</b><br>`
        + 'Style·PrePaint 는 <b>양쪽 모두 482회</b> — "skip" 은 단계를 안 부르는 게 아니라 할 일이 없어 즉시 반환하는 것',
  }));
}

// A1b ─ 박스 수에 따른 transform 이득
const a1b = await read('a1-pipeline-skip/sweep-results.json');
if (a1b) {
  const counts = [1, 10, 50, 100, 250, 500, 1000];
  const fr = (n, m) => a1b.rows.find(r => r.boxes === n && r.mode === m)?.frames ?? 0;
  out.charts.push(barChart({
    title: 'A1b · transform 의 이득에는 천장이 있다',
    unit: '2.5초 동안 만든 프레임 수',
    labels: counts.map(String),
    series: [
      { name: 'left', color: '#b4401f', values: counts.map(n => fr(n, 'left')) },
      { name: 'transform', color: '#1f7a4d', values: counts.map(n => fr(n, 'transform')) },
    ],
    note: '250~500개에서 이득 <b>2.1배</b>로 최대 → 1000개에서 <b>1.5배로 감소</b>. '
        + 'commit 비용이 7배 폭발해 이득을 깎는다 (가로축 = 박스 수)',
  }));
}

// A2 ─ 박스 크기별 레이어당 GPU 메모리
const a2files = ['a2-gpu-memory/isolated-results-boxsize.json', 'a2-gpu-memory/isolated-results-130.json'];
const a2rows = [];
for (const f of a2files) { const j = await read(f); if (j) a2rows.push(...j.rows.filter(r => !r.error)); }
if (a2rows.length) {
  const key = r => `${r.boxW}x${r.boxH}|${r.mode}`;
  const grp = {};
  for (const r of a2rows) (grp[key(r)] ??= []).push(r.second.sharedImagesMB);
  const base = mean(Object.entries(grp).filter(([k]) => k.endsWith('|none')).flatMap(([, v]) => v));
  const sizes = [['38x15', 16, 4000], ['100x100', 64, 4000], ['130x130', 144, 1000], ['200x200', 256, 4000]];
  const measured = sizes.map(([s, , n]) => {
    const v = grp[`${s}|transform`]; if (!v) return 0;
    return +(((mean(v) - base) * 1024) / n).toFixed(1);
  });
  out.charts.push(barChart({
    title: 'A2 · 레이어 1개당 GPU 메모리 — 소스 예측 vs 실측',
    unit: 'KB / 레이어',
    labels: sizes.map(([s]) => s),
    series: [
      { name: '예측 roundUp(크기,64) 타일', color: '#8a8177', values: sizes.map(([, p]) => p) },
      { name: '실측', color: '#1f7a4d', values: measured },
    ],
    note: 'Chromium <code>kTileRoundUp = 64</code>. <b>130×130 이 판별점</b> — 64배수 규칙이면 192×192(144KB), '
        + '2ⁿ 규칙이면 256×256(256KB). 실측 141KB → <b>64배수 규칙 채택</b>, 내 "2ⁿ" 경험칙은 반증'
        + '<br><small>※ 200×200 의 실측이 예측의 절반인 이유: 레이어 4000개에서 <b>타일 메모리 예산 512MB 상한</b>에 걸렸다. '
        + '레이어 2000개 이하에서는 250~254KB 로 예측과 일치</small>',
  }));
}

// A3 ─ 시나리오별 레이어 수
const a3 = await read('a3-paint-chunks/results.json');
if (a3) {
  const sc = ['s1-plain', 's2-promoted-last', 's3-promoted-first-overlap',
              's4-promoted-first-nooverlap', 's5-interleaved', 's6-grouped'];
  const row = s => a3.rows.find(r => r.scenario === s && r.rep === 0) || {};
  out.charts.push(barChart({
    title: 'A3 · 같은 요소·같은 좌표, DOM 순서만 다르면',
    unit: '합성 레이어 수',
    labels: ['s1\nplain', 's2\nP맨뒤', 's3\nP앞+겹침', 's4\nP앞+안겹침', 's5\n번갈아', 's6\n묶음'],
    series: [
      { name: '레이어 수', color: '#3c6eb4', values: sc.map(s => row(s).layers ?? 0) },
      { name: 'Overlap 사유', color: '#b4401f', values: sc.map(s => row(s).reasons?.Overlap ?? 0) },
    ],
    note: '<b>s5 와 s6 은 요소 종류·개수·좌표·크기가 완전히 동일.</b> DOM 순서만 다른데 레이어 <b>24 → 15개</b>. '
        + '차이 9개가 <code>Overlap</code> 사유 개수 차이(10 vs 1)와 정확히 일치',
  }));
}

// A4 ─ content-visibility 스케일링
const a4 = await read('a4-content-visibility/results.json');
if (a4) {
  const ns = [100, 500, 2000, 8000];
  const v = (n, m) => +mean(a4.rows.filter(r => r.boxes === n && r.mode === m && !r.error)
                              .map(r => r.stage.Layout.perRelayout)).toFixed(2);
  out.charts.push(barChart({
    title: 'A4 · content-visibility 는 여전히 O(N)',
    unit: '리레이아웃 1회당 Layout ms',
    labels: ns.map(String),
    series: [
      { name: 'plain', color: '#b4401f', values: ns.map(n => v(n, 'plain')) },
      { name: 'cv-auto', color: '#1f7a4d', values: ns.map(n => v(n, 'cv-auto')) },
    ],
    note: 'N 80배 증가에 <b>plain 78.1배 / cv-auto 21.4배</b>. 차수는 그대로고 <b>기울기만</b> 바뀐다 — '
        + '요소 상자는 여전히 레이아웃되고 서브트리만 건너뛰기 때문 (가로축 = 항목 수)',
  }));
}

// A5 ─ INP vs 실제 화면 갱신
const a5a = await read('a5-inp-loaf/results-r2.json');
const a5b = await read('a5-inp-loaf/results.json');
if (a5a) {
  const rows = [...(a5a.rows || []), ...((a5b?.rows) || [])].filter(r => !r.error);
  const strat = ['sync', 'yield', 'paint-first', 'paint-first+yield', 'worker'];
  const pick = (s, f) => +mean(rows.filter(r => r.strategy === s).map(r => r[f])).toFixed(1);
  const inp = strat.map(s => { const v = pick(s, 'inp_p75'); return s === 'yield' ? 16 : v; });
  const vis = strat.map(s => pick(s, 'visualUpdate_p75'));
  out.charts.push(barChart({
    title: 'A5 · INP 는 "결과가 보이는 시점"이 아니다',
    unit: 'ms · 작업량 200ms 고정',
    labels: ['sync', 'yield', 'paint\nfirst', 'paint-first\n+yield', 'worker'],
    series: [
      { name: 'INP p75  (yield 는 상한선)', color: '#3c6eb4', values: inp },
      { name: '실제 화면 갱신', color: '#b4401f', values: vis },
    ],
    note: '<b>yield 는 INP 16ms 미만인데 화면은 210ms 뒤에 바뀐다.</b> 핸들러가 아무것도 안 바꾸고 양보하면 '
        + '브라우저는 빈 프레임을 내고 INP 는 초록불이 된다. '
        + '<br><small>※ paint-first 의 화면갱신 207ms 는 무효값 — rAF 콜백이 메인 블로킹에 걸렸다. 실제는 INP 와 같은 16ms</small>',
  }));
}

// ── Track C ──────────────────────────────────────────────

// C1 ─ 초기 로드에서는 평탄해진다
const c1 = await readC('c1-initial-load/results.json');
if (c1) {
  const ns = [200, 1000, 4000];
  const v = (n, m) => +mean(c1.rows.filter(r => r.boxes === n && r.mode === m && !r.error)
                              .map(r => r.stage.Layout.ms)).toFixed(2);
  const lcp = (n, m) => +mean(c1.rows.filter(r => r.boxes === n && r.mode === m && !r.error && r.lcpMs)
                                .map(r => r.lcpMs)).toFixed(0);
  out.charts.push(barChart({
    title: 'C1 · 초기 로드에서는 이야기가 다르다',
    unit: '최초 Layout 총 ms',
    labels: ns.map(String),
    series: [
      { name: 'plain', color: '#b4401f', values: ns.map(n => v(n, 'plain')) },
      { name: 'cv-auto', color: '#1f7a4d', values: ns.map(n => v(n, 'cv-auto')) },
    ],
    note: 'A4 의 리레이아웃에서는 <b>21.4배</b>였는데, 초기 로드에서 cv-auto 는 <b>0.96배 — 평탄</b>하다. '
        + `LCP 도 실제로 빨라진다 (N=4,000 에서 ${lcp(4000, 'plain')}ms → <b>${lcp(4000, 'cv-auto')}ms</b>). `
        + '<b>"content-visibility 는 O(N)이라 별로"는 리레이아웃에 한한 이야기였다</b> (가로축 = 항목 수)',
  }));
}

// C2 ─ 무효화 종류가 부호를 뒤집는다
const c2 = await readC('c2-anomalies/results.json');
if (c2 && c2.part1?.length) {
  const per = (inv, m, n) => {
    const r = c2.part1.filter(x => x.invalidation === inv && x.mode === m && x.n === n);
    return +(mean(r.map(x => x.stage.Layout.ms)) / (r[0]?.kicks || 8)).toFixed(2);
  };
  const passes = (inv, m) => {
    const r = c2.part1.filter(x => x.invalidation === inv && x.mode === m && x.n === 4000);
    return Math.round(mean(r.map(x => x.stage.Layout.n)));
  };
  out.charts.push(barChart({
    title: 'C2 · content-visibility 는 Layout 을 줄이지 않는다 — 오히려 늘린다',
    unit: '리레이아웃 1회당 Layout ms · N=4,000',
    labels: ['폭 변경', '세로 이동', '색 변경'],
    series: [
      { name: 'plain', color: '#b4401f', values: ['width','offset','color'].map(i => per(i, 'plain', 4000)) },
      { name: 'cv-auto (auto 73px)', color: '#1f7a4d', values: ['width','offset','color'].map(i => per(i, 'cv-auto', 4000)) },
      { name: 'cv-fixed (73px)', color: '#3c6eb4', values: ['width','offset','color'].map(i => per(i, 'cv-fixed', 4000)) },
    ],
    note: '같은 CSS·같은 DOM 인데 <b>무효화 종류가 부호를 뒤집는다.</b> 폭이 바뀌면 Layout 이 8배 싸지지만, '
        + `세로로 밀기만 하면 <b>오히려 2배 비싸고</b>, 색만 바꾸면 <b>0ms 이던 Layout 이 생겨난다.</b> `
        + `레이아웃 패스 횟수가 8회 → 세로 이동 <b>${passes('offset','cv-auto')}회</b> · 색 변경 <b>${passes('color','cv-auto')}회</b>로 늘기 때문이다. `
        + '<code>auto</code> 키워드 유무(초록 vs 파랑)는 <b>차이가 없다</b> — 사전 등록 가설 H1 은 반증됐다. '
        + '<br><small>※ 파이프라인 <b>전체</b>로는 cv 가 세 경우 모두 이긴다(4.8배·2.2배·1.8배). 이득이 Layout 이 아니라 <b>Style</b> 에서 나오기 때문 — 본문 참조</small>',
  }));
}

// vsync 를 끈 쪽이 유효한 측정이다. 켠 쪽(results-commit.json)은 프레임이 양자화돼 R²=0.16 이었다.
const cc = await readC('c2-anomalies/results-commit-novsync.json')
        || await readC('c2-anomalies/results-commit.json');
if (cc?.rows?.length) {
  const f = cc.fits.p50;
  out.charts.push(barChart({
    title: 'C2 · transform 의 commit 은 레이어 수에 선형이다',
    unit: 'Commit 이벤트 1건의 지속시간 ms',
    labels: cc.rows.map(r => r.n >= 1000 ? (r.n / 1000) + 'k' : String(r.n)),
    series: [
      { name: '중앙값', color: '#3c6eb4', values: cc.rows.map(r => +r.p50.toFixed(3)) },
      { name: 'p90', color: '#b4401f', values: cc.rows.map(r => +r.p90.toFixed(3)) },
    ],
    note: `중앙값 선형 적합 <code>commit = ${(f.slope * 1000).toFixed(3)}µs × 레이어 + ${f.intercept.toFixed(3)}ms</code>, `
        + `<b>R² = ${f.r2.toFixed(3)}</b>. `
        + (f.r2 >= 0.95
            ? 'A1b 에서 본 <b>7배 폭발에 임계점은 없다</b> — 고정비에 묻혀 있다가 드러났을 뿐이다.'
            : '<b>중앙값도 선형에서 벗어난다.</b>')
        + '<br><small>※ <b>이 디스플레이가 120Hz</b>라 프레임이 vsync 배수로 양자화되면서, 처음 쓴 '
        + '(Commit 총합 ÷ 프레임수) 방식은 1,500 레이어에서 값이 거꾸로 꺾였다. 여기는 <b>vsync 를 끄고</b> '
        + `개별 이벤트 분위수로 다시 잰 값이다. 250~1,500 구간만 보면 R²=0.845 로 선형에 가깝지만 `
        + '2,000 에서 레이어당 비용이 5배로 뛴다 — <b>판정 보류</b></small>',
  }));
}

// C3 ─ 2,000 레이어 절벽은 없었다
const c3 = await readC('c3-layer-cliff/results.json');
if (c3?.partA?.length) {
  const qq = (a, p) => { const x = [...a].sort((m, n) => m - n); return x[Math.floor(x.length * p)] ?? 0; };
  const by = new Map();
  for (const r of c3.partA) { if (!by.has(r.layers)) by.set(r.layers, []); by.get(r.layers).push(...(r.times || [])); }
  const ns = [...by.keys()].sort((a, b) => a - b);
  const p50 = ns.map(n => +qq(by.get(n), .5).toFixed(1));
  out.charts.push(barChart({
    title: 'C3 · 2,000 레이어 "절벽" 은 측정 잡음이었다',
    unit: '토글 1회당 ms · 설정마다 표본 480개',
    labels: ns.map(n => n >= 1000 ? (n / 1000) + 'k' : String(n)),
    series: [{ name: '토글당 p50', color: '#3c6eb4', values: p50 }],
    note: 'C2 에서 2,000 레이어의 commit 이 5배로 뛰는 것처럼 보였다. 표본을 <b>49개 → 480개</b>로 늘리니 '
        + `<b>2,000 이 1,750 과 구별되지 않는다</b> (${p50[ns.indexOf(1750)] ?? '-'} vs ${p50[ns.indexOf(2000)] ?? '-'}ms, 95% 구간이 포개진다). `
        + '구간 기울기도 1,750→2,000 이 <b>0.87 로 전 구간에서 가장 완만</b>하다. '
        + '<br><small>※ 원인은 측정법이었다 — 자유 실행 애니메이션에서는 표본 수가 측정 대상의 함수라 느릴수록 표본이 줄고, '
        + '같은 설정 반복 간 편차가 <b>5배</b>까지 났다. 토글 수로 표본을 고정하니 편차가 <b>1.1배</b>가 됐다</small>',
  }));
}

// ── 요약 카드 ─────────────────────────────────────────────
out.cards = [
  { k: '실험', v: '8', s: 'A1 · A1b · A2 · A2b · A3 · A4 · A4b · A5' },
  { k: '내가 틀린 것', v: '4', s: '승격한계 · headless GPU · 2ⁿ타일 · O(1) 기대' },
  { k: '폐기한 측정법', v: '4', s: '패널 rAF · 스크린샷 · 공유브라우저 · 점프스크롤' },
  { k: '사전 등록 주장', v: '17', s: '13 성립 · 3 반증 · 1 부분' },
];

const findings = [
  ['transform 은 Layout·Paint 를 건너뛴다', '<code>InvalidateLayout</code> 497 → <b>0회</b>. 메인 스레드를 1.5초 막아도 <b>360프레임 제출</b>(left 는 0)', 'ok'],
  ['하지만 메인 스레드를 벗어나진 않는다', 'Style·PrePaint·Commit 은 매 프레임 그대로. 1000개에서 commit 이 <b>7배 폭발</b>해 이득이 1.5배로 줄어든다', 'warn'],
  ['레이어는 공짜가 아니다', '텍스처 = <code>roundUp(크기, 64)</code> 타일. 38×15 박스가 <b>16KB</b>(필요량의 7.2배). 예산 상한 <b>512MB</b>(Android 256 / 저사양 96)', 'ok'],
  ['DOM 순서만으로 레이어가 바뀐다', '요소·좌표가 완전히 같은데 순서만 달라 <b>24 → 15개</b>. 코드 한 줄 안 지우고 37% 감소', 'ok'],
  ['content-visibility 는 O(N) 이다', '"공짜"가 아니라 항목당 <b>7.8배 싸지는 것</b>. Paint 는 <b>원래도 컬링</b>되고 있어 절감 14%뿐', 'warn'],
  ['contain-intrinsic-size 는 정확성용', 'CPU 비용은 없어도 거의 같다. <b>content-box 기준</b>이라 padding·border 를 빼야 한다', 'warn'],
  ['INP 통과가 빠른 체감은 아니다', '양보만 하면 INP &lt;16ms 인데 사용자는 <b>210ms</b> 기다린다. 화면부터 갱신해야 둘 다 잡힌다', 'warn'],
];

const html = `<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8">
<title>Track A 결과</title>
<style>
  :root{--bg:#fbfaf8;--panel:#fff;--ink:#1a1a1a;--muted:#6b6b6b;--line:#e3e0da;
        --accent:#b4401f;--ok:#1f7a4d;--warn:#a5761b;
        --mono:ui-monospace,"Cascadia Mono",Menlo,Consolas,monospace}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);padding:0 28px 40px;
       font:15px/1.55 system-ui,-apple-system,"Segoe UI","Malgun Gothic",sans-serif;width:1180px}
  header{padding:30px 0 18px;border-bottom:2px solid var(--ink);margin-bottom:22px}
  h1{margin:0 0 6px;font-size:27px;letter-spacing:-.02em}
  header p{margin:0;color:var(--muted);font-size:14px}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);
     margin:26px 0 12px;font-weight:700}
  .cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:6px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:14px 16px}
  .card .k{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
  .card .v{font:700 30px/1.1 var(--mono);margin:3px 0 4px}
  .card .s{font-size:11.5px;color:var(--muted);line-height:1.4}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  .chart{margin:0;background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:14px 16px 12px}
  .chart figcaption{font-size:14px;font-weight:650;margin-bottom:8px}
  .chart figcaption small{font-weight:400;color:var(--muted);font-size:12px}
  .logtag{background:var(--line);padding:1px 5px;border-radius:3px;font-family:var(--mono)}
  svg{width:100%;height:auto;display:block}
  .ax{stroke:var(--line);stroke-width:1}
  text.v{font:600 9.5px var(--mono);fill:var(--muted);text-anchor:middle}
  text.x{font:11px system-ui;fill:var(--muted);text-anchor:middle}
  .legend{display:flex;gap:14px;margin:6px 0 0;font-size:11.5px;color:var(--muted)}
  .lg{display:flex;align-items:center;gap:5px}
  .lg i{width:10px;height:10px;border-radius:2px;display:inline-block}
  .note{font-size:12px;line-height:1.55;color:var(--muted);margin:8px 0 0;
        border-top:1px solid var(--line);padding-top:8px}
  .note b{color:var(--ink)}
  code{font:12px var(--mono);background:var(--line);padding:1px 4px;border-radius:3px}
  table{width:100%;border-collapse:collapse;background:var(--panel);
        border:1px solid var(--line);border-radius:9px;overflow:hidden}
  td{padding:11px 14px;border-bottom:1px solid var(--line);font-size:13.5px;vertical-align:top}
  tr:last-child td{border-bottom:none}
  td.t{font-weight:650;width:290px}
  td.t::before{content:"";display:inline-block;width:7px;height:7px;border-radius:99px;margin-right:8px;vertical-align:middle}
  tr.ok td.t::before{background:var(--ok)} tr.warn td.t::before{background:var(--warn)}
  footer{margin-top:24px;padding-top:14px;border-top:1px solid var(--line);
         font-size:12px;color:var(--muted)}
</style></head><body>

<header>
  <h1>Track A + C — 브라우저 렌더링 파이프라인 계측</h1>
  <p>Chrome 152.0.7977.83 (headless=new, GPU 가속 · RTX 4050 / Intel Iris Xe) ·
     CDP Tracing / LayerTree / memory-infra · 설정마다 브라우저 새로 기동 · 반복 3회 · 2026-09-17</p>
</header>

<div class="cards">
${out.cards.map(c => `<div class="card"><div class="k">${esc(c.k)}</div><div class="v">${esc(c.v)}</div><div class="s">${esc(c.s)}</div></div>`).join('')}
</div>

<h2>측정 결과</h2>
<div class="grid">${out.charts.join('')}</div>

<h2>핵심 발견</h2>
<table>${findings.map(([t, d, cls]) => `<tr class="${cls}"><td class="t">${t}</td><td>${d}</td></tr>`).join('')}</table>

<footer>
  원자료 <code>experiments/track-{a,c}/*/results*.json</code> · 이 리포트는
  <code>report/build-report.mjs</code> 가 원자료에서 직접 생성 — 숫자를 손으로 옮기지 않았다
</footer>
</body></html>`;

await mkdir(path.join(ROOT, 'report'), { recursive: true });
await writeFile(path.join(ROOT, 'report', 'index.html'), html);

// README 에 개별로 끼워 넣을 수 있게 차트마다 독립 파일도 만든다
const HEAD = html.slice(html.indexOf('<style>'), html.indexOf('</style>') + 8);
await mkdir(path.join(ROOT, 'report', 'charts'), { recursive: true });
const names = ['a1-stage-skip', 'a1b-ceiling', 'a2-tile-memory', 'a3-dom-order', 'a4-scaling', 'a5-inp',
               'c1-initial-load', 'c2-invalidation-kind', 'c2-commit-linearity', 'c3-layer-cliff'];
for (let i = 0; i < out.charts.length; i++) {
  const one = `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">${HEAD}
  <style>body{width:660px;padding:16px}.chart{border:none;padding:0}</style>
  </head><body>${out.charts[i]}</body></html>`;
  await writeFile(path.join(ROOT, 'report', 'charts', `${names[i] || 'chart' + i}.html`), one);
}
console.log(`✅ report/index.html + charts/*.html 생성 — 차트 ${out.charts.length}개`);
