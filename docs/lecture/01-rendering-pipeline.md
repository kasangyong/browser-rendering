# 강의 정리 — 브라우저 렌더링 파이프라인

> 출처: 수강 중인 강의 "브라우저 렌더링 - 빠릿한 페이지"
> 구성: **내 노트** = 강의에서 받아적은 내용 그대로 / **슬라이드** = 이미지 매칭 / **보강** = 조사([01-landscape-2026.md](../01-landscape-2026.md))에서 가져온 추가 설명
> 노트 원문은 손대지 않았다. 보강은 명확히 분리해 둔다.

---

## 전체 흐름

```
loading → parsing → DOM → style → layout → paint → layer → composite
```

**정의**: rendering pipeline = 브라우저가 페이지를 화면에 그리는 과정

### 이미지 ↔ 단계 매칭표

| # | 슬라이드 내용 | 대응 단계 |
|---|---|---|
| ① | Renderer Process: HTML 소스 + Network request 화살표 → DOM Tree(document/body/p/text) | **loading · parsing · DOM** |
| ② | DOM 노드마다 → Computed Style 박스, 우측에 CSS 규칙 | **style** |
| ③ | Computed Style → Layout Tree(LayoutBlockFlow / LayoutText) | **layout** |
| ④ | Draw Rect(red) → Draw Text → Draw Rect(blue) 체인 | **paint** (paint ops) |
| ⑤ | 파란 선 + 노란/초록 사각형이 빽빽한 실제 페이지 시각화, 자막 "실제로 일어나는 일입니다" | **paint** — ④의 실제 규모 |
| ⑥ | Layout Tree → Layer Tree(오각형 Layer 1, Layer 2) | **layer** |
| ⑦ | 같은 paint ops 두 벌, 각각 노란 오각형/파란 오각형 태그 | **layer** — 레이어별 paint ops 분리 |
| ⑧ | viewport 점선 + 노랑/파랑/초록 사각형 겹침 | **composite** |

---

## 1. loading · parsing 〔슬라이드 ①〕

> **내 노트**
> network에서 받은 html 파일을 읽고, parsing을 시작

**슬라이드 ①이 보여주는 것**
- `Renderer Process` 박스 안에서 전부 일어난다
- HTML 소스의 `<link href="zzz.css">`, `<img src="horse.png">`, `<script src="zzz.js">` 각각에서 **Network request 화살표**가 나간다
- 우측 상단 `Main thread` 표시 — 이 작업이 메인 스레드에서 돈다는 뜻

<details>
<summary><b>보강</b> — 서브리소스 요청이 파싱 중에 나가는 이유</summary>

파싱하다가 `<link>`/`<img>`/`<script>`를 만나면 그 자리에서 요청을 쏜다. 그래서 파싱과 네트워크가 겹친다.
추가로 Chromium에는 **PreloadScanner**가 있어서, 메인 파서가 `<script>`에 막혀 있는 동안 별도로 문서를 앞서 훑으며 서브리소스를 미리 요청한다. 파서 블로킹의 피해를 줄이는 장치다.
</details>

---

## 2. DOM 〔슬라이드 ①〕

> **내 노트**
> dom(document object model) tree를 만듦

**슬라이드 ①이 보여주는 것**
- 트리 루트가 `document`, 그 아래 `body`, `p`, 그리고 리프에 `text`
- 즉 **텍스트도 노드**다

---

## 3. style 〔슬라이드 ②〕

> **내 노트**
> 각 dom node에 적용될 style 계산

**슬라이드 ②가 보여주는 것**
- DOM 노드 **각각**에 `Computed Style` 박스가 1:1로 붙는다
- 우측 CSS:
  ```css
  * { font-size: 12px; font-family: serif; }
  p { color: blue; margin: 10px; }
  ```
- 핵심은 "CSS 규칙"이 아니라 **노드별로 최종 확정된 값**이 만들어진다는 것

<details>
<summary><b>보강</b> — Computed Style이 "계산"인 이유</summary>

`*` 규칙과 `p` 규칙이 겹칠 때 어느 쪽이 이기는지(명시도), 상속받을 값은 무엇인지, `10px` 같은 상대 단위를 절대값으로 바꾸는 작업까지 전부 여기서 끝난다. 이후 단계는 CSS 문법을 다시 볼 일이 없다.

Ladybird가 2026년에 이 단계를 "DOM 변경을 typed delta로 보고 **영향받는 셀렉터에만** 다시 계산"하는 증분 방식으로 바꿔서 StyleBench 점수가 3.5 → 83으로 뛰었다. 이 단계가 성능에서 차지하는 비중을 보여주는 사례.
</details>

---

## 4. layout 〔슬라이드 ③〕

> **내 노트**
> 위치 너비 높이 등 기하학적 요소를 계산해 레이아웃 트리를 만듦, 요소의 속성에 따라 레이아웃 트리에는 속하지 않을 수 있음

**슬라이드 ③이 보여주는 것**
- Computed Style → **Layout Tree**
- 노드 타입 이름이 붙는다: `LayoutBlockFlow`, `LayoutBlockFlow`, `LayoutText`
- **DOM 트리보다 노드 수가 적다** ← 노트의 "레이아웃 트리에는 속하지 않을 수 있음"이 그림으로 드러난 부분

