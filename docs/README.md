# 브라우저 렌더링 — 학습/실험 워크스페이스

## 문서

| 문서 | 내용 |
|---|---|
| [01-landscape-2026.md](01-landscape-2026.md) | 2026년 기술 지형 조사 — 엔진별 현황, GitHub 리포, 영상, 1차 출처 |
| [02-experiment-tracks.md](02-experiment-tracks.md) | 실험 트랙 후보 A~D |
| **[03-track-a-synthesis.md](03-track-a-synthesis.md)** | **Track A 종합** — 실측 결론, 통용되는 말 vs 실측, 정정 이력, 방법론 12조 |
| [lecture/01-rendering-pipeline.md](lecture/01-rendering-pipeline.md) | 강의 — 렌더링 파이프라인 (슬라이드 8장 매칭) |
| [lecture/02-javascript-and-rendering.md](lecture/02-javascript-and-rendering.md) | 강의 — 자바스크립트와 렌더링 |
| [video/01-life-of-a-pixel-2020.md](video/01-life-of-a-pixel-2020.md) | 영상 분석 — Life of a Pixel (Chrome University 2020), 강의와 대조 |

## 실험

### Track A — 파이프라인 계측

| 실험 | 상태 | 결과 |
|---|---|---|
| [A1 · 파이프라인 단계 스킵](../experiments/track-a/a1-pipeline-skip/README.md) | 완료 (보통) | [RESULTS.md](../experiments/track-a/a1-pipeline-skip/RESULTS.md) — `InvalidateLayout` 497→0, 메인 블록 중 `Swap` 360 vs 0 |
| A1b · 박스 개수 스윕 (보강) | 완료 (통과) | [RESULTS-b.md](../experiments/track-a/a1-pipeline-skip/RESULTS-b.md) — 승격 한계 없음, `transform` 이득은 250~500개에서 최대 후 감소 |
| [A2 · 합성 레이어의 GPU 메모리](../experiments/track-a/a2-gpu-memory/README.md) | 완료 (통과) | [RESULTS.md](../experiments/track-a/a2-gpu-memory/RESULTS.md) — 레이어당 메모리 실측, 타일 메모리 **상한 ≈500MB** |
| A2b · Chromium 소스 검증 | 완료 (통과) | [RESULTS-source.md](../experiments/track-a/a2-gpu-memory/RESULTS-source.md) — 타일은 **64의 배수로 올림**(`kTileRoundUp`), 예산은 **`kDefaultMemoryMB = 512`**. A2의 "2ⁿ" 경험칙 **반증** |
| [A3 · paint chunk 경계와 레이어화](../experiments/track-a/a3-paint-chunks/PREDICTION.md) | 완료 (통과) | [RESULTS.md](../experiments/track-a/a3-paint-chunks/RESULTS.md) — **구성·좌표가 같아도 DOM 순서만으로 레이어 24 → 15개**. `Overlap` 사유 10 vs 1 |
| [A4 · `content-visibility`](../experiments/track-a/a4-content-visibility/PREDICTION.md) | 완료 (통과) | [RESULTS.md](../experiments/track-a/a4-content-visibility/RESULTS.md) — **여전히 O(N)**(21.4배 증가). 항목당 7.8배 싸질 뿐. **Paint 는 원래도 컬링**되고 있었다(절감 14%) |
| [A4b · `content-visibility` 의 대가](../experiments/track-a/a4-content-visibility/PREDICTION-scroll.md) | 완료 (통과) | [RESULTS-scroll.md](../experiments/track-a/a4-content-visibility/RESULTS-scroll.md) — 스크롤 총량은 **7.4배 더 비싸다**. 다만 프레임당 6.7ms로 **분산**된다 |
| [A5 · INP와 LoAF](../experiments/track-a/a5-inp-loaf/PREDICTION.md) | 완료 (통과) | [RESULTS.md](../experiments/track-a/a5-inp-loaf/RESULTS.md) — **INP는 "결과가 보이는 시점"이 아니다.** 양보만 하면 INP<16ms인데 화면은 210ms 뒤 |

### Track C — Track A 의 결론을 되짚는다

Track A 를 끝내고 나서 **설명 못 한 채로 닫은 것들**이 남았다. 그걸 판별하는 트랙이다.

