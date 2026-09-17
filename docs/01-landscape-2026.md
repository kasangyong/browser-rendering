# 브라우저 렌더링 2026 — 기술 지형 조사

> 조사일: 2026-09-17 · 목적: 실험/학습 기반 확보
> 원칙: 1차 출처(엔진 공식 문서·블로그·리포) 우선, 블로그 요약은 보조

---

## 0. 한 장 요약

| 레이어 | 2026년 현재 상태 | 실험 가치 |
|---|---|---|
| 파이프라인 아키텍처 | Chromium **RenderingNG** 가 사실상 정본. 13단계 × 3프로세스 × 6스레드 | ★★★ |
| 레이아웃 엔진 | Blink LayoutNG 완료 / WebKit은 **재작성 진행 중**(inline 완료 → flex → grid) | ★★★ |
| 래스터화 | Skia **Ganesh → Graphite** 전환기. Dawn(WebGPU) 위에 구축 | ★★★ |
| 합성(compositing) | property tree 기반 + Viz 프로세스 집중 | ★★★ |
| 독립 엔진 | **Ladybird**(알파 2026 목표, Rust 이식 시작), **Servo**(0.5, 월간 릴리스) | ★★☆ |
| 웹 플랫폼 CSS | scroll-driven / view transitions / anchor positioning 이 Interop 2026 핵심 | ★★★ |
| 계측 | INP + **LoAF**(Long Animation Frames)가 진단 축 | ★★★ |

---

## 1. 렌더링 파이프라인 정본 — RenderingNG

Chromium이 2014년 BlinkNG로 시작해 8년 이상 걸려 완성한 구조. 지금 "브라우저 렌더링"을 공부한다는 건 사실상 이 모델을 이해한다는 뜻이다.

### 1.1 프로세스 / 스레드 구조

| 프로세스 | 스레드 | 역할 |
|---|---|---|
| **Renderer** (사이트당 N개) | Main | 스크립트 실행, 문서 라이프사이클, HTML/CSS 파싱, hit testing |
| | Compositor (impl) | 입력 이벤트 처리, 스크롤/애니메이션, **layerization** 계산 |
| | Helper | 이미지 디코드, paint worklet, raster task |
| **Browser** (1개) | 단일 | 브라우저 UI 렌더, 입력 라우팅 |
| **Viz** (1개) | GPU Main | display list 래스터화, compositor frame draw |
| | Display Compositor | 여러 compositor frame **aggregate** 후 화면 제출 |

> 핵심: **main / compositor 분리**가 성능 격리의 전부다. transform·opacity·scroll 은 compositor 스레드만으로 프레임을 만들 수 있어 main thread가 JS로 막혀 있어도 60/120Hz가 유지된다.

### 1.2 13단계 파이프라인

```
 1 Animate       property tree를 선언적 타임라인으로 mutate
 2 Style         CSS 적용 → ComputedStyle
 3 Layout        크기/위치 결정 → immutable fragment tree
 4 Pre-paint     property tree 구축, display list / GPU tile 무효화
 5 Scroll        scroll offset 갱신 (property tree mutate)
 6 Paint         display list 생성 (Skia 드로잉 명령)
 ── commit ──
 7 Commit        property tree + display list 를 compositor 스레드로 복사
 8 Layerize      display list → composited layer list
 9 Raster/Decode display list → GPU texture tile
10 Activate      compositor frame 생성
11 Aggregate     모든 프레임을 하나의 전역 프레임으로 통합 (Viz)
12 Draw          GPU 실행 → 화면 픽셀
```

**최적화 지점**: 1·5 만 돌고 2~6을 통째로 건너뛰는 경로가 존재한다. → "compositor-only 속성"(transform/opacity/filter)만 애니메이션하라는 조언의 실제 근거.

### 1.3 핵심 자료구조 (여기가 진짜 공부 포인트)

