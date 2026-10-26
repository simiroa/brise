import { clamp } from "./ui";
import { isBrowser } from "./env";
import { call } from "./invoke";
import {
  DEFAULT_ACCENT,
  alphaForContrast,
  contrastRatio,
  hexToOklch,
  isAccentHex,
  lightnessForContrast,
  mixHex,
  oklchToHex,
  onAccentFor,
  renderAccent,
} from "./accentPalette";

// 타입을 여기서 정의하여 stores/settings.ts 와의 circular import 를 방지한다.
// settings.ts 에서 정의된 동명 타입과 반드시 동기화해야 한다.
export type ThemePref = "system" | "dark" | "light";
export type Theme = "dark" | "light";
/** 강조색 — 소문자 `#rrggbb`. PLAN-2026-09-12 §4 가 hue 슬라이더를 열면서 **5개 리터럴
 *  유니온에서 연속 값 공간으로 바뀌었다**(열거가 불가능하다). 형식 판정은 한 곳 —
 *  `accentPalette.ts::isAccentHex`, 백엔드 `validate_setting` 의 `is_hex_color` 와 같은 규칙. */
export type Accent = string;
export type SurfaceStyle = "flat" | "acrylic";

export function resolveTheme(pref: ThemePref): Theme {
  if (pref === "dark" || pref === "light") return pref;
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "dark";
}

/** applyCssVars 에 전달할 외형 서브셋 — stores/settings.ts::SettingsState 의 해당 필드와 동일 */
export interface ApplyCssVarsInput {
  theme: Theme;
  accent: Accent;
  fontScale: number;
  bgDim: number;
  bgTone: number;
  surfaceStyle: SurfaceStyle;
  surfaceEffectApplied: boolean;
  sheetAlpha: number;
  fontFamily?: string;
  /** PLAN-2026-09-12 §5 — 본문 캔버스 틴트의 **부호 있는 오프셋**(-30~40). 선택적인 이유는
   *  `applySavedAppearanceSeed` 가 시드(AppearanceSeed)를 그대로 넘기는데 시드에는 이 필드가
   *  없기 때문이다 — 결측이면 0(= tokens.css 의 기준값 그대로)으로 읽고, 곧이어 `load()` 가
   *  DB 값으로 다시 적용한다. 기본값 사용자는 첫 페인트와 완전히 같고, 슬라이더를 움직여 둔
   *  사용자만 아주 짧게 기준값을 본다(fontFamily 가 선택인 것과 같은 부류). */
  contentTint?: number;
  /** PLAN-2026-09-12 §3/E3 — 배경 채도(0~100). 캔버스를 **테마색 쪽으로** 물들이는 세기이고,
   *  0 = 오늘 화면과 픽셀 동일이다(saturateCanvas 가 0 에서 즉시 반환한다). 선택인 이유는
   *  contentTint 와 같다 — 구 시드에는 이 필드가 없다. */
  bgSat?: number;
}

// tokens.css 의 :root/--app-canvas 및 :root[data-theme='light']/--app-canvas 와 반드시 동기화
// (여기서 톤 보정의 기준값으로 재사용하므로 값이 갈리면 "현재값이 기본값" 전제가 깨진다).
export const CANVAS_BASE: Record<Theme, string> = {
  dark: "#171b1a",
  light: "#f4efe3",
};

// bgTone 클램프 — Wave(theme customisation) 리포트에 실측 대비(worst-case)를 남겨둠:
// 톤 ±10, glass(alpha .80) 최악 배경(순백/순검정) 겹침 기준 dark 5.11:1 / light 5.15:1 (>=4.5:1).
export const BG_TONE_MIN = -10;
export const BG_TONE_MAX = 10;
// acrylic 표면 불투명도(투명도) — `.app` 단일 시트(--bg)의 알파. 뒤 OS 데스크톱이 (1-alpha)만큼
// 비친다. 사용자 요청으로 하한 제거(2026-07-23) — 낮은 값은 본문 가독성 저하(사용자 선택). 과거엔
// 대비 하한(본문 4.5:1)에서 0.72 를 하한으로 뒀으나 지금은 0~1.0 전 구간 허용.
export const SHEET_ALPHA_MIN = 0.0;
export const SHEET_ALPHA_MAX = 1.0;

// 본문 틴트(PLAN-2026-09-12 §5 / D6) — `content_tint` 는 **부호 있는 오프셋**이고, 실효 틴트는
// 테마 기준값 + 오프셋이다. 범위는 Rust `settings_schema.rs::validate_setting` 의
// `content_tint` arm(-30..=40)과 **같은 숫자**여야 한다(둘이 갈리면 프런트가 저장을 시도했다가
// 백엔드가 조용히 거절한다 — CLAUDE.md 함정 3).
export const CONTENT_TINT_MIN = -30;
export const CONTENT_TINT_MAX = 40;
// tokens.css 의 --content-tint-amount 기본값(:root 16% / [data-theme='light'] 7%)과 반드시 같다.
// 오프셋 0 에서 CSS 기본값과 픽셀 단위로 같아야 "기본값은 오늘 화면 그대로"가 참이 된다.
export const CONTENT_TINT_BASE: Record<Theme, number> = { dark: 16, light: 7 };

// ── 테마색 (PLAN-2026-09-12 §2/E1) ───────────────────────────────────────────
// tokens.css 의 `:root{--theme}` / `:root[data-theme='light']{--theme}` 와 반드시 같아야 한다
// (appearanceSeedDrift.test.ts 가 tokens.css 를 직접 읽어 대조한다). CANVAS_BASE 와 같은 부류의
// "테마 상수 그 자체"이지 어딘가에 박아 둔 색이 아니다.
//
// ⚠️ 이 값을 setProperty 하지 마라. --theme 은 사용자 손잡이가 아니고, data-theme 이 바뀌면
// CSS 가 알아서 갈아끼운다. 여기 사본이 있는 이유는 두 가지뿐이다: ⓐ index.html 부팅 스크립트와
// jsdom 테스트처럼 스타일시트가 아직/전혀 없는 자리, ⓑ 아래 themeColor() 의 폴백.
export const THEME_COLOR: Record<Theme, string> = {
  dark: "#9cc5a4",
  light: "#33573a",
};

/** 실제 `--theme` 값. 스타일시트가 있으면 거기서 읽고(테마 블록이 SSOT), 없으면 위 사본. */
export function themeColor(theme: Theme): string {
  if (typeof document !== "undefined" && typeof getComputedStyle === "function") {
    const v = getComputedStyle(document.documentElement).getPropertyValue("--theme").trim();
    if (isAccentHex(v)) return v;
  }
  return THEME_COLOR[theme];
}

