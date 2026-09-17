# A3 사전 등록 예측 — paint chunk 경계와 레이어화

> **측정 전에 작성.** 작성 시각: 2026-09-17, 하네스 완성 직후 / 측정 실행 전.
> [A2 교훈](../a2-gpu-memory/RESULTS.md#8-자가-평가): 기준을 미리 못 박지 않으면 결과를 보고 사후에 말을 맞추게 된다.

## 검증할 것

[RenderingNG 자료구조 문서](https://developer.chrome.com/docs/chromium/renderingng-data-structures)의 정의:

> "Paint chunks" group **consecutive** display items sharing identical property tree states.
> The rendering pipeline then layerizes these chunks.

여기서 **consecutive(연속된)** 가 핵심이다. 이게 사실이라면:

- 같은 property state를 가진 요소라도 **사이에 다른 state가 끼면 chunk가 쪼개진다**
- 즉 **DOM 구성이 같아도 순서가 다르면 레이어화 결과가 달라야 한다**

겹침(overlap)도 레이어화에 관여한다. 합성 레이어 **위에** 그려져야 하는 콘텐츠는 그 레이어 아래로 병합될 수 없다.

## 시나리오

박스는 전부 `position:absolute`, z-index 없음 → **DOM 순서 = 페인트 순서**.
`P` = `will-change: transform` (승격), `d` = 평범.

| # | 시나리오 | 구성 | 겹침 | DOM 순서 |
|---|---|---|---|---|
| s1 | `plain` | d×20 | 없음 | `dddd…` |
| s2 | `promoted-last` | d×20 + P×1 | P가 d들 위 | `dddd…P` |
| s3 | `promoted-first-overlap` | P×1 + d×20 | d들이 P 위 | `Pdddd…` |
| s4 | `promoted-first-nooverlap` | P×1 + d×20 | 없음 | `Pdddd…` |
| s5 | `interleaved` | P×10 + d×10 | 전부 상호 겹침 | `PdPdPdPd…` |
| s6 | `grouped` | P×10 + d×10 | **s5와 위치 완전 동일** | `PPPPP…ddddd…` |

**s5와 s6은 요소 종류·개수·좌표·크기가 전부 같다. DOM 순서만 다르다.**

## 예측 (s1 대비 레이어 증가분)

| 시나리오 | 예측 Δ레이어 | 근거 |
|---|---:|---|
| s1 | 0 (기준) | 승격 요인 없음 |
| s2 | **+1** | P가 맨 위 → 아래 d들은 루트로 병합 가능 |
| s3 | **+2 이상** | P 레이어 1개 + 그 위에 겹치는 d들이 별도 레이어(squashing) |
| s4 | **+1** | 겹치지 않으므로 d들은 P 아래 루트로 병합 |
| s5 | **+10 이상** | P와 d가 번갈아 겹침 → d를 아래로 내릴 수도 위로 묶을 수도 없음 |
| s6 | **s5보다 작다** | P들이 연속 → d들은 하나의 덩어리로 위에 얹힘 |

## 핵심 주장 (이게 성립해야 통과)

| # | 주장 | 뜻 |
|---|---|---|
| **C1** | `s3 > s4` | 순서가 같아도 **겹침**만으로 레이어가 늘어난다 |
| **C2** | `s5 > s6` | 구성·좌표가 완전히 같아도 **페인트 순서**만으로 레이어가 달라진다 |
| **C3** | `s2 ≈ s4` (차이 ≤ 1) | 겹침 없이 위에 그려지는 건 추가 비용이 없다 |
| **C4** | s3·s5의 compositing reason 에 **겹침 관련 사유**가 나타난다 | 레이어가 는 이유가 겹침임을 직접 확인 |

**C2가 이 실험의 전부다.** DOM을 전혀 바꾸지 않고 순서만 바꿔 레이어 수가 달라진다면, "chunk는 *연속된* 동일 state 항목의 묶음"이라는 정의가 실측으로 확인되는 것이다.

## 판정

- C1·C2 모두 성립 → **통과**
- C2 실패 (s5 ≈ s6) → 순서가 아니라 다른 요인(겹침만)이 지배한다는 뜻. 모델 재검토
- C1 실패 → 겹침이 레이어화에 관여하지 않는다는 뜻. 문서 해석 재검토

## 계측

| 항목 | 방법 |
|---|---|
| 레이어 수 | `LayerTree.layerTreeDidChange` (푸시형) |
| 레이어별 사유 | `LayerTree.compositingReasons(layerId)` — 메인 스레드 의존이지만 블로킹을 안 하므로 사용 가능 |
| 격리 | **시나리오마다 Chrome 새로 기동** (A2 교훈 — 리소스 이월 방지) |
| 반복 | 3회, rep 0 은 워밍업 이상치로 간주하고 별도 표기 |

## 예상 반증 요인 (미리 적어둔다)

- 최신 Chromium의 CAP는 겹치는 콘텐츠를 **squashing layer 하나로 묶을 수 있다.** 그러면 s5의 증가폭이 예측(+10)보다 훨씬 작을 수 있다 — 그래도 `s5 > s6` 부등호만 성립하면 C2는 지지된다
- `will-change: transform` 이 20개를 넘어가면 Chromium이 승격을 거부할 가능성 — [A1b](../a1-pipeline-skip/RESULTS-b.md#q2-레이어-승격-한계는-어디인가--한계-없음-가설이-틀렸다)에서 8000개까지 거부가 없었으므로 낮게 본다

## 결과

→ [RESULTS.md](RESULTS.md)