| 구조 | 생성 단계 | 특징 |
|---|---|---|
| **Immutable fragment tree** | Layout | 한 번 만들면 불변. 부모 역참조 금지 / 데이터 버블링 금지 → **fragment 재사용** 가능. 인라인 콘텐츠는 트리가 아닌 `(object, descendant_count)` **flat list** |
| **Property trees** (4개) | Pre-paint | transform / clip / effect / scroll. DOM 요소마다 4-tuple 상태를 가짐. DOM보다 sparse |
| **Display list + Paint chunk** | Paint | CSS paint order로 순회한 Skia 명령 리스트. 동일 property state를 공유하는 연속 item = paint chunk → layerization 단위 |
| **Compositor frame** | Activate | tile + quad + **render pass** + surface(다른 프레임 참조) |
| **Surface / Aggregation** | Viz | 개별 렌더러가 못 보는 전역 정보로 불필요한 중간 텍스처 제거 |

> 불변성이 중요한 이유: "화면에서 실제로 바뀐 만큼만 일한다"를 보장하려면 캐시가 안전해야 하고, 캐시가 안전하려면 구조가 불변이어야 한다. LayoutNG의 3막 구조 `NGConstraintSpace → NGLayoutAlgorithm → NGPhysicalBoxFragment` 가 그 구현.

---

## 2. 엔진별 2026 현황

### 2.1 Blink / Chromium
- RenderingNG 구조는 안정기. 현재 중심 이슈는 **래스터 백엔드 교체(Graphite)** 와 GPU 스택 단일화.
- `LayoutNG` 완료, `CompositeAfterPaint` 완료 — 레이어 결정이 paint **이후**로 이동해 예측 가능성/메모리가 개선됨.
- 소스 맵: `third_party/blink/...` (1~6단계), `cc/...` (7~10), `components/viz/...` (11~12).
- ⚠️ 2026년 Blink 렌더링 로드맵 1차 자료는 이번 조사에서 확보 못 함. BlinkOn 21(2026-04, Redmond) 세션 목록 확인 필요.

### 2.2 WebKit / Safari
**지금 가장 흥미로운 진행형 사건**: 레이아웃 엔진을 formatting context 단위로 통째로 재작성 중.

- Safari 26.4 — **block-in-inline 레이아웃 완료**
- Safari 26.5 — block-in-inline 버그 수정 라운드
- 진행 중 — **Flexbox** 재작성, **CSS Grid** 재작성 착수
- Safari 27 beta — **Subpixel inline layout**(블록 방향 device-pixel 정밀도), transform-aware anchor positioning, `srgb-linear` / `display-p3-linear` 색공간, 렌더링 버그 200여 건 수정
- 부작용 사례: iOS Safari 26.4 레이아웃 엔진 변경으로 Salesforce Field Service 앱 렌더링 깨짐 → 재작성이 실제 호환성 리스크를 동반한다는 증거

### 2.3 Gecko / Firefox
- **WebRender**(Rust, GPU 기반 2D 렌더러) 가 여전히 축. 원래 Servo에서 왔다.
- Gecko display list → `BuildWebRenderCommands()` → WebRender display item.
- 2026년 그래픽스 팀 화두: **Windows HDR 비디오**, 비디오 프레임을 데스크톱 컴포지터 오버레이로 승격할지 vs 일반 경로로 갈지 판단 로직.
- scroll-driven animations 는 Firefox 152(2026-06) 기준 아직 `layout.css.scroll-driven-animations.enabled` 플래그 뒤 (Nightly 기본 on).

### 2.4 Ladybird (독립 엔진, C++ → Rust)
가장 학습 가치가 높은 **읽을 수 있는 크기의 진짜 엔진**. GitHub 66.2k★, 매일 커밋.

2026-08 뉴스레터 기준 실제 엔진 변화:

