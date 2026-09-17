# 강의 정리 — 자바스크립트와 렌더링

> 앞 장: [01-rendering-pipeline.md](01-rendering-pipeline.md)
> 구성: **내 노트** = 강의 받아적은 것 그대로 / **보강** = 조사에서 가져온 추가 설명
> 이번 파트는 슬라이드 이미지 없음 (나오면 매칭해서 추가)

---

## 이 파트의 한 줄 요약

앞 장은 "브라우저가 어떻게 그리는가"였고, 이 파트는 **"내 JS가 그 과정을 어떻게 방해하는가"** 다.
파이프라인은 메인 스레드에서 돈다. JS도 메인 스레드에서 돈다. **둘은 같은 자리를 두고 경쟁한다.**

---

## 0. 전제 — 프레임 예산

모든 항목의 근거가 여기서 나온다.

| 주사율 | 프레임 간격 | 현실적 JS 예산 |
|---|---|---|
| 60Hz | 16.7ms | **~5ms** |
| 120Hz | 8.3ms | **~3ms** |

간격 전체를 쓰면 안 된다. 그 안에서 브라우저가 style → layout → paint → commit 까지 해야 하기 때문이다.
노트의 **"프레임당 5ms씩"** 이 바로 이 숫자다. 임의로 고른 값이 아니라 16.7ms에서 브라우저 몫을 빼고 남은 양.

---

## 1. 즉시 렌더 vs 양보 렌더

> **내 노트**
> 즉시 렌더 vs 양보 렌더 -> fps 좋아짐?

### 두 방식의 차이

```
[즉시 렌더]  작업 200ms 통째로 실행 ────────────────────▶ 렌더 1번
             그동안 프레임 0개. 화면 멈춤.

[양보 렌더]  5ms ▶렌더 5ms ▶렌더 5ms ▶렌더 ... (40회)
             프레임이 계속 나옴.
```

메인 스레드는 한 번에 하나만 한다. JS가 200ms 동안 놓아주지 않으면 브라우저는 그리고 싶어도 못 그린다.
**양보(yield)** = 작업을 끊고 메인 스레드를 브라우저에게 잠깐 돌려주는 것.

### 노트의 물음표에 대한 답 — "fps 좋아짐?"

**좋아진다. 단, 공짜는 아니다.**

| | 즉시 렌더 | 양보 렌더 |
|---|---|---|
| 총 작업 완료 시간 | **짧음** | 조금 **늘어남** (양보 오버헤드) |
| 그 사이 프레임 수 | 0 | 계속 나옴 |
| 체감 | 멈춤 → 한 번에 툭 | 부드럽게 진행 |
| 입력 반응 | 200ms 동안 무반응 | 즉시 반응 |

정확히 말하면 **처리량(throughput)을 조금 내주고 반응성(responsiveness)을 크게 산다.**
"일을 더 빨리 끝내기"가 목적이 아니라 **"일하는 동안에도 화면이 살아있게 하기"** 가 목적이다.

> 주의할 함정: 양보를 너무 잘게 하면(예: 항목마다 1개씩) 오버헤드가 커져서 총 시간이 몇 배로 늘 수 있다.
> 그래서 "N개마다"가 아니라 **"시간 기준(5ms)"** 으로 끊는다. → 2번 항목

<details>
<summary><b>보강</b> — 실제로 양보하는 방법 (2026년 기준)</summary>

```js
function yieldToMain() {
  // 1순위: scheduler.yield() — 양보 후 큐 앞쪽으로 복귀
  if (globalThis.scheduler?.yield) return scheduler.yield();
  // 폴백: setTimeout — 양보 후 큐 뒤로 밀림
  return new Promise(resolve => setTimeout(resolve, 0));
}
```

**`scheduler.yield()` 가 `setTimeout(0)` 보다 나은 이유**: `setTimeout`으로 양보하면 내 작업이 태스크 큐 **맨 뒤**로 간다. 그 사이 다른 태스크가 끼어들면 내 작업은 계속 밀린다. `scheduler.yield()`는 양보하되 **우선순위를 유지**해서 앞쪽으로 돌아온다.

**지원 현황 (2026-09)**

| 브라우저 | `scheduler.yield()` |
|---|---|
| Chrome / Edge | ✅ |
| Firefox | ✅ (2025-08~) |
| Safari | ❌ |

→ **Baseline 아님.** 폴백 필수.

관련 API:
- `scheduler.postTask({ priority })` — `user-blocking` / `user-visible` / `background` 우선순위 지정. 지원 현황 동일(Safari ❌)
- `requestIdleCallback()` — 한가할 때만 실행. 급하지 않은 작업용
</details>