| 실험 | 상태 | 결과 |
|---|---|---|
| [C1 · 초기 로드 비용](../experiments/track-c/c1-initial-load/PREDICTION.md) | 완료 (통과) | [RESULTS.md](../experiments/track-c/c1-initial-load/RESULTS.md) — **A4 의 "여전히 O(N)" 은 리레이아웃에 한한 이야기였다.** 초기 로드에서 `cv-auto` 의 Layout 은 **0.96배(평탄)**, LCP 는 **36~39% 단축**. 사전 등록 5개 중 **2개 반증** |
| [C2 · 남겨둔 이상치 3개](../experiments/track-c/c2-anomalies/PREDICTION.md) | 완료 (통과) | [RESULTS.md](../experiments/track-c/c2-anomalies/RESULTS.md) — **`content-visibility` 는 Layout 을 늘린다.** 이득은 전부 **Style**(−71~76%). 레이아웃 패스가 세로 이동에서 8→17회, 색 변경에서 0→9회. `auto` 키워드는 **차이 없음**(H1 반증). 덤으로 **이 화면이 120Hz** 라 A1b 의 "commit 7.0배"가 vsync 양자화 때문임을 확인 |
| [C3 · 2,000 레이어 절벽](../experiments/track-c/c3-layer-cliff/PREDICTION.md) | 완료 (통과) | [RESULTS.md](../experiments/track-c/c3-layer-cliff/RESULTS.md) — **절벽은 없었다.** 표본을 49→480개로 늘리니 2,000이 1,750과 구별되지 않는다(95% 구간 포개짐). 타일 메모리는 예산의 6%라 산수로도 기각. 덤으로 **commit 이 레이어당 14.5µs 로 선형**임을 확인해 C2 의 ③을 닫았다 |
| [C4 · Raster 110배의 정체](../experiments/track-c/c4-raster-threshold/PREDICTION.md) | 완료 (통과) | [RESULTS.md](../experiments/track-c/c4-raster-threshold/RESULTS.md) — **렌더러의 임계점이 아니라 내가 하네스에 박아둔 `sleep(2000)`.** `RasterTask` 가 레이어당 정확히 1.00회(매 프레임이면 15,000회), 한 덩어리로 몰렸다 끝나고, 레이어 고정한 채 4초만 기다리면 사라진다. 소스에서 개수 상한 `kDefaultNumResourcesLimit = 10,000,000` 확인해 내 가설 E1 도 기각 |

---

## 강의 커버리지 맵

강의(완료)가 다룬 범위와, 조사에서 나왔지만 강의엔 없던 것들.

### ✅ 강의가 다룬 것

| 주제 | 문서 |
|---|---|
| 파이프라인 8단계 (loading→composite) | [lecture/01](lecture/01-rendering-pipeline.md) |
| DOM 트리 ≠ 레이아웃 트리 | [lecture/01 §4](lecture/01-rendering-pipeline.md#4-layout-슬라이드-) |
| paint ops = 명령 기록, 픽셀 아님 / z-order | [lecture/01 §5](lecture/01-rendering-pipeline.md#5-paint-슬라이드--) |
| 레이어 분리 = 움직이는 것과 아닌 것 | [lecture/01 §6](lecture/01-rendering-pipeline.md#6-layer-슬라이드--) |
| rasterize + composite | [lecture/01 §7](lecture/01-rendering-pipeline.md#7-composite-슬라이드-) |
| 양보 렌더 / 시간 분할 / rAF coalescing / 워커 | [lecture/02](lecture/02-javascript-and-rendering.md) |

### ⬜ 강의에 없던 것 (조사에서 나온 것)

| 주제 | 왜 중요한가 | 어디에 |
|---|---|---|
| **Property trees** (transform/clip/effect/scroll) | 레이어를 "어떻게 변형할지"가 여기서 정해짐. 강의의 layer→composite 사이 빈칸 | [01 §1.3](01-landscape-2026.md#13-핵심-자료구조-여기가-진짜-공부-포인트) · [영상 §4](video/01-life-of-a-pixel-2020.md#property-trees-2055) |
| **compositing update / prepaint 2단계** | 강의의 `layer` 한 단계가 사실 두 작업이었다 | [영상 §2](video/01-life-of-a-pixel-2020.md#2-강의--영상-대조표) |
| **invalidation 4종 API** | 캐싱의 실제 구현체 (`SetNeedsLayout` 등) | [영상 §4](video/01-life-of-a-pixel-2020.md#invalidation-1720--강의에-없던-좋은-슬라이드) |
| **paint phase 4단계 순회** | paint가 트리를 여러 번 도는 이유 | [영상 §3](video/01-life-of-a-pixel-2020.md#paint-12301330) |
| **immutable fragment tree** | "바뀐 만큼만 다시 계산"의 실제 구현 | [01 §1.3](01-landscape-2026.md#13-핵심-자료구조-여기가-진짜-공부-포인트) |
| **Animate / Scroll 지름길** | style~paint를 통째로 건너뛰는 경로 | [01 §1.2](01-landscape-2026.md#12-13단계-파이프라인) |
| **강제 동기 레이아웃** (layout thrashing) | JS↔렌더링 상호작용의 대표 함정. 강의 02의 빠진 한 조각 | 미작성 |
| **`content-visibility`** | 오프스크린 렌더 스킵. layout+paint 30~60% 절감 | [01 §4](01-landscape-2026.md#4-웹-플랫폼-레이어--interop-2026) |
| **INP / LoAF 계측** | 강의 02의 내용을 실제로 측정하는 법 | [01 §5](01-landscape-2026.md#5-계측--디버깅) |
| **Skia Graphite, WebGPU** | composite 단계의 2026년 실제 변화 | [01 §3](01-landscape-2026.md#3-래스터화--gpu-레이어) |

---

## 남은 질문

- 슬라이드 ⑤(빽빽한 paint ops 시각화)의 도구가 무엇인지 — 강의에서 언급 없었음
- Blink 렌더링 팀 2026 공식 로드맵 (BlinkOn 21 세션 목록 확인 필요)
