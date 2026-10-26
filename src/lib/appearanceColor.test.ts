import { describe, it, expect, beforeEach } from "vitest";
import {
  BG_SAT_MAX_CHROMA,
  CANVAS_BASE,
  CONTENT_TINT_BASE,
  DEFAULT_APPEARANCE_SEED,
  FAINT_MIN_CONTRAST,
  INK_BASE,
  INK_TARGET_CONTRAST,
  THEME_COLOR,
  applyCssVars,
  autoInk,
  saturateCanvas,
  themeColorFor,
  tintCanvas,
  type Theme,
} from "./appearance";
import { DEFAULT_ACCENT, contrastRatio, hexToOklch, mixHex, oklchToHex } from "./accentPalette";

const THEMES: Theme[] = ["dark", "light"];

/** applyCssVars 가 계산하는 것과 **같은 식**으로 두 기준면을 만든다(사이드바 / 본문). */
function surfaces(theme: Theme, opts: { bgTone?: number; bgDim?: number; bgSat?: number; contentTint?: number } = {}) {
  const canvas = saturateCanvas(
    tintCanvas(CANVAS_BASE[theme], opts.bgTone ?? 0),
    opts.bgSat ?? 0,
    THEME_COLOR[theme],
  );
  const sheet = mixHex(canvas, "#000000", (opts.bgDim ?? 0) / 100);
  const tint = CONTENT_TINT_BASE[theme] + (opts.contentTint ?? 0);
  const content = mixHex(sheet, tint < 0 ? "#ffffff" : "#000000", Math.abs(tint) / 100);
  return { canvas, sheet, content };
}

// ── 배경 채도 (PLAN-2026-09-12 §3/E3) ────────────────────────────────────────

describe("saturateCanvas", () => {
  it("0 은 입력을 **그대로** 돌려준다 — 기본값은 오늘 화면과 픽셀 동일", () => {
    for (const theme of THEMES) {
      expect(saturateCanvas(CANVAS_BASE[theme], 0, THEME_COLOR[theme])).toBe(CANVAS_BASE[theme]);
    }
  });

  it("100 에서 채도가 상한(구분선 합성색의 채도)에 닿는다", () => {
    for (const theme of THEMES) {
      const out = saturateCanvas(CANVAS_BASE[theme], 100, THEME_COLOR[theme]);
      expect(hexToOklch(out).C).toBeCloseTo(BG_SAT_MAX_CHROMA, 2);
    }
  });

  it("명도를 건드리지 않는다 — 라이트에서 어두운 테마색을 섞어도 캔버스가 탁해지지 않는다", () => {
    // 오너가 우려한 지점: 라이트 --theme(#33573a)은 한지 캔버스보다 훨씬 어둡다. sRGB 에서 그냥
    // 섞으면 채도보다 **어두워짐**이 먼저 온다 — 실제로 재 보면 26% 혼합에서 L 이 0.95 → 0.82 로
    // 떨어진다. L 을 고정하는 방식은 같은 채도를 내면서 그 낙폭이 0 이다.
    for (const theme of THEMES) {
      const base = hexToOklch(CANVAS_BASE[theme]).L;
      for (const sat of [25, 50, 75, 100]) {
        const out = hexToOklch(saturateCanvas(CANVAS_BASE[theme], sat, THEME_COLOR[theme])).L;
        expect(Math.abs(out - base)).toBeLessThan(0.005);
      }
    }
    // 대조군 — 같은 세기를 sRGB 에서 섞었을 때의 낙폭(이 방식이 푸는 문제 그 자체).
    const naive = hexToOklch(mixHex(CANVAS_BASE.light, THEME_COLOR.light, 0.26)).L;
    expect(hexToOklch(CANVAS_BASE.light).L - naive).toBeGreaterThan(0.1);
  });

  it("상한이 강조색 사다리의 가장 옅은 유채 칸(C 0.03)보다 아래다 — 배경이 강조를 이기지 않는다", () => {
    expect(BG_SAT_MAX_CHROMA).toBeLessThan(0.03);
  });

  it("무채색 테마색(C≈0)에서는 no-op이다 — H:0 을 실제 색상각으로 오인해 배경에 색을 얹지 않는다", () => {
    // themeColorFor 가 무채색 accent 에 대해 만드는 정확한 인코딩(C:0,H:0). accentPalette.ts::
    // hexToOklch 의 문서화된 계약대로, 채도가 0이면 색상각은 의미가 없다 — 그 0을 "빨강 쪽"으로
    // 읽어 배경을 물들이면 안 된다.
    const achromaticTheme = oklchToHex({ L: 0.5, C: 0, H: 0 });
    for (const theme of THEMES) {
      for (const sat of [25, 50, 100]) {
        expect(saturateCanvas(CANVAS_BASE[theme], sat, achromaticTheme)).toBe(CANVAS_BASE[theme]);
      }
    }
  });

  it("채도는 세기를 따라 단조 증가한다(슬라이더가 중간에 멈추지 않는다)", () => {
    for (const theme of THEMES) {
      let prev = -1;
      for (const sat of [0, 20, 40, 60, 80, 100]) {
        const c = hexToOklch(saturateCanvas(CANVAS_BASE[theme], sat, THEME_COLOR[theme])).C;
        // 라이트 캔버스는 시작 채도(크림, C 0.0168)가 목표 색상과 60° 어긋나 있어 경로 중간이
        // 아주 살짝 꺼질 수 있다 — 눈금 하나 분의 오차(0.002)까지만 허용한다.
        expect(c).toBeGreaterThan(prev - 0.002);
        prev = c;
      }
      expect(prev).toBeGreaterThan(0.02);
    }
  });
});

