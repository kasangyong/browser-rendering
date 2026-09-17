# A2 보강 — Chromium 소스로 검증

측정일 2026-09-17 · 사전 등록 예측: [PREDICTION.md](PREDICTION.md) · 원자료 `isolated-results-130.json`
소스: Chromium `main` 브랜치, 2026-09-17 시점

---

## 결론 먼저

**[RESULTS.md](RESULTS.md)의 "2의 거듭제곱 정사각 타일" 경험칙은 틀렸다.**

실제 규칙은 **64의 배수로 올림**이다. 내가 고른 세 크기(38×15, 100×100, 200×200)가 하필 두 규칙의 답이 일치하는 값이라 **실험이 두 가설을 구분하지 못했다.** 데이터가 경험칙을 지지한 게 아니라, 반박할 능력이 없었을 뿐이다.

그리고 관측한 ~500MB 상한은 소스의 **`kDefaultMemoryMB = 512`** 였다.

---

## 1. 타일 크기 — `cc/layers/tile_size_calculator.cc`

```cpp
// When making odd-sized tiles, round them up to increase the chances
// of using the same tile size.
const int kTileRoundUp = 64;

// For performance reasons and to support compressed tile textures, tile
// width and height should be an even multiple of 4 in size.
const int kTileMinimalAlignment = 4;
```

```cpp
// Clamp the tile width/height to the content width/height to save space.
if (content_bounds.width() < default_tile_width) {
  tile_width = MathUtil::UncheckedRoundUp(content_bounds.width(), kTileRoundUp);
  tile_width = std::min(tile_width, default_tile_width);
}
if (content_bounds.height() < default_tile_height) {
  tile_height = MathUtil::UncheckedRoundUp(content_bounds.height(), kTileRoundUp);
  tile_height = std::min(tile_height, default_tile_height);
}
```

**규칙**: `타일 = min(roundUp(콘텐츠 크기, 64), default_tile_size)`

### `default_tile_size` 는 어디서 오나 (GPU 래스터)

CPU 래스터는 설정값(데스크톱 256×256)을 쓰지만, **GPU 래스터는 뷰포트에서 계산한다.**

```cpp
// For GPU rasterization, we pick an ideal tile size using the viewport so we
// don't need any settings. The current approach uses 4 tiles to cover the
// viewport vertically.
int tile_height = MathUtil::UncheckedRoundUp(base_tile_size.height(), divisor) / divisor;
```
```cpp
// Grow default sizes to account for overlapping border texels.
tile_width  += 2 * PictureLayerTiling::kBorderTexels;   // kBorderTexels = 1
tile_height += 2 * PictureLayerTiling::kBorderTexels;
// Round GPU default tile sizes to a multiple of 32.
tile_width  = MathUtil::UncheckedRoundUp(tile_width,  kGpuDefaultTileRoundUp);  // 32
tile_height = MathUtil::UncheckedRoundUp(tile_height, kGpuDefaultTileRoundUp);
tile_height = std::max(tile_height, min_height_for_gpu_raster_tile);            // 256
```

내 측정 환경(뷰포트 1280×900, dsf 1.0)에 대입하면:

```
base          = 1280 × 900
세로 4등분     → 1280 × 225
+2 border     → 1282 × 227
roundUp(32)   → 1312 × 256
min_height 256 적용 → default_tile_size = 1312 × 256
```

---

## 2. 판별 실험 — 130×130

세 크기가 왜 쓸모없었는지:

| 크기 | 64배수 규칙 | 2ⁿ 규칙 | 구분 |
|---|---|---|---|
| 38×15 | 64×64 = 16 KB | 64×64 = 16 KB | ❌ |
| 100×100 | 128×128 = 64 KB | 128×128 = 64 KB | ❌ |
| 200×200 | 256×256 = 256 KB | 256×256 = 256 KB | ❌ |
| **130×130** | **192×192 = 144 KB** | 256×256 = 256 KB | ✅ |

`130×130`, 레이어 1000개, 3회 반복:

| 모드 | `gpu/shared_images` |
|---|---|
| `none` | 49.03 / 49.29 / 49.82 → 평균 **49.38MB** |
| `transform` | 189.65 / 185.93 / 183.54 → 평균 **186.37MB** |

```
델타 = 186.37 − 49.38 = 136.99 MB / 1000 레이어 = 140.3 KB/레이어
```