/**
 * 사용자가 고른 강조색(Accent)의 색조(Hue)에 연동하여 테마색(--theme)을 동적 계산.
 * - 기본 청자색(DEFAULT_ACCENT)일 때는 역사적 상수(#9cc5a4 / #33573a)를 그대로 반환하여 기본값 불변 보장.
 * - 무채색일 때는 채도 0의 중립 회색을 반환.
 * - 유채색일 때는 사용자의 Accent 색상각(H)을 따르되, 구분선과 앱 구조에 적합한 은은한 채도(C ≈ 0.044)와 테마별 명도(L: 다크 0.77, 라이트 0.38)를 유지.
 */
export function themeColorFor(accentHex: string, theme: Theme): string {
  if (!isAccentHex(accentHex) || accentHex.toLowerCase() === DEFAULT_ACCENT.toLowerCase()) {
    return THEME_COLOR[theme];
  }
  const { C, H } = hexToOklch(accentHex);
  const L = theme === "dark" ? 0.773 : 0.38;
  if (C < 0.005) {
    return oklchToHex({ L, C: 0, H: 0 });
  }
  const targetC = Math.min(0.044, Math.max(0.02, C * 0.7));
  return oklchToHex({ L, C: targetC, H });
}

// ── 배경 채도 (PLAN-2026-09-12 §3/E3) ────────────────────────────────────────
// 0~100 은 "상한의 몇 %"이고, 상한은 아래 BG_SAT_MAX_CHROMA 다. 0 = 오늘과 픽셀 동일.
export const BG_SAT_MIN = 0;
export const BG_SAT_MAX = 100;

/**
 * 채도 100% 에서 캔버스가 갖는 **OKLCH 채도**. 취향이 아니라 역산이다.
 *
 * 기준선: 지금 화면에서 테마색이 가장 진하게 칠해지는 곳은 **구분선**
 * (`color-mix(--theme 26%, transparent)`)이다. 그 합성색의 채도를 두 테마에서 재면
 *   다크  #171b1a + #9cc5a4 26% → #3a473e  C = 0.02261
 *   라이트 #f4efe3 + #33573a 26% → #c2c7b7  C = 0.02261
 * **두 테마가 같은 숫자**로 떨어진다 — C0 가 라이트 --theme 의 밝기를 "공통 알파에서 같은 선
 * 무게"로 역산했기 때문이다. 그래서 상한도 테마별로 가를 필요가 없다(아래 "라이트가 탁해지는
 * 문제"는 상한이 아니라 **혼합 방식**으로 푼다 — saturateCanvas 주석).
 *
 * 규칙 한 줄: **배경은 머리카락 선보다 더 색을 띠지 않는다.**
 * 오너의 "강조색보다 튀면 안 된다"에 대한 검산 — 강조색 사다리는 C 0 / 0.03 / 0.064 / 0.10 /
 * 0.145 이고, 0.0226 은 **가장 옅은 유채 칸(0.03)보다도 아래**이며 기본 강조색(0.064)의 1/3,
 * 가장 강한 칸(0.145)의 1/6 이다. 면적이 99:1 로 뒤집혀 있어도 픽셀당 채도가 이만큼 벌어져
 * 있으면 "무엇이 강조인가"는 흔들리지 않는다. (면적을 곱해 총량을 맞추는 계산도 해 봤지만
 * C ≈ 0.0007 이 나와 슬라이더 자체가 무의미해진다 — 그건 기준이 아니라 산술이다.)
 *
 * 색역 여유도 확인했다: 상한 채도가 필요한 지점의 최대 채도는 다크 캔버스 L 0.2175 에서
 * 0.0591, 라이트 캔버스 L 0.9527 에서 0.0792 — 둘 다 0.0226 을 여유 있게 담는다(클램프 없음).
 */
export const BG_SAT_MAX_CHROMA = 0.0226;

// ── 글자색 자동 보정 (PLAN-2026-09-12 §5/E6) ─────────────────────────────────
// tokens.css 의 --text/--ink/--muted/--faint 정의와 반드시 같아야 한다(드리프트 가드 동상).
// --muted/--faint 는 --text 와 **같은 RGB + 알파**라 알파만 적는다.
export const INK_BASE: Record<Theme, { text: string; mutedAlpha: number; faintAlpha: number }> = {
  dark: { text: "#e0deda", mutedAlpha: 0.8, faintAlpha: 0.46 },
  light: { text: "#3b3833", mutedAlpha: 0.78, faintAlpha: 0.45 },
};

/** 본문/보조 글자의 목표 대비비(WCAG AA 본문). */
export const INK_TARGET_CONTRAST = 4.5;
/** `--faint` 는 **바닥만** 깐다 — 흐린 건 의도고 안 보이는 건 사고다(E6). */
export const FAINT_MIN_CONTRAST = 3;
// 잉크가 갈 수 있는 끝. 순백/순검정(1/0)이 아닌 이유 둘: ⓐ L=1·L=0 에서는 채도가 0 이라
// 잉크가 **무채로 변색**된다(§5: 색상은 지키고 명도만 움직여라), ⓑ DESIGN.md 의 "절대 검정을
// 피한다" 원칙. 이 끝에서도 목표에 못 미치는 극단 설정에서는 끝값을 그대로 쓴다 — 낼 수 있는
// 최대 대비다. 0.97/0.08 과 1/0 의 대비 차이는 실측 0.07 포인트(2.51 vs 2.44)로 무시할 만하다.
/** `--muted` 알파의 상한. 1.0 에 닿으면 보조 텍스트가 본문과 **픽셀 단위로 같은 색**이 된다.
 *  왜 상한이 필요한가: --text 를 목표 대비 4.5 에 딱 붙게 풀고 나서 --muted 에게 **같은 바탕·
 *  같은 잉크·같은 4.5** 를 요구하면 해는 알파 1.0 뿐이다. 2026-09-12 검토가 라이트 극단 조합과
 *  다크+아크릴 α0.5 에서 세 단(text/muted/faint)이 전부 한 색으로 붙는 것을 실측했다. */
const MUTED_MAX_ALPHA = 0.88;
/** `--faint` 는 `--muted` 보다 최소 이만큼 옅다 — 사다리가 붙어 보이지 않게. */
const FAINT_MIN_GAP = 0.1;
const INK_L_MAX = 0.97;
const INK_L_MIN = 0.08;

// WAVE K — 외형 시드 저장 키 (첫 페인트 스타일 지연 방지)
export const APPEARANCE_SEED_STORAGE_KEY = "brise_appearance_seed_v1";