<details>
<summary><b>보강</b> — 어떤 게 빠지고 어떤 게 남나</summary>

| 속성 | 레이아웃 트리 | 이유 |
|---|---|---|
| `display: none` | **빠짐** | 공간을 차지하지 않음 = 기하학적 계산 대상이 아님 |
| `visibility: hidden` | **남음** | 안 보일 뿐 공간은 차지함 |
| `opacity: 0` | **남음** | 위와 같음 |
| `<head>` 안의 요소들 | **빠짐** | 렌더링 대상이 아님 |

반대로 DOM에 없던 노드가 **생기기도** 한다 — `::before`/`::after` 같은 가상 요소, 그리고 텍스트가 여러 줄로 쪼개질 때.
그래서 "DOM 트리 ≠ 레이아웃 트리"이고, 이름도 DOM과 다르게 `LayoutBlockFlow`/`LayoutText`를 쓴다.

`LayoutBlockFlow`는 Chromium(Blink)의 실제 클래스 이름이다. 이 슬라이드가 Chromium 기준이라는 표시.
</details>

---

## 5. paint 〔슬라이드 ④, ⑤〕

> **내 노트**
> 각 요소를 그리기 위한 페인팅 명령들을 기록, 즉 아직 눈에 보이는 픽셀은 아님, 요소의 선언 순서와 paint 순서는 다를 수 있음: z-order

**슬라이드 ④가 보여주는 것**
```
Draw Rect (pos: x,y,w,h / color: red)
        ↓
Draw Text
        ↓
Draw Rect (pos: x,y,w,h / color: blue)
```
- **명령의 순서 있는 목록**. 픽셀이 아니라 "이렇게 그려라"는 레시피

**슬라이드 ⑤가 보여주는 것**
- 실제 페이지의 paint ops를 전부 펼친 시각화. 파란 선이 명령 흐름, 노란/초록 사각형이 개별 명령
- 자막: **"실제로 일어나는 일입니다"**
- ④는 3개짜리 교보재고, 현실은 ⑤ — 화면 한 장에 명령이 수천 개 단위로 쌓인다는 의미

> ⑤의 정확한 출처 도구는 강의에서 확인 필요. 좌하단 `+ / R / -` 줌 컨트롤이 있는 걸로 봐서 인터랙티브 뷰어.

<details>
<summary><b>보강</b> — "선언 순서 ≠ paint 순서"를 결정하는 것</summary>

노트에 적은 z-order가 핵심이다. CSS 명세의 **paint order**는 대략 이 순서로 돈다:

```
배경/보더 → 음수 z-index 스택 → 블록 레벨 → float → 인라인 → z-index:0/auto → 양수 z-index
```

그래서 HTML에서 먼저 쓴 요소가 나중에 그려질 수 있다. `position` + `z-index`, `opacity`, `transform`, `filter` 등은 **스택 컨텍스트**를 만들어서 이 순서를 바꾼다.

용어: 이 명령 목록을 Chromium은 **display list**라 부르고, 개별 명령은 **display item**이다. 실제로는 Skia 드로잉 명령이다.
</details>

---

## 6. layer 〔슬라이드 ⑥, ⑦〕

> **내 노트**
> 함께 그리기 좋은 것들 끼리 한 레이어로 그룹 짓고, 레이어 트리를 만듦
> layer: 함께 그릴 단위, 애니메이션은 이미지를 연속으로 보여주는 것, 모두 한 레이어라면 배경부터 스마일까지 매번 전부 다시 그려야함, 그래서 움직이는 부분과 움직이지 않는 부분 분리

**슬라이드 ⑥이 보여주는 것**
- Layout Tree → **Layer Tree** (오각형 = 레이어, `Layer 1`, `Layer 2`)
- 레이아웃 트리 노드 여러 개가 레이어 하나로 묶인다

**슬라이드 ⑦이 보여주는 것**
- ④의 paint ops 체인이 **두 벌로 복제**되어 있고, 각각 **노란 오각형 / 파란 오각형** 태그가 붙어 있다
- = 같은 paint ops 목록이 **레이어별로 나뉘어 소속**된다는 뜻
- ⑥과 ⑦을 합쳐 읽어야 "레이어링"이 무슨 작업인지 잡힌다: 트리 구조를 만드는 것(⑥) + 그 안에 그릴 명령을 배분하는 것(⑦)

<details>
<summary><b>보강</b> — 노트의 "움직이는 부분과 움직이지 않는 부분 분리"가 왜 결정적인가</summary>

레이어를 나누면, 움직이는 레이어는 **다시 그리지 않고 위치만 옮겨서** 합성할 수 있다. 래스터화 결과(픽셀 이미지)를 재사용하기 때문이다.
이것이 `transform`/`opacity` 애니메이션이 빠른 이유의 전부다 — 이 두 속성은 **합성 단계에서만** 처리되므로 style·layout·paint를 통째로 건너뛴다.
반대로 `left`, `top`, `width`를 애니메이션하면 매 프레임 layout부터 다시 돈다.

