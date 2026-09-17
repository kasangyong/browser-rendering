# A2 · 합성 레이어의 GPU 메모리 비용

## 질문

[A1b](../a1-pipeline-skip/RESULTS-b.md)에서 박스 1000개를 `transform` 으로 애니메이션하면 **레이어도 1000개**가 되고, 승격 거부는 일어나지 않는다는 걸 확인했다.
그러면 **레이어 하나가 GPU 메모리를 얼마나 먹는가?** 무한정 늘어나는가?

## 사전 검증 — 계측기부터 (A1 교훈 #2)

본 실험 전에 [`probe.mjs`](probe.mjs) 로 세 가지를 확인했다. 하나라도 안 되면 측정에 의미가 없다.

| | 확인 항목 | 결과 |
|---|---|---|
| P1 | GPU 가속이 실제로 켜져 있는가 (`SystemInfo.getInfo`) | ✅ `gpu_compositing: enabled`, `rasterization: enabled` |
| P2 | `Tracing.requestMemoryDump` 가 동작하는가 | ✅ `success: true` (706ms) |
| P3 | 덤프에 GPU allocator 가 있는가 | ✅ `gpu/shared_images` 55.96MB 확인 |

> 📌 **A1b에 적었던 "headless는 GPU가 없다"는 이 환경에서 틀렸다.**
> `--headless=new` 는 실제 GPU(RTX 4050 / Intel Iris Xe)로 합성·래스터한다. Skia Graphite 는 `disabled_off`(Ganesh 사용).

## 계측 설계

| 항목 | 값 |
|---|---|
| 지표 | `gpu/shared_images` (GPU 프로세스) · `gpu` 총량 · `cc/tile_memory` (렌더러) |
| 레이어 수 | `LayerTree.layerTreeDidChange` — **푸시형**이라 메인 스레드에 안 걸림 |
| 격리 | **설정 하나마다 Chrome 을 새로 띄우고 죽인다** |
| 대조군 | `none` (애니메이션 없음, 레이어 5개) |
| 안정화 | 설정 후 2,500ms 대기, 덤프 2회(2회차 사용) |

### 왜 프로세스를 격리했나

1차 시도([`sweep.mjs`](sweep.mjs))는 한 브라우저에서 설정만 바꿔가며 쟀다. **결과가 오염됐다**:
- `left` 값이 n=1000/2000/4000 에서 소수점까지 동일 (45.15 / 66.22 / 78.44)
- 레이어 6개인 `none` 이 레이어 4006개인 `transform` 보다 메모리가 많음

GPU 리소스 풀이 설정 사이에 이월된 것이다. → [`sweep-isolated.mjs`](sweep-isolated.mjs) 로 재설계.

### 워밍업 이상치

반복 측정에서 **각 그룹의 rep 0 이 일관되게 낮은 이상치**로 나온다 (예: 200 none → 22.31 / 54.31 / 47.93).
reps 1·2 는 소수점까지 재현된다 (113.04 / 113.04). → **rep 0 은 버린다.**

## 실행

```bash
cd "experiments/track-a" && python -m http.server 8765 --bind 127.0.0.1
```

```bash
node probe.mjs                                                          # 사전 검증
node sweep-isolated.mjs --counts=1000,4000 --repeat=3                   # 개수 스윕
node sweep-isolated.mjs --counts=4000 --sizes=38x15,100x100,200x200 --repeat=3   # 크기 스윕
```

원자료: `isolated-results-*.json`

## 결과

→ [RESULTS.md](RESULTS.md)