<details>
<summary><b>보강</b> — 이 이야기가 곧 INP다</summary>

조사 문서에서 본 **INP(Interaction to Next Paint)** 가 정확히 이 문제를 재는 지표다. "사용자가 누른 순간부터 **화면이 실제로 바뀔 때까지**".
즉시 렌더 방식이면 200ms 작업 내내 INP가 그만큼 나빠진다. 2026년 기준 사이트의 43%가 INP 200ms 기준을 못 넘긴다.

원인 추적에는 **LoAF(Long Animation Frames API)** 를 쓴다. "어느 프레임이 길었고, 그 안에서 누가 시간을 썼는지"를 알려준다.

```js
new PerformanceObserver(list => {
  for (const frame of list.getEntries()) {
    console.log(frame.duration, frame.scripts);
  }
}).observe({ type: 'long-animation-frame', buffered: true });
```
→ [조사 문서 5절](../01-landscape-2026.md#5-계측--디버깅)
</details>

---

## 2. 시간 분할 — 프레임당 5ms씩

> **내 노트**
> 마우스의 움직임에 따라 파티클의 움직임을 다 계산해야됨 -> 통째로 계산 x 프레임당 5ms 씩

파티클 10,000개를 한 번에 계산하면 그 프레임은 죽는다. **예산만큼만 하고 끊는다.**

```js
const BUDGET = 5; // ms

async function updateParticles(particles) {
  let start = performance.now();

  for (const p of particles) {
    step(p);

    // 개수가 아니라 '시간'으로 끊는다
    if (performance.now() - start > BUDGET) {
      await yieldToMain();
      start = performance.now();
    }
  }
}
```

**왜 개수가 아니라 시간 기준인가**: 파티클 하나당 비용은 기기마다 다르다. "100개마다 양보"는 빠른 PC에선 과하고 느린 폰에선 부족하다. 시간으로 끊으면 기기에 알아서 맞춰진다.

<details>
<summary><b>보강</b> — 시간 분할이 항상 답은 아니다</summary>

분할은 **결과가 조금 늦게 나와도 되는 작업**에만 쓴다.
파티클처럼 "매 프레임 최신 상태여야 하는" 것이라면 분할 대신 **일의 양 자체를 줄이는** 쪽이 맞을 때가 많다:

- 화면 밖 파티클은 계산에서 제외 (culling)
- 계산 정밀도를 낮춤 (매 프레임 → 2프레임마다)
- 아예 **워커/GPU로 옮김** → 4번 항목

분할은 "메인 스레드에서 해야만 하는데 양이 많을 때"의 대응책이다.
</details>

---

## 3. 프레임에 맞춰 한 번만 반영

> **내 노트**
> 시세 업데이트될 때마다 그리지 말고 프레임에 맞춰 한번만 반영

### 문제

WebSocket 시세가 초당 300번 온다. 화면은 초당 60번밖에 안 바뀐다.
→ **240번은 그려도 아무도 못 본다.** 순수 낭비.

### 패턴 — 최신값만 들고 있다가 프레임에 한 번

```js
let latest = null;
let scheduled = false;

socket.onmessage = (e) => {
  latest = JSON.parse(e.data);   // 항상 최신값으로 덮어쓰기만

  if (scheduled) return;         // 이미 예약돼 있으면 아무것도 안 함
  scheduled = true;

  requestAnimationFrame(() => {
    scheduled = false;
    render(latest);              // 프레임당 딱 한 번
  });
};
```

핵심은 두 줄이다:
- `latest = ...` — 데이터 수신과 렌더를 **분리**. 받는 건 300번, 그리는 건 60번
- `if (scheduled) return` — 중복 예약 차단 (**coalescing**)

### 왜 `requestAnimationFrame`인가

`rAF` 콜백은 **브라우저가 다음 프레임을 그리기 직전**에 실행된다. 앞 장의 파이프라인으로 보면 style 단계 바로 앞이다.
그래서 여기서 DOM을 바꾸면 **그 변경이 바로 이번 프레임에 반영**된다. 낭비도 없고 지연도 없다.

`setInterval(render, 16)`과 다른 점: `setInterval`은 프레임과 어긋나서 어떤 프레임엔 두 번, 어떤 프레임엔 0번 그린다. 탭이 백그라운드로 가도 계속 돈다. `rAF`는 프레임과 정렬되고 백그라운드에선 자동으로 멈춘다.

<details>
<summary><b>보강</b> — 같은 패턴이 쓰이는 곳</summary>

이 "최신값 보관 + rAF 한 번"은 고빈도 이벤트 전반에 그대로 쓴다:

| 상황 | 이벤트 발생 빈도 |
|---|---|
| WebSocket 시세 | 초당 수백 |
| `mousemove` / `pointermove` | 초당 60~1000 (고주사율 마우스) |
| `scroll` | 스크롤 중 계속 |
| `resize` | 드래그 중 계속 |

`scroll`/`resize`에 무거운 핸들러를 직접 붙이면 안 되는 이유가 이것.
React 쓴다면 이건 프레임워크가 배칭으로 어느 정도 해주지만, **캔버스 직접 그리기나 DOM 직접 조작**에는 여전히 직접 해야 한다.
</details>

---

## 4. 무거운 작업은 워커로

> **내 노트**
> 무거운 작업은 워커로

### 앞의 셋과 급이 다른 해법

1~3번은 전부 **"메인 스레드를 어떻게 잘 나눠 쓸까"** 였다. 워커는 **"아예 다른 스레드로 옮긴다"** 다.
메인 스레드를 1ms도 안 쓰므로, 워커가 아무리 오래 걸려도 화면은 멈추지 않는다.

```js
// main.js
const worker = new Worker('calc.js');
worker.postMessage({ particles });
worker.onmessage = (e) => { latest = e.data; };  // 받아서 rAF로 그리기

// calc.js
onmessage = (e) => {
  const result = heavyCalculation(e.data.particles);  // 200ms 걸려도 OK
  postMessage(result);
};
```

### 워커의 제약

워커에는 **DOM이 없다.** `document`, `window`에 접근 못 한다.
→ 워커는 **계산**을 하고, 메인 스레드는 그 결과를 **그리기만** 한다. 이 분업이 기본형이다.

<details>
<summary><b>보강</b> — 데이터 전달 비용과 OffscreenCanvas</summary>

**① 전달 비용을 조심할 것**

`postMessage`는 기본적으로 데이터를 **복사**한다(structured clone). 큰 배열을 매 프레임 주고받으면 복사 비용이 이득을 까먹는다.
해결: `ArrayBuffer`를 **이전(transfer)** 하면 복사 없이 소유권만 넘어간다.

```js
worker.postMessage(buffer, [buffer]);  // 두 번째 인자 = transfer list
```
이전된 buffer는 보낸 쪽에서 더 이상 못 쓴다(길이 0). 그게 복사를 안 한다는 증거.

**② OffscreenCanvas — 그리기까지 워커로**

캔버스라면 "계산만 워커"가 아니라 **그리기 자체를 워커로** 보낼 수 있다.

```js
// main.js
const offscreen = canvas.transferControlToOffscreen();
worker.postMessage({ canvas: offscreen }, [offscreen]);

// worker.js
onmessage = (e) => {
  const ctx = e.data.canvas.getContext('2d');
  // 워커 안에서 rAF까지 돌릴 수 있다
};
```

지원: **2023-03부터 widely available**(Baseline). 전역 지원률 약 95%. → 파티클 같은 캔버스 작업엔 지금 바로 써도 되는 선택지.

**③ 워커로 못 넘기는 것**

DOM 조작 자체는 메인 스레드에만 있다. 그래서 "DOM 노드가 10,000개라 느리다"는 워커로 해결 안 된다.
그건 [앞 장](01-rendering-pipeline.md)의 layout/paint 문제고, `content-visibility`나 가상 스크롤로 푸는 영역이다.
</details>

---

## 정리 — 네 가지 대응의 관계

| 상황 | 대응 | 성격 |
|---|---|---|
| 긴 작업이 프레임을 막음 | **양보 렌더** | 메인 스레드를 나눠 씀 |
| 계산량이 프레임 예산 초과 | **시간 분할 (5ms)** | 위의 구체적 실행법 |
| 이벤트가 프레임보다 자주 옴 | **rAF coalescing** | 낭비 제거 |
| 작업 자체가 무거움 | **워커** | 메인 스레드에서 탈출 |

선택 순서: **워커로 옮길 수 있으면 워커** → 못 옮기면 시간 분할 + 양보 → 입력이 잦으면 rAF로 묶기.

---

## 아직 안 나온 것 (나올 법한 것)

- **강제 동기 레이아웃 / layout thrashing** — `offsetHeight` 같은 걸 읽으면 브라우저가 레이아웃을 즉시 계산해야 한다. 읽기/쓰기를 번갈아 하면 매번 레이아웃이 다시 돈다. JS ↔ 렌더링 상호작용의 대표 함정
- `will-change` / `transform` vs `left` 실험
- 가상 스크롤, `content-visibility`

→ 강의에서 나오면 이어서 정리. 안 나오면 [Track A](../02-experiment-tracks.md) 실험으로 직접 확인.
