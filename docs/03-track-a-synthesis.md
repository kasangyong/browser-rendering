# Track A 종합 — 파이프라인 계측에서 배운 것

실험 기간 2026-09-17 · Chrome **152.0.7977.83** (headless=new, GPU 가속 · RTX 4050 / Intel Iris Xe)
계측: CDP `Tracing` / `LayerTree` / `memory-infra` · 설정마다 Chrome 새로 기동 · 반복 3회

| 실험 | 주제 | 결과 |
|---|---|---|
| [A1](../experiments/track-a/a1-pipeline-skip/RESULTS.md) | `transform` vs `left` 단계 스킵 | 보통 |
| [A1b](../experiments/track-a/a1-pipeline-skip/RESULTS-b.md) | 박스 개수 스윕 | 통과 |
| [A2](../experiments/track-a/a2-gpu-memory/RESULTS.md) | 합성 레이어의 GPU 메모리 | 통과 |
| [A2b](../experiments/track-a/a2-gpu-memory/RESULTS-source.md) | Chromium 소스 검증 | 통과 |
| [A3](../experiments/track-a/a3-paint-chunks/RESULTS.md) | paint chunk 경계와 레이어화 | 통과 |
| [A4](../experiments/track-a/a4-content-visibility/RESULTS.md) | `content-visibility` 비용 스케일링 | 통과 |
| [A4b](../experiments/track-a/a4-content-visibility/RESULTS-scroll.md) | `content-visibility` 의 대가 (스크롤) | 통과 |
| [A5](../experiments/track-a/a5-inp-loaf/RESULTS.md) | INP와 LoAF | 통과 |

---

## 1. 파이프라인 단계별로 모은 결론

[강의에서 배운 8단계](lecture/01-rendering-pipeline.md)에 실측값을 붙인 것.

### Style · Layout