export interface AppearanceSeed {
  themePref: ThemePref;
  theme: Theme;
  accent: Accent;
  fontScale: number;
  bgDim: number;
  bgTone: number;
  /** PLAN-2026-09-12 §3/E3 — 배경 채도(0~100). bgTone/bgDim 과 같은 이유로 시드에 담는다:
   *  첫 페인트 색을 index.html 부팅 스크립트가 이 값으로 계산한다(안 담으면 채도를 올려 둔
   *  사용자만 첫 프레임에 무채 배경을 본다). contentTint 와 갈리는 지점이기도 하다 —
   *  그쪽은 CSS 기본값이 이미 같은 그림을 그리지만, 채도는 CSS 에 기본값이 없다. */
  bgSat: number;
  surfaceStyle: SurfaceStyle;
  sheetAlpha: number;
  fontFamily: string;
  /** W15: 지난 부팅에서 syncWindowEffect 가 실제로 돌려준 결과(추측이 아니라 실측) —
   *  stores/settings.ts::applySurfaceEffectAfterShow/setSurfaceStyle/setTheme 가 OS 호출
   *  결과를 얻을 때마다 이 필드까지 함께 저장한다. surfaceStyle이 "flat"이면 의미 없음(항상
   *  effectiveSurface="flat"). applySavedAppearanceSeed 가 이 실측값을 그대로 써서, 다음
   *  부팅에서 환경이 안 바뀌는 한 applySurfaceEffectAfterShow 의 재확인이 아무것도 바꾸지
   *  않게 한다(부팅 중 --bg 반전 방지). */
  surfaceEffectApplied: boolean;
  /** 저장 시점 테마의 실제 --theme(강조색에서 계산, themeColorFor). index.html 부팅 스크립트는
   *  OKLCH 계산을 손 복제하지 않고 이 값을 그대로 쓴다 — 고정 세이지(#9cc5a4)를 쓰던 때는 배경
   *  채도를 올린 사용자가 부팅·새로고침 순간에만 녹색 배경을 봤다. 구 시드에는 없다(없으면 고정값). */
  themeHex?: string;
}

export const DEFAULT_APPEARANCE_SEED: AppearanceSeed = {
  // E5-a: 신규 설치 기본값은 "시스템 따름"이다. 짝인 `theme`("dark")은 **정적 최후 폴백** —
  // matchMedia 조차 없는 환경(구 웹뷰·테스트)에서 쓰이고, index.html 의 DEFAULT_THEME 및
  // 그 파일의 CSS `var(--boot-bg, #171b1a)` 리터럴과 반드시 같아야 한다(appearanceSeedDrift.test.ts).
  // 시드가 없을 때의 실제 첫 페인트는 아래 defaultSeed() 가 OS 밝기를 읽어 정한다.
  themePref: "system",
  theme: "dark",
  accent: DEFAULT_ACCENT,
  fontScale: 1,
  bgDim: 0,
  bgTone: 0,
  // 0 = 채도 없음 = 오늘 화면과 픽셀 동일(saturateCanvas 가 0 에서 입력을 그대로 돌려준다).
  bgSat: 0,
  surfaceStyle: "flat",
  sheetAlpha: 0.85,
  fontFamily: "pretendard",
  // flat 은 OS 효과가 필요 없으니 trivially "적용됨" — defaultSettings() 의 같은 필드 기본값과 동일.
  surfaceEffectApplied: true,
};

// VALID_ACCENTS(5색 화이트리스트)는 PLAN-2026-09-12 §4 에서 **폐기됐다** — hue 슬라이더가 열려
// 값 공간이 연속이라 열거가 불가능하다. 검증은 accentPalette.ts::isAccentHex 한 곳이다.

/** 시드가 없거나 못 읽을 때의 기본값. 기본 themePref 가 "system" 이므로 **여기서 OS 밝기를
 *  해석해야** 첫 실행이 어둠으로 번쩍이지 않는다 — 상수를 그대로 퍼뜨리면 라이트 모드 OS 에서도
 *  dark 로 칠한 뒤 load() 가 뒤늦게 뒤집는다. */
function defaultSeed(): AppearanceSeed {
  return { ...DEFAULT_APPEARANCE_SEED, theme: resolveTheme(DEFAULT_APPEARANCE_SEED.themePref) };
}

/** localStorage 에서 외형 시드를 읽어 파싱/검증. 실패 시 안전 기본값 반환. */
export function loadAppearanceSeed(): AppearanceSeed {
  try {
    if (typeof localStorage === "undefined") return defaultSeed();
    const raw = localStorage.getItem(APPEARANCE_SEED_STORAGE_KEY);
    if (!raw) return defaultSeed();
    const parsed = JSON.parse(raw) as Partial<AppearanceSeed>;
    if (!parsed || typeof parsed !== "object") return defaultSeed();

    const rawThemePref = parsed.themePref ?? parsed.theme;
    const themePref: ThemePref =
      rawThemePref === "system" || rawThemePref === "light" || rawThemePref === "dark"
        ? rawThemePref
        : "dark";
    const theme: Theme = resolveTheme(themePref);
    const accent: Accent = isAccentHex(parsed.accent)
      ? parsed.accent
      : DEFAULT_APPEARANCE_SEED.accent;
    const fontScale =
      typeof parsed.fontScale === "number" && !Number.isNaN(parsed.fontScale) && parsed.fontScale > 0
        ? parsed.fontScale
        : DEFAULT_APPEARANCE_SEED.fontScale;
    const bgDim =
      typeof parsed.bgDim === "number" && !Number.isNaN(parsed.bgDim)
        ? clamp(parsed.bgDim, 0, 100)
        : DEFAULT_APPEARANCE_SEED.bgDim;
    const bgTone =
      typeof parsed.bgTone === "number" && !Number.isNaN(parsed.bgTone)
        ? clamp(parsed.bgTone, BG_TONE_MIN, BG_TONE_MAX)
        : DEFAULT_APPEARANCE_SEED.bgTone;
    const bgSat =
      typeof parsed.bgSat === "number" && !Number.isNaN(parsed.bgSat)
        ? clamp(parsed.bgSat, BG_SAT_MIN, BG_SAT_MAX)
        : DEFAULT_APPEARANCE_SEED.bgSat;
    const surfaceStyle: SurfaceStyle = parsed.surfaceStyle === "acrylic" ? "acrylic" : "flat";
    const sheetAlpha =
      typeof parsed.sheetAlpha === "number" && !Number.isNaN(parsed.sheetAlpha)
        ? clamp(parsed.sheetAlpha, SHEET_ALPHA_MIN, SHEET_ALPHA_MAX)
        : DEFAULT_APPEARANCE_SEED.sheetAlpha;
    const fontFamily =
      typeof parsed.fontFamily === "string" && parsed.fontFamily.trim().length > 0 && parsed.fontFamily.length <= 128
        ? parsed.fontFamily
        : DEFAULT_APPEARANCE_SEED.fontFamily;
    // 구 시드(이 필드 추가 이전 저장분)는 결측 -> 기본값(true)으로 읽는다. 딱 한 번, 다음
    // applySurfaceEffectAfterShow 가 실측값으로 되돌려 놓는다 — 회귀 아님(위 인터페이스 주석).
    const surfaceEffectApplied =
      typeof parsed.surfaceEffectApplied === "boolean"
        ? parsed.surfaceEffectApplied
        : DEFAULT_APPEARANCE_SEED.surfaceEffectApplied;

    return {
      themePref,
      theme,
      accent,
      fontScale,
      bgDim,
      bgTone,
      bgSat,
      surfaceStyle,
      sheetAlpha,
      fontFamily,
      surfaceEffectApplied,
    };
  } catch {
    return defaultSeed();
  }
}