// ── 글자색 자동 보정 (PLAN-2026-09-12 §5/E6) ─────────────────────────────────

describe("autoInk", () => {
  const worst = (fg: string, bgs: string[]) => Math.min(...bgs.map((b) => contrastRatio(fg, b)));

  it("다크 기본값에서는 **아무것도 바꾸지 않는다**", () => {
    const { sheet, content } = surfaces("dark");
    expect(autoInk("dark", sheet, content, false, 1)).toEqual({
      text: null,
      mutedAlpha: null,
      faintAlpha: null,
    });
  });

  it("라이트 기본값에서는 --faint 바닥(3:1)만 올린다 — 실측 2.28 은 안 보이는 쪽이다", () => {
    const { sheet, content } = surfaces("light");
    const ink = autoInk("light", sheet, content, false, 1);
    expect(ink.text).toBeNull();
    expect(ink.mutedAlpha).toBeNull();
    expect(ink.faintAlpha).not.toBeNull();
    expect(ink.faintAlpha!).toBeGreaterThan(INK_BASE.light.faintAlpha);
    // 반투명 잉크는 **바탕마다 다른 색으로 합성**된다 — 바탕별로 합성해서 재야 한다.
    const worstAlpha = Math.min(
      ...[sheet, content].map((b) => contrastRatio(mixHex(b, INK_BASE.light.text, ink.faintAlpha!), b)),
    );
    expect(worstAlpha).toBeGreaterThanOrEqual(FAINT_MIN_CONTRAST - 0.01);
  });

  it("라이트 + 배경 밝기 −100 에서 본문 잉크가 목표 대비를 되찾는다(실측 2.65 → 4.5)", () => {
    const { sheet, content } = surfaces("light", { bgDim: 40, bgTone: -10 });
    const before = worst(INK_BASE.light.text, [sheet, content]);
    expect(before).toBeLessThan(INK_TARGET_CONTRAST);

    const ink = autoInk("light", sheet, content, false, 1);
    expect(ink.text).not.toBeNull();
    expect(worst(ink.text!, [sheet, content])).toBeGreaterThanOrEqual(INK_TARGET_CONTRAST - 0.01);
    // 어두운 잉크는 **더 어두워지기만** 한다 — 방향이 뒤집혀 흰 글자가 되면 안 된다.
    expect(hexToOklch(ink.text!).L).toBeLessThan(hexToOklch(INK_BASE.light.text).L);
    // 잉크 RGB 가 바뀌면 알파 두 단도 그 위에서 다시 나와야 한다(안 그러면 옛 RGB 가 남는다).
    expect(ink.mutedAlpha).not.toBeNull();
    expect(ink.faintAlpha).not.toBeNull();
  });

  it("두 바탕 중 **나쁜 쪽**으로 푼다 — 본문 틴트를 끝까지 밀어도 사이드바가 무너지지 않는다", () => {
    const { sheet, content } = surfaces("light", { contentTint: 40 });
    const ink = autoInk("light", sheet, content, false, 1);
    expect(ink.text).not.toBeNull();
    // 어느 쪽에서도 목표 아래로 떨어지지 않는다(쉬운 쪽은 과보정된다 — 의도된 대가).
    expect(contrastRatio(ink.text!, content)).toBeGreaterThanOrEqual(INK_TARGET_CONTRAST - 0.01);
    expect(contrastRatio(ink.text!, sheet)).toBeGreaterThan(INK_TARGET_CONTRAST);
  });

  it("아크릴은 벽지를 모르므로 최악값을 가정한다 — flat 보다 항상 보수적이다", () => {
    const { sheet, content } = surfaces("dark");
    const flat = autoInk("dark", sheet, content, false, 0.5);
    const acrylic = autoInk("dark", sheet, content, true, 0.5);
    expect(flat.faintAlpha).toBeNull();
    // 시트가 반투명하면 밝은 벽지가 비쳐 바탕이 밝아진다 — 밝은 잉크에겐 최악이다.
    expect(acrylic.text).not.toBeNull();
    expect(hexToOklch(acrylic.text!).L).toBeGreaterThan(hexToOklch(INK_BASE.dark.text).L);
  });

  it("불투명(sheetAlpha 1) 아크릴에서는 벽지 후보가 없다 — flat 과 같은 답", () => {
    const { sheet, content } = surfaces("dark");
    expect(autoInk("dark", sheet, content, true, 1)).toEqual(autoInk("dark", sheet, content, false, 1));
  });

  it("어떤 극단 조합에서도 --faint 가 --muted 보다 진해지지 않는다(위계 역전 금지)", () => {
    for (const theme of THEMES) {
      for (const bgDim of [0, 20, 40]) {
        for (const contentTint of [-30, 0, 40]) {
          for (const acrylic of [false, true]) {
            const { sheet, content } = surfaces(theme, { bgDim, contentTint });
            const ink = autoInk(theme, sheet, content, acrylic, 0.7);
            const muted = ink.mutedAlpha ?? INK_BASE[theme].mutedAlpha;
            const faint = ink.faintAlpha ?? INK_BASE[theme].faintAlpha;
            expect(faint).toBeLessThanOrEqual(muted);
          }
        }
      }
    }
  });
});

