# A3 결과 — paint chunk 경계와 레이어화

측정일 2026-09-17 · Chrome **152.0.7977.83** (headless=new, GPU 가속) · 시나리오마다 Chrome 새로 기동 · 3회 반복
사전 등록 예측: [PREDICTION.md](PREDICTION.md) · 하네스: [index.html](index.html) · 원자료: [results.json](results.json)

> **3회 반복이 전부 소수점까지 동일**했다. 워밍업 이상치도 없다. 레이어화는 결정론적이다.

---

## 결론 먼저

**요소 구성과 좌표가 완전히 같아도, DOM(페인트) 순서만 바꾸면 합성 레이어가 24개 → 15개로 바뀐다.**

RenderingNG 문서의 *"paint chunks group **consecutive** display items sharing identical property tree states"* 에서 **consecutive** 가 말 그대로 작동한다는 뜻이다.

---

## 1. 전체 결과

| 시나리오 | DOM 순서 | 레이어 | Δ(s1) | `WillChangeTransform` | **`Overlap`** |
|---|---|---:|---:|---:|---:|
| s1 `plain` | `dddd…` | 4 | 0 | 0 | 0 |
| s2 `promoted-last` | `dddd…P` | 5 | +1 | 1 | **0** |
| s3 `promoted-first-overlap` | `Pdddd…` | 6 | +2 | 1 | **1** |
| s4 `promoted-first-nooverlap` | `Pdddd…` | 5 | +1 | 1 | **0** |
| s5 `interleaved` | `PdPdPdPd…` | **24** | +20 | 10 | **10** |
| s6 `grouped` | `PPPPP…ddddd…` | **15** | +11 | 10 | **1** |

`P` = `will-change: transform`, `d` = 평범한 박스. z-index 없음 → **DOM 순서 = 페인트 순서**.

기본 4개 레이어(`OverflowScrolling×2` · `RootScroller` · `Viewport`)는 모든 시나리오 공통이다.

### 산술이 정확히 닫힌다

```
s5 = 4(기본) + 10(WillChangeTransform) + 10(Overlap) = 24 ✓
s6 = 4(기본) + 10(WillChangeTransform) +  1(Overlap) = 15 ✓
```

레이어 수 차이 9개가 **`Overlap` 사유 개수 차이와 정확히 일치**한다. 추측할 여지가 없다.

---

## 2. 사전 등록 주장 판정

| # | 주장 | 예측 | 실측 | 판정 |
|---|---|---|---|---|
| **C1** | `s3 > s4` — 겹침만으로 레이어 증가 | — | **6 > 5** | ✅ |
| **C2** | `s5 > s6` — 순서만으로 레이어 변화 | — | **24 > 15** | ✅ |
| **C3** | `s2 ≈ s4` (차이 ≤ 1) | — | **5 = 5** | ✅ |
| **C4** | s3·s5에 겹침 관련 사유 출현 | — | `Overlap` ×1, ×10 | ✅ |

레이어 수 예측도 전부 맞았다:

| 시나리오 | 예측 Δ | 실측 Δ |
|---|---:|---:|
| s2 | +1 | +1 ✓ |
| s3 | +2 이상 | +2 ✓ |
| s4 | +1 | +1 ✓ |
| s5 | +10 이상 | +20 ✓ |
| s6 | s5보다 작다 | +11 ✓ |

---

## 3. 왜 이렇게 되는가

### s5 (번갈아) — 낄 자리가 없다

```
페인트 순서:  P₀ d₁ P₂ d₃ P₄ d₅ …
             ↑   ↑
         레이어  d₁은 P₀ 위, P₂ 아래에 와야 한다
                → 아래로 병합 불가 (P₀보다 위)
                → 다른 d와 합치기 불가 (사이에 P₂가 끼어 있음)
                → 자기 레이어를 가질 수밖에 없다
```
평범한 박스 10개가 **각각** `Overlap` 사유로 승격된다.

### s6 (묶음) — 한 덩어리로 얹힌다

```
페인트 순서:  P₀ P₁ P₂ … P₉ d₀ d₁ … d₉
                            └──────┬──────┘
                        연속이고 property state 동일
                        → 하나의 squashing 레이어로 병합
```
`Overlap` 사유가 **10개가 아니라 1개**다. d 10개가 레이어 하나를 나눠 쓴다.

### s2 vs s3 — 같은 요소, 순서만 반대

| | 순서 | Overlap | 레이어 |
|---|---|---:|---:|
| s2 | `dddd…P` | 0 | 5 |
| s3 | `Pdddd…` | 1 | 6 |

승격 박스가 **맨 나중**이면 그 아래 d들은 루트로 병합된다. **맨 처음**이면 그 위의 d들이 별도 레이어를 요구한다.
**요소도 좌표도 같고 DOM에서의 위치만 다르다.**