- **스타일 엔진 증분화**: DOM 변경을 typed delta로 보고 의존 셀렉터에만 라우팅 → StyleBench에서 메이저 브라우저와 동급 도달
- **레이아웃 캐싱**: 입력 constraint 기반 재사용 + shadow mode 검증으로 회귀 방지
- **컴포지터 오프로딩**: opacity/transform CSS 애니메이션을 main thread에서 분리, vsync 구동
- 벤치마크 점프: Speedometer 2 `47→64`, Speedometer 3 `2.5→3.9`, **StyleBench `3.5→83`**
- 3D transform: flattening, `backface-visibility`, **BSP tree depth sorting**
- WPT 서브테스트 `2,079,020 → 2,088,677`
- **Rust 이식**: CSS 파싱 완료(출력 불일치 0), **페인팅 파이프라인(display list 기록 + hit testing) Rust로 이동**, computed style 저장도 이동
- Rust 전환 배경: 2026-02, LibJS 렉서/파서/AST/바이트코드 약 25,000줄을 AI 에이전트(Claude Code/Codex) 보조로 **2주**만에 이식. test262 52,000+ / 회귀 12,000 통과, 성능 저하 없음
- 로드맵: 알파 2026(Linux/macOS) → 베타 2027 → 정식 2028

### 2.5 Servo (Rust)
GitHub 38.0k★, 월간 릴리스. 임베딩 가능한 경량 엔진 지향.

2026-07 기준:
- **2D canvas 멀티스레드화 → 프레임레이트 최대 +55%, 프레임당 전력 -42%**
- 동일 텍스트/다른 폰트 크기 케이스 텍스트 렌더링 **최대 10배** 개선
- flex 레이아웃 +3%, inline SVG 내 웹폰트, `box-decoration-break`, `@font-feature-values`
- 0.5(2026-08-31): 텍스트 선택 시각화, canvas/텍스트 성능, DuckDuckGo 홈 첫 정상 렌더
- 웹 암호(ML-KEM/ML-DSA)에서는 오히려 메이저를 앞섬

---

## 3. 래스터화 / GPU 레이어

### 3.1 Skia Graphite (Chrome의 차세대 래스터 백엔드)
Ganesh(OpenGL ES 전제)의 부채를 털어낸 재설계.

| 항목 | Ganesh | Graphite |
|---|---|---|
| 설계 기준 API | OpenGL ES | Vulkan / Metal / D3D12 |
| 백엔드 구현 | 직접 다중 구현 | **Dawn(WebGPU 구현체)을 추상화 레이어로 사용** |
| 스레딩 | 제한적 | **Recorder → Recording** 모델, 다중 스레드 기본 |
| 2D 오버드로 | 클립 스택 | **depth buffer(z값)로 2D 오버드로 제거**, 클립은 depth-only draw |

- 현재 Recorder 2개: (1) 웹 콘텐츠 타일 + Canvas2D, (2) 컴포지팅
- 성과: MacBook Pro M3에서 **Motionmark 1.3 약 +15%**(M133→M134), INP/LCP/스무스니스/GPU 메모리 개선
- 상태: **Mac 기본 활성**, Windows 진행 중
- 다음 계획: 래스터화 스레드 2→N 확장, Recording 재발행으로 GPU 메모리 절약, **GPU compute 기반 path 래스터화**(MSAA 한계 돌파)

### 3.2 WebGPU — 2026년 드디어 전 브라우저

| 브라우저 | 상태 |
|---|---|
| Chrome/Edge | 113(2023)부터 |
| Safari | **26(2025-09)** macOS/iOS/iPadOS/visionOS |
| Firefox | 141 Windows, **145 macOS(Apple Silicon)** |
| Linux / Android | 진행 중 (Mozilla는 2026년 중 Android 목표) |

브라우저 렌더링 관점에서 중요한 이유: **Graphite가 Dawn 위에 있다**. 즉 WebGPU는 이제 "웹 콘텐츠용 API"일 뿐 아니라 **브라우저 자신의 렌더링 인프라**다.

### 3.3 Rust 2D 렌더러 생태계 (실험 친화적)
- **Vello** (linebender, 4.3k★) — GPU compute 중심 2D 렌더러. 세 갈래:
  - `vello` (full GPU compute) / `vello_cpu` (CPU) / **`vello_hybrid`** (CPU가 path 처리, GPU가 렌더/합성)
