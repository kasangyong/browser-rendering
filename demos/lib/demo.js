/** 데모 공용 유틸 */

const DEMOS = [
  ['01', '파이프라인 라이브', '01-pipeline'],
  ['02', '스레드 레이스', '02-thread-race'],
  ['03', '레이어 3D 분해', '03-layers-3d'],
  ['04', '타일과 뷰포트', '04-tiles'],
  ['05', 'paint order', '05-paint-order'],
  ['06', '강제 동기 레이아웃', '06-thrash'],
  ['07', '프레임 예산', '07-frame-budget'],
  ['08', '렌더 스킵 뷰어', '08-render-skip'],
  ['09', 'INP 분해 실험실', '09-inp-lab'],
  ['10', '무효화 전파', '10-invalidation'],
];

/** 아래쪽에 실험 출처와 다른 데모 링크를 붙인다 */
export function mountFooter(no, source, sourceHref) {
  const f = document.createElement('footer');
  f.className = 'demo';
  const idx = DEMOS.findIndex(d => d[0] === no);
  const prev = DEMOS[(idx - 1 + DEMOS.length) % DEMOS.length];
  const next = DEMOS[(idx + 1) % DEMOS.length];
  f.innerHTML =
    (source ? `근거 <a href="${sourceHref}">${source}</a> <span class="dot">·</span> ` : '') +
    `<a href="../">데모 목록</a> <span class="dot">·</span> ` +
    `<a href="../${prev[2]}/">← ${prev[0]} ${prev[1]}</a> <span class="dot">·</span> ` +
    `<a href="../${next[2]}/">${next[0]} ${next[1]} →</a>`;
  document.querySelector('.wrap').appendChild(f);
}

export const DEMO_LIST = DEMOS;

/** 실제 프레임 간격을 재는 작은 계측기 */
export function fpsMeter(onTick) {
  let last = 0, samples = [];
  function tick(now) {
    if (last) {
      const dt = now - last;
      if (dt < 500) samples.push(dt);
      if (samples.length > 120) samples.shift();
    }
    last = now;
    if (samples.length) {
      const sorted = [...samples].sort((a, b) => a - b);
      const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
      onTick({
        fps: 1000 / avg,
        avg,
        p95: sorted[Math.floor(sorted.length * 0.95)],
        n: samples.length,
      });
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  return { reset: () => { samples = []; } };
}

/** 메인 스레드를 ms 만큼 통째로 점유한다 */
export function blockMain(ms) {
  const t = performance.now();
  while (performance.now() - t < ms) { /* 점유 */ }
}

/** 화면 갱신이 실제로 반영된 뒤 resolve */
export const nextPaint = () =>
  new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

/** 숫자를 읽기 좋게 */
export const fmt = (v, d = 1) =>
  (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(d));