### s3 vs s4 — 같은 순서, 겹침만 다름

둘 다 `Pdddd…` 인데 s4는 d들을 P와 겹치지 않는 곳에 뒀다. → `Overlap` 0, 레이어 5.
**겹치지 않으면 페인트 순서가 뒤여도 아래로 병합된다.**

---

## 4. 실무로 옮기면

**"레이어를 줄이려면 `will-change`를 빼라"만으로는 부족하다. 순서를 바꾸는 것만으로도 줄어든다.**

| 흔한 패턴 | 문제 | 고치는 법 |
|---|---|---|
| 카드 목록에 애니메이션 카드가 **섞여** 있음 | 사이에 낀 정적 카드마다 `Overlap` 레이어 | 애니메이션 요소를 **한쪽으로 모은다** |
| 고정 헤더(`will-change`)가 DOM **앞쪽**에 | 뒤에 오는 겹치는 콘텐츠가 전부 승격 | 헤더를 DOM **뒤로** 보내고 위치는 CSS로 |
| 툴팁·모달이 DOM 중간에 | 그 뒤 겹치는 형제들이 승격 | 최상위로 이동 (`popover`, portal) |

이 실험에서 **DOM 순서만 바꿔 레이어를 24 → 15개(37% 감소)** 로 줄였다. 코드 한 줄도 지우지 않았다.
[A2](../a2-gpu-memory/RESULTS.md)에서 레이어 하나가 GPU 메모리를 수십~수백 KB 먹는다는 걸 쟀으니, 이 감소는 곧 메모리 감소다.

> DevTools에서 직접 보려면: **Layers 패널**에서 레이어별 *Compositing Reasons* 를 확인한다. `Overlap` 이 잡힌 레이어가 "순서 때문에 생긴" 레이어다.

---

## 5. 한계 — 정직하게

- **paint chunk 를 직접 센 게 아니다.** chunk 개수를 노출하는 API를 찾지 못해, **그 하류 결과인 합성 레이어 수와 승격 사유**를 쟀다. `Overlap` 사유 개수가 레이어 차이와 정확히 일치하므로 추론은 강하지만, 여전히 추론이다
- 승격 트리거를 `will-change: transform` 하나만 썼다. `opacity`, `filter`, `position:fixed` 등은 확인 안 함
- 뷰포트 1280×900, 박스 크기 2종만 시험했다
- squashing 레이어의 **크기**(= 메모리)는 재지 않았다. 개수만 쟀다. s6의 squash 레이어 1개가 s5의 작은 레이어 10개보다 넓을 수 있다

---

## 6. 자가 평가

**통과**

- **측정 전에 예측을 등록**했고([PREDICTION.md](PREDICTION.md)) 4개 주장과 6개 수치 예측이 전부 맞았다. A2에서 놓쳤던 절차를 A2b에 이어 연속으로 지켰다
- **s5 / s6 설계가 핵심이었다.** 요소 종류·개수·좌표·크기를 전부 고정하고 DOM 순서만 바꾼 쌍을 만들었기 때문에, 차이가 나오면 원인이 하나로 특정된다. [A2b에서 배운 것](../a2-gpu-memory/RESULTS-source.md#5-자가-평가) — *가설들이 갈리는 표본을 먼저 고른다* — 을 적용한 것
- `Overlap` 사유 개수와 레이어 수 차이가 정확히 일치해 **기전까지 확인**됐다. "빠르다/느리다"가 아니라 "무엇이 몇 개 생겼나"로 잰 덕이다
- 3회 반복 완전 일치 → 노이즈 논쟁의 여지가 없다

### 숙제 결과 — paint chunk 직접 계수는 **릴리스 Chrome에서 불가능**

후속 조사 결과:

- `PaintArtifact::ToJSON()` / `AppendChunksAsJSON()` 이 `third_party/blink/renderer/platform/graphics/paint/paint_artifact.cc` 에 실제로 있다
- 이걸 밖으로 노출하는 통로는 `internals.layerTreeAsText()` (`core/testing/internals.idl`) 뿐이다
- **`window.internals` 는 테스트 빌드(`content_shell`) 전용이다.** 릴리스 Chrome 에서는 `--expose-internals-for-testing` · `--enable-blink-test-features` 를 줘도 `undefined` 다 (실측 확인)
- CDP 에도 chunk 를 노출하는 도메인이 없다

→ 직접 계수하려면 **Chromium 을 소스에서 빌드**해야 한다. 이 실험의 범위를 벗어난다.
따라서 §5의 한계(레이어 수로 chunk 경계를 추론)는 **해소 불가 상태로 남는다.** 다만 `Overlap` 사유 개수가 레이어 차이와 정확히 일치하므로 추론의 신뢰도는 높다.