단, 레이어는 공짜가 아니다. 레이어마다 GPU 메모리를 먹는다. 무작정 `will-change: transform`을 뿌리면 메모리가 터지고 오히려 느려진다.

**순서에 대한 관찰**: 이 강의는 `paint → layer` 순서로 가르친다. 이게 **현행 Chromium 구조(CompositeAfterPaint)** 와 일치한다. 예전 설명들은 `layer → paint`(레이어를 먼저 정하고 레이어별로 그림) 순서였는데, Chromium이 순서를 뒤집었다. 이미 그려둔 display list를 보고 레이어를 정하는 쪽이 더 정확하고 메모리를 덜 쓴다는 판단.
슬라이드 ⑥의 화살표가 `Layout Tree → Layer Tree`로 되어 있어 옛 그림에 가까운데, 노트의 서술 순서와 ⑦은 새 모델을 따른다. 그림은 옛 자료를 재사용한 것으로 보인다.

> ✅ **확인됨** — [Life of a Pixel 2020 분석](../video/01-life-of-a-pixel-2020.md#0-가장-중요한-발견--paint--layer-순서-문제가-풀렸다)에서 직접 증거를 찾았다.
> 2020년 Chromium은 실제로 `compositing update(layer) → prepaint → paint` 순서였고, 같은 발표에 **`composite after paint (CAP)`가 "UNDER CONSTRUCTION"** 으로 등장한다. 그 공사가 2026년엔 끝났다. 강의는 최신을 가르치고 그림만 옛것이 맞다.
>
> 덧붙여 용어 하나: Chromium의 실제 자료구조는 "Layer **Tree**"가 아니라 **계층 없는 layer list**다 (`PaintLayer` = 합성 후보 → `cc::Layer` = 평평한 목록).
</details>

---

## 7. composite 〔슬라이드 ⑧〕

> **내 노트**
> 레이어는 만들어졌지만, 아직 픽셀로 만들어지지 않은 상태, 각 레이어의 paint ops를 실행하면서 픽셀을 뽑아냄(rasterize), 뽑아낸 레이어의 이미지들을 위치에 맞게 놓고 합성
> 각 레이어를 픽셀로 만들고, 픽셀화된 레이어를 합성해 만든 최종 이미지를 화면에 나타냄

**슬라이드 ⑧이 보여주는 것**
- **viewport** 점선 사각형
- 노랑 / 파랑 / 초록 레이어가 서로 다른 위치에서 **겹쳐져** 있다
- 각 레이어는 viewport보다 크거나 viewport 밖으로 나가 있다 → **화면에 보이는 것보다 넓은 영역이 존재**한다는 표현

<details>
<summary><b>보강</b> — rasterize와 타일</summary>

레이어 전체를 한 번에 래스터화하지 않는다. 레이어를 **타일**로 쪼개고, viewport 근처 타일부터 우선 래스터화한다. 스크롤을 미리 준비해두기 위해 viewport 밖 일부도 함께 그려둔다 — ⑧에서 레이어가 viewport보다 큰 이유가 이것.

Chromium 기준으로 이 작업은 **Renderer 프로세스가 아니라 별도 프로세스(Viz)의 GPU 스레드**에서 돈다. 그래서 페이지 JS가 아무리 바빠도 스크롤 합성은 계속 돌아갈 수 있다.
래스터화 엔진은 Skia이고, 2026년 현재 구버전 백엔드(Ganesh) → 신버전(**Graphite**)으로 교체 중이다.
</details>

---

## 강의 파이프라인 ↔ 실제 Chromium 13단계 대조

강의의 7단계는 실제 구현에서 이렇게 펼쳐진다. ([상세](../01-landscape-2026.md#12-13단계-파이프라인))

| 강의 | Chromium RenderingNG | 실행 위치 |
|---|---|---|
| loading · parsing · DOM | (파싱) | Renderer / Main |
| style | 2 Style | Renderer / Main |
| layout | 3 Layout | Renderer / Main |
| — | 4 Pre-paint | Renderer / Main |
| paint | 6 Paint | Renderer / Main |
| — | 7 Commit | Main → Compositor |
| layer | 8 Layerize | Renderer / **Compositor** |
| composite (rasterize) | 9 Raster · 10 Activate | **Viz** / GPU |
| composite (합성·표시) | 11 Aggregate · 12 Draw | **Viz** |

강의에 안 나온 단계 둘:
- **1 Animate / 5 Scroll** — 애니메이션과 스크롤만 처리하는 지름길. style~paint를 전부 건너뛴다
- **4 Pre-paint** — transform/clip/effect/scroll을 별도 트리(property tree)로 뽑아내는 단계. 합성에서 레이어를 어떻게 변형할지가 여기서 정해진다

---

## 다음에 확인할 것

- [ ] 슬라이드 ⑤의 시각화 도구가 무엇인지 (강의에서 언급됐는지)
- [ ] 강의가 이후에 `will-change`, `transform` vs `left` 실험을 다루는지 → 다루면 [Track A](../02-experiment-tracks.md#track-a--파이프라인-계측-진입-장벽-최저-즉시-시작-가능)와 합치기
