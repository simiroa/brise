/**
 * Per-device mobile-only prefs: theme override + text-size scale. Deliberately NOT routed through
 * stores/settings.ts (the shared desktop settings store, synced to the DB) — "테마"/"글자 크기" on
 * the owner brief are explicitly this phone's screen/lighting, not a workspace-wide preference the
 * desktop should inherit. Persisted in localStorage (per-browser, survives reloads) instead.
 *
 * Theme: applied straight to `document.documentElement`'s `data-theme` attribute, the same
 * attribute tokens.css's `:root[data-theme='light']` selector keys off (stores/settings.ts's own
 * applyCssVars sets the same attribute from the shared setting — this module's applyMobilePrefs()
 * must run AFTER that boot call so the per-device override wins, see MobileApp.tsx).
 *
 * Font scale: shadowed on `.mobile-app` only (an inline `--fs` override on that subtree), not on
 * `:root` — reuses the existing `--text-*` token scale (tokens.css: every type token is
 * `calc(px * var(--fs))`) instead of inventing a parallel scale, and never touches the desktop
 * tree's own `--fs` (a different, shared setting).
 */
export type MobileTheme = "system" | "light" | "dark";
export type MobileFontSize = "small" | "medium" | "large";

const THEME_KEY = "brise_mobile_theme";
const FONT_KEY = "brise_mobile_font_size";

const FONT_SCALE: Record<MobileFontSize, number> = { small: 0.9, medium: 1, large: 1.15 };

export function getMobileTheme(): MobileTheme {
  const v = localStorage.getItem(THEME_KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function getMobileFontSize(): MobileFontSize {
  const v = localStorage.getItem(FONT_KEY);
  return v === "small" || v === "large" ? v : "medium";
}

function resolveTheme(pref: MobileTheme): "light" | "dark" {
  if (pref !== "system") return pref;
  const prefersLight = typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches;
  return prefersLight ? "light" : "dark";
}

function applyTheme(pref: MobileTheme): void {
  document.documentElement.setAttribute("data-theme", resolveTheme(pref));
  // 공유 외형 적용기(lib/appearance.ts::applyCssVars, W18 C2 로 stores/settings.ts 에서 이동)가
  // --app-canvas 를 인라인으로 박는다(bgTone 넛지 포함,
  // 데스크톱 공유 테마 기준값). 인라인은 tokens.css 의 [data-theme] 스코프 값을 항상 이기므로,
  // 모바일이 속성만 뒤집으면 "다크 잉크(흰 글자) + 라이트 캔버스" 혼합 상태가 된다
  // (2026-07-30 실검증 — 사용자 보고 "글자가 하얀데"). 인라인을 걷어내 테마 스코프 값이
  // 적용되게 한다. bgTone 미세조정은 모바일에선 포기 — 기기 화면에 맞춘 테마가 우선.
  document.documentElement.style.removeProperty("--app-canvas");
}

function applyFontSize(size: MobileFontSize): void {
  document.querySelector<HTMLElement>(".mobile-app")?.style.setProperty("--fs", String(FONT_SCALE[size]));
}

let systemListenerAttached = false;

/** Call once on MobileApp mount, after useSettingsStore's load() resolves. Also wires a live
 *  prefers-color-scheme listener for "시스템 따름" (idempotent — safe to call on every mount). */
export function applyMobilePrefs(): void {
  applyTheme(getMobileTheme());
  applyFontSize(getMobileFontSize());

  if (!systemListenerAttached && typeof window !== "undefined" && window.matchMedia) {
    systemListenerAttached = true;
    // Optional chaining: some test doubles (and older WebKit) return a MediaQueryList without
    // addEventListener — the live-update is a nice-to-have, not worth failing boot over.
    window.matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", () => {
      if (getMobileTheme() === "system") applyTheme("system");
    });
  }
}

export function setMobileTheme(pref: MobileTheme): void {
  localStorage.setItem(THEME_KEY, pref);
  applyTheme(pref);
}

export function setMobileFontSize(size: MobileFontSize): void {
  localStorage.setItem(FONT_KEY, size);
  applyFontSize(size);
}

/** 현재 위치 자동 첨부 정책(기기별 — 이 기기 GPS 권한 성격이라 PC 공유 설정이 아니다). 기본 ask. */
export type MobileLocMode = "off" | "ask" | "auto";
const LOC_MODE_KEY = "brise_mobile_loc_mode";

export function getLocMode(): MobileLocMode {
  try {
    const v = localStorage.getItem(LOC_MODE_KEY);
    return v === "off" || v === "auto" ? v : "ask";
  } catch {
    return "ask"; // silent-ok: 저장소 접근 불가면 가장 보수적인 기본값
  }
}

export function setLocMode(mode: MobileLocMode): void {
  try {
    localStorage.setItem(LOC_MODE_KEY, mode);
  } catch {
    // silent-ok: 저장 불가(사생활 모드 등) — 다음 로드에 기본값
  }
}