// ── applyCssVars 배선 ────────────────────────────────────────────────────────

describe("applyCssVars — 배경 채도 · 글자색", () => {
  const root = () => document.documentElement;
  const base = { ...DEFAULT_APPEARANCE_SEED };

  beforeEach(() => {
    for (const p of ["--text", "--ink", "--muted", "--faint", "--app-canvas"]) {
      root().style.removeProperty(p);
    }
  });

  it("채도 0 의 --app-canvas 는 오늘과 같고, 올리면 물든다", () => {
    applyCssVars({ ...base, theme: "dark" });
    expect(root().style.getPropertyValue("--app-canvas")).toBe(CANVAS_BASE.dark);
    applyCssVars({ ...base, theme: "dark", bgSat: 100 });
    const tinted = root().style.getPropertyValue("--app-canvas");
    expect(tinted).not.toBe(CANVAS_BASE.dark);
    expect(hexToOklch(tinted).C).toBeGreaterThan(hexToOklch(CANVAS_BASE.dark).C);
  });

  it("기본 다크에서는 글자색 토큰을 아예 건드리지 않는다(tokens.css 가 그대로 선다)", () => {
    applyCssVars({ ...base, theme: "dark" });
    for (const p of ["--text", "--ink", "--muted", "--faint"]) {
      expect(root().style.getPropertyValue(p)).toBe("");
    }
  });

  it("안전하지 않은 조합에서 --text/--ink 를 함께 덮고, 되돌리면 함께 지운다", () => {
    applyCssVars({ ...base, theme: "light", bgDim: 40, bgTone: -10, contentTint: 40 });
    const text = root().style.getPropertyValue("--text");
    expect(text).not.toBe("");
    expect(root().style.getPropertyValue("--ink")).toBe(text);
    expect(root().style.getPropertyValue("--muted")).toMatch(/^rgba\(/);

    // 슬라이더를 안전한 자리로 되돌리면 진해진 글자가 눌러앉지 않아야 한다.
    applyCssVars({ ...base, theme: "light" });
    expect(root().style.getPropertyValue("--text")).toBe("");
    expect(root().style.getPropertyValue("--ink")).toBe("");
  });
});

/**
 * 회귀 가드: 잉크 3단(본문/보조/흐림)이 **절대 한 색으로 붙지 않는다.**
 *
 * 2026-09-12 적대적 검토가 실측으로 잡은 붕괴다. 처음 구현은 `--text` 를 목표 대비 4.5 에 딱
 * 붙게 푼 뒤 `--muted` 에게 **같은 바탕·같은 잉크·같은 4.5** 를 요구했는데, 그러면 해가 알파
 * 1.0 하나뿐이라 보조가 본문과 픽셀 단위로 같은 색이 된다(라이트 극단 조합과 다크+아크릴
 * α0.5 에서 세 단이 전부 한 색이었다). 지금은 잉크를 **보조가 상한 알파에서도 목표를 만족하는
 * L** 로 풀어 자리를 먼저 만든다.
 *
 * "보정이 걸렸는가"가 아니라 **"세 단이 서로 다른가"** 를 본다 — 전자는 위 사고를 통과시켰다.
 */
describe("autoInk — 잉크 3단이 붙지 않는다", () => {
  const COMBOS: Array<[string, "dark" | "light", string, string, boolean, number]> = [
    // [이름, 테마, 사이드바 바탕, 본문 바탕, 아크릴, 시트 알파]
    ["라이트 틴트+40", "light", "#f4efe3", "#817f78", false, 1],
    ["라이트 밝기-100", "light", "#928f88", "#7a7872", false, 1],
    ["라이트 밝기-100+틴트+40", "light", "#928f88", "#454440", false, 1],
    ["라이트 아크릴 α.2", "light", "#f4efe3", "#e2ddd2", true, 0.2],
    ["다크 아크릴 α.5", "dark", "#171b1a", "#131615", true, 0.5],
    ["다크 기본", "dark", "#171b1a", "#131615", false, 1],
    ["라이트 기본", "light", "#f4efe3", "#e2ddd2", false, 1],
  ];

  for (const [name, theme, sheet, content, acrylic, alpha] of COMBOS) {
    it(`${name} — text/muted/faint 가 서로 다른 색이다`, () => {
      const ink = autoInk(theme, sheet, content, acrylic, alpha);
      const base = INK_BASE[theme];
      const hex = ink.text ?? base.text;
      const mutedA = ink.mutedAlpha ?? base.mutedAlpha;
      const faintA = ink.faintAlpha ?? base.faintAlpha;

      // ① 보조는 절대 불투명해지지 않는다 — 불투명 = 본문과 같은 색.
      expect(mutedA).toBeLessThan(1);
      // ② 세 단 사이에 눈에 띄는 간격이 있다.
      expect(faintA).toBeLessThan(mutedA);
      expect(mutedA - faintA).toBeGreaterThanOrEqual(0.05);
      // ③ 실제 합성색이 본문과 다르다(알파가 다르면 색도 달라야 한다).
      for (const bg of [sheet, content]) {
        expect(mixHex(bg, hex, mutedA)).not.toBe(hex);
        expect(contrastRatio(mixHex(bg, hex, mutedA), hex)).toBeGreaterThan(1);
      }
    });
  }
});

describe("themeColorFor — 강조색 연동 테마색 동적 계산", () => {
  it("기본 강조색(DEFAULT_ACCENT)은 기존 테마 상수를 픽셀 단위로 정확히 반환", () => {
    expect(themeColorFor(DEFAULT_ACCENT, "dark")).toBe(THEME_COLOR.dark);
    expect(themeColorFor(DEFAULT_ACCENT, "light")).toBe(THEME_COLOR.light);
  });

  it("핑크 강조색을 주면 색상각(H)을 보존하면서 테마에 맞는 은은한 채도의 테마색 생성", () => {
    const pinkAccent = "#e05688";
    const darkThemeCol = themeColorFor(pinkAccent, "dark");
    const lightThemeCol = themeColorFor(pinkAccent, "light");

    const accentLch = hexToOklch(pinkAccent);
    const darkLch = hexToOklch(darkThemeCol);
    const lightLch = hexToOklch(lightThemeCol);

    const diffH = (a: number, b: number) => {
      const d = Math.abs(a - b) % 360;
      return d > 180 ? 360 - d : d;
    };
    expect(diffH(darkLch.H, accentLch.H)).toBeLessThan(3);
    expect(diffH(lightLch.H, accentLch.H)).toBeLessThan(3);
    expect(darkLch.C).toBeLessThanOrEqual(0.045);
    expect(lightLch.C).toBeLessThanOrEqual(0.045);
    expect(darkThemeCol).not.toBe(THEME_COLOR.dark);
  });

  it("무채색 강조색은 채도 0의 중립 회색을 반환", () => {
    const gray = "#888888";
    const darkCol = themeColorFor(gray, "dark");
    expect(hexToOklch(darkCol).C).toBeCloseTo(0, 3);
  });

  it("applyCssVars 호출 시 document.documentElement에 --theme이 설정됨", () => {
    applyCssVars({
      ...DEFAULT_APPEARANCE_SEED,
      theme: "dark",
      accent: "#e05688",
      fontScale: 1,
      surfaceStyle: "flat",
      surfaceEffectApplied: false,
    });
    const computed = document.documentElement.style.getPropertyValue("--theme");
    expect(computed).toBe(themeColorFor("#e05688", "dark"));
  });
});
