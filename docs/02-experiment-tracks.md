# 실험 트랙 후보 (조사 결과에서 도출)

조사에서 나온 "실제로 손으로 확인 가능한" 지점만 추렸다. 한 트랙씩 진행한다.

---

## Track A — 파이프라인 계측 (진입 장벽 최저, 즉시 시작 가능)
**질문**: RenderingNG 13단계 중 내 페이지는 어디서 시간을 쓰는가?

| 실험 | 방법 | 성공 기준 |
|---|---|---|
| A1. 단계 스킵 증명 | `left` 애니메이션 vs `transform` 애니메이션 동일 씬 2개 | Perfetto 트레이스에서 layout/paint 이벤트 유무 차이 확인 |
| A2. layerization 관찰 | DevTools Layer borders + Layers 패널 | `will-change`/`transform` 유무에 따른 레이어 수·타일 변화 캡처 |
| A3. paint chunk 경계 | property state가 다른 요소들 배치 | paint flashing으로 리페인트 영역 경계 확인 |
| A4. `content-visibility` 효과 | 긴 리스트에 `content-visibility:auto` + `contain-intrinsic-size` | layout+paint 시간 절감률 측정 (기대 30~60%) |
| A5. INP ↔ LoAF | 의도적 롱태스크 + `PerformanceObserver('long-animation-frame')` | INP 악화 프레임을 LoAF로 특정 |

필요 도구: Chrome, DevTools Rendering/Performance/Layers, `chrome://tracing` → Perfetto, `chrome://gpu`
산출물: `experiments/track-a/` 아래 재현 가능한 HTML + 트레이스 + 측정표

---

## Track B — 엔진 소스 리딩 (Ladybird 중심)
**질문**: 실제 엔진에서 style → layout → paint 가 어떤 코드로 이어지는가?

- 대상: `LadybirdBrowser/ladybird` (66.2k★, C++/Rust, 읽을 수 있는 크기)
- 읽기 순서: `Libraries/LibWeb/CSS` → `LibWeb/Layout` → `LibWeb/Painting`
- 2026년 현재 **Painting(display list 기록 + hit testing)은 Rust로 이동 중** → C++/Rust 경계를 같이 보게 됨
- 대조군: 같은 개념을 Chromium(`third_party/blink/renderer/core/layout`, `cc/`)에서 찾아 비교

성공 기준: "특정 CSS 속성 하나"를 골라 파싱 → computed style → layout 영향 → display list 항목까지 코드 경로를 그림으로 그릴 수 있을 것

---

## Track C — 미니 엔진 직접 구현
**질문**: 바이트에서 픽셀까지 내가 만들 수 있는가?

두 갈래:
1. **책 따라가기** — Web Browser Engineering (browser.engineering, 소스 공개). Python, 단계별로 진짜 브라우저가 됨. 저자 중 한 명이 Blink Rendering 팀 리드
2. **Rust 모듈 조립** — `html5ever`(파싱) + `stylo`(CSS) + `taffy`(레이아웃) + `parley`(텍스트) + `vello`(GPU 페인트). 사실상 `blitz`가 이미 이 조합 → blitz를 읽고 축소 재구현

성공 기준: 임의 HTML/CSS 한 장을 창에 그리기 + `transform` 애니메이션을 별도 경로로 처리

---

## Track D — GPU 래스터화 심화
**질문**: Ganesh와 Graphite는 실제로 무엇이 다른가?

- `chrome://gpu` 로 현재 백엔드 확인 → 플래그로 전환 후 MotionMark 1.3 비교
- Graphite의 핵심 아이디어(depth buffer로 2D 오버드로 제거, Recorder/Recording 다중 스레드)를 `vello`/`wgpu`로 소규모 재현
- 참고: Graphite는 **Dawn(WebGPU) 위**에 있음 → WebGPU 학습이 곧 브라우저 내부 학습

---

## 추천 순서
```
A (1~2일, 감각 확보)
  └→ B (엔진 실물 확인)
        └→ C 또는 D (깊이 선택)
```

A를 먼저 하는 이유: 나머지 트랙을 읽을 때 "이 코드가 만드는 게 아까 본 그 트레이스구나"가 연결된다.
