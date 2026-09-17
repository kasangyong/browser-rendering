# 영상 분석 — Life of a Pixel (Chrome University 2020)

> https://www.youtube.com/watch?v=PwYxv-43iM4 · 25분 19초
> 발표: **Philip Rogers** — Chrome Rendering팀 내 **Paint팀 TL**, 당시 재직 8년차
> 원작: Steve Kobes(2017), 이후 지속 업데이트 — 발표자 본인이 "living document"라 부름
> 분석 방법: 자동자막 전문 + 슬라이드 46장 추출(1024px) 판독

관련: [강의 정리 01](../lecture/01-rendering-pipeline.md) · [강의 정리 02](../lecture/02-javascript-and-rendering.md) · [2026 조사](../01-landscape-2026.md)

---

## 0. 가장 중요한 발견 — `paint → layer` 순서 문제가 풀렸다

[강의 정리 01](../lecture/01-rendering-pipeline.md#6-layer-슬라이드--)에서 남겨둔 의문이 이 영상으로 해소된다.

**당시 기록한 관찰**: 강의는 `paint → layer` 순서로 가르치는데 슬라이드 ⑥은 `Layout Tree → Layer Tree` 화살표라 옛 모델처럼 보인다.

**영상이 주는 답**: 2020년 Chromium은 **실제로 layer가 paint보다 먼저**였다.

```
[2020년 실제 파이프라인 — 21:15 슬라이드]
main:  ... → layout → compositing update → prepaint → paint
                      └─ 여기서 layer 생성      └─ 여기서 property tree 생성
```

그리고 같은 슬라이드에 **`composite after paint (CAP)`** 가 ⚠️**UNDER CONSTRUCTION** 표지와 함께 등장한다. `compositing update` 박스에 빨간 X가 그어져 있고, 캡션은 이렇다:

> *"In the future, layers will be created after paint."*

**정리하면**:

| 시점 | 순서 | 상태 |
|---|---|---|
| 2020 (이 영상) | layer → paint | 당시 현행 |
| 2020 계획 | paint → layer (CAP) | 공사 중 |
| 2026 (현재) | **paint → layer** | [완료](../01-landscape-2026.md#21-blink--chromium) |
| 수강한 강의 | **paint → layer** | 현행 반영 ✅ |

들으신 강의는 최신 모델을 가르치고 있고, 슬라이드 ⑥ 그림만 옛 자료를 재사용한 게 맞다. **6년에 걸쳐 실제로 뒤집힌 아키텍처**를 양쪽에서 본 셈이다.

---

## 1. 영상의 최종 요약 슬라이드 (24:20)

발표 전체가 이 한 장으로 압축된다.

```
content <html>...</html>
   │
   ▼  ┌──────────────── renderer process ────────────────┐
main │ DOM → style → layout → compositing update → prepaint → paint
      │ └──────────────────── Blink ────────────────────┘
      │                          │
impl  │ commit → tiling → raster → (raster 워커풀) → activate → draw
      └──────────────────────────────────────────────────┘
                     │
      ┌──────── GPU process ────────┐
      │  SKIA  →  display           │ → 🖥️
      └─────────────────────────────┘
```

입력(`⇅🖱`)은 **impl 스레드로 먼저** 들어간다 — 스크롤을 main 없이 처리하기 위한 구조.

---

## 2. 강의 ↔ 영상 대조표

| 수강 강의 8단계 | 영상의 단계 | 영상에서 나온 실제 클래스 |
|---|---|---|
| loading · parsing | parsing | `HTMLDocumentParser` → `HTMLTreeBuilder` |
| DOM | DOM | `Document`(항상 루트), HTML/BODY는 선택적 태그 |
| style | style | `CSSParser` → `Document::UpdateStyle` → `StyleResolver::StyleForElement` → `ComputedStyle` |
| layout | layout | `LayoutView` / `LayoutBlockFlow` / `LayoutText`, `LayoutRect{x,y,w,h}` |
| — | **compositing update** | `PaintLayer` → `cc::Layer` (layer list 생성) |
| — | **prepaint** | `PrePaintTreeWalk::Walk` → `PaintPropertyTreeBuilder` (property tree 4종) |
| paint | paint | `LocalFrameView::PaintTree` → `PaintCanvas::DrawRect` → `DisplayItem`/`PaintOp` → **`PaintArtifact`** |
| layer | (compositing update에 포함) | — |
| composite | commit → tiling → raster → activate → draw → display | 아래 §5 |

**강의에 없던 2단계**가 `compositing update`와 `prepaint`다. 조사 문서에서 "강의의 빈칸"으로 짚었던 [property trees](../01-landscape-2026.md#13-핵심-자료구조-여기가-진짜-공부-포인트)가 바로 `prepaint`의 산출물이다.

---

## 3. 단계별 상세 (타임스탬프 = 다시 볼 지점)

### content와 pixels의 정의 (01:10~03:05)
- **content** = URL 바 **아래**의 것. `content::WebContents`가 관리. 탭 스트립·뒤로가기 버튼은 *NOT "content"*
- 각 content는 **sandboxed renderer process** 안의 **Blink**가 그린다 — 한 웹페이지가 다른 웹페이지에 영향을 못 주게 하는 보안 경계
- content 종류: HTML / CSS / JS / images, 그리고 `<video>`, `<canvas>`, WebAssembly, WebGL, WebVR, PDF
- **pixels** = OS의 최저수준 primitive. `#include <GL/gl.h>` → textures, shaders, vertex buffers. OpenGL이 기본이고 DirectX / Vulkan / Metal이 대안

### goals (03:40) — 이 영상의 설계 철학
> 1. render content into pixels
> 2. **build data structures to enable *updating* the rendering efficiently**

2번이 핵심이다. 갱신 요인으로 JavaScript · user input · asynchronous loading · animations · scrolling · zooming을 나열한다.
한 번 그리는 건 쉽고, **다시 그리는 걸 싸게 만드는 게 아키텍처의 전부**라는 선언.

### style의 실제 파이프라인 (07:00~07:45)
```
CSSParser → StyleSheetContents{StyleRule} → CSSSelectorList{CSSSelector}
                                          → CSSPropertyValueSet{CSSPropertyValue}
                                          → BorderLeftColor / CSSColorValue(0x0000FFFF)
```
코드 생성도 등장한다: `css_properties.json5` → `make_css_property_subclasses.py` → `longhands.h`
→ CSS 속성 클래스들이 **손으로 쓴 게 아니라 생성된다**.

`Document::UpdateStyle`이 DOM 노드마다 `StyleResolver::StyleForElement`를 돌려 `ComputedStyle{fontWeight, marginLeft, outline, transform, background, ...}`를 채운다.
**수강 강의 슬라이드 ②의 "Computed Style 박스"가 정확히 이것.**

### layout (08:20~11:40)
- 예시가 구체적이다: w3.org의 한 `DIV` → `LayoutRect { x=212, y=148, width=474, height=66 }`
- **block flow**(위→아래) vs **inline flow**(좌→우, 줄바꿈). 아랍어·히브리어 RTL도 같은 줄에 섞일 수 있음
- **text shaping**: `"fire"` + `Font` → `HarfBuzzShaper`(내부에 **HarfBuzz**) → `ShapeResult`. 4글자가 **3글리프**로 — `fi` 합자(ligature)
  - 좌/우 side bearing, advance width 같은 타이포그래피 개념이 그대로 등장
- layout tree는 DOM과 **거의 1:1**. 발표자 표현: "레이아웃 시스템 안에서 일하는 게 아니라면 1:1로 생각해도 충분히 멀리 간다"

**LayoutNG (11:40)** — 2020년 스냅샷
```
[legacy] LayoutObject::UpdateLayout()   ← 입력·출력·알고리즘이 한 덩어리
[NG]     LayoutNGMixin → NGLayoutInputNode + NGConstraintSpace
                       → NGLayoutAlgorithm
                       → NGLayoutResult → NGPhysicalFragment
```
> *"LayoutNG separates these to improve caching and scalability."*

당시 **레이아웃의 약 75%가 LayoutNG 경로**, 나머지는 레거시와 공존. → 2026년엔 완료되어 `NGPhysicalFragment`가 [immutable fragment tree](../01-landscape-2026.md#13-핵심-자료구조-여기가-진짜-공부-포인트)로 자리잡았다.

### paint (12:30~13:30)
```
LocalFrameView::PaintTree
  → LayoutObject::Paint() → PaintCanvas::DrawRect
  → PaintArtifact { DisplayItem { PaintOp: DrawRectOp - rect{x,y,w,h}, PaintFlags{color} } , ... }
```
**수강 강의 슬라이드 ④의 `Draw Rect / Draw Text / Draw Rect`가 이 `DisplayItem` 리스트다.**

두 가지 "순서가 뒤집히는" 이유를 각각 슬라이드 한 장씩 할애한다:

**① stacking order ≠ DOM order (12:50)**
```html
<div class="yellow"></div>   <!-- z-index: 2 -->
<div class="green"></div>    <!-- z-index: 1 -->
```
DOM에선 yellow가 먼저인데 **yellow paints last** (위에 그려짐).
→ 노트에 적으신 "요소의 선언 순서와 paint 순서는 다를 수 있음: z-order"가 이것.

**② paint phase (13:10)**
각 phase가 stacking context를 **따로 한 번씩 순회**한다:
```
backgrounds → floats → foregrounds → outlines
```
캡션: *"blue after green, but foregrounds after backgrounds"* — 그래서 green의 텍스트가 blue 박스보다 아래 깔린다.
**같은 요소가 여러 번 방문된다**는 뜻이고, 이래서 paint는 트리를 "몇 번" 훑는다.

### raster / GPU (13:30~16:00)
```
DrawRectOp::RasterWithFlags
  → SkCanvas::drawRect → GrRenderTargetContext::addDrawOp → GrOp(FillRectOp)
  → SkSurface::flush → GrOp::execute → GrGLGpu::draw → glDrawElements(...)
```

**out-of-process raster (15:25)** — 보안 때문에 프로세스가 갈린다:
```
renderer process                      GPU process
RasterTaskImpl → RasterInterface  ──DoRasterCHROMIUM──▶  RasterDecoderImpl
                 {PaintOp}                               → PaintOp::Raster → SKIA → OpenGL
```
저수준 GL 호출은 안전하지 않고 드라이버가 잘 죽는다. 분리해두면 **GPU 프로세스가 죽어도 브라우저는 살아남는다** — 예전엔 브라우저 전체가 날아갔다.

**ANGLE (16:00)**
```
GLApi::glDrawElementsFn
  ├─ Linux:   dlopen("libGLESv2.so") / dlsym("glDrawElements")
  └─ Windows: LoadLibrary("libglesv2.dll") / GetProcAddress("glDrawElements")
                                    └─ ANGLE: OpenGL → DirectX 변환
```
Chromium은 Windows에서도 Skia에게 "OpenGL을 써라"라고 말하고, 뒤에서 ANGLE이 DirectX로 번역한다.

> 📌 2026년 대조: [Skia Graphite](../01-landscape-2026.md#31-skia-graphite-chrome의-차세대-래스터-백엔드)는 이 `Gr*`(Ganesh) 계열을 걷어내고 **Dawn(WebGPU) 위**에 새로 짓는 중이다. 이 영상의 `GrGLGpu::draw` 경로가 곧 과거가 된다.

---

## 4. 후반부 — "변화"를 싸게 만들기

### change (16:45)
완성된 파이프라인 옆에 라이온킹 라피키 짤과 함께:
> *"Change is good." / "Yeah, but it's not easy."*

변화 요인: scrolling, zooming, animations, incremental loading, JavaScript

### invalidation (17:20) — 강의에 없던 좋은 슬라이드
각 단계가 **자기 무효화 플래그**를 따로 관리한다:

| 호출 | 무효화 대상 |
|---|---|
| `Node::SetNeedsStyleRecalc()` | style |
| `LayoutObject::SetNeedsLayout()` | layout |
| `PaintInvalidator::InvalidatePaint()` | paint |
| `RasterInvalidator::Generate()` | raster |

> *"Outputs are reused from previous frames when possible."*

캐싱의 실체가 이 4개 비트다. 이게 2026년 [immutable fragment tree](../01-landscape-2026.md#13-핵심-자료구조-여기가-진짜-공부-포인트)로 발전한다.

### jank (17:55) — [강의 02](../lecture/02-javascript-and-rendering.md)와 정확히 같은 이야기
슬라이드 캡션: *"...and anything on the main thread competes with JavaScript."*

타임라인 그림에서 main 스레드가 파란 블록(프레임) 두 개를 내다가, 빨간 긴 블록에 막혀 프레임이 하나 **터진다**(💥 아이콘).
그 빨간 블록의 정체:
```html
<script>
  mineSomeBitcoins();  // why not?
</script>
```

→ **강의 02의 "즉시 렌더 vs 양보 렌더"가 다루는 문제가 이 그림 한 장이다.**

### threaded compositing (18:45)
> - Decompose the page into **layers** which raster independently.
> - Combine the layers on another thread.

```
main:  build layers ──commit──▶
impl:              ──────────▶ draw layers
```
각주가 재밌다: `* ("impl" = compositor thread) ¯\_(ツ)_/¯` — 발표자도 이름이 이상하다고 인정한다.
배경에 DevTools **Layers 패널** 스크린샷(레이어들이 3D로 비스듬히 쌓인 모습).

### layer list (19:20) — 용어 교정 포인트
```
layout tree                    PaintLayer            cc::Layer
LayoutBlockFlow{transform:…} → (compositing          → layer list
                                "candidate")
```
> *"The layer list is based on the layout tree. **It has no hierarchy.**"*

⚠️ **수강 강의 슬라이드 ⑥은 "Layer Tree"라고 표기했지만, Chromium의 실제 자료구조는 계층 없는 layer *list*다.** `PaintLayer`는 "합성 후보"일 뿐이고, 실제 합성 레이어인 `cc::Layer`는 평평한 목록으로 관리된다.

### property trees (20:55)
```
main: … → layout → compositing update → [prepaint] → paint
                                            ↓
                                   PrePaintTreeWalk::Walk
                                            ↓
                                   PaintPropertyTreeBuilder
                                            ↓
                              🟢🟠🔵⚪  (4개 트리)
```
슬라이드에 색만 4개 그려져 있는데, 2026년 문서 기준 **transform / clip / effect / scroll** 이다.

> *"The prepaint stage builds the property trees."*

### commit (21:30)
```
main:  … → paint → (blocked) ─── ready to commit ───┐
                                                     │ copy layers and properties
                                                     │ cc::Layer  →  LayerImpl
impl:  ──────────────────────▶ commit ──────────────┘── commit complete ──▶
```
**두 스레드를 실제로 멈춘 뒤** 데이터를 복사하고 다시 푼다.

### tiling (22:05)
```
layer(세로로 긴 페이지)          impl: prepare tiles
  ├ viewport (분홍 박스)              ↓
  └ visible tiles ─────────▶  raster task → CategorizedWorkerPool
                                     ↓        (raster 스레드 여러 개)
                                rastered tile
```
페이지 맨 아래 copyright는 사용자가 볼 일이 한참 없으니 **래스터화하지 않는다**.
→ **수강 강의 슬라이드 ⑧에서 레이어가 viewport보다 컸던 이유가 이것.**

### draw (22:40)
```
impl: (raster complete) → draw → PictureLayerImpl::AppendQuads
Tile{TileDrawInfo.resource_} ──▶ GPU memory(래스터 결과) ──▶ CompositorFrame{DrawQuad{rect}}
```
> *"CompositorFrame is the output of the renderer process."*

### activation (23:10) — 노트의 "double buffer"
```
commit ──▶ pending tree {LayerImpl} ──raster──▶ activation ──┐
           active tree  {LayerImpl} ──draw──▶                ▼
                                             새 active tree ──draw──▶
```
> *"Drawing can continue while a new commit is rastered."*

**작업 중인 트리(pending)와 사용자가 보는 트리(active)가 따로 있고**, 다 되면 교체한다. 그래서 래스터 중에도 스크롤이 계속 먹는다.

### display / viz (23:30)
```
browser process {ui::Compositor} ──CompositorFrame(브라우저 UI)──┐
renderer process ────────────────CompositorFrame────────────────┤──▶ GPU process
renderer process ────────────────CompositorFrame────────────────┘     display compositor (VCT)
                                                                       SurfaceAggregator
```
렌더러가 **여러 개**인 이유: 메인 페이지 + iframe이 각각 다른 프로세스일 수 있다.
여기서 Skia는 **곡선을 그리는 게 아니라 이미 만들어진 텍스처를 화면에 얹는 용도**로만 쓰인다 — 저수준 플랫폼 API로 가는 유일한 통로라서.

---

## 5. 이 영상에서만 얻은 것 (강의에 없던 것)

| # | 내용 | 왜 중요한가 |
|---|---|---|
| 1 | **compositing update + prepaint** 2단계의 존재 | 강의의 `layer`가 사실 두 작업이었다 |
| 2 | **property trees**를 prepaint가 만든다 | 레이어를 "어떻게 변형할지"의 출처 |
| 3 | **layer list has no hierarchy** | "Layer Tree"라는 통념 교정 |
| 4 | **invalidation 4종 API** | 캐싱의 실제 구현체 |
| 5 | **paint phase 4단계** 순회 | paint가 트리를 여러 번 도는 이유 |
| 6 | **out-of-process raster + ANGLE** | 왜 GPU 프로세스가 따로인가 |
| 7 | **pending / active tree** | 노트의 "double buffer"의 실제 이름 |
| 8 | **CAP under construction** | 강의 순서 의문의 직접 증거 |

---

## 6. 주의 — 2020년 자료라 낡은 부분

| 영상 내용 | 2026년 현재 |
|---|---|
| LayoutNG "약 75%" 진행 중 | **완료** |
| CAP "under construction" | **완료** — layer가 paint 뒤로 |
| Ganesh(`GrGLGpu`, `GrRenderTargetContext`) | **Graphite**로 교체 중 (Mac 기본 활성) |
| OpenGL 중심 + ANGLE 변환 | **Dawn(WebGPU)** 기반, Vulkan/Metal/D3D12 직접 |
| 파이프라인 단계 표기 | RenderingNG의 [13단계 정식 명칭](../01-landscape-2026.md#12-13단계-파이프라인) |

그래도 **구조와 자료구조의 뼈대는 그대로**다. 이름과 순서만 일부 바뀌었다.

---

## 7. 다음에 볼 것

- 발표자가 말한 슬라이드 원본(계속 업데이트됨): [Life of a Pixel 슬라이드](https://docs.google.com/presentation/d/1boPxbgNrTU0ddsc144rcXayGA_WF53k96imRH8Mp34Y)
- 강의 슬라이드 ⑤(빽빽한 paint ops 시각화)의 정체는 이 영상에서도 못 찾음 — 여전히 미확인