| 발견 | 출처 |
|---|---|
| `transform` 애니메이션은 `InvalidateLayout` 을 **한 번도** 호출하지 않는다 (497 → 0) | [A1](../experiments/track-a/a1-pipeline-skip/RESULTS.md) |
| 반면 **Style 과 PrePaint 는 매 프레임 그대로 돈다** (482회 → 482회). "skip" 은 *단계를 안 부른다*가 아니라 *할 일이 없어 즉시 반환한다* | [A1](../experiments/track-a/a1-pipeline-skip/RESULTS.md#1-핵심-측정--박스-5개-모드당-4초) |
| Style recalc 비용은 **DOM 크기가 아니라 애니메이션 개수**에 비례한다 (`none` 모드는 1000개여도 0.004ms) | [A1b](../experiments/track-a/a1-pipeline-skip/RESULTS-b.md) |
| `content-visibility` 는 Layout 을 87%, Style 을 82% 줄이지만 **여전히 O(N)** | [A4](../experiments/track-a/a4-content-visibility/RESULTS.md) |

### Paint

| 발견 | 출처 |
|---|---|
| **화면 밖 페인트는 `content-visibility` 없이도 이미 컬링된다.** `plain` 조차 N이 80배 늘 때 Paint 는 5.4배만 증가 | [A4](../experiments/track-a/a4-content-visibility/RESULTS.md#3-가장-뜻밖이었던-것--paint-는-원래도-안-하고-있었다) |
| 그래서 `content-visibility` 의 Paint 절감은 **14%** 에 그친다. 이득은 Style·Layout 에 있다 | [A4](../experiments/track-a/a4-content-visibility/RESULTS.md) |
| paint chunk 는 **연속된** 동일 property state 항목의 묶음이다 — 순서가 끊기면 chunk 도 끊긴다 | [A3](../experiments/track-a/a3-paint-chunks/RESULTS.md) |

### Layer · Composite

| 발견 | 출처 |
|---|---|
| 레이어 승격에 **개수 제한이 없다.** 8000개 요소 → 8005 레이어 | [A1b](../experiments/track-a/a1-pipeline-skip/RESULTS-b.md) · [A2](../experiments/track-a/a2-gpu-memory/RESULTS.md) |
| **요소 구성·좌표가 같아도 DOM 순서만으로 레이어가 24 → 15개** 로 바뀐다 | [A3](../experiments/track-a/a3-paint-chunks/RESULTS.md) |
| 레이어 텍스처는 **`roundUp(콘텐츠 크기, 64)`** 타일 (소스 `kTileRoundUp = 64`) | [A2b](../experiments/track-a/a2-gpu-memory/RESULTS-source.md) |
| 타일 메모리 예산: 데스크톱 **512MB** / Android **256MB** / 저사양 **96MB** (소스 `kDefaultMemoryMB`) | [A2b](../experiments/track-a/a2-gpu-memory/RESULTS-source.md) |
| `transform` 의 이득에는 **천장이 있다.** 250~500개에서 2.1배로 최대, 1000개에서 1.5배로 감소 — commit 비용이 7배 폭발 | [A1b](../experiments/track-a/a1-pipeline-skip/RESULTS-b.md) |
| 메인 스레드를 1.5초 막아도 `transform` 은 **360프레임 제출**, `left` 는 0 | [A1](../experiments/track-a/a1-pipeline-skip/RESULTS.md#3-s4--메인-스레드를-막아도-움직이는가) |

### JavaScript ↔ 렌더링

| 발견 | 출처 |
|---|---|
| **INP는 "결과가 보이는 시점"이 아니다.** 양보만 하면 INP < 16ms 인데 화면은 210ms 뒤에 바뀐다 | [A5](../experiments/track-a/a5-inp-loaf/RESULTS.md) |
| 지표와 체감을 같이 잡으려면 **화면부터 갱신 + 작업 분할 양보** | [A5](../experiments/track-a/a5-inp-loaf/RESULTS.md#5-정리--네-가지-축으로-봐야-한다) |
| `content-visibility` 는 총량을 줄이는 게 아니라 **큰 정지를 잘게 나눈다** (78ms 한 방 → 6.7ms/프레임) | [A4b](../experiments/track-a/a4-content-visibility/RESULTS-scroll.md#4-총량이-아니라-분포로-봐야-한다) |

---

## 2. 통용되는 말 vs 실측

| 자주 듣는 말 | 실측 |
|---|---|
| "`transform` 을 쓰면 레이아웃·페인트를 건너뛴다" | ✅ 맞다 (Layout 32배, Paint 94배 감소) |
| "`transform` 은 메인 스레드를 안 쓴다" | ❌ Style·PrePaint·Commit 은 매 프레임 돈다. 요소가 많으면 그게 병목이 된다 |
| "`will-change` 를 쓰면 레이어로 승격된다" | ⚠️ CSS transform 애니메이션은 **이미 승격**돼 있어 `will-change` 가 아무 차이도 안 만든다 |
| "레이어는 공짜가 아니다" | ✅ 38×15 박스 하나가 **16KB** (실제 필요량의 7.2배) |
| "`content-visibility` 는 화면 밖을 공짜로 만든다" | ❌ **여전히 O(N)**. 항목당 7.8배 싸질 뿐 |
| "`content-visibility` 는 layout 과 paint 를 건너뛴다" | ⚠️ layout·style 은 맞다(82~87%). **paint 는 원래도 컬링**되고 있었다(14%) |
| "`contain-intrinsic-size` 는 성능용" | ❌ **정확성용**. CPU 비용은 거의 같고, 없으면 스크롤바가 망가진다 |
| "INP 200ms 를 통과하면 반응이 빠른 것" | ❌ 양보만 해도 통과한다. 사용자는 여전히 기다릴 수 있다 |

---

## 3. 내가 틀렸던 것 (정정 이력)

실험을 하는 동안 **네 번 틀렸다.** 전부 문서에 남겨뒀다.

| # | 틀린 주장 | 어떻게 드러났나 | 정정 |
|---|---|---|---|
| 1 | "600개는 레이어 승격 한계를 넘어 거부됐을 것" | 개수 스윕 | **거부 없음.** 8000개까지 전부 승격 |
| 2 | "headless 는 GPU 가 없다" | A2 사전 검증(`SystemInfo.getInfo`) | **GPU 가속 켜져 있음** |
| 3 | "레이어 텍스처는 **2의 거듭제곱** 정사각 타일" | Chromium 소스 + 130×130 판별 실험 | **64의 배수로 올림**. 내 표본 3개가 전부 두 규칙의 답이 같은 값이었다 |
| 4 | "`content-visibility` 는 비용을 N과 무관하게 만든다" | N 스윕 | **여전히 O(N)** (21.4배 증가) |

그리고 **측정 방법을 네 번 폐기**했다.

| # | 폐기한 방법 | 이유 |
|---|---|---|
| 1 | 브라우저 패널에서 rAF 프레임 측정 | `document.hidden` 이면 rAF 가 **완전히 멈춘다.** 빈 배열을 정상 측정으로 착각할 뻔 |
| 2 | 스크린샷으로 컴포지터 동작 관찰 | `captureScreenshot` 도 **메인 스레드에 걸린다** (2,000ms 블록 중 1,936ms 지연) |
| 3 | 한 브라우저에서 GPU 메모리 연속 측정 | GPU 리소스 풀이 **이월**된다 (`left` 값이 소수점까지 동일) |
| 4 | 문서 전체를 40단계로 점프하는 "스크롤" | 21,786px 점프는 스크롤이 아니다. **결론이 정반대로 뒤집혔다** |

---

## 4. 방법론 — 다음 실험에서 그대로 쓸 것

Track A 를 거치며 굳어진 규칙들. 거의 전부 **틀리고 나서** 얻었다.

### 측정하기 전에

1. **성공 기준을 파일로 먼저 쓴다.** A2에서 안 썼다가 "101% 적중"을 자신 있게 보고했는데, 실은 판별력 없는 표본이었다. A4에서는 "5배 미만"을 미리 못 박아둔 덕에 21.4배를 보고 *"그래도 7.8배 빨라졌네"* 로 넘어가지 않았다
2. **계측기가 메인 스레드에 걸리는지 먼저 확인한다.** 두 번 당했다(스크린샷 · `LayerTree.compositingReasons`). 푸시형 이벤트(`layerTreeDidChange`)는 안 걸린다
3. **가설들이 갈리는 표본을 고른다.** "데이터가 가설을 지지한다"와 "데이터가 가설을 반박하지 못한다"는 다르다. 38×15 / 100×100 / 200×200 은 전부 두 규칙의 답이 같았다

### 측정할 때

4. **"몇 배 빠른가"가 아니라 "어떤 이벤트가 몇 번 도는가"** 로 잰다. 프레임 시간은 1.4배밖에 안 벌어졌지만 이벤트 카운트는 32~94배 갈렸다
5. **N을 스윕한다.** 단일 N의 "87% 절감"은 통용 문구를 재확인할 뿐이다. 여러 N을 봐야 *차수가 그대로인지 기울기만 바뀌는지* 보인다
6. **대조군을 같이 스케일링한다.** `plain` 의 Paint 가 5.4배밖에 안 느는 걸 보지 않았다면 "화면 밖 페인트는 원래도 컬링된다"를 몰랐을 것이다
7. **아무것도 안 하는 대조군(`none`)을 둔다.** 없었다면 "style 비용은 DOM 크기 탓"이라고 잘못 결론냈을 것이다
8. **프로세스를 격리한다.** 설정마다 브라우저를 새로 띄운다. 느리지만 이월이 원천 차단된다
9. **반복하고 rep 0 을 의심한다.** GPU 메모리 측정에서 첫 회차가 일관되게 낮은 이상치였다

### 결과를 볼 때

10. **소수점까지 같은 값이 반복되면 의심한다.** 재현성이 아니라 **캐시된 값**일 수 있다
11. **측정 조건이 현실적인지 되묻는다.** 21,786px 점프를 "스크롤"이라 부르는 순간 결론이 뒤집혔다
12. **소스를 확인한다.** 실측으로 세운 경험칙이 반증됐다 (2ⁿ → 64의 배수)

---

## 5. 실무로 가져갈 것

우선순위 순.

1. **애니메이션은 `transform`/`opacity` 로** — Layout 32배, Paint 94배, Raster 65배 감소. 메인이 막혀도 계속 움직인다
2. **`will-change` 를 작은 요소에 뿌리지 마라** — 38×15 요소는 실제 필요량의 **7.2배**(16KB)를 쓴다. CSS 애니메이션에는 애초에 불필요하다
3. **애니메이션 요소를 DOM에서 한쪽으로 모아라** — 코드 한 줄 안 지우고 레이어 **37% 감소**
4. **애니메이션 요소 수를 세어라** — 250~500개에서 `transform` 이득이 최대, 그 이상이면 commit 비용이 이득을 깎는다
5. **`content-visibility` 는 긴 리스트(≥500) + 무거운 항목에만** — 100개 수준에서는 2.2배뿐이다. 수만 개면 **가상 스크롤**이 맞다
6. **`contain-intrinsic-size` 는 content-box 기준으로 정확히** — padding·border 를 뺀 값. 틀리면 스크롤바도 성능도 같이 나빠진다
7. **긴 작업은 "화면부터 갱신 + 분할 양보"** — 양보만 하면 INP 지표만 좋아지고 체감은 그대로다
8. **워커로 옮길 수 있으면 워커** — 모든 축에서 최고

---

## 6. 닫지 못한 것

| 항목 | 상태 |
|---|---|
| **paint chunk 직접 계수** | ❌ **불가능 확인.** `internals.layerTreeAsText()` 는 테스트 빌드 전용. 릴리스 Chrome 에서는 `--expose-internals-for-testing` 을 줘도 `undefined`. 소스 빌드가 필요하다 |
| 600~1000개에서 `transform` 의 style recalc 가 `left` 보다 비싼 정확한 기전 | 부분 해결 (commit 비용으로 설명) |
| 점프형 스크롤에서 정확한 `contain-intrinsic-size` 가 되레 느려지는 기전 | ❌ 미확인 (`Paint` 97 → 1,315 이 단서) |
| `content-visibility` 의 **초기 로드** 비용 | ❌ 미측정. 이 기능의 주요 홍보 지점인데 빠졌다 |
| 실제 휠·터치 스크롤 (JS `scrollTop` 대입으로 대체) | ❌ 미측정 |
| Skia **Graphite** 경로 (이 환경은 `disabled_off` = Ganesh) | ❌ 미측정 |
| Safari·Firefox 대조 | ❌ 미측정. 전부 Chrome 152 단일 엔진 |

---

## 7. 문서 지도

```
docs/
├── README.md                     ← 인덱스 · 강의 커버리지 맵
├── 01-landscape-2026.md          ← 2026 기술 지형 조사
├── 02-experiment-tracks.md       ← 실험 트랙 후보
├── 03-track-a-synthesis.md       ← 이 문서
├── lecture/
│   ├── 01-rendering-pipeline.md  ← 강의 + 슬라이드 8장 매칭
│   └── 02-javascript-and-rendering.md
└── video/
    └── 01-life-of-a-pixel-2020.md

experiments/track-a/
├── a1-pipeline-skip/     README · RESULTS · RESULTS-b · index.html · *.mjs
├── a2-gpu-memory/        README · PREDICTION · RESULTS · RESULTS-source · *.mjs
├── a3-paint-chunks/      PREDICTION · RESULTS · index.html · measure.mjs
├── a4-content-visibility/ PREDICTION(×2) · RESULTS · RESULTS-scroll · index.html · measure.mjs
└── a5-inp-loaf/          PREDICTION · RESULTS · index.html · measure.mjs
```

모든 실험은 `python -m http.server 8765` 를 `experiments/track-a` 에서 띄운 뒤 각 `measure.mjs` 를 실행하면 재현된다.
