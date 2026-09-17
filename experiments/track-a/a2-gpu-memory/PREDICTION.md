# 사전 등록 예측 — 130×130 판별 실험

> 측정 **전에** 작성한다. A2 본실험에서 기준을 미리 못 박지 않은 것을 교정하는 절차.
> 작성 시각: 2026-09-17, 측정 실행 전.

## 왜 이 실험이 필요한가

[A2 RESULTS](RESULTS.md)에서 "레이어 텍스처는 **2의 거듭제곱 정사각 타일**로 올림"이라는 경험칙을 세웠다.
Chromium 소스([`cc/layers/tile_size_calculator.cc`](https://chromium.googlesource.com/chromium/src/+/main/cc/layers/tile_size_calculator.cc))를 확인한 결과, 실제 규칙은 다르다:

```cpp
const int kTileRoundUp = 64;

if (content_bounds.width() < default_tile_width) {
  tile_width = MathUtil::UncheckedRoundUp(content_bounds.width(), kTileRoundUp);
  tile_width = std::min(tile_width, default_tile_width);
}
// height 도 동일
```

**64의 배수로 올림**이지 2의 거듭제곱이 아니다.

문제는 내가 고른 세 크기가 전부 두 규칙의 답이 같아지는 값이었다는 것이다:

| 크기 | 64배수 | 2ⁿ | 구분 |
|---|---|---|---|
| 38×15 | 64×64 | 64×64 | ❌ 동일 |
| 100×100 | 128×128 | 128×128 | ❌ 동일 |
| 200×200 | 256×256 | 256×256 | ❌ 동일 |

**내 실험은 두 가설을 구분할 수 없었다.** 데이터가 경험칙을 지지한 게 아니라, 단지 반박하지 못했을 뿐이다.

## 판별 조건

`130×130` 은 두 규칙이 갈린다.

| 가설 | 타일 | 레이어당 | 레이어 1000개 델타 |
|---|---|---:|---:|
| **H1 · 64의 배수 (소스 기준)** | 192×192 | **144.0 KB** | **≈ 140.6 MB** |
| H2 · 2의 거듭제곱 (내 경험칙) | 256×256 | 256.0 KB | ≈ 250.0 MB |

기준선(`none`) ≈ 48–51 MB, 노이즈 ±8 MB. 두 예측의 간격이 **109 MB** 로 노이즈의 13배 → 판별 가능.

## 소스에서 유도한 계산 과정

뷰포트 1280×900, GPU 래스터:
```
base_tile_size        = 1280 × 900
tile_height           = roundUp(900, 4) / 4 = 225        // 세로로 4장이 뷰포트를 덮는다
+ 2 × kBorderTexels(1) → 1282 × 227
roundUp(·, 32)         → 1312 × 256
min_height_for_gpu_raster_tile = 256 적용 → default_tile_size = 1312 × 256
```
그 다음 content(130×130)가 default보다 작으므로:
```
tile_width  = min(roundUp(130, 64), 1312) = min(192, 1312) = 192
tile_height = min(roundUp(130, 64),  256) = min(192,  256) = 192
→ 192 × 192 × 4 bytes = 147,456 B = 144 KB
```

## 판정 기준

- 실측 KB/레이어가 **130–160** 구간 → **H1 채택** (소스가 맞고 내 경험칙은 틀림)
- 실측 KB/레이어가 **240–270** 구간 → **H2 채택** (소스 해석을 내가 잘못한 것)
- 둘 다 아니면 → 모델 자체를 다시 세운다

## 실행

```bash
node sweep-isolated.mjs --counts=1000 --modes=none,transform --sizes=130x130 --repeat=3
```

## 결과

→ [RESULTS-source.md](RESULTS-source.md)