- **WebRender** (servo, 3.4k★) — Firefox 실사용. display list → GPU
- **Parley** (735★) — 리치 텍스트 레이아웃
- **Taffy** (3.6k★) — flexbox/grid 레이아웃 엔진 단독 크레이트
- **Stylo** (servo, 329★) — **Servo와 Firefox가 공유하는 CSS 엔진**

---

## 4. 웹 플랫폼 레이어 — Interop 2026

렌더링과 직결된 Interop 2026 포커스:

| 영역 | 내용 | 렌더링 관점 |
|---|---|---|
| **Anchor positioning** | 다른 요소 기준 배치(툴팁 등) | 레이아웃/포지셔닝 신규 축 |
| **Scroll-driven animations** | `animation-timeline`, `scroll-timeline`, `view-timeline` | **컴포지터에서 스크롤 위치에 직접 바인딩** → JS·main thread 없이 동작 |
| **View Transitions** | same-doc 개선 + **cross-document**, `blocking="render"`, `<link rel="expect">`, `:active-view-transition-type()` | 스냅샷 기반 합성 |
| **Scroll snap** | `scroll-snap-*` 일관성 | 컴포지터 스크롤과 상호작용 |
| **`shape()` 함수** | line/move/curve 명령 도형, `clip-path`/`shape-outside` | 클립/마스크 = effect tree |
| **`zoom` 속성** | 레이아웃에 영향 주는 스케일 | 2025에서 이어짐 |

기타 2026 상황:
- **`display: grid-lanes`** — 네이티브 masonry. Masonry.js 및 옛 `display: masonry` 프로토타입 대체
- scroll-driven animations: Chrome 115(2023-07) / Safari 26(2025-09, 26.4에서 threaded) / Firefox는 아직 플래그
- `content-visibility` + `contain-intrinsic-size`: Baseline(2024-09~), 오프스크린 렌더 스킵. 현실적 기대치는 **layout+paint 단계 30~60% 절감**
- Speculation Rules: 여전히 Chromium 계열 한정. `prerender_until_script` 는 Chrome 144(2026-01)부터 오리진 트라이얼

---

## 5. 계측 / 디버깅

### 5.1 지표
- **INP** 가 2026년 가장 많이 실패하는 CWV — 43%의 사이트가 200ms 기준 미달
- **LoAF (Long Animation Frames API)** — Long Tasks의 후계. "태스크 시작부터 렌더 갱신까지"를 프레임 단위로 노출 → INP 원인 규명용. Chrome 123+ / web-vitals v4+ 의 `longAnimationFrameEntries`

### 5.2 도구 스택 (실험 시 그대로 사용)

| 도구 | 용도 |
|---|---|
| DevTools **Rendering 탭** | Paint flashing(초록 하이라이트), **Layer borders**(주황/올리브=레이어, 청록=타일), FPS/CWV 오버레이 |
| DevTools **Performance 패널** | Insights 사이드바, LCP 단계 분해, **Layout shifts 트랙**(5초 클러스터 + 원인 목록), Live metrics |
| **Layers 패널** | 합성 레이어 3D 시각화 |
| `chrome://tracing` → **Perfetto UI** | 원시 이벤트 스트림: `BeginFrame`, `DrawFrame`, `RasterTask` 와 실행 스레드 |
| `chrome://gpu` | 래스터 백엔드(Ganesh/Graphite), 하드웨어 가속 상태 확인 |
| **WPT** / Interop 대시보드 | 엔진 간 동작 차이 확인 |

---

## 6. GitHub 리포지토리 카탈로그

### 실제 엔진

