# A1 · 파이프라인 단계 스킵 증명

## 검증할 가설

> `transform` 애니메이션은 Chromium 파이프라인의 **Style · Layout · Paint 단계를 건너뛰고**
> Animate → Commit → Layerize → Raster → Draw 경로만 돈다.
> `left` 애니메이션은 매 프레임 Layout부터 다시 돈다.

근거가 되는 문서:
- [RenderingNG 13단계](../../../docs/01-landscape-2026.md#12-13단계-파이프라인) — "animations of visual effects, and scroll, can skip layout, pre-paint and paint"
- [강의 정리 §6 보강](../../../docs/lecture/01-rendering-pipeline.md#6-layer-슬라이드--)
- [Life of a Pixel §invalidation](../../../docs/video/01-life-of-a-pixel-2020.md#invalidation-1720--강의에-없던-좋은-슬라이드) — `LayoutObject::SetNeedsLayout()`

## 성공 기준 (사전 정의)

측정 전에 못 박아 둔다. 통과 못 하면 가설이 아니라 **측정이 틀린 것**으로 보고 하네스를 고친다.

| # | 기준 | 판정 |
|---|---|---|
| S1 | `transform`의 p95 프레임 시간이 `left`보다 **최소 2배** 짧다 | ❌ 실패 (1.40배) |
| S2 | `left`는 지연 프레임(목표×1.5 초과)이 발생, `transform`은 ~0 | ❌ 실패 (분리 안 됨) |
| S3 | LoAF의 `style+layout` 구간이 `left`에서만 유의미하게 잡힌다 | ⚠️ 트레이스로 대체 충족 |
| S4 | 메인 스레드를 막는 동안 `transform` 애니메이션은 **계속 움직인다** | ✅ 통과 (Swap 360 vs 0) |

→ 판정 근거와 S1·S2가 실패한 이유는 [RESULTS.md §4](RESULTS.md#4-성공-기준-판정-사전-정의한-그대로)

S4가 가장 중요하다. 나머지는 "빠르다"는 정도 차이지만, S4는 **다른 스레드에서 돈다**는 질적 증거다.

## 하네스 설계

`index.html` — 의존성 없는 단일 파일.

**측정 방식**
- 프레임 시간: `requestAnimationFrame` 콜백 간격. rAF는 메인 스레드에서 돌므로 **이 값이 곧 메인 스레드 부하**다
- 주사율: 시작 시 90프레임 샘플의 중앙값으로 목표 프레임 시간 자동 결정 (60Hz 가정 금지)
- 지연 프레임: 간격 > 목표×1.5
- LoAF: `PerformanceObserver('long-animation-frame')` → `styleAndLayoutStart`로 style+layout 구간 분리

**3개 모드**

| 모드 | CSS | 예상 경로 |
|---|---|---|
| `left` | `@keyframes { left: 0 → dist }` | Style → Layout → Paint → … (전 구간) |
| `transform` | `@keyframes { translateX(0 → dist) }` | Animate → Commit → … (스킵) |
| `transform + will-change` | 위 + `will-change: transform` | 레이어 사전 승격 |

세 모드 모두 **CSS 애니메이션**을 쓴다. JS `rAF`로 값을 바꾸면 `transform`이라도 메인 스레드를 매 프레임 거치므로 비교가 성립하지 않는다.

**통제 변인**
- 동일한 박스 수 · 동일한 DOM · 동일한 keyframe 길이(2s linear alternate)
- 모드 전환 후 **1.2초 워밍업** 뒤 측정 시작 (레이어 승격 안정화)
- 각 모드 6초 측정
- 500ms 넘는 간격은 제외 (탭 비활성 등)

## 실행

```bash
cd "experiments/track-a" && python -m http.server 8765 --bind 127.0.0.1
```
→ http://127.0.0.1:8765/a1-pipeline-skip/

**자동**: `자동 벤치마크` 버튼 → 결과표. `window.__A1_RESULTS__`에 JSON.

**수동(콘솔)**:
```js
__A1.setCount(600)
__A1.setMode('left')      // 'transform' | 'willchange'
__A1.stats()
__A1.blockMain(1500)
```

## DevTools 수동 검증 (자동 측정으로는 못 보는 것)

프레임 시간은 "결과"지 "원인"이 아니다. 어느 단계가 도는지는 직접 봐야 한다.

1. **Performance 패널** — 각 모드 3초 녹화
   - `left`: 메인 스레드 트랙에 `Recalculate Style` / `Layout` / `Paint` 가 매 프레임 반복
   - `transform`: 메인 트랙이 거의 비어 있고 Compositor 트랙만 동작
   - → **이게 "단계 스킵"의 직접 관찰**

2. **Rendering 탭 → Paint flashing**
   - `left`: 박스들이 계속 초록으로 점멸 (리페인트 중)
   - `transform`: 점멸 없음 (이미 래스터된 타일을 옮기기만)

3. **Rendering 탭 → Layer borders**
   - `transform + will-change`: 박스마다 주황 테두리 = 개별 합성 레이어로 승격
   - `left`: 승격 없음
   - → 레이어 수가 늘면 GPU 메모리도 늘어난다는 걸 **Layers 패널**에서 확인

4. **메인 스레드 막기 버튼** (S4)
   - 누른 뒤 1.5초간: `left`는 정지, `transform`은 계속 움직임
   - JS로는 측정 불가(메인이 막혀 있으므로) → 눈으로 확인하는 항목

## 결과

→ [RESULTS.md](RESULTS.md)