| 가설 | 예측 | 실측 대비 |
|---|---:|---:|
| **H1 · 64의 배수 (192×192)** | 144.0 KB | **97.4%** ✅ |
| H2 · 2의 거듭제곱 (256×256) | 256.0 KB | 54.8% ❌ |

사전 등록한 판정 기준(130–160 → H1)에 들어온다. **H1 채택.**

### 기존 측정은 여전히 유효하다

세 크기 모두 두 규칙의 답이 같으므로, [RESULTS.md](RESULTS.md)의 실측값(15.4 / 64.5 / 250~254 KB)은 **정정된 규칙으로도 그대로 설명된다.** 틀린 건 숫자가 아니라 내가 붙인 **이름**이다.

---

## 3. 500MB 상한 — `third_party/blink/.../layer_tree_settings.cc`

```cpp
static constexpr size_t kLargeResolutionMemoryMB = 1152;
static constexpr size_t kDefaultMemoryMB = 512;

constexpr size_t kLargeResolution = 2056 * 1329 * 2 * 2;
size_t display_size = round(screen_w * dsf * screen_h * dsf);
size_t mb_limit_when_visible = kLargeResolutionMemoryMB * (display_size * 1.0 / kLargeResolution);

// Cap the memory size to one fourth of the total system memory ...
size_t memory_cap_mb = AmountOfTotalPhysicalMemory().InMiB() / 4;
if (mb_limit_when_visible > memory_cap_mb)      mb_limit_when_visible = memory_cap_mb;
else if (mb_limit_when_visible < kDefaultMemoryMB) mb_limit_when_visible = kDefaultMemoryMB;

actual.bytes_limit_when_visible = mb_limit_when_visible * 1024 * 1024;
```

작은 화면에서는 비례식 결과가 512MB를 밑돌아 **하한 `kDefaultMemoryMB = 512MB`로 올라간다.**
실측 상한(델타 ≈ 501MB)과 일치한다.

**플랫폼별 타일 메모리 예산**

| 플랫폼 | 예산 |
|---|---|
| 데스크톱 (작은~보통 화면) | **512 MB** (하한) |
| 데스크톱 (고해상도) | 비례 증가, 최대 1152MB 기준 · 시스템 메모리의 1/4로 캡 |
| Android 일반 | **256 MB** |
| Android 저사양 (< 2GB RAM) | **96 MB** |

> [RESULTS.md §5](RESULTS.md#5-실무로-옮기면)에서 "모바일은 훨씬 낮다"고 추측했는데, **정확히는 데스크톱의 1/2 (256MB), 저사양은 1/5 (96MB)** 다.

---

## 4. 정정 사항 정리

| 위치 | 기존 서술 | 정정 |
|---|---|---|
| [RESULTS.md](RESULTS.md) 결론 | "2의 거듭제곱 정사각 타일로 올림" | **"64의 배수로 올림"** (`kTileRoundUp = 64`) |
| RESULTS.md | "최소 64×64" | 맞다. 단 이유는 2ⁿ이 아니라 64배수 올림의 결과 |
| RESULTS.md §7 | "소스에서 확인하지 않았다" | 확인 완료 — 경험칙이 틀렸음 |
| RESULTS.md §5 | "모바일은 훨씬 낮다" | Android 256MB / 저사양 96MB |

실측 수치와 실무 함의(작은 레이어일수록 낭비가 크다, 상한에 닿으면 조용히 나빠진다)는 그대로다.

---

## 5. 자가 평가

**통과**

- 소스 확인이 **경험칙을 반증**했다. 데이터만 봤으면 계속 틀린 이름을 붙이고 있었을 것이다
- 더 중요한 건 **왜 틀렸는지**다 — 세 표본이 전부 두 가설의 답이 같은 지점이었다. *"데이터가 가설을 지지한다"와 "데이터가 가설을 반박하지 못한다"는 다르다.* A2 본문에서 "101% 적중"이라고 자신 있게 썼던 게 실은 판별력 없는 표본이었다
- **이번엔 측정 전에 예측을 파일로 등록했다** ([PREDICTION.md](PREDICTION.md)). A2에서 못 지킨 교훈 #3을 교정한 것
- 다음에 크기 의존 규칙을 잴 때는 **후보 가설들이 갈리는 표본을 먼저 고른다**