/** 외형 서브셋을 localStorage 에 저장 (WAVE K). */
export function saveAppearanceSeed(
  seed: AppearanceSeed | Partial<AppearanceSeed>,
): void {
  try {
    if (typeof localStorage === "undefined") return;
    const themePref = seed.themePref ?? (seed.theme === "light" ? "light" : "dark");
    const payload: AppearanceSeed = {
      themePref,
      theme: seed.theme ?? resolveTheme(themePref),
      accent: seed.accent ?? DEFAULT_APPEARANCE_SEED.accent,
      fontScale: seed.fontScale ?? DEFAULT_APPEARANCE_SEED.fontScale,
      bgDim: seed.bgDim ?? DEFAULT_APPEARANCE_SEED.bgDim,
      bgTone: seed.bgTone ?? DEFAULT_APPEARANCE_SEED.bgTone,
      bgSat: seed.bgSat ?? DEFAULT_APPEARANCE_SEED.bgSat,
      surfaceStyle: seed.surfaceStyle ?? DEFAULT_APPEARANCE_SEED.surfaceStyle,
      sheetAlpha: seed.sheetAlpha ?? DEFAULT_APPEARANCE_SEED.sheetAlpha,
      fontFamily: seed.fontFamily ?? DEFAULT_APPEARANCE_SEED.fontFamily,
      surfaceEffectApplied: seed.surfaceEffectApplied ?? DEFAULT_APPEARANCE_SEED.surfaceEffectApplied,
    };
    payload.themeHex = themeColorFor(payload.accent, payload.theme);
    localStorage.setItem(APPEARANCE_SEED_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // localStorage 쓰기 실패(접근 제한/용량 등)는 조용히 무시
  }
}

// hex 색상을 부호있는 톤(%) 만큼 흰색(+)/검정(-) 쪽으로 섞는다 — color-mix(in srgb, ...) 와 같은
// 감마 공간 선형보간(채널값 직접 보간)이라 CSS 쪽 계산과 결과가 일치한다. (콘텐츠 --app-canvas 전용
// — OS acrylic 틴트는 아래 ACRYLIC_TINT_FIXED 처럼 bg_tone/bg_dim 과 무관한 고정값이라 이 함수를
// 쓰지 않는다.)
export function tintCanvas(hex: string, tonePct: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const toward = tonePct >= 0 ? 255 : 0;
  const t = Math.min(100, Math.abs(tonePct)) / 100;
  const mix = (c: number) => Math.round(c * (1 - t) + toward * t);
  const hx = (c: number) => c.toString(16).padStart(2, "0");
  return `#${hx(mix(r))}${hx(mix(g))}${hx(mix(b))}`;
}

/**
 * 캔버스를 **테마색 쪽으로** 물들인다 (PLAN-2026-09-12 §3/E3). 0 이면 입력을 **그대로** 돌려준다
 * — 기본값에서 이 함수는 존재하지 않는 것과 같다(hex→OKLCH→hex 왕복의 ±1 오차도 안 난다).
 *
 * **명도를 고정하고 OKLab 평면에서만 움직인다.** 이것이 오너가 지목한 "라이트가 급격히
 * 탁해진다"의 답이다: 라이트 테마색 #33573a 는 L 0.42 로 한지 캔버스(L 0.95)보다 훨씬 어두워서,
 * sRGB 에서 그냥 섞으면 채도보다 **어두워짐**이 먼저 온다(같은 상한에서 라이트만 칙칙해진다).
 * L 을 붙잡아 두면 섞이는 것은 색뿐이라 두 테마가 같은 상한을 써도 대칭이고, 배경 밝기
 * 슬라이더(bgTone/bgDim)와 역할이 겹치지도 않는다 — 밝기는 저쪽, 채도는 여기.
 *
 * 향하는 색이 `--accent` 가 아니라 `--theme` 인 이유: 배경은 **구조**다(§2 판정 기준 — 사용자가
 * 강조색을 레드로 바꿨다고 바탕까지 빨개지면 안 된다).
 */
export function saturateCanvas(hex: string, satPct: number, themeHex: string): string {
  const t = Math.max(BG_SAT_MIN, Math.min(BG_SAT_MAX, satPct)) / 100;
  if (t <= 0) return hex;
  const base = hexToOklch(hex);
  const theme = hexToOklch(themeHex);
  // 무채색 강조색(themeColorFor 가 C:0,H:0 으로 인코딩)에서는 accentPalette.ts::hexToOklch 의
  // 계약대로 H 가 의미를 잃는다. 그 자리의 0 을 "빨강 쪽 색상각"으로 오인해 background-saturation
  // 이 배경에 색을 얹혀 버리던 것을 막는다 — 겨냥할 색상이 없으면 이 함수는 통째로 no-op.
  if (theme.C < 0.005) return hex;
  const rad = Math.PI / 180;
  const a0 = base.C * Math.cos(base.H * rad);
  const b0 = base.C * Math.sin(base.H * rad);
  const a1 = BG_SAT_MAX_CHROMA * Math.cos(theme.H * rad);
  const b1 = BG_SAT_MAX_CHROMA * Math.sin(theme.H * rad);
  const a = a0 + (a1 - a0) * t;
  const b = b0 + (b1 - b0) * t;
  return oklchToHex({ L: base.L, C: Math.hypot(a, b), H: (Math.atan2(b, a) * 180) / Math.PI });
}

/**
 * 부팅 첫 페인트의 **불투명** 배경색 한 개. `index.html` 의 인라인 스크립트가 같은 이름·같은
 * 식으로 이 함수를 손으로 복제하고 있고(그 파일은 TS 를 import 할 수 없다),
 * `src/lib/appearanceSeedDrift.test.ts` 가 **그 사본을 꺼내 실행해 출력을 대조**한다 —
 * 상수만 비교하면 계산 순서가 어긋나는 드리프트를 놓치기 때문이다.
 *
 * 순서가 곧 계약이다: 밝기(tone) → 채도(sat) → 어둡기(dim). 앞의 둘은 `--app-canvas` 에 담기고
 * dim 은 CSS 가 `--surface-base` 에서 하므로, 부팅 때만 여기서 셋을 한 번에 합성한다.
 * 인자를 전부 받는 이유는 자기완결(테스트가 통째로 eval 한다)이다.
 */
export function bootCanvasColor(
  canvasHex: string,
  themeHex: string,
  bgTone: number,
  bgDim: number,
  bgSat: number,
): string {
  return mixHex(saturateCanvas(tintCanvas(canvasHex, bgTone), bgSat, themeHex), "#000000", bgDim / 100);
}

// Windows acrylic 틴트 알파(0~255) — 은은하게. 슬라이더(--sheet-alpha)와는 무관한 고정값: 그건
// `.app` 단일 시트(CSS 쪽) 반투명만 조절하고, 이건 OS 합성 자체의 틴트 세기다.
export const ACRYLIC_TINT_ALPHA = 90;
// 테마별 고정 중립 OS 틴트 — mica→acrylic 리네임(2026-07-24)과 함께 bg_tone/bg_dim 미러링을
// 걷어냈다: 그 두 값은 매 슬라이더 틱마다 바뀌는데, OS acrylic 재적용은 합성 재구성 비용 때문에
// 디바운스가 필요했고(예전 scheduleAcrylicRetint) 그래도 flicker/lag 가 남았다(사용자 피드백).
// 이제 OS 틴트는 테마당 하나의 고정값이라 재계산이 필요 없고, bg_tone/bg_dim 은 콘텐츠
// (--surface-base, CSS 쪽)에만 즉시 반영된다 — acrylic 배경은 항상 이 중립 톤 그대로다.
export const ACRYLIC_TINT_FIXED: Record<Theme, [number, number, number]> = {
  dark: [23, 27, 26],
  light: [244, 239, 227],
};

// 테마별 acrylic 틴트 — flat 은 효과 자체가 없으니 null(무효), 그 외엔 테마 고정색(위
// ACRYLIC_TINT_FIXED)에 **배경 채도만** 얹어 은은한 알파(90)로 보낸다.
//
// 2026-09-12(E4): 색은 보내고 **밝기는 여전히 안 보낸다**. 2026-07-24 에 bg_tone/bg_dim 미러링을
// 걷어낸 이유는 그 둘이 슬라이더 틱마다 바뀌어 OS 재합성이 flicker/lag 를 냈기 때문인데, 색은
// 성질이 다르다 — 바뀌는 순간이 ⓐ 테마 변경 ⓑ 배경 채도 **확정**(드래그 중이 아니라 손 뗀 뒤)
// 둘뿐이라 드래그당 정확히 1회다. 안 보내면 채도를 올려도 CSS 시트만 물들고 그 뒤 아크릴은
// 중성으로 남아 두 층이 따로 논다(계획 §4).
// ⚠️ flicker 는 테스트로 안 잡힌다. 실앱에서 채도 슬라이더를 드래그해 확인해야 하고, 재발하면
// 여기서 bgSat 을 무시하고 고정색으로 되돌리는 것이 안전판이다(그 한 줄이면 2026-07-24 상태).
export function acrylicTint(
  style: SurfaceStyle,
  theme: Theme,
  bgSat = 0,
): [number, number, number, number] | null {
  if (style === "flat") return null;
  const fixed = ACRYLIC_TINT_FIXED[theme];
  if (bgSat <= 0) return [fixed[0], fixed[1], fixed[2], ACRYLIC_TINT_ALPHA];
  const hex = `#${fixed.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  const n = parseInt(saturateCanvas(hex, bgSat, themeColor(theme)).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, ACRYLIC_TINT_ALPHA];
}

/** index.html 부팅 스크립트가 계산해 둔 **불투명** 첫-페인트 색(--boot-bg). 모듈 평가 시점에
 *  딱 한 번 붙잡는다 — 번들은 그 인라인 스크립트 뒤에 실행되므로 이 시점의 값이 원본이다.
 *  applyCssVars 안에서 지연 읽기를 하면 acrylic 이 먼저 써 넣은 "transparent" 를 원본으로
 *  착각해 flat 으로 못 돌아온다. 빈 문자열이면 setProperty 가 속성을 지워 index.html 의 CSS
 *  폴백(#171b1a)이 그대로 선다 — 부팅 이전과 같은 상태다. */
const BOOT_BG_OPAQUE =
  typeof document === "undefined" ? "" : document.documentElement.style.getPropertyValue("--boot-bg");

/**
 * 합성 배경에서 읽히는 글자색 (PLAN-2026-09-12 §5/E6).
 *
 * 반환은 **"바꿔야 할 것만"** 이다(안 바꿔도 되면 null) — 기본 설정에서는 셋 다 null 이라
 * tokens.css 의 테마 값이 그대로 선다. `--muted`/`--faint` 를 색이 아니라 **알파**로 돌려주는
 * 이유는 그 둘이 tokens.css 에서 `--text` 와 같은 RGB + 알파이기 때문이다: 알파만 올리면
 * 색상·채도·명도가 그대로고 "덜 흐려질" 뿐이라 3단 위계가 무너지지 않는다.
 *
 * **후보 배경이 둘인 이유**: 사이드바는 `dim(canvas)`, 본문은 거기에 본문 틴트를 한 겹 더
 * 얹은 색이다. 두 바탕이 다른데 `--text` 는 하나뿐이므로 **둘 중 나쁜 쪽**으로 푼다 — 그래야
 * 어느 쪽에서도 목표 아래로 떨어지지 않는다. 대가는 쉬운 쪽의 과보정(글자가 필요보다 진해진다)
 * 이고, 정확히 가르려면 `.content-canvas` 에서 `--text` 계열을 재정의해야 한다(tokens.css 소관,
 * 이 레인 밖 — 후속으로 남긴다). 두 바탕이 크게 벌어지는 것은 본문 틴트를 끝까지 민 경우뿐이다.
 *
 * **아크릴 최악값 가정**: 시트 뒤 `(1 - sheetAlpha)` 는 데스크톱 벽지라 알 수 없다. 잉크를
 * 잡아먹는 쪽 극단만 후보에 넣는다 — 밝은 잉크(다크 테마)에는 흰 벽지, 어두운 잉크에는 검은
 * 벽지. 투명도를 많이 내린 창에서는 어떤 잉크로도 목표에 못 미치는데(하한을 없앤 것은 사용자
 * 선택이다, 2026-07-23) 그때는 낼 수 있는 최대(INK_L_MAX/MIN)까지만 가고 멈춘다.
 */
export function autoInk(
  theme: Theme,
  sheet: string,
  content: string,
  acrylic: boolean,
  sheetAlpha: number,
): { text: string | null; mutedAlpha: number | null; faintAlpha: number | null } {
  const base = INK_BASE[theme];
  const up = theme === "dark"; // 밝은 잉크는 위로, 어두운 잉크는 아래로만 움직인다(방향 고정)
  const endpoint = up ? INK_L_MAX : INK_L_MIN;
  const bgs = [sheet, content];
  if (acrylic && sheetAlpha < 1) {
    const wall = up ? "#ffffff" : "#000000";
    bgs.push(mixHex(sheet, wall, 1 - sheetAlpha), mixHex(content, wall, 1 - sheetAlpha));
  }
  // 잉크를 푸는 기준은 **--text 가 아니라 --muted 다.**
  //
  // --text 만 4.5 에 딱 맞춰 풀면, 그 다음 --muted 가 같은 바탕에서 같은 4.5 를 요구받아 해가
  // 알파 1.0 하나뿐이 된다 — 보조 텍스트가 본문과 같은 색이 되고 3단 위계가 사라진다(실측:
  // 라이트 극단 조합과 다크+아크릴 α0.5 에서 세 단이 전부 한 색). 그래서 **보조가 설 자리를
  // 먼저 만든다**: 잉크는 "알파 MUTED_MAX_ALPHA 로 얹었을 때도 목표를 만족하는" L 로 푼다.
  // 그러면 --text(알파 1.0)는 자동으로 목표를 넘고, --muted 는 상한 아래에서 해를 찾는다.
  const { L: baseL, C, H } = hexToOklch(base.text);
  const worstAtL = (L: number, alpha: number) => {
    const hex = oklchToHex({ L, C, H });
    return Math.min(...bgs.map((bg) => contrastRatio(alpha >= 1 ? hex : mixHex(bg, hex, alpha), bg)));
  };
  let ink = base.text;
  if (worstAtL(baseL, MUTED_MAX_ALPHA) < INK_TARGET_CONTRAST) {
    // 바탕마다 풀고 가장 먼 해를 취한다(솔버는 accentPalette 한 곳 — 알파를 받는다).
    let solved = baseL;
    for (const bg of bgs) {
      const l = lightnessForContrast(bg, { C, H }, INK_TARGET_CONTRAST, endpoint, MUTED_MAX_ALPHA);
      solved = up ? Math.max(solved, l) : Math.min(solved, l);
    }
    ink = oklchToHex({ L: solved, C, H });
  }
  const inkChanged = ink !== base.text;

  const worstAt = (alpha: number) =>
    Math.min(...bgs.map((bg) => contrastRatio(mixHex(bg, ink, alpha), bg)));

  let mutedAlpha = base.mutedAlpha;
  if (worstAt(mutedAlpha) < INK_TARGET_CONTRAST) {
    for (const bg of bgs) {
      mutedAlpha = Math.max(mutedAlpha, alphaForContrast(bg, ink, INK_TARGET_CONTRAST, base.mutedAlpha));
    }
    // 상한 — 위 잉크 해가 이 알파에서 목표를 보장하므로, 여기서 잘라도 4.5 는 지켜진다.
    mutedAlpha = Math.min(mutedAlpha, MUTED_MAX_ALPHA);
  }
  let faintAlpha = base.faintAlpha;
  if (worstAt(faintAlpha) < FAINT_MIN_CONTRAST) {
    for (const bg of bgs) {
      faintAlpha = Math.max(faintAlpha, alphaForContrast(bg, ink, FAINT_MIN_CONTRAST, base.faintAlpha));
    }
    // 사다리 유지 — faint 가 muted 와 **같아지는 것만으로도** 3단이 2단으로 읽힌다.
    // 역전 방지(<=)가 아니라 **최소 간격**을 강제한다.
    faintAlpha = Math.min(faintAlpha, mutedAlpha - FAINT_MIN_GAP);
  }

  return {
    // 잉크 RGB 가 바뀌면 알파 두 단도 함께 다시 내보내야 한다(그 둘은 이 RGB 위에 얹힌다).
    text: inkChanged ? ink : null,
    mutedAlpha: inkChanged || mutedAlpha !== base.mutedAlpha ? mutedAlpha : null,
    faintAlpha: inkChanged || faintAlpha !== base.faintAlpha ? faintAlpha : null,
  };
}

/** `#rrggbb` + 알파 → `rgba(r,g,b,a)` (tokens.css 의 --muted/--faint 와 같은 표기). */
function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Number(alpha.toFixed(3))})`;
}

// 토큰은 tokens.css 에서 :root 에 정의된다 — ModalShell 이 document.body 로 portal 되므로
// 런타임 오버라이드도 반드시 documentElement 에 걸어야 모달까지 도달한다 (.app 에 걸면 누락).
export const applyCssVars = (s: ApplyCssVarsInput) => {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("data-theme", s.theme);
  // PLAN-2026-09-12 §4: 저장 값은 색상·채도만 사용자의 것이고 **명도는 테마가 정한다**. 그래서
  // 저장 hex 를 그대로 박지 않고 현재 테마의 L 로 다시 그린다 — 다크에서 고른 밝은 세이지가
  // 라이트 한지 배경에서 하얗게 날아가는 일을 막는 것이 목적이다. 기본값(#9cc5a4/다크)에서는
  // 저장 hex 와 결과가 완전히 같다(accentPalette.test.ts 가 그 왕복을 지킨다).
  const accent = renderAccent(s.accent, s.theme);
  root.style.setProperty("--accent", accent);
  // 강조색(Accent)의 색조(Hue)에 연동하여 테마선과 기본 구조 톤을 동기화
  root.style.setProperty("--theme", themeColorFor(s.accent, s.theme));
  // 강조색 위 글자색은 표가 아니라 **고른 색에서 계산**한다 — 두 잉크 후보의 WCAG 대비를 재서
  // 큰 쪽을 고르므로, 나중에 ACCENT_L 을 조정해도 저절로 따라온다.
  root.style.setProperty("--on-accent", onAccentFor(accent));
  root.style.setProperty("--fs", String(s.fontScale));
  // 배경 톤(bgTone, -10..+10) — 현재 테마의 기본 --app-canvas 에서 흰/검정 쪽으로 미리 계산된
  // 안전 범위만큼 넛지. 인라인(root.style)이라 tokens.css 의 :root/:root[data-theme='light']
  // 양쪽 --app-canvas 규칙보다 항상 우선한다.
  // 배경 채도(PLAN-2026-09-12 §3/E3)는 여기 **한 줄**에 얹는다 — --surface-base 가 이 값에서
  // 파생되고 그 아래 222 소비처가 전부 따라오므로, 다른 곳을 손댈 필요가 없다. 향하는 색은
  // --theme 이다(강조색이 아니다 — §2 판정 기준).
  // themeColor() 는 채도가 0 보다 클 때만 부른다 — getComputedStyle 은 스타일 재계산을 강제하는데
  // 이 함수는 슬라이더 틱마다 불린다(기본값 사용자에게 공짜여야 한다).
  const bgSat = s.bgSat ?? 0;
  const canvas =
    bgSat > 0
      ? saturateCanvas(tintCanvas(CANVAS_BASE[s.theme], s.bgTone), bgSat, themeColor(s.theme))
      : tintCanvas(CANVAS_BASE[s.theme], s.bgTone);
  root.style.setProperty("--app-canvas", canvas);
  // Wave (window transparency): data-surface 는 사용자가 고른 값이 아니라 "실제로 적용된" 값을
  // 반영한다 — acrylic 을 골랐는데 OS 효과가 실패했다면(Windows 11 미만 등) flat 으로 내려앉힌다.
  // tokens.css 의 :root[data-surface='acrylic']는 --bg 를 transparent 로 바꿔 .app 캔버스 자체를
  // 뚫어버리므로, 실제 Acrylic 배경이 없는 상태에서 이 값을 그대로 두면 아무것도 없는 구멍(또는 검은
  // 창)이 남는다 — 그 실패 모드를 막는 게 이 분기의 목적.
  const effectiveSurface = s.surfaceStyle !== "flat" && !s.surfaceEffectApplied ? "flat" : s.surfaceStyle;
  root.setAttribute("data-surface", effectiveSurface);
  // 아크릴이 실제로 걸린 창에서는 **문서 캔버스 자체**가 투명해야 한다.
  //
  // index.html 의 `html,body{background-color:var(--boot-bg)}` 는 부팅 첫 페인트가 깜빡이지
  // 않도록 불투명 근사값을 칠한다(e925d6fb, 2026-08-30 "부팅 시 외형 단계적 적용 제거"). 그런데
  // 그걸 **걷어내는 단계가 없었다** — Chromium 은 root 요소 배경을 뷰포트 캔버스로 전파하므로
  // 웹뷰가 매 픽셀 불투명해지고, transparent:true 창 뒤의 DWM Acrylic 이 원리상 보일 수 없다.
  // (펫 창만 petwindow.css 가 같은 이유로 html/body 를 투명으로 되돌리고 있었고, 그 주석이
  //  "이 규칙이 딸려오면 메인 앱 배경이 투명해진다"고 인과를 이미 적어 두었다.)
  //
  // 두 목적은 시간축에서 겹치지 않는다: 부팅 중엔 불투명하게 칠하고, applySurfaceEffectAfterShow
  // 가 OS 효과를 **실제로 적용한 뒤**(surfaceEffectApplied=true) 여기서 걷어낸다. flat 에서는
  // `.app`(100vw×100vh 불투명 시트)이 문서 캔버스를 완전히 덮어 이 값이 화면에 닿지 않으므로
  // 부팅 근사값을 그대로 되돌려 두면 된다.
  root.style.setProperty("--boot-bg", effectiveSurface === "acrylic" ? "transparent" : BOOT_BG_OPAQUE);
  // acrylic 시트 불투명도 — acrylic 시트(.app --bg)가 이 값을 쓴다(tokens.css). 인라인이라 acrylic
  // 프리셋 블록의 기본값을 override 한다.
  root.style.setProperty("--sheet-alpha", String(s.sheetAlpha));
  root.style.setProperty("--bg-dim", `${s.bgDim}%`);

  // 본문 틴트(PLAN-2026-09-12 §5) — 실효값 = 테마 기준값 + 사용자 오프셋. **부호가 색을 표현하고
  // 세기는 항상 양수**다: 검정 한 색으로는 본문이 사이드바보다 밝아질 수 없어서(0% 가 하한),
  // 실효값이 음수로 내려가면 틴트가 흰색으로 뒤집힌다.
  // ⚠️ `%` 를 빼먹으면 color-mix 가 통째로 무효가 되어 **본문 배경이 조용히 사라진다** —
  // 바로 위 --bg-dim 이 같은 모양인 이유도 그것이다.
  const tint = CONTENT_TINT_BASE[s.theme] + clamp(s.contentTint ?? 0, CONTENT_TINT_MIN, CONTENT_TINT_MAX);
  root.style.setProperty("--content-tint-color", tint < 0 ? "#fff" : "#000");
  root.style.setProperty("--content-tint-amount", `${Math.abs(tint)}%`);

  // 글자색 자동 보정(PLAN-2026-09-12 §5/E6) — 합성 배경을 아는 유일한 지점이 여기다.
  // 사이드바 기준면 = dim(canvas) (tokens.css 의 --surface-base 와 같은 식),
  // 본문 기준면 = 거기에 본문 틴트를 한 겹 더(.content-canvas 의 --surface-base 와 같은 식).
  const sheet = mixHex(canvas, "#000000", s.bgDim / 100);
  const content = mixHex(sheet, tint < 0 ? "#ffffff" : "#000000", Math.abs(tint) / 100);
  const ink = autoInk(s.theme, sheet, content, effectiveSurface === "acrylic", s.sheetAlpha);
  // 보정이 필요 없으면 **지운다** — tokens.css 의 테마 값이 다시 서야 한다(사용자가 슬라이더를
  // 안전한 자리로 되돌렸을 때 진해진 글자가 눌러앉는 것을 막는 단계다).
  const setOrClear = (name: string, value: string | null) => {
    if (value === null) root.style.removeProperty(name);
    else root.style.setProperty(name, value);
  };
  const inkHex = ink.text ?? INK_BASE[s.theme].text;
  setOrClear("--text", ink.text);
  // --ink 는 tokens.css 에서 --text 와 같은 값인 별칭이다 — 한쪽만 덮으면 둘이 갈린다.
  setOrClear("--ink", ink.text);
  setOrClear("--muted", ink.mutedAlpha === null ? null : rgba(inkHex, ink.mutedAlpha));
  setOrClear("--faint", ink.faintAlpha === null ? null : rgba(inkHex, ink.faintAlpha));

  // W11: 글꼴 패밀리 인라인 오버라이드
  //
  // 2026-09-02(오너 확정): --font-editor 도 함께 덮어쓴다. 예전엔 --font-body 만 바꿔서
  // "산세리프"를 골라도 **노트 본문은 세리프 그대로**였다 — .mdbody/.ProseMirror 가
  // --font-editor 를 쓰는데 그 값이 :root 에 고정돼 있었기 때문이다. 기본값(serif)에서는 두
  // 스택이 같아 티가 안 나서 오래 묻혀 있었다. 설정 라벨이 그냥 "글꼴"이므로 본문까지 바뀌는 게
  // 맞다. 굵기 사다리는 두 스택 모두 400/600 만 쓰므로(CLAUDE.md 함정 10) 영향 없다.
  const fontFam = s.fontFamily ?? "pretendard";
  const stack =
    fontFam === "pretendard"
      ? '"Pretendard", "Source Sans 3", system-ui, sans-serif'
      : fontFam === "serif"
        ? '"Source Serif 4", "Noto Serif KR", serif'
        : fontFam === "sans"
          ? '"Source Sans 3", "Noto Sans KR", system-ui, sans-serif'
          : // ponytail: 시스템 글꼴명 직접 입력까지만. ttf/otf 파일 임포트는 이걸로 부족하다는 실사용 피드백이 오면
            `"${fontFam}", "Pretendard", system-ui, sans-serif`;
  root.style.setProperty("--font-body", stack);
  root.style.setProperty("--font-editor", stack);
};

let systemThemeListenerAttached = false;

/** 시스템 테마(prefers-color-scheme) 변경 리스너 등록 (idempotent). */
export function attachSystemThemeListener(onThemeChange: (resolved: Theme) => void): void {
  if (typeof window === "undefined" || !window.matchMedia || systemThemeListenerAttached) return;
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const listener = (e: MediaQueryListEvent) => {
    onThemeChange(e.matches ? "dark" : "light");
  };
  if (media.addEventListener) {
    media.addEventListener("change", listener);
  } else if ("addListener" in media) {
    // Safari legacy fallback
    (media as unknown as { addListener: (cb: (e: MediaQueryListEvent) => void) => void }).addListener(listener);
  }
  systemThemeListenerAttached = true;
}

/**
 * index.html 이 부팅 동안 걸어 둔 `html.booting`(transition 전부 끔)을 푼다. 마지막 CSS 변수
 * 변경이 그려진 **뒤**여야 하므로 두 프레임 기다린다 — 한 프레임 안에 풀면 방금 바뀐 값이 그대로
 * 페이드된다. 여러 번 불러도 무해하다.
 */
export function endBootTransitions(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (!root.classList.contains("booting")) return;
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("booting")));
}

/** 저장된 외형 시드를 읽어 DOM 에 즉시 동기 적용 (WAVE K 첫 페인트 지연 방지) */
export function applySavedAppearanceSeed(): AppearanceSeed {
  const seed = loadAppearanceSeed();
  if (typeof document !== "undefined") {
    // W15 Part 3: surfaceStyle==="acrylic" 라는 추측이 아니라, 지난 부팅에서 syncWindowEffect 가
    // 실제로 돌려준 결과(seed.surfaceEffectApplied)를 쓴다 — 환경이 안 바뀌었다면 이후
    // applySurfaceEffectAfterShow 의 재확인이 --bg 를 다시 뒤집지 않는다. AppearanceSeed 는 이제
    // ApplyCssVarsInput 과 필드가 1:1이라 그대로 넘긴다.
    applyCssVars(seed);
  }
  return seed;
}

/** Wave (window transparency): src-tauri/src/commands/window.rs::window_set_effect 호출 —
 * surfaceStyle 프리셋을 실제 Windows 창 효과(Acrylic)에 라이브로 반영한다. 실패(플러그인
 * 없음/미지원 OS)는 여기서 조용히 삼키고 applied:false 로 취급 — 호출부(load/setTheme/
 * setSurfaceStyle)가 surfaceEffectApplied 를 그 값으로 갱신해 CSS 쪽 폴백(위 applyCssVars)을
 * 트리거한다. tint(2026-07-24 개정): 테마 고정 틴트만 보낸다(acrylicTint) — bg_tone/bg_dim 은
 * 더 이상 OS 틴트에 반영되지 않으므로(콘텐츠 --surface-base 에만 즉시 반영) 그 두 값이 바뀔 때
 * 이 함수를 다시 부를 필요가 없다. 테마/표면 스타일이 바뀔 때만 호출한다. */
export async function syncWindowEffect(
  style: SurfaceStyle,
  theme: Theme,
  bgSat = 0,
): Promise<boolean> {
  // 동기화(브라우저 탭) 클라이언트에는 OS 창이 없다 — window_set_effect 는 sync 서버가 아예
  // 라우팅하지 않는 명령(excluded-over-HTTP)이라 매번 "unavailable_in_browser: window_set_effect"
  // 404 왕복 + call() 의 에러 토스트만 발생시켰다(부팅을 끊지는 않았다: 이 함수 자신이 잡아
  // 삼켜 load() 는 계속 진행됨 — 사용자 눈에만 동기화가 실패한 것처럼 보였다, QA 2026-07-31).
  // 모든 호출부(load/setTheme/setSurfaceStyle)가 이 함수 하나를 거치므로 여기 한 번만 막으면
  // 충분하다. false 를 반환해야 한다 — true 로 두면 surfaceEffectApplied 가 그대로 남아
  // applyCssVars 가 data-surface="acrylic" 를 적용하고, tokens.css 의 SINGLE-SHEET ACRYLIC
  // CONTRACT 상 --bg 가 transparent 로 뚫린다 — 브라우저 탭엔 그 뒤를 채울 OS Acrylic이 절대
  // 없으므로 캔버스에 구멍만 남는다. false 가 flat 폴백을 트리거해 이를 막는다.
  if (isBrowser()) return false;
  try {
    const tint = acrylicTint(style, theme, bgSat);
    const res = await call<{ applied: boolean }>("window_set_effect", { style, tint });
    return Boolean(res?.applied);
  } catch {
    return false;
  }
}
