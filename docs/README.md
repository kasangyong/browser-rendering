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
| [C5 · 현실적인 무효화](../experiments/track-c/c5-realistic-invalidation/PREDICTION.md) | 완료 (통과) | [RESULTS.md](../experiments/track-c/c5-realistic-invalidation/RESULTS.md) — **C2 의 "이득은 Style" 이 뒤집혔다.** C2 의 세 무효화가 전부 `:root` 커스텀 프로퍼티(최악 경우)였다. 컨테이너 폭만 바꾸는 흔한 경우엔 이득이 **Layout** 에서 나오고(Style 은 0.41 → 9.29ms 로 **증가**), 항목 스타일만 바뀌면 **4.5배 손해**. `plain` 의 Style 이 무효화 방식에 따라 **337배** 차이 |
| [C6 · 실제 웹사이트 3곳](../experiments/track-c/c6-real-sites/PREDICTION.md) | 완료 (통과) | [RESULTS.md](../experiments/track-c/c6-real-sites/RESULTS.md) — **합성 하네스가 양쪽으로 틀렸다.** 실제 3곳(MediaWiki·WHATWG 스펙·Sphinx)에서 성능은 **손해 보는 경우가 없고**(폭 변경 5.9~11.3배 이득, 최악도 무승부), **이득의 출처는 Style 이 아니라 Layout**. 반면 `contain-intrinsic-size` 오차가 블록 높이 **변동계수를 그대로 따라간다**(1.16→32% · 1.90→47% · 3.72→89%) — 가장 균일한 곳도 32% 틀린다 |
| [C7 · 초기 로드의 실제판](../experiments/track-c/c7-real-initial-load/PREDICTION.md) | 완료 (통과) | [RESULTS.md](../experiments/track-c/c7-real-initial-load/RESULTS.md) — **C1 의 "LCP 36~39% 단축" 은 조건부였다.** 초기 Layout 은 실제 3곳 모두 **84~99% 절감**되는데, LCP 가 움직인 건 **1곳뿐**(Wikipedia 24초 → 2.2초). 나머지 둘은 분포가 겹쳐 차이 없음. **레이아웃이 첫 페인트의 병목일 때만** 사용자에게 보인다 |
| [C8 · LCP 가 이미지일 때](../experiments/track-c/c8-image-lcp/PREDICTION.md) | 완료 (통과) | [RESULTS.md](../experiments/track-c/c8-image-lcp/RESULTS.md) — **빨라진다. 그런데 이유가 달랐다.** 모바일 폭 위키 3곳(이미지 LCP)에서 LCP 가 **12~38% 단축**. 다운로드가 빨라진 게 아니다 — 바이트·전송시간이 같고 **요청 시작만** 400~580ms 앞당겨졌다. 원인은 LCP 이미지가 `loading="lazy"` 라 **레이아웃이 요청의 선행 조건**이라는 것. `eager` 로 바꾸면 그 앞당김이 사라진다(평균 −52ms). `eager` 가 실제인 사이트(Wikivoyage 3곳)에서 다시 재니 **기전은 확인, 이득은 없음** — 요청이 첫 레이아웃 **전에** 나간다(순서 14/14). 조건이 둘로 좁혀진다: ① LCP 이미지가 `lazy` ② 레이아웃이 수백 ms. ②만 만족하는 페이지(Turku · Layout 876ms)까지 찾아 **네 칸을 다 채웠다** — 요청 앞당김이 크고 일관된 칸은 `lazy`×비싼 레이아웃 **하나뿐**. Turku 는 Canyon 보다 레이아웃을 더 아꼈는데(424 vs 354ms) 요청이 **38ms 밀렸다**. 남은 `응답끝 → LCP` 대기도 쪼갰다 — **레이아웃 22% · 준비된 뒤 그려지기까지 78%(426ms)**. 두 독립 측정이 맞아떨어진다. LCP 후보는 갈아치워지고, 최종 배너는 앞선 `<p>` 를 **1.3~3.1%** 차이로 이긴다. 그 426ms 도 다시 쪼갰다 — **A**(다음 페인트 패스까지 기다림, 전부를 좌우) + **B**(고정 117ms). 디코드는 범인이 아니다(`PaintImage` 앞에 온 적 **0/12**). 창 안에서 `Layout` 50회 vs `Paint` 9회. 이어서 "왜 절대 LCP 는 안 움직이나" 를 트레이스 바닥까지 팠다. **A(−420·−506ms)와 `LCP−응답끝`(−320·−358ms)은 유의한데 절대 LCP 만 0 을 포함**한다. 콜드에서는 네트워크 변동(±600ms)에 묻히고, warm 에서는 **cv 자신이 첫 페인트를 160~248ms 늦춰서** 상쇄된다 — 첫 페인트 전 `Layout` 이 1ms → 200ms 가 된다. 가는 길에 내 설명을 두 번 반증했다. 선행 비용은 cv 요소 수에 **거의 비례**한다 — DCL 기준 요소당 **23~58µs**. ("2.8배 흔들린다" 고 썼던 건 분자를 FCP 까지, 분모를 끝까지 세던 **내 지표 탓**이었다.) 그리고 cv 는 **첫 페인트에 바닥을 깐다** — 기준선 FCP 가 이를수록 지연이 크다(r = −0.88). 결과 파일에 남은 측정 **759행** |

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
