// type-only: appearance.ts 가 이 파일을 값으로 import 하므로, 되돌아오는 이 한 줄은 반드시
// `import type` 이어야 한다(런타임에 소거되어 순환이 컴파일 단계에만 존재한다 — stores/settings.ts
// ↔ lib/aiCapabilities.ts 가 쓰는 것과 같은 수법).
import type { Theme } from "./appearance";

/**
 * 강조색 팔레트 — **OKLCH 로 계산하고 sRGB hex 로 내보낸다** (PLAN-2026-09-12 §4 / D4).
 *
 * 축이 셋인데 사용자에게 여는 건 둘이다:
 *   H(색상) = hue 슬라이더 · C(채도) = 5칩 사다리 · **L(명도) = 테마별 고정 상수**.
 * L 을 열지 않는 이유는 배경이 테마마다 다르기 때문이다 — 다크 #171b1a 위에서 읽히는 L 과
 * 라이트 #f4efe3 위에서 읽히는 L 이 애초에 다르고, 사용자가 L 을 고르면 테마를 바꾸는 순간
 * 강조색이 배경에 먹히거나 눈을 찌른다.
 *
 * **왜 HSL 이 아니라 OKLCH 인가**: HSL 은 같은 L 값에서도 노랑이 파랑보다 훨씬 밝아 보인다.
 * hue 슬라이더를 돌리면 강조색의 시각 무게가 출렁인다는 뜻이다. OKLCH 는 지각 균등이라
 * hue 를 돌려도 무게가 유지된다.
 *
 * **브라우저 `oklch()` 를 그대로 쓰지 않는 이유**: 저장 값이 계속 hex 여야 한다. Rust
 * `settings_schema.rs::validate_setting` 의 `accent` arm 은 `is_hex_color` 이고, 백엔드는 이
 * 웨이브에서 손대지 않는다. 그래서 변환을 여기서 직접 한다(외부 의존성 추가 금지).
 *
 * 이 파일은 `check:colors`(PLAN §7) 관점에서 **토큰의 출처**다 — appearance.ts 의 CANVAS_BASE 와
 * 같은 부류로, 여기 있는 hex 는 테마 상수 그 자체이지 "어딘가에 박아 둔 색"이 아니다.
 */

// ── sRGB ↔ OKLab ────────────────────────────────────────────────────────────
// 행렬은 Björn Ottosson 의 원본 OKLab 정의 그대로다. 상수를 줄이거나 반올림하지 마라 —
// 왕복(hex→OKLCH→hex)이 1 단위라도 어긋나면 저장된 강조색이 매 렌더마다 조금씩 흐른다.

const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
const linearToSrgb = (c: number): number =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