| 리포 | ★ | 언어 | 최근 push | 메모 |
|---|---|---|---|---|
| [LadybirdBrowser/ladybird](https://github.com/LadybirdBrowser/ladybird) | 66.2k | C++(→Rust) | 2026-09-17 | **학습용 1순위**. LibWeb 전체를 읽을 수 있음 |
| [servo/servo](https://github.com/servo/servo) | 38.0k | Rust | 2026-09-17 | 임베딩 가능, 월간 릴리스 |
| [chromium/chromium](https://github.com/chromium/chromium) | 24.8k | C++ | 2026-09-17 | 공식 미러. `third_party/blink`, `cc`, `components/viz` |
| [WebKit/WebKit](https://github.com/WebKit/WebKit) | 10.2k | C++ | 2026-09-16 | 레이아웃 재작성 실황 관찰 |
| [mozilla-firefox/firefox](https://github.com/mozilla-firefox/firefox) | — | C++/Rust | 활성 | `mozilla/gecko-dev` 는 **2025-07 이후 중단** |

### 렌더링 인프라

| 리포 | ★ | 메모 |
|---|---|---|
| [google/skia](https://github.com/google/skia) | 10.9k | Ganesh + **Graphite** |
| [google/dawn](https://github.com/google/dawn) | 1.1k | 네이티브 WebGPU 구현. Graphite의 하부 |
| [gfx-rs/wgpu](https://github.com/gfx-rs/wgpu) | 18.1k | Rust WebGPU. Firefox의 WebGPU 백엔드 |
| [servo/webrender](https://github.com/servo/webrender) | 3.4k | Firefox 실사용 GPU 렌더러 |
| [linebender/vello](https://github.com/linebender/vello) | 4.3k | GPU compute 2D 렌더러 (+ `vello_hybrid`) |
| [harfbuzz/harfbuzz](https://github.com/harfbuzz/harfbuzz) | 6.1k | 텍스트 셰이핑. 모든 엔진이 씀 |

### 모듈 단위(실험 조립용)

| 리포 | ★ | 메모 |
|---|---|---|
| [DioxusLabs/blitz](https://github.com/DioxusLabs/blitz) | 4.2k | **모듈형 HTML/CSS 렌더러**. stylo+taffy+parley+vello+wgpu 조합. 실험 최적 |
| [DioxusLabs/taffy](https://github.com/DioxusLabs/taffy) | 3.6k | flex/grid 레이아웃만 |
| [servo/stylo](https://github.com/servo/stylo) | 329 | Servo+Firefox 공용 CSS 엔진 |
| [linebender/parley](https://github.com/linebender/parley) | 735 | 리치 텍스트 레이아웃 |
| [servo/html5ever](https://github.com/servo/html5ever) | 2.6k | 브라우저급 HTML5 파서 |

### 학습/장난감

| 리포 | ★ | 메모 |
|---|---|---|
| [browserengineering/book](https://github.com/browserengineering/book) | 1.2k | **Web Browser Engineering** 책 소스 (2026-08 갱신) |
| [mbrubeck/robinson](https://github.com/mbrubeck/robinson) | 1.7k | 고전 토이 엔진(Rust). 2024 이후 정체 |
| [Lei-TzuY/toy-browser-engine](https://github.com/Lei-TzuY/toy-browser-engine) | — | 파싱→레이아웃→페인트→스크립팅 전 구간 |
| [maekawatoshiki/naglfar](https://github.com/maekawatoshiki/naglfar) | — | Rust 토이 브라우저 |

### 표준 / 계측

| 리포 | 메모 |
|---|---|
| [web-platform-tests/wpt](https://github.com/web-platform-tests/wpt) | 6.2k. 엔진 비교의 기준 |
| [gpuweb/gpuweb](https://github.com/gpuweb/gpuweb) | 5.5k. WebGPU 스펙 + [Implementation Status wiki](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status) |
| [w3c/long-animation-frames](https://github.com/w3c/long-animation-frames) | LoAF 스펙 |
| [GoogleChrome/web-vitals](https://github.com/GoogleChrome/web-vitals) | 8.6k |
| [GoogleChrome/lighthouse](https://github.com/GoogleChrome/lighthouse) | 30.8k |

---

## 7. 영상 / 강의 자료

### 필수 (이 순서로)

| 영상 | 성격 | 링크 |
|---|---|---|
| **Life of a Pixel** (Chrome University 2020) | Chromium 렌더링 파이프라인 정본 강의 | https://www.youtube.com/watch?v=PwYxv-43iM4 |
| Life of a Pixel (다른 회차) | 2018 / 2019 버전 | [2018](https://www.youtube.com/watch?v=zVwDTLOOSmY) · [2019](https://www.youtube.com/watch?v=m-J-tbAlFic) · [기타](https://www.youtube.com/watch?v=K2QHdgAKP-s) |
| 슬라이드(항상 최신) | Google Slides | [Life of a Pixel 슬라이드](https://docs.google.com/presentation/d/1boPxbgNrTU0ddsc144rcXayGA_WF53k96imRH8Mp34Y) |

### 독립 엔진 (2026 최신)

| 영상 | 날짜 | 링크 |
|---|---|---|
| **Ladybird Browser: State of the Union** | 2026-06-25 | https://www.youtube.com/watch?v=gZL3uk7oa2g |
| Ladybird Browser Is In For A Rusty Future (Kling 인터뷰) | 2026-03-13 | https://www.youtube.com/watch?v=fXnuR6nXJzc |
| Ladybird: Building a new browser from scratch | — | https://www.youtube.com/watch?v=otf-FQRwBDQ |

### 채널 / 플레이리스트
- [BlinkOn 공식 채널](https://www.youtube.com/user/blinkontalks) — BlinkOn 20(2025-04) / **BlinkOn 21(2026-04-20~21, Redmond)**
- [Chromium University 플레이리스트](https://www.youtube.com/playlist?list=PL9ioqAuyl6ULp1f36EEjIN1vSBEfsb-0a)
- [Andreas Kling 채널](https://www.youtube.com/c/AndreasKling) — 엔진 구현 라이브 코딩

---

## 8. 문서 / 책 (1차 출처)

| 자료 | 링크 |
|---|---|
| **RenderingNG 개요** | https://developer.chrome.com/docs/chromium/renderingng |
| **RenderingNG 아키텍처** | https://developer.chrome.com/docs/chromium/renderingng-architecture |
| **RenderingNG 자료구조** ← 가장 밀도 높음 | https://developer.chrome.com/docs/chromium/renderingng-data-structures |
| BlinkNG deep-dive | https://developer.chrome.com/docs/chromium/blinkng |
| How cc Works (Chromium) | https://chromium.googlesource.com/chromium/src/+/master/docs/how_cc_works.md |
| GPU Accelerated Compositing in Chrome | https://www.chromium.org/developers/design-documents/gpu-accelerated-compositing-in-chrome/ |
| dbaron, How browser rendering works (Gecko 관점) | https://dbaron.github.io/browser-rendering/ |
| Skia Graphite 소개 | https://blog.google/chromium/introducing-skia-graphite-chromes/ |
| WebKit Safari 27 beta | https://webkit.org/blog/17967/news-from-wwdc26-webkit-in-safari-27-beta/ |
| Interop 2026 | https://web.dev/blog/interop-2026 |
| LoAF API | https://developer.chrome.com/docs/web-platform/long-animation-frames |
| Mozilla Gfx 팀 블로그 | https://mozillagfx.wordpress.com/ |
| Servo 블로그(월간) | https://servo.org/blog/ |
| Ladybird 뉴스레터(월간) | https://ladybird.org/newsletter/2026-08-31/ |
| **Web Browser Engineering** (Panchekha & Harrelson, OUP 2026) — 공저자가 Blink Rendering 팀 리드 | https://browser.engineering/ |

---

## 9. 조사 중 확인 못 한 것 (정직하게 남김)

- Blink 렌더링 팀의 **2026년 공식 로드맵** 1차 자료 — BlinkOn 21 세션 목록 직접 확인 필요
- Graphite의 **Windows/Android 정확한 롤아웃 단계**
- `display: grid-lanes` 의 **엔진별 실제 구현 상태** (기사 기반이라 검증 필요)
- Chromium 2026 진행 프로젝트(`RenderDocument`, scroll unification 등) 현재 상태
