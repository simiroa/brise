import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  APPEARANCE_SEED_STORAGE_KEY,
  BG_SAT_MAX_CHROMA,
  BG_TONE_MIN,
  BG_TONE_MAX,
  CANVAS_BASE,
  DEFAULT_APPEARANCE_SEED,
  INK_BASE,
  THEME_COLOR,
  bootCanvasColor,
} from "./appearance";
import { hexToOklch, mixHex } from "./accentPalette";

// W15 Part 1: index.html carries a hand-written subset of appearance.ts's seed logic (it can't
// import TS). This test is the drift guard the wave's spec demanded — if appearance.ts's
// defaults/constants change without index.html being updated to match, this fails instead of
// silently letting the boot-time inline paint diverge from the real seed (reintroducing the
// exact flash this wave removed).
const html = readFileSync("index.html", "utf8");

/** Pulls `var NAME = <expr>;` out of the inline boot-seed script and evaluates <expr>. The file
 *  is our own trusted source (not user input), so Function-eval is fine for a test. */
function extractValue(varName: string): unknown {
  const re = new RegExp("var\\s+" + varName + "\\s*=\\s*([^;]+);");
  const m = html.match(re);
  if (!m) {
    throw new Error(
      `index.html: could not find "var ${varName} = ...;" in the boot-appearance-seed <script> — ` +
        "did the inline script get renamed or removed?",
    );
  }
  return new Function(`"use strict"; return (${m[1]});`)();
}