export interface Oklch {
  /** 명도 0~1 */
  L: number;
  /** 채도(0 = 무채) */
  C: number;
  /** 색상 0~360° */
  H: number;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function oklabFromRgb([r, g, b]: [number, number, number]): [number, number, number] {
  const R = srgbToLinear(r);
  const G = srgbToLinear(g);
  const B = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab → **클램프하지 않은** sRGB(0~1 밖으로 나갈 수 있다 — 색역 판정에 그 값이 필요하다). */
function rgbFromOklab(L: number, A: number, B: number): [number, number, number] {
  const l_ = L + 0.3963377774 * A + 0.2158037573 * B;
  const m_ = L - 0.1055613458 * A - 0.0638541728 * B;
  const s_ = L - 0.0894841775 * A - 1.291485548 * B;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function lchToRgb(L: number, C: number, H: number): [number, number, number] {
  const h = (H * Math.PI) / 180;
  return rgbFromOklab(L, C * Math.cos(h), C * Math.sin(h));
}

// 반올림 한 단위(1/255 ≈ 0.0039)보다 작은 여유 — 이게 없으면 경계에 정확히 앉은 색이
// "색역 밖"으로 판정돼 쓸데없이 채도가 깎인다.
const GAMUT_EPS = 1e-4;
const inGamut = (rgb: [number, number, number]): boolean =>
  rgb.every((c) => c >= -GAMUT_EPS && c <= 1 + GAMUT_EPS);

/**
 * 주어진 L·H 에서 sRGB 안에 남는 **최대 채도**. 이분 탐색 — OKLCH 색역 경계는 닫힌 식이 없고,
 * 40 회면 1e-12 까지 좁혀지므로 반올림 오차보다 훨씬 정밀하다.
 *
 * 왜 필요한가: 클램프를 하지 않으면 채도가 높은 칩들이 sRGB 경계에서 **같은 색으로 클리핑되어**
 * "선명"과 "강렬"이 구분되지 않는다(사다리가 4단으로 보인다).
 */
export function maxChromaFor(L: number, H: number): number {
  let lo = 0;
  let hi = 0.4; // OKLCH 에서 sRGB 가 낼 수 있는 최대 채도(≈0.32)보다 넉넉한 상한
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (inGamut(lchToRgb(L, mid, H))) lo = mid;
    else hi = mid;
  }
  return lo;
}

const hx = (v: number): string =>
  Math.min(255, Math.max(0, Math.round(v * 255)))
    .toString(16)
    .padStart(2, "0");

/** OKLCH → `#rrggbb`. 색역 밖이면 **채도만 줄여** 안쪽으로 끌어온다(L·H 는 지킨다). */
export function oklchToHex({ L, C, H }: Oklch): string {
  const hue = ((H % 360) + 360) % 360;
  const chroma = C > 0 && !inGamut(lchToRgb(L, C, hue)) ? maxChromaFor(L, hue) : Math.max(0, C);
  const [r, g, b] = lchToRgb(L, chroma, hue);
  return `#${hx(r)}${hx(g)}${hx(b)}`;
}

/** `#rrggbb` → OKLCH. 무채색(C≈0)에서는 H 가 의미를 잃고 0 이 나온다 — 호출부가 다뤄야 한다. */
export function hexToOklch(hex: string): Oklch {
  const [L, A, B] = oklabFromRgb(hexToRgb(normalizeHex(hex)));
  let H = (Math.atan2(B, A) * 180) / Math.PI;
  if (H < 0) H += 360;
  return { L, C: Math.hypot(A, B), H };
}

// ── 강조색 계약 ──────────────────────────────────────────────────────────────

/** 기본 청자색. 초기화(↺)가 되돌리는 값이고, 시드·백엔드 기본값과 **글자 하나까지** 같아야 한다. */
export const DEFAULT_ACCENT = "#9cc5a4";

/**
 * 테마별 고정 명도(§4). 두 값은 임의로 고른 숫자가 아니라 **지금까지 쓰던 두 기본 강조색의
 * 실측 L** 이다 — 다크는 `#9cc5a4`, 라이트는 tokens.css 의 `:root[data-theme='light']`
 * `--accent:#7da98c`. 그래서 기본값 사용자는 이 웨이브 전후로 1px 도 달라지지 않는다.
 *
 * (이전에는 `applyCssVars` 가 저장 hex 를 그대로 `--accent` 에 인라인으로 박아서, 라이트 테마의
 *  `--accent:#7da98c` 규칙이 **항상 가려진 죽은 값**이었다. L 을 테마 상수로 만들면서 그 규칙의
 *  원래 의도가 되살아난다 — 같은 색상·채도를 라이트에서는 한 단 짙게 그린다.)
 */
export const ACCENT_L: Record<Theme, number> = {
  dark: 0.7847,
  light: 0.6947,
};

/**
 * 채도 사다리 5단 — 무채 · 옅음 · 중간 · 선명 · 강렬.
 * 가운데(0.064)가 기본 청자색의 실측 채도라, 기본값이 사다리 한가운데에 정확히 앉는다.
 * 마지막 단(0.145)은 hue 에 따라 색역 밖으로 나가 클램프된다(그게 의도다 — 각 hue 가 낼 수
 * 있는 가장 진한 색이 "강렬"이다). 그 아래 단(0.10)은 어떤 hue 에서도 클램프되지 않으므로
 * 두 칩이 같은 색으로 붙는 일이 없다.
 */
export const ACCENT_CHROMA_STEPS: readonly number[] = [0, 0.03, 0.064, 0.1, 0.145];

/** 무채 단의 인덱스 — 이 단에서는 hue 가 결과에 영향을 주지 않는다(UI 가 hue 칩을 죽인다). */
export const ACCENT_NEUTRAL_STEP = 0;

/** 기본 강조색의 색상각. 저장값이 무채색이라 hue 를 잃었을 때의 복귀점이다. */
export const DEFAULT_ACCENT_HUE = hexToOklch(DEFAULT_ACCENT).H;

const HEX_RE = /^#[0-9a-f]{6}$/;

function normalizeHex(hex: string): string {
  const v = hex.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(v)) {
    return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  }
  return v;
}

/**
 * 저장된 강조색이 쓸 수 있는 값인가. **옛 `VALID_ACCENTS` 화이트리스트 5개를 대신한다** —
 * hue 슬라이더가 열린 뒤로 값 공간이 연속이라 열거가 불가능하다. 백엔드
 * `settings_schema.rs::validate_setting` 의 `accent` arm(`is_hex_color`)과 같은 판정이다.
 */
export function isAccentHex(v: unknown): v is string {
  return typeof v === "string" && HEX_RE.test(normalizeHex(v));
}

/** 한 칸의 색 — (hue, 채도, 테마) → hex. L 은 테마가 정한다. */
export function accentHex(hue: number, chroma: number, theme: Theme): string {
  return oklchToHex({ L: ACCENT_L[theme], C: chroma, H: hue });
}

/** 한 hue 의 5칩. UI 가 그리는 사다리와 **같은 함수**여야 한다(두 벌이면 반드시 드리프트한다). */
export function accentPalette(hue: number, theme: Theme): string[] {
  return ACCENT_CHROMA_STEPS.map((c) => accentHex(hue, c, theme));
}

/** 저장된 강조색의 색상각. 무채색이면 hue 가 남지 않으므로 기본 색상각으로 돌아간다. */
export function accentHueOf(hex: string): number {
  const { C, H } = hexToOklch(hex);
  return C < 0.002 ? DEFAULT_ACCENT_HUE : H;
}

/**
 * 저장된 강조색이 사다리의 몇 번째 칸인가(칩 선택 표시용). 저장값은 hex 하나뿐이라 "몇 번째
 * 칩을 눌렀는지"가 남지 않는다 — 채도로 되짚는다. 색역 클램프 때문에 칩의 **실효 채도**가
 * 사다리 값보다 작을 수 있으므로, 비교 대상도 같은 클램프를 거친 값이어야 한다.
 */
export function accentStepOf(hex: string): number {
  const { L, C, H } = hexToOklch(hex);
  const ceiling = maxChromaFor(L, H);
  let best = 0;
  let bestGap = Infinity;
  ACCENT_CHROMA_STEPS.forEach((step, i) => {
    const gap = Math.abs(C - Math.min(step, ceiling));
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  });
  return best;
}

/**
 * 저장 hex 를 **현재 테마의 L 로 다시 그린** 실제 `--accent` 값. 색상·채도는 사용자 것이고
 * 명도는 앱 것이라는 §4 의 분업이 여기서 실행된다 — 테마를 바꾸면 같은 색이 그 배경에서
 * 읽히는 밝기로 옮겨간다.
 */
export function renderAccent(hex: string, theme: Theme): string {
  if (!isAccentHex(hex)) return renderAccent(DEFAULT_ACCENT, theme);
  const { C, H } = hexToOklch(hex);
  return oklchToHex({ L: ACCENT_L[theme], C, H });
}

/** WCAG 2.1 상대 휘도. `--on-accent` 선택이 감이 아니라 숫자에서 나오게 하는 재료다. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(normalizeHex(hex)).map(srgbToLinear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 대비비(1~21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

// 잉크 두 후보의 명도. 강조색의 색상을 아주 옅게만 섞어(채도 상한) 순검정/순백의 차가움을
// 피하면서도 대비는 잃지 않는다 — 예전 고정 토큰 `--on-accent:#06211f`(L≈0.227)와 같은 자리다.
const INK_DARK_L = 0.21;
const INK_DARK_C = 0.03;
const INK_LIGHT_L = 0.98;
const INK_LIGHT_C = 0.02;

/**
 * 강조색 위에 얹을 글자색(`--on-accent`). **표가 아니라 고른 색에서 계산한다**(§4).
 *
 * 임계 명도를 손으로 정하지 않고 두 후보(어두운 잉크 / 밝은 잉크)의 **WCAG 대비비를 실제로
 * 재서 큰 쪽**을 고른다. 임계값을 박아 두면 ACCENT_L 을 나중에 조정했을 때 조용히 틀리지만,
 * 재서 고르면 저절로 따라온다.
 *
 * ponytail: L 이 0.55~0.62 구간에 들어오면 두 후보 **모두** 4.5:1 에 못 미친다(중간 명도 배경의
 * 원리적 한계). 지금 ACCENT_L(0.78/0.69)은 그 구간 밖이고 최악 대비가 6.09:1 이라 여유가 있다 —
 * L 상수를 그 구간으로 내리게 되면 잉크 L 도 함께 벌려야 한다.
 */
export function onAccentFor(accentHex: string): string {
  const { C, H } = hexToOklch(normalizeHex(accentHex));
  const dark = oklchToHex({ L: INK_DARK_L, C: Math.min(C, INK_DARK_C), H });
  const light = oklchToHex({ L: INK_LIGHT_L, C: Math.min(C, INK_LIGHT_C), H });
  return contrastRatio(accentHex, dark) >= contrastRatio(accentHex, light) ? dark : light;
}

// ── 배경 위 글자색 · 배경 채도 (PLAN-2026-09-12 §5/E6, §3/E3) ─────────────────
//
// 아래 셋은 강조색과 무관한 **일반 색 계산**이지만 이 파일에 둔다: OKLCH↔sRGB 변환과 WCAG
// 대비비가 전부 여기 있고, 두 번째 사본을 만드는 순간 반드시 드리프트한다(위 accentPalette /
// UI 사다리가 한 함수를 공유하는 것과 같은 이유). 소비처는 lib/appearance.ts::applyCssVars 다.

/**
 * 두 색을 sRGB 에서 채널 선형보간 — `color-mix(in srgb, over t%, base)` 와 **같은 식**이고,
 * 알파 `t` 합성(over 를 base 위에 올림)과도 같은 식이다. 감마 공간 보간이라 CSS 쪽 계산과
 * 결과가 일치한다(appearance.ts::tintCanvas 가 흰/검정에 대해 하는 것의 일반형).
 */
export function mixHex(base: string, over: string, t: number): string {
  const a = hexToRgb(normalizeHex(base));
  const b = hexToRgb(normalizeHex(over));
  const k = Math.min(1, Math.max(0, t));
  return `#${hx(a[0] * (1 - k) + b[0] * k)}${hx(a[1] * (1 - k) + b[1] * k)}${hx(a[2] * (1 - k) + b[2] * k)}`;
}

/**
 * 배경 `bg` 위에서 목표 대비비 `target` 을 만족하는 **가장 가까운 명도 L**. 색상·채도(ink)는
 * 지키고 L 만 움직인다 — 글자가 회색으로 변색되면 안 되기 때문이다.
 *
 * `onAccentFor` 의 "후보 둘 중 대비 높은 쪽" 방식이 **여기서는 안 통한다**: 그 함수 주석이
 * 이미 적었듯 L 0.55~0.62 배경에서는 두 후보 모두 4.5:1 에 못 미치고, 라이트 테마에서 배경
 * 밝기를 내린 캔버스(L≈0.52)가 정확히 그 구간이다. 그래서 후보를 고르는 대신 **푼다**.
 *
 * 이분탐색이 성립하는 이유: 대비비는 `bg` 의 L 에서 최소(=1)이고 거기서 멀어질수록 단조
 * 증가한다. 그래서 [bg 의 L, endpoint] 구간에서 "목표 이상인가"는 단조 술어다.
 * `endpoint` 는 잉크가 갈 수 있는 끝(밝은 잉크면 위쪽, 어두운 잉크면 아래쪽)이고, 거기서도
 * 목표에 못 미치면 **그 끝을 그대로 돌려준다** — 낼 수 있는 최대 대비다(골격은 maxChromaFor).
 * `alpha` 는 잉크를 **반투명으로 얹었을 때**를 푼다(기본 1 = 불투명). `--muted` 가 상한 알파에서
 * 목표를 만족하도록 `--text` 의 L 을 미리 밀어 두는 데 쓴다 — 그걸 안 하면 `--text` 를 목표에 딱
 * 붙여 푼 뒤 `--muted` 가 같은 바탕·같은 목표를 요구받아 해가 알파 1.0 뿐이 되고, 본문과 보조가
 * 픽셀 단위로 같은 색이 된다(2026-09-12 실측).
 */
export function lightnessForContrast(
  bg: string,
  ink: { C: number; H: number },
  target: number,
  endpoint: number,
  alpha = 1,
): number {
  const at = (L: number) => {
    const hex = oklchToHex({ L, C: ink.C, H: ink.H });
    return alpha >= 1 ? hex : mixHex(bg, hex, alpha);
  };
  if (contrastRatio(at(endpoint), bg) < target) return endpoint;
  let fail = hexToOklch(bg).L; // 여기서 대비비는 1 — 반드시 실패한다
  let pass = endpoint;
  for (let i = 0; i < 40; i++) {
    const mid = (fail + pass) / 2;
    if (contrastRatio(at(mid), bg) >= target) pass = mid;
    else fail = mid;
  }
  return pass;
}

/**
 * 반투명 잉크(`--muted`/`--faint`)가 배경 `bg` 위에서 목표 대비비를 만족하는 **최소 알파**.
 * L 을 움직이지 않는 이유: 이 둘은 tokens.css 에서 `--text` 와 **같은 RGB + 알파**로 정의돼
 * 있고, 흐림의 정도가 알파 그 자체다. 알파만 올리면 색상·채도·명도가 전부 그대로 유지되고
 * "덜 흐려질" 뿐이라, 3단 위계가 무너지지 않는다(잉크를 따로 어둡게 하면 무너진다).
 * 알파가 오를수록 합성색이 배경에서 멀어지므로 술어는 단조다. 1 에서도 못 미치면 1.
 */
export function alphaForContrast(
  bg: string,
  ink: string,
  target: number,
  minAlpha: number,
): number {
  const ok = (a: number) => contrastRatio(mixHex(bg, ink, a), bg) >= target;
  // 이미 충분하면 **그대로** 둔다 — 이분탐색은 위에서 좁혀 오므로 시작값에 정확히 닿지 못해,
  // 이 한 줄이 없으면 바꿀 필요가 없는 배경에서도 알파가 1e-9 만큼 올라간다(= 토큰이 덮인다).
  if (ok(minAlpha)) return minAlpha;
  if (!ok(1)) return 1;
  let fail = minAlpha;
  let pass = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (fail + pass) / 2;
    if (ok(mid)) pass = mid;
    else fail = mid;
  }
  return pass;
}
