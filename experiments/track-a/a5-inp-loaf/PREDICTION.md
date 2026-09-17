# A5 사전 등록 예측 — INP와 LoAF

> **측정 전에 작성.** 2026-09-17.

## 검증할 것

[강의 02](../../../docs/lecture/02-javascript-and-rendering.md)의 네 가지 대응이 **INP 수치로 실제로 갈리는가.**
그리고 [Life of a Pixel 의 jank 슬라이드](../../../docs/video/01-life-of-a-pixel-2020.md#jank-1755--강의-02와-정확히-같은-이야기)가 말한 *"메인 스레드의 모든 것이 JavaScript와 경쟁한다"* 를 숫자로 본다.

**작업량은 네 전략 모두 동일(200ms)** 하다. 처리 방식만 다르다.

| 전략 | 방식 | 강의 대응 |
|---|---|---|
| `sync` | 핸들러 안에서 200ms 통째로 | 즉시 렌더 |
| `yield` | 5ms씩 쪼개며 `scheduler.yield()` | 양보 렌더 + 시간 분할 |
| `paint-first` | 화면 먼저 갱신 → 양보 → 그 다음 200ms | (강의에 없음) |
| `worker` | 200ms를 워커로 보냄 | 무거운 작업은 워커로 |

## 측정

| 항목 | 값 |
|---|---|
| 작업량 | 200ms (고정) |
| 클릭 | 전략당 12회, `Input.dispatchMouseEvent` 로 구동 |
| 지표 | Event Timing `duration`(=INP 후보), inputDelay / processing / presentationDelay 분해 |
| 보조 | LoAF `blockingDuration`, `styleAndLayoutStart` |
| 격리 | 전략마다 Chrome 새로 기동 · 3회 반복 |

INP 는 실제로 "가장 나쁜 상호작용" 근처 값을 쓰므로 **p75 와 최댓값**을 함께 본다.

## 예측

| # | 주장 | 근거 |
|---|---|---|
| **F1** | `sync` 의 INP p75 ≥ **200ms** | 핸들러가 200ms를 잡고 있으니 다음 페인트가 그만큼 밀린다 |
| **F2** | `worker` 의 INP p75 ≤ **50ms** | 메인 스레드를 거의 안 쓴다 |
| **F3** | `paint-first` 의 INP p75 ≤ **50ms** | 페인트를 먼저 하고 작업을 뒤로 미룬다 |
| **F4** | `yield` 의 INP 가 `sync` 보다 작다 | 중간중간 렌더 기회를 준다 |
| **F5** | `sync` 의 LoAF `blockingDuration` 합계가 다른 전략보다 크다 | 롱태스크가 곧 blocking |

### 가장 불확실한 것

**`yield` 가 INP를 얼마나 줄이는지 모르겠다.** 두 갈래가 가능하다:

- (a) 양보할 때마다 렌더 기회가 생기므로 **첫 청크 직후 페인트** → INP ≈ 5~20ms
- (b) 브라우저가 렌더를 하지 않고 큐의 다음 태스크로 넘어가면, `repaint()` 가 마지막에 있으므로 **INP ≈ 200ms+**

내 하네스는 `repaint()` 를 **작업이 다 끝난 뒤** 호출한다. (b)라면 `yield` 는 INP를 거의 못 줄이고,
그건 **"양보만으로는 부족하고 화면 갱신을 앞당겨야 한다"**(= `paint-first`)는 뜻이 된다.

→ **F4는 성립하되 그 폭이 작을 것**으로 본다. `yield` INP p75 는 150~210ms 로 예측한다.

## 판정

- F1·F2·F5 성립 → 통과
- F4 실패 (`yield` ≈ `sync`) → 위 (b) 가설 확인. 그 자체가 유의미한 발견
- F2 실패 (`worker` 도 INP 큼) → 하네스가 INP를 잘못 재고 있다는 뜻. 계측 재검토

## 결과

→ [RESULTS.md](RESULTS.md)