describe("index.html boot-appearance seed — drift guard (W15)", () => {
  it("reads localStorage under the exact key appearance.ts writes seeds to", () => {
    expect(html).toContain(APPEARANCE_SEED_STORAGE_KEY);
  });

  it("mirrors CANVAS_BASE from src/lib/appearance.ts exactly (theme -> app-canvas hex)", () => {
    expect(extractValue("CANVAS_BASE")).toEqual(CANVAS_BASE);
  });

  it("mirrors DEFAULT_APPEARANCE_SEED's theme/bgTone/bgDim fallbacks", () => {
    expect(extractValue("DEFAULT_THEME")).toBe(DEFAULT_APPEARANCE_SEED.theme);
    expect(extractValue("DEFAULT_BG_TONE")).toBe(DEFAULT_APPEARANCE_SEED.bgTone);
    expect(extractValue("DEFAULT_BG_DIM")).toBe(DEFAULT_APPEARANCE_SEED.bgDim);
  });

  it("mirrors THEME_COLOR — 배경 채도가 향하는 색(PLAN-2026-09-12 §2/E1)", () => {
    expect(extractValue("THEME_COLOR")).toEqual(THEME_COLOR);
  });

  it("mirrors the bgSat default (DEFAULT_BG_SAT)", () => {
    expect(extractValue("DEFAULT_BG_SAT")).toBe(DEFAULT_APPEARANCE_SEED.bgSat);
  });

  it("mirrors the bgTone clamp bounds (BG_TONE_MIN/MAX)", () => {
    expect(extractValue("BG_TONE_MIN")).toBe(BG_TONE_MIN);
    expect(extractValue("BG_TONE_MAX")).toBe(BG_TONE_MAX);
  });

  it("CSS fallback background equals CANVAS_BASE[DEFAULT_APPEARANCE_SEED.theme] (no localStorage case)", () => {
    // At bgTone=0/bgDim=0 (the defaults), tintCanvas/applyDim are no-ops, so the very first
    // painted color (before the inline script even runs, and its explicit fallback if it throws)
    // must equal the raw theme canvas color, not some derived value.
    const expected = CANVAS_BASE[DEFAULT_APPEARANCE_SEED.theme];
    const m = html.match(/background-color:\s*var\(--boot-bg,\s*(#[0-9a-fA-F]{6})\)/);
    expect(m, "expected an `html, body { background-color: var(--boot-bg, #RRGGBB) }` fallback rule").not.toBeNull();
    expect((m as RegExpMatchArray)[1].toLowerCase()).toBe(expected.toLowerCase());
  });
});

/** `function NAME(...) { ... }` 를 index.html 에서 **통째로** 꺼낸다(중괄호 짝을 세어 끝을 찾는다).
 *  상수만 비교하면 "값은 같은데 계산 순서가 다른" 드리프트를 놓치기 때문에, 함수 자체를 꺼내
 *  실행해 출력을 맞춰 본다. 꺼낸 함수는 **자기완결**이어야 한다(바깥 스코프를 읽으면 여기서 터진다). */
function extractFunction(name: string): (...args: never[]) => unknown {
  const start = html.indexOf(`function ${name}(`);
  if (start < 0) {
    throw new Error(
      `index.html: "function ${name}(" 를 찾지 못했다 — 부팅 스크립트에서 이름이 바뀌었거나 사라졌다.`,
    );
  }
  let i = html.indexOf("{", start);
  let depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}" && --depth === 0) break;
  }
  const src = html.slice(start, i + 1);
  return new Function(`"use strict"; ${src}; return ${name};`)() as (...args: never[]) => unknown;
}

// PLAN-2026-09-12 §3/E3 — 배경 채도가 붙으면서 부팅 스크립트의 손 복제본이 상수 몇 개가 아니라
// **OKLab 변환 한 벌**을 품게 됐다. 값 비교로는 그 안의 드리프트를 잡을 수 없어서, 사본을 꺼내
// 실행해 TS 원본과 출력을 대조한다(둘 다 JS 라 부동소수 결과까지 같아야 한다 — 근사 비교 아님).
describe("index.html boot-appearance seed — bootCanvasColor 사본 (§3/E3)", () => {
  it("두 구현이 같은 색을 낸다 — 테마 × 밝기 × 어둡기 × 채도 전 범위", () => {
    const boot = extractFunction("bootCanvasColor") as (
      canvasHex: string,
      themeHex: string,
      bgTone: number,
      bgDim: number,
      bgSat: number,
    ) => string;
    const themes = ["dark", "light"] as const;
    let checked = 0;
    for (const theme of themes) {
      for (const tone of [BG_TONE_MIN, -5, 0, 5, BG_TONE_MAX]) {
        for (const dim of [0, 13, 40]) {
          for (const sat of [0, 1, 25, 50, 99, 100]) {
            const mine = bootCanvasColor(CANVAS_BASE[theme], THEME_COLOR[theme], tone, dim, sat);
            expect(boot(CANVAS_BASE[theme], THEME_COLOR[theme], tone, dim, sat)).toBe(mine);
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(180);
  });

  it("채도 0 은 무연산이다 — 기본값 사용자의 첫 페인트가 오늘과 픽셀 동일", () => {
    const boot = extractFunction("bootCanvasColor") as (
      a: string,
      b: string,
      c: number,
      d: number,
      e: number,
    ) => string;
    for (const theme of ["dark", "light"] as const) {
      expect(boot(CANVAS_BASE[theme], THEME_COLOR[theme], 0, 0, 0)).toBe(CANVAS_BASE[theme]);
    }
  });
});

// tokens.css 쪽 드리프트 — appearance.ts 의 THEME_COLOR/INK_BASE 는 CANVAS_BASE 와 같은 부류의
// "테마 상수 사본"이다(스타일시트가 없는 자리에서 쓰인다). 원본이 움직이면 여기서 잡는다.
const tokens = readFileSync("src/styles/tokens.css", "utf8");
/** tokens.css 를 :root(다크) / :root[data-theme='light'] 두 구역으로 가른다. */
const LIGHT_AT = tokens.indexOf(":root[data-theme='light']{");
const REGION: Record<"dark" | "light", string> = {
  dark: tokens.slice(0, LIGHT_AT),
  light: tokens.slice(LIGHT_AT),
};

function tokenValue(theme: "dark" | "light", name: string): string {
  const m = REGION[theme].match(new RegExp(`--${name}\\s*:\\s*([^;]+);`));
  if (!m) throw new Error(`tokens.css: ${theme} 구역에서 --${name} 를 찾지 못했다`);
  return m[1].trim();
}

describe("tokens.css ↔ appearance.ts 상수 사본 (PLAN-2026-09-12)", () => {
  it("LIGHT 구역을 실제로 찾았다(아래 단언들이 조용히 다크만 보지 않도록)", () => {
    expect(LIGHT_AT).toBeGreaterThan(0);
  });

  it("THEME_COLOR 가 tokens.css 의 --theme 과 같다", () => {
    expect(tokenValue("dark", "theme")).toBe(THEME_COLOR.dark);
    expect(tokenValue("light", "theme")).toBe(THEME_COLOR.light);
  });

  it("INK_BASE 가 tokens.css 의 --text/--muted/--faint 와 같다", () => {
    for (const theme of ["dark", "light"] as const) {
      const ink = INK_BASE[theme];
      expect(tokenValue(theme, "text")).toBe(ink.text);
      // --ink 는 --text 의 별칭 — applyCssVars 가 둘을 함께 덮으므로 값도 같아야 한다.
      expect(tokenValue(theme, "ink")).toBe(ink.text);
      // 알파는 **수치로** 비교한다 — CSS 는 `.80`, JS 는 `0.8` 로 적는 같은 값이다.
      const rgb = ink.text.slice(1).match(/../g)!.map((h) => parseInt(h, 16));
      const parse = (css: string) => {
        const m = css.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/);
        if (!m) throw new Error(`tokens.css: rgba(...) 형태가 아니다 — ${css}`);
        return { rgb: [+m[1], +m[2], +m[3]], alpha: parseFloat(m[4]) };
      };
      const muted = parse(tokenValue(theme, "muted"));
      expect(muted.rgb).toEqual(rgb);
      expect(muted.alpha).toBeCloseTo(ink.mutedAlpha, 5);
      const faint = parse(tokenValue(theme, "faint"));
      expect(faint.rgb).toEqual(rgb);
      expect(faint.alpha).toBeCloseTo(ink.faintAlpha, 5);
    }
  });

  it("BG_SAT_MAX_CHROMA 가 구분선 합성색의 채도다 — 상한의 근거 자체를 못 박는다", () => {
    // "배경은 머리카락 선보다 더 색을 띠지 않는다"(E3). --divider 는 두 테마 공통으로
    // color-mix(in srgb, var(--theme) 26%, transparent) 이고, 캔버스 위에 얹으면 26% 혼합이다.
    for (const theme of ["dark", "light"] as const) {
      const divider = mixHex(CANVAS_BASE[theme], THEME_COLOR[theme], 0.26);
      expect(hexToOklch(divider).C).toBeCloseTo(BG_SAT_MAX_CHROMA, 3);
    }
  });
});
