<div align="center">

# 브라우저 렌더링 — 강의에서 실측까지

**강의를 듣고 → 원본 영상과 대조하고 → 직접 측정해서 → 틀린 걸 찾아내고 → 움직이는 데모로 만든 기록**

`Chrome 152` · `CDP Tracing` · `LayerTree` · `memory-infra` · `Chromium 소스`

인터랙티브 데모 **10개** · 실험 **8개** · 사전 등록 주장 **17개**(13 성립 · 3 반증 · 1 부분)

**내가 틀린 것 4개** · 폐기한 측정법 **4개**

### ▶ [**데모 10개 지금 바로 실행하기**](https://kasangyong.github.io/browser-rendering/demos/)

[![데모](https://img.shields.io/badge/%E2%96%B6%20%EB%8D%B0%EB%AA%A8%2010%EA%B0%9C-%EC%8B%A4%ED%96%89-2f6f4e?style=for-the-badge)](https://kasangyong.github.io/browser-rendering/demos/)
[![대시보드](https://img.shields.io/badge/%F0%9F%93%8A%20%EC%8B%A4%EC%B8%A1%20%EB%8C%80%EC%8B%9C%EB%B3%B4%EB%93%9C-%EC%97%B4%EA%B8%B0-3b5b8c?style=for-the-badge)](https://kasangyong.github.io/browser-rendering/report/)

설치 없이 브라우저에서 바로 열린다.

</div>

---

<div align="center">
  <img src="report/images/00-pipeline-diagram.png" width="100%" alt="렌더링 파이프라인 — 실측값을 붙인 지도">
</div>

---

## 한 장면으로 보는 핵심

같은 애니메이션, 다른 CSS 속성. 램프가 **빨강일 때 메인 스레드는 JavaScript에 점유**돼 있다.

<div align="center">
  <img src="report/images/demo-main-thread-block.gif" width="100%" alt="메인 스레드 블로킹 중 left는 정지, transform은 계속 동작">
</div>

| | `left` | `transform` |
|---|---|---|
| 메인 1.5초 점유 중 **화면 제출** | **0 프레임** (완전 정지) | **360 프레임** (계속 동작) |
| `InvalidateLayout` 호출 | 497회 | **0회** |

> 이 GIF는 `Page.startScreencast` 로 녹화했다. `Page.captureScreenshot` 은 **메인 스레드에 걸려서** 블로킹 구간을 담지 못한다 —
> 그걸 모르고 처음엔 잘못된 결론을 낼 뻔했다. ([A1 §5](experiments/track-a/a1-pipeline-skip/RESULTS.md#5-도중에-버린-방법-두-가지-기록용))

---

## 목차

- [이 저장소는 무엇인가](#이-저장소는-무엇인가)
- [**인터랙티브 데모 10선**](#인터랙티브-데모-10선)
- [전체 결과 대시보드](#전체-결과-대시보드)
- [실험 8개](#실험-8개)
  - [A1 · 파이프라인 단계 스킵](#a1--파이프라인-단계-스킵)
  - [A1b · transform 의 이득에는 천장이 있다](#a1b--transform-의-이득에는-천장이-있다)
  - [A2 · 합성 레이어의 GPU 메모리](#a2--합성-레이어의-gpu-메모리)
  - [A3 · DOM 순서만으로 레이어가 바뀐다](#a3--dom-순서만으로-레이어가-바뀐다)
  - [A4 · content-visibility 는 여전히 O(N)](#a4--content-visibility-는-여전히-on)
  - [A5 · INP 는 "결과가 보이는 시점"이 아니다](#a5--inp-는-결과가-보이는-시점이-아니다)
- [통용되는 말 vs 실측](#통용되는-말-vs-실측)
- [내가 틀렸던 것 4번](#내가-틀렸던-것-4번)
- [방법론 12조](#방법론-12조)
- [재현하기](#재현하기)
- [파일 구조](#파일-구조)
- [참고 자료](#참고-자료)

---

## 이 저장소는 무엇인가

브라우저 렌더링을 **읽고 끝내지 않고 직접 재본** 기록이다. 세 갈래로 진행했다.

```
① 조사      2026년 기술 지형 — 엔진별 현황 · GitHub 리포 · 1차 출처
   ↓
② 강의·영상  수강한 강의 정리(슬라이드 8장 매칭) + Life of a Pixel 원본 대조
   ↓
③ 실험      CDP 로 직접 계측 — 8개 실험, 사전 등록 예측, 반증 포함
```

| 단계 | 산출물 |
|---|---|
| 조사 | [2026 기술 지형](docs/01-landscape-2026.md) — Blink·WebKit·Gecko·Ladybird·Servo 현황, Skia Graphite, WebGPU, Interop 2026 |
| 강의 | [렌더링 파이프라인](docs/lecture/01-rendering-pipeline.md) · [JS와 렌더링](docs/lecture/02-javascript-and-rendering.md) |
| 영상 | [Life of a Pixel 분석](docs/video/01-life-of-a-pixel-2020.md) — 자막 전문 + 슬라이드 46장 판독 |
| 실험 | [Track A 종합](docs/03-track-a-synthesis.md) + `experiments/track-a/` |

### 영상 대조에서 나온 것

강의 정리 중 *"`paint → layer` 순서가 맞나?"* 라는 의문이 생겼고, [Life of a Pixel(2020)](https://www.youtube.com/watch?v=PwYxv-43iM4) 에서 **직접 증거**를 찾았다.

2020년 Chromium 은 실제로 `compositing update(layer) → prepaint → paint` 순서였고, 같은 발표에
**`composite after paint (CAP)` 가 "UNDER CONSTRUCTION"** 표지와 함께 등장한다. 캡션은 *"In the future, layers will be created after paint."*

| 시점 | 순서 |
|---|---|
| 2020 (영상) | layer → paint + **CAP 공사중** |
| 2026 (현재) | **paint → layer** (완료) |

6년에 걸쳐 실제로 뒤집힌 아키텍처를 양쪽에서 본 셈이다. → [상세](docs/video/01-life-of-a-pixel-2020.md#0-가장-중요한-발견--paint--layer-순서-문제가-풀렸다)

---

## 인터랙티브 데모 10선

**전부 움직이고 조작할 수 있다.** 의존성 없는 단일 HTML 파일이고, 표시되는 숫자는
아래 실험에서 **직접 측정한 값**이다. 각 데모 하단에 근거 실험 링크가 붙어 있다.

> ▶ **[지금 바로 열기](https://kasangyong.github.io/browser-rendering/demos/)** — 설치 없이 동작한다.
> 📂 소스는 [demos/](demos/) 에 있다. 받아서 `python -m http.server` 로 열어도 똑같다.

<div align="center">
  <a href="https://kasangyong.github.io/browser-rendering/demos/"><img src="report/images/demos-index.png" width="100%" alt="데모 10선 목록"></a>
</div>

### 움직이는 것들

<table>
<tr>
<td width="50%" valign="top">

**[01 · 파이프라인 라이브](https://kasangyong.github.io/browser-rendering/demos/01-pipeline/)** ▶
CSS 속성을 바꾸면 **어느 단계가 실제로 일하는지** 달라진다.
테두리가 켜진 단계 = 일하는 단계, 흐린 단계 = 호출되지만 할 일 없음.

<img src="report/images/demo-01-pipeline.gif" width="100%" alt="파이프라인 라이브">

</td>
<td width="50%" valign="top">

**[02 · 스레드 레이스](https://kasangyong.github.io/browser-rendering/demos/02-thread-race/)** ▶
메인 스레드를 점유하면 `left` 는 멈추고 `transform` 은 계속 간다.
아래 스트립차트는 **실제 프레임 간격** — 막힌 구간이 봉우리로 남는다.

<img src="report/images/demo-02-thread-race.gif" width="100%" alt="스레드 레이스">

</td>
</tr>
<tr>
<td width="50%" valign="top">

**[03 · 레이어 3D 분해](https://kasangyong.github.io/browser-rendering/demos/03-layers-3d/)** ▶
DOM 순서만 바꾸면 레이어가 **24개 → 15개**로 갈라졌다 합쳐진다.
초록 = 승격된 레이어, 파랑 = `Overlap` 때문에 생긴 레이어.

<img src="report/images/demo-03-layers-3d.gif" width="100%" alt="레이어 3D 분해">

</td>
<td width="50%" valign="top">

**[04 · 타일과 뷰포트](https://kasangyong.github.io/browser-rendering/demos/04-tiles/)** ▶
레이어는 통째로 래스터되지 않는다. 스크롤에 따라
초록(래스터됨) → 주황(선행) → 회색(버림) 으로 바뀐다.

<img src="report/images/demo-04-tiles.gif" width="100%" alt="타일과 뷰포트">

</td>
</tr>
</table>

### 나머지 6개

| 데모 | 무엇을 보여주나 | 근거 |
|---|---|---|
| [**05 · paint order**](https://kasangyong.github.io/browser-rendering/demos/05-paint-order/) | 요소를 고르고 `z-index`·`opacity`·`transform` 을 켜면 **그리는 순서가 재배열**된다. paint phase 4단계 순회도 애니메이션으로 | A1 |
| [**06 · 강제 동기 레이아웃**](https://kasangyong.github.io/browser-rendering/demos/06-thrash/) | 읽기·쓰기를 번갈아 하면 매번 레이아웃이 강제된다. **실제로 측정한** 작업 순서를 타임라인으로 | — |
| [**07 · 프레임 예산**](https://kasangyong.github.io/browser-rendering/demos/07-frame-budget/) | 요소 수를 올리면 막대가 **마감선을 넘고** 프레임이 죽는다. 단계별 비용은 Track A 실측값 | A1·A1b·A4 |
| [**08 · 렌더 스킵 뷰어**](https://kasangyong.github.io/browser-rendering/demos/08-render-skip/) | 화면 밖 항목이 정말 건너뛰어지는지 **브라우저에 직접 물어본다**(`checkVisibility`) | A4 |
| [**09 · INP 분해 실험실**](https://kasangyong.github.io/browser-rendering/demos/09-inp-lab/) | 클릭하면 input delay / processing / presentation 이 막대로 쌓인다. **INP 와 실제 화면 갱신의 간극**이 핵심 | A5 |
| [**10 · 무효화 전파**](https://kasangyong.github.io/browser-rendering/demos/10-invalidation/) | 노드를 누르면 재계산이 트리에 번진다. `contain` 을 켜면 **경계에서 멈춘다** | Life of a Pixel |

<div align="center">
  <img src="report/images/demo-07-frame-budget.png" width="49%" alt="프레임 예산">
  <img src="report/images/demo-10-invalidation.png" width="49%" alt="무효화 전파">
</div>

<details>
<summary><b>데모 5~9 스크린샷 펼치기</b></summary>

<img src="report/images/demo-05-paint-order.png" width="100%" alt="paint order">
<img src="report/images/demo-06-thrash.png" width="100%" alt="강제 동기 레이아웃">
<img src="report/images/demo-08-render-skip.png" width="100%" alt="렌더 스킵 뷰어">
<img src="report/images/demo-09-inp-lab.png" width="100%" alt="INP 분해 실험실">

</details>

> **데모가 실측에 기대는 방식** — 애니메이션은 설명을 위한 모형이지만,
> 표시되는 **숫자는 전부 이 저장소의 측정값**이다. 예를 들어 07의 "요소 1개당 Style 0.0116ms" 는
> [A1b](experiments/track-a/a1-pipeline-skip/RESULTS-b.md) 에서 1000개 기준 11.58ms 를 잰 값이고,
> 08의 렌더 여부는 추측이 아니라 `checkVisibility({contentVisibilityAuto:true})` 로 브라우저에 물어본 결과다.

---

## 전체 결과 대시보드

숫자는 [`report/build-report.mjs`](report/build-report.mjs) 가 원자료 JSON에서 **직접 계산**한다. 손으로 옮긴 값이 없다.

<div align="center">
  <img src="report/images/01-track-a-results.png" width="100%" alt="Track A 결과 대시보드">
</div>

---

## 실험 8개

모든 실험은 **측정 전에 예측을 파일로 등록**하고(`PREDICTION.md`), 설정마다 Chrome 을 새로 띄우고, 3회 반복했다.

| | 실험 | 핵심 결과 | 판정 |
|---|---|---|:---:|
| A1 | [파이프라인 단계 스킵](experiments/track-a/a1-pipeline-skip/RESULTS.md) | `InvalidateLayout` 497 → **0회** | 보통 |
| A1b | [박스 개수 스윕](experiments/track-a/a1-pipeline-skip/RESULTS-b.md) | 승격 한계 **없음**, 이득에 **천장** | 통과 |
| A2 | [합성 레이어 GPU 메모리](experiments/track-a/a2-gpu-memory/RESULTS.md) | 레이어당 16KB, 상한 512MB | 통과 |
| A2b | [Chromium 소스 검증](experiments/track-a/a2-gpu-memory/RESULTS-source.md) | **내 경험칙 반증** | 통과 |
| A3 | [paint chunk 경계](experiments/track-a/a3-paint-chunks/RESULTS.md) | DOM 순서로 레이어 **24 → 15** | 통과 |
| A4 | [content-visibility 스케일링](experiments/track-a/a4-content-visibility/RESULTS.md) | **여전히 O(N)** | 통과 |
| A4b | [content-visibility 의 대가](experiments/track-a/a4-content-visibility/RESULTS-scroll.md) | 총량 7.4배, 그러나 **분산됨** | 통과 |
| A5 | [INP ↔ LoAF](experiments/track-a/a5-inp-loaf/RESULTS.md) | INP ≠ 체감 | 통과 |

---

### A1 · 파이프라인 단계 스킵

> **질문** — `transform` 애니메이션은 정말 Layout·Paint 를 건너뛰는가?

박스 5개로 줄이자 세 모드 모두 **정확히 같은 482프레임**을 냈다. 프레임 수가 같으니 이벤트 수를 그대로 비교할 수 있다.

<img src="report/images/chart-a1-stage-skip.png" width="640" alt="A1 단계별 이벤트 횟수">

| 단계 | `left` | `transform` | 배율 |
|---|---:|---:|---:|
| `UpdateLayoutTree` (Style) | 482회 | 482회 | **1× 동일** |
| `Layout` | 482회 | **15회** | **32×** |
| `PrePaint` | 482회 | 482회 | **1× 동일** |
| `Paint` | 2,832회 | **30회** | **94×** |
| `RasterTask` | 979회 | **15회** | **65×** |
| **`InvalidateLayout`** | **497회** | **0회** | **∞** |

`InvalidateLayout` 497 → 0 이 가장 깨끗한 증거다. 영상의 invalidation 슬라이드에 나온 `LayoutObject::SetNeedsLayout()` 이 바로 이 이벤트다.

#### 📌 예상과 달랐던 것 — "skip"의 정확한 뜻

문서는 *"animations can skip layout, pre-paint and paint"* 라고 쓰지만, 실측에서 **`PrePaint` 는 양쪽 모두 482회** 돌았다.

**단계를 호출하지 않는 게 아니라, 할 일이 없어 즉시 반환한다.** 비용은 0.13ms/프레임으로 무시할 만하지만, 이 구분이 A1b의 결과를 설명한다.

<details>
<summary><b>계측 하네스</b> (클릭)</summary>

<img src="report/images/02-a1-pipeline-harness.png" width="100%" alt="A1 하네스">

의존성 없는 단일 HTML. 주사율 자동 감지, 커버리지 검사(브라우저 창이 가려져 rAF 가 멈추면 **측정 무효** 표시), LoAF 관찰자 내장.
</details>

---

### A1b · transform 의 이득에는 천장이 있다

> **질문** — 몇 개부터 레이어 승격이 거부되는가?

<img src="report/images/chart-a1b-ceiling.png" width="640" alt="A1b transform 이득 곡선">

**답: 거부되지 않는다.** 8000개 요소 → 8005 레이어. 내 가설이 틀렸다.

대신 다른 게 나왔다. **이득이 250~500개에서 최대 2.1배를 찍고 1000개에서 1.5배로 줄어든다.**

| 프레임당 비용 | `none` | `left` | `transform` |
|---|---:|---:|---:|
| Style recalc (1000개) | **0.004ms** | 11.58ms | 14.95ms |
| **`Commit`** (1000개) | 0.107ms | 0.372ms | **2.616ms** |

- `none`(애니메이션 없음)은 1000개여도 0.004ms → **style 비용은 DOM 크기가 아니라 애니메이션 개수에 비례**
- 1000개에서 `transform` 의 commit 이 **7배 폭발** — 레이어 1006개와 property tree 를 매 프레임 스레드 경계 너머로 복사해야 하니까

> **`transform` 은 Layout·Paint 를 없앨 뿐, 메인 스레드에서 완전히 벗어나는 게 아니다.**

---

### A2 · 합성 레이어의 GPU 메모리

> **질문** — 레이어 하나가 GPU 메모리를 얼마나 먹는가?

<img src="report/images/chart-a2-tile-memory.png" width="640" alt="A2 레이어당 GPU 메모리">

**텍스처는 실제 크기가 아니라 `roundUp(콘텐츠 크기, 64)` 타일로 올림된다.**

| 박스 크기 | 실제 픽셀 | 타일 | 레이어당 | 오버헤드 |
|---|---:|---|---:|---:|
| 38×15 | 2.23 KB | 64×64 | **16 KB** | **7.2×** |
| 100×100 | 39.1 KB | 128×128 | **64 KB** | 1.64× |
| 130×130 | 66.0 KB | 192×192 | **144 KB** | 2.2× |
| 200×200 | 156.3 KB | 256×256 | **256 KB** | 1.64× |

#### 📌 여기서 내가 틀렸다 — 그리고 어떻게 알았나

처음엔 "**2의 거듭제곱** 정사각 타일"이라고 결론냈다. 38×15 → 64, 100×100 → 128, 200×200 → 256. 세 개 다 맞았으니까.

Chromium 소스를 열어보니 실제 규칙은 달랐다.

```cpp
// cc/layers/tile_size_calculator.cc
const int kTileRoundUp = 64;

if (content_bounds.width() < default_tile_width) {
  tile_width = MathUtil::UncheckedRoundUp(content_bounds.width(), kTileRoundUp);
  tile_width = std::min(tile_width, default_tile_width);
}
```

**64의 배수로 올림**이다. 내가 고른 세 크기가 하필 **두 규칙의 답이 같아지는 값**이었던 것.

| 크기 | 64배수 | 2ⁿ | 구분 |
|---|---|---|:---:|
| 38×15 · 100×100 · 200×200 | 64 / 128 / 256 | 64 / 128 / 256 | ❌ |
| **130×130** | **192×192 = 144KB** | 256×256 = 256KB | ✅ |

판별 실험(레이어 1000개, 3회) 결과 **140.3 KB/레이어** → 예측 144KB의 **97.4%**. H1(64배수) 채택.

> *데이터가 가설을 지지한 것*과 *데이터가 가설을 반박할 능력이 없는 것*은 다르다. → [A2b 전문](experiments/track-a/a2-gpu-memory/RESULTS-source.md)

#### 타일 메모리 상한도 소스에서 확인

```cpp
// third_party/blink/renderer/platform/widget/compositing/layer_tree_settings.cc
static constexpr size_t kDefaultMemoryMB = 512;
```

| 플랫폼 | 예산 |
|---|---|
| 데스크톱 | **512 MB** (하한) |
| Android 일반 | **256 MB** |
| Android 저사양(<2GB) | **96 MB** |

레이어 4006개를 만들어도 **메모리는 501MB에서 멈춘다.** 승격은 계속하면서 타일은 안 준다 — 에러도 경고도 없이 조용히 나빠진다.

---

### A3 · DOM 순서만으로 레이어가 바뀐다

> **질문** — paint chunk 는 *연속된* 항목의 묶음이라는데, 순서가 정말 결과를 바꾸는가?

<img src="report/images/chart-a3-dom-order.png" width="640" alt="A3 DOM 순서와 레이어 수">

**s5 와 s6 은 요소 종류·개수·좌표·크기가 완전히 동일하다. DOM 순서만 다르다.**

| 시나리오 | DOM 순서 | 레이어 | `Overlap` 사유 |
|---|---|---:|---:|
| s5 `interleaved` | `PdPdPdPd…` | **24** | **10** |
| s6 `grouped` | `PPPPP…ddddd…` | **15** | **1** |

```
s5 = 4(기본) + 10(WillChangeTransform) + 10(Overlap) = 24 ✓
s6 = 4(기본) + 10(WillChangeTransform) +  1(Overlap) = 15 ✓
```

레이어 차이 9개가 **`Overlap` 사유 개수 차이와 정확히 일치**한다. 3회 반복 전부 동일 — 레이어화는 결정론적이다.

**왜**: `d₁`은 `P₀` 위, `P₂` 아래에 와야 한다. 아래로 병합 불가, 다른 `d`와 합치기도 불가(사이에 `P₂`가 낌) → 자기 레이어를 가질 수밖에 없다. 반면 `d` 10개가 **연속**이면 하나의 squashing 레이어로 묶인다.

> **코드 한 줄 안 지우고 레이어 37% 감소.** 애니메이션 요소를 DOM에서 한쪽으로 모으기만 하면 된다.

<details>
<summary><b>계측 하네스</b> — 시나리오 6종 (클릭)</summary>

<img src="report/images/03-a3-layerization.png" width="100%" alt="A3 하네스">
</details>

---

### A4 · content-visibility 는 여전히 O(N)

> **질문** — 화면 밖 콘텐츠가 정말 "공짜"가 되는가?

<img src="report/images/chart-a4-scaling.png" width="640" alt="A4 content-visibility 스케일링">

**내 예측(N과 무관해진다)은 반증됐다.**

| Layout 시간, N=100 → 8000 (80배) | 예측 | 실측 |
|---|---:|---:|
| `plain` | ≥40배 | **78.1배** ✅ |
| `cv-auto` | **<5배** | **21.4배** ❌ |

바뀌는 건 **기울기지 차수가 아니다.** 항목당 9.8µs → 1.25µs (7.8배)로 줄 뿐, 항목 수에는 그대로 비례한다.
`content-visibility: auto` 는 각 요소의 **서브트리**를 건너뛰지만 **상자 자체는 여전히 레이아웃**된다.

#### 📌 더 뜻밖이었던 것 — Paint 는 원래도 안 하고 있었다

| N 배율 (100→8000) | Paint |
|---|---:|
| `plain` | **5.4배** |
| `cv-auto` | 5.5배 |

`plain` **조차** Paint 가 N에 비례하지 않는다. Chromium 은 `content-visibility` 없이도 **화면 밖 페인트를 이미 컬링**한다.

| 단계 | 실제 절감 |
|---|---:|
| Layout | **87%** |
| Style | **82%** |
| PrePaint | **74%** |
| **Paint** | **14%** |

"layout **and paint** 를 건너뛴다"는 흔한 설명은 이 조건에선 절반만 맞다.

#### contain-intrinsic-size 는 속도가 아니라 정확성용

| 모드 | Layout (N=8000) | `scrollHeight` |
|---|---:|---:|
| `plain` (진짜) | 78.50ms | 872,328px |
| `cv-auto` (118px) | 10.00ms | 1,231,608px (**+41%**) |
| `cv-nosize` (미지정) | 10.88ms | 291,832px (**−67%**) |

CPU 비용은 사실상 같다. 차이는 전부 스크롤 길이에 있다. 그리고 41% 오차를 파고들다 함정을 찾았다.

```
cv-auto 추정 153.95px = 지정값 118 + padding 24 + border 2 + margin 10 ✓
```

**`contain-intrinsic-size` 는 content-box 크기다.** "항목이 대충 118px이니 118 넣자"가 틀린 이유고, 넣었어야 할 값은 **73px** 이었다.

#### A4b · 미뤄둔 일은 사라지지 않는다

| N=8000, 스크롤 중 | `Layout` |
|---|---:|
| `plain` | **정확히 0ms** |
| `cv-auto` | **584ms** |

전체 스크롤 누적이 `plain` 1회 리레이아웃의 **7.4배**. 하지만 총량이 아니라 **분포**가 핵심이다.

| | `plain` | `cv-exact` |
|---|---|---|
| 구축·리레이아웃 | **78.5ms 한 방** (프레임 4~5개 날아감) | ~10ms |
| 스크롤 중 | 0ms | 401ms를 **60프레임에 분산 = 6.7ms/프레임** |
| 체감 | 한 번 크게 멈춤 | 멈춤 없음 (예산 16.7ms 안) |

> **총 작업량을 줄이는 기능이 아니라, 큰 정지를 잘게 나누는 기능이다.**

⚠️ **스크롤 패턴이 결론을 뒤집었다.** 1차 측정은 21,786px 씩 점프했는데 그건 스크롤이 아니라 순간이동이다.
점프형에선 정확한 `contain-intrinsic-size` 가 1.9배 **나빴고**, 연속형(300px×60)에선 1.78배 **좋았다**.
점프형 결과를 그대로 보고했다면 *"정확한 값은 오히려 해롭다"* 는 틀린 조언을 남겼을 것이다.

<details>
<summary><b>계측 하네스</b> (클릭)</summary>

<img src="report/images/04-a4-content-visibility.png" width="100%" alt="A4 하네스">
</details>

---

### A5 · INP 는 "결과가 보이는 시점"이 아니다

> **질문** — 같은 200ms 작업을 어떻게 처리하느냐에 따라 INP 가 얼마나 달라지는가?

<img src="report/images/chart-a5-inp.png" width="640" alt="A5 INP vs 화면 갱신">

| 전략 | INP p75 | **실제 화면 갱신** | LoAF blocking |
|---|---:|---:|---:|
| `sync` | 208ms | 201.6ms | 1,805ms |
| `yield` | **<16ms** | **210.4ms** | **0ms** |
| `paint-first` | 16ms | (측정 무효)¹ | 1,801ms |
| **`paint-first+yield`** | **16ms** | **17.6ms** | **0ms** |
| `worker` | 16ms | 15.3ms | **0ms** |

**`yield` 만 하면 INP 는 거의 완벽해지는데 사용자는 여전히 210ms 기다린다.**

INP 는 "입력 → **다음 프레임**"을 잰다. **그 프레임에 내 작업 결과가 들어있는지는 보지 않는다.**
핸들러가 아무것도 안 바꾸고 양보하면 브라우저는 빈 프레임을 내고 INP 는 초록불이 된다.
12번 클릭 중 10~12번이 16ms 임계값 미달로 **기록조차 안 됐다**.

> INP 200ms 기준 통과가 곧 빠른 체감은 아니다. 양보만으로 지표를 좋아 보이게 만들 수 있다.

¹ `paint-first` 의 화면 갱신 207ms 는 **거짓값**이다. 내 `rAF` 콜백도 메인 스레드에서 도는데 `busy(200)` 이 막고 있어서
"픽셀 시점"이 아니라 "메인이 한가해진 시점"을 쟀다. 나중에 추가한 `paint-first+yield`(메인이 안 막힘)가 **17.6ms** 를 보여줘 걸러냈다.
→ **A1에서 스크린샷으로 당한 것과 같은 함정을 두 번째로 만난 것.**

**권장 순서**: 워커로 옮길 수 있으면 워커 → 못 옮기면 **화면부터 갱신 + 시간 분할 양보** → 양보만 하는 건 지표만 고친다.

<details>
<summary><b>계측 하네스</b> (클릭)</summary>

<img src="report/images/05-a5-inp-loaf.png" width="100%" alt="A5 하네스">
</details>

---

## 통용되는 말 vs 실측

| 자주 듣는 말 | 실측 |
|---|---|
| "`transform` 을 쓰면 레이아웃·페인트를 건너뛴다" | ✅ 맞다 (Layout 32배, Paint 94배 감소) |
| "`transform` 은 메인 스레드를 안 쓴다" | ❌ Style·PrePaint·Commit 은 매 프레임 돈다. 요소가 많으면 그게 병목 |
| "`will-change` 를 쓰면 레이어로 승격된다" | ⚠️ CSS transform 애니메이션은 **이미 승격**돼 있어 아무 차이 없음 |
| "레이어는 공짜가 아니다" | ✅ 38×15 박스 하나가 **16KB** (실제 필요량의 7.2배) |
| "`content-visibility` 는 화면 밖을 공짜로 만든다" | ❌ **여전히 O(N)**. 항목당 7.8배 싸질 뿐 |
| "`content-visibility` 는 layout 과 paint 를 건너뛴다" | ⚠️ layout·style 은 맞다(82~87%). **paint 는 원래도 컬링**(14%) |
| "`contain-intrinsic-size` 는 성능용" | ❌ **정확성용**. CPU 비용은 거의 같고, 없으면 스크롤바가 망가진다 |
| "INP 200ms 를 통과하면 반응이 빠른 것" | ❌ 양보만 해도 통과한다. 사용자는 여전히 기다릴 수 있다 |

---

## 내가 틀렸던 것 4번

| # | 틀린 주장 | 어떻게 드러났나 | 정정 |
|---|---|---|---|
| 1 | "600개는 레이어 승격 한계를 넘어 거부됐을 것" | 개수 스윕 | **거부 없음.** 8000개까지 전부 승격 |
| 2 | "headless 는 GPU 가 없다" | A2 사전 검증(`SystemInfo.getInfo`) | **GPU 가속 켜져 있음** |
| 3 | "레이어 텍스처는 **2의 거듭제곱** 타일" | Chromium 소스 + 130×130 판별 실험 | **64의 배수로 올림** |
| 4 | "`content-visibility` 는 비용을 N과 무관하게 만든다" | N 스윕 | **여전히 O(N)** (21.4배) |

### 폐기한 측정 방법 4번

| # | 폐기한 방법 | 이유 |
|---|---|---|
| 1 | 브라우저 패널에서 rAF 프레임 측정 | `document.hidden` 이면 rAF 가 **완전히 멈춘다.** 빈 배열을 정상 측정으로 착각할 뻔 |
| 2 | 스크린샷으로 컴포지터 동작 관찰 | `captureScreenshot` 도 **메인 스레드에 걸린다** (2,000ms 블록 중 1,936ms 지연) |
| 3 | 한 브라우저에서 GPU 메모리 연속 측정 | GPU 리소스 풀이 **이월**된다 (`left` 값이 소수점까지 동일) |
| 4 | 문서 전체를 40단계로 점프하는 "스크롤" | 21,786px 점프는 스크롤이 아니다. **결론이 정반대로 뒤집혔다** |

---

## 방법론 12조

거의 전부 **틀리고 나서** 얻은 것들이다.

<table>
<tr><td valign="top" width="33%">

**측정하기 전에**

1. 성공 기준을 **파일로 먼저** 쓴다
2. 계측기가 **메인 스레드에 걸리는지** 먼저 확인한다
3. **가설들이 갈리는 표본**을 고른다

</td><td valign="top" width="33%">

**측정할 때**

4. "몇 배 빠른가"가 아니라 **"어떤 이벤트가 몇 번 도는가"**
5. **N을 스윕**한다
6. **대조군도 같이 스케일링**한다
7. **아무것도 안 하는 대조군**을 둔다
8. **프로세스를 격리**한다
9. 반복하고 **rep 0 을 의심**한다

</td><td valign="top" width="33%">

**결과를 볼 때**

10. **소수점까지 같은 값**이 반복되면 의심한다
11. **측정 조건이 현실적인지** 되묻는다
12. **소스를 확인**한다

</td></tr>
</table>

> 2번이 이 프로젝트에서 **두 번** 나를 구했다 (A1 스크린샷 · A5 rAF 콜백).
> 1번은 A4에서 값어치를 증명했다 — "5배 미만"을 미리 못 박아두지 않았다면 21.4배를 보고도 *"그래도 7.8배 빨라졌네"* 로 넘어갔을 것이다.

---

## 재현하기

### 필요한 것

| | |
|---|---|
| Node.js | 22+ (내장 `WebSocket` 사용, 의존성 0개) |
| Chrome | 헤드리스 + `--remote-debugging-port` |
| Python | 정적 서버용 (`http.server`) |
| ffmpeg | GIF 생성 시에만 |

### 실행

```bash
# 1) 정적 서버 (프로젝트 루트에서)
python -m http.server 8765 --bind 127.0.0.1
```

```bash
# 2) 실험 — 각 디렉터리에서
cd experiments/track-a/a1-pipeline-skip
node trace-bench.mjs --boxes=5          # 단계별 이벤트 카운트
node s4-trace.mjs --boxes=1             # 메인 블로킹 중 컴포지터 활동
node sweep.mjs                          # 박스 개수 스윕

cd ../a2-gpu-memory
node probe.mjs                          # ① 계측기 사전 검증 (필수)
node sweep-isolated.mjs --counts=1000,4000 --repeat=3
node sweep-isolated.mjs --counts=4000 --sizes=38x15,100x100,200x200 --repeat=3

cd ../a3-paint-chunks   && node measure.mjs --repeat=3
cd ../a4-content-visibility
node measure.mjs --counts=100,500,2000,8000 --repeat=3          # 리레이아웃
node measure.mjs --phase=scroll2 --counts=8000 --repeat=3       # 연속 스크롤
cd ../a5-inp-loaf       && node measure.mjs --clicks=12 --work=200 --repeat=3
```

```bash
# 3) 리포트 재생성 (원자료 → 대시보드 → 이미지)
cd report
node build-report.mjs
node shoot.mjs
node record.mjs "http://127.0.0.1:8765/report/demo-thread.html" "demo-main-thread-block" --sec=8
```

각 실험 하네스는 브라우저에서 **직접 열어 조작**할 수도 있다. 콘솔에서:

```js
__A1.setMode('transform'); __A1.setCount(600); __A1.blockMain(1500)
__A3.setScenario('s5-interleaved')
__A4.build(2000, 'cv-exact'); await __A4.scrollLinear(300, 60)
__A5.setStrategy('paint-first+yield')
```

---

## 파일 구조

```
.
├── README.md                          ← 이 문서
├── docs/
│   ├── README.md                      인덱스 · 강의 커버리지 맵
│   ├── 01-landscape-2026.md           2026 기술 지형 조사
│   ├── 02-experiment-tracks.md        실험 트랙 후보 A~D
│   ├── 03-track-a-synthesis.md        Track A 종합 · 방법론 12조
│   ├── lecture/
│   │   ├── 01-rendering-pipeline.md   강의 + 슬라이드 8장 매칭
│   │   └── 02-javascript-and-rendering.md
│   └── video/
│       └── 01-life-of-a-pixel-2020.md 자막 전문 + 슬라이드 46장 판독
│
├── demos/                             ← 인터랙티브 데모 10선
│   ├── index.html                     목록 페이지
│   ├── lib/                           공용 CSS·JS
│   └── 01-pipeline/ … 10-invalidation/
│
├── experiments/track-a/
│   ├── a1-pipeline-skip/        index.html · 5개 스크립트 · RESULTS ×2
│   ├── a2-gpu-memory/           PREDICTION · probe · sweep-isolated · RESULTS ×2
│   ├── a3-paint-chunks/         PREDICTION · index.html · measure · RESULTS
│   ├── a4-content-visibility/   PREDICTION ×2 · index.html · measure · RESULTS ×2
│   └── a5-inp-loaf/             PREDICTION · index.html · measure · RESULTS
│
└── report/
    ├── build-report.mjs         원자료 JSON → 대시보드 HTML
    ├── shoot.mjs                CDP 스크린샷
    ├── record.mjs               CDP screencast → ffmpeg → GIF
    ├── diagram-pipeline.html    파이프라인 다이어그램
    ├── demo-thread.html         메인 블로킹 데모
    └── images/                  PNG 12 · GIF 1
```

**문서 23 · 데모 10 · 하네스 7 · 스크립트 17 · 원자료 JSON 20 · 이미지 24(GIF 5 포함)**

---

## 참고 자료

### 1차 출처 (조사에서 가장 많이 쓴 것)

| 자료 | 비고 |
|---|---|
| [RenderingNG 자료구조](https://developer.chrome.com/docs/chromium/renderingng-data-structures) | 밀도가 가장 높다. immutable fragment tree · property trees · paint chunk |
| [RenderingNG 아키텍처](https://developer.chrome.com/docs/chromium/renderingng-architecture) | 13단계 · 3프로세스 · 6스레드 |
| [BlinkNG deep-dive](https://developer.chrome.com/docs/chromium/blinkng) | |
| [How cc Works](https://chromium.googlesource.com/chromium/src/+/master/docs/how_cc_works.md) | 컴포지터 내부 |
| [dbaron, How browser rendering works](https://dbaron.github.io/browser-rendering/) | Gecko 관점 |
| [Skia Graphite 소개](https://blog.google/chromium/introducing-skia-graphite-chromes/) | Ganesh → Graphite |
| [Interop 2026](https://web.dev/blog/interop-2026) | |
| [LoAF API](https://developer.chrome.com/docs/web-platform/long-animation-frames) | |

### 영상

| 영상 | 비고 |
|---|---|
| [**Life of a Pixel** (Chrome University 2020)](https://www.youtube.com/watch?v=PwYxv-43iM4) | 이 저장소에서 **자막 전문 + 슬라이드 46장** 분석 → [정리](docs/video/01-life-of-a-pixel-2020.md) |
| [Life of a Pixel 슬라이드](https://docs.google.com/presentation/d/1boPxbgNrTU0ddsc144rcXayGA_WF53k96imRH8Mp34Y) | 계속 갱신되는 원본 |
| [Ladybird: State of the Union (2026-06)](https://www.youtube.com/watch?v=gZL3uk7oa2g) | |
| [Ladybird Is In For A Rusty Future (2026-03)](https://www.youtube.com/watch?v=fXnuR6nXJzc) | C++ → Rust 이식 |
| [BlinkOn 채널](https://www.youtube.com/user/blinkontalks) · [Chromium University](https://www.youtube.com/playlist?list=PL9ioqAuyl6ULp1f36EEjIN1vSBEfsb-0a) | |

### 소스에서 직접 확인한 것

| 파일 | 확인한 내용 |
|---|---|
| [`cc/layers/tile_size_calculator.cc`](https://chromium.googlesource.com/chromium/src/+/main/cc/layers/tile_size_calculator.cc) | `kTileRoundUp = 64` · GPU 래스터의 `default_tile_size` 유도 |
| [`third_party/blink/.../layer_tree_settings.cc`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/platform/widget/compositing/layer_tree_settings.cc) | `kDefaultMemoryMB = 512` · 플랫폼별 예산 |
| `.../graphics/paint/paint_artifact.cc` | `ToJSON()` 은 있으나 **테스트 빌드 전용** — 릴리스 Chrome 에서 접근 불가 확인 |

### 엔진 저장소

| 리포 | ★ | 메모 |
|---|---:|---|
| [LadybirdBrowser/ladybird](https://github.com/LadybirdBrowser/ladybird) | 66.2k | **학습용 1순위.** 읽을 수 있는 크기의 진짜 엔진 |
| [servo/servo](https://github.com/servo/servo) | 38.0k | Rust, 임베딩 가능, 월간 릴리스 |
| [chromium/chromium](https://github.com/chromium/chromium) | 24.8k | `third_party/blink` · `cc` · `components/viz` |
| [WebKit/WebKit](https://github.com/WebKit/WebKit) | 10.2k | 레이아웃 엔진 재작성 실황 |
| [google/skia](https://github.com/google/skia) | 10.9k | Ganesh + Graphite |
| [DioxusLabs/blitz](https://github.com/DioxusLabs/blitz) | 4.2k | 모듈형 HTML/CSS 렌더러 — 실험 최적 |
| [linebender/vello](https://github.com/linebender/vello) | 4.3k | GPU compute 2D 렌더러 |

> 전체 목록과 2026년 엔진별 현황은 [docs/01-landscape-2026.md](docs/01-landscape-2026.md) 에 있다.

---

## 닫지 못한 것

| 항목 | 상태 |
|---|---|
| **paint chunk 직접 계수** | ❌ **불가능 확인.** `internals.layerTreeAsText()` 는 테스트 빌드 전용. 소스 빌드 필요 |
| `content-visibility` 의 **초기 로드** 비용 | ❌ 미측정. 이 기능의 주요 홍보 지점인데 빠졌다 |
| 점프형 스크롤에서 정확한 intrinsic-size 가 느려지는 기전 | ❌ 미확인 (`Paint` 97 → 1,315 이 단서) |
| 실제 휠·터치 스크롤 | ❌ JS `scrollTop` 대입으로 대체 |
| Skia **Graphite** 경로 | ❌ 이 환경은 `skia_graphite: disabled_off` (Ganesh) |
| Safari · Firefox 대조 | ❌ 전부 Chrome 152 단일 엔진 |

---

<div align="center">
<sub>측정 환경: Chrome 152.0.7977.83 (headless=new, GPU 가속) · RTX 4050 Laptop / Intel Iris Xe · Windows 11 · 2026-09-17</sub>
</div>
