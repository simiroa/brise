import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EQ_BARS, EQ_FLOOR } from "../mobile/recEqualizerMath";

// jsdom applies none of our CSS, so the rule text itself is what a test can pin (same approach as
// mobile/mobileDock.contract.test.ts). 폰 배경 신호(MobileAmbient) — AI 빛줄기 + 녹음 이퀄라이저 띠.

const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const ambient = strip(readFileSync("src/styles/mobileAmbient.css", "utf8"));
const tokens = strip(readFileSync("src/styles/tokens.css", "utf8"));

/** 그 셀렉터를 (목록의 일부로든 단독으로든) 쓰는 규칙 전부의 본문을 이어 붙인다. 중첩 없는 `a, b { … }` 형태만 본다. */
function rule(css: string, selector: string): string {
  const bodies: string[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(",").some((s) => s.trim() === selector)) bodies.push(m[2]);
  }
  if (bodies.length === 0) throw new Error(`rule not found: ${selector}`);
  return bodies.join("\n");
}
/** `@media (prefers-reduced-motion: reduce) { … }` 의 본문(중괄호 짝 맞춤). */
function reducedMotionBody(css: string): string {
  const at = css.indexOf("@media (prefers-reduced-motion: reduce)");
  if (at < 0) throw new Error("no reduced-motion block");
  let i = css.indexOf("{", at) + 1;
  const start = i;
  for (let depth = 1; i < css.length && depth > 0; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
  }
  return css.slice(start, i - 1);
}
/** 정규식이 가리키는 곳 뒤 첫 `{` 로 시작하는 블록의 본문(중괄호 짝 맞춤) — 토큰 파일처럼 중첩·긴 값이 섞인 곳용. 줄바꿈(LF/CRLF)에 무관. */
function blockBody(css: string, opener: RegExp): string {
  const m = opener.exec(css);
  if (!m) throw new Error(`block not found: ${opener}`);
  let i = css.indexOf("{", m.index) + 1;
  const start = i;
  for (let depth = 1; i < css.length && depth > 0; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") depth--;
  }
  return css.slice(start, i - 1);
}
/** 어느 블록 안의 `--name: value;` 첫 값(문자열). */
function tokenIn(body: string, name: string): string {
  const m = body.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  if (!m) throw new Error(`token not found: ${name}`);
  return m[1].trim();
}

describe("mobileAmbient.css — layer", () => {
  const root = rule(ambient, ".mobile-ambient");
  it("is a fixed, touch-transparent layer just above the modal scrim and below toasts", () => {
    expect(root).toMatch(/position:\s*fixed/);
    expect(root).toMatch(/inset:\s*0/);
    expect(root).toMatch(/pointer-events:\s*none/);
    expect(root).toMatch(/z-index:\s*calc\(var\(--z-modal\)\s*\+\s*1\)/);
  });

  it("holds no colour literals — colours come from tokens.css only", () => {
    expect(ambient).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(ambient).not.toMatch(/\b(?:rgba?|hsla?)\(/);
  });

  it("the AI beam host only overrides the two opacity variables (and sizes itself)", () => {
    const body = rule(ambient, ".mobile-ambient-beam");
    const decls = body.split(";").map((d) => d.trim()).filter(Boolean).map((d) => d.split(":")[0].trim());
    expect(decls.sort()).toEqual(["--ai-beam-inner-opacity", "--ai-beam-stroke-opacity", "height", "width"].sort());
  });
});

describe("mobileAmbient.css — recording equalizer", () => {
  it("is a bottom band, not an edge glow: anchored to the bottom, as tall as the token, touch-transparent by inheritance", () => {
    const body = rule(ambient, ".mobile-rec-eq");
    expect(body).toMatch(/bottom:\s*0/);
    expect(body).toMatch(/left:\s*0/);
    expect(body).toMatch(/right:\s*0/);
    expect(body).toMatch(/height:\s*var\(--rec-eq-height\)/);
    expect(body).not.toMatch(/pointer-events:\s*auto/);
  });

  it("each column grows from the bottom and is driven by --eq-h alone (scaleY, bottom origin, compositor-only)", () => {
    const body = rule(ambient, ".mobile-rec-bar");
    expect(body).toMatch(/transform-origin:\s*50%\s+100%/);
    expect(body).toMatch(/transform:\s*scaleY\(var\(--eq-h,\s*var\(--rec-eq-rest\)\)\)/);
    expect(body).toMatch(/will-change:\s*transform/);
    expect(body).toMatch(/transition:\s*transform\s+var\(--dur-fast\)/);
    // feathered by gradients (soft on every side), not by a filter
    expect(body).toMatch(/radial-gradient\(ellipse[^)]*var\(--rec-eq-core\)/);
    expect(body).toMatch(/radial-gradient\(ellipse[^)]*var\(--rec-eq-halo\)/);
  });

  it("columns overlap their neighbours by half a slot (two-slot width centred on slot i)", () => {
    const body = rule(ambient, ".mobile-rec-bar");
    expect(body).toMatch(/left:\s*calc\(\(var\(--i\)\s*-\s*0\.5\)\s*\/\s*var\(--n\)\s*\*\s*100%\)/);
    expect(body).toMatch(/width:\s*calc\(2\s*\/\s*var\(--n\)\s*\*\s*100%\)/);
  });

  it("animates only compositor properties (opacity/transform): no filter, and every transition is on one of them", () => {
    const frames = [...ambient.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)];
    expect(frames.length).toBeGreaterThanOrEqual(1);
    for (const [, name, body] of frames) {
      const props = [...body.matchAll(/([\w-]+)\s*:/g)].map((m) => m[1]);
      for (const p of props) expect(["opacity", "transform"], `${name}: ${p}`).toContain(p);
    }
    expect(ambient).not.toMatch(/filter\s*:/);
    for (const m of ambient.matchAll(/transition\s*:\s*([^;]+);/g)) {
      const first = m[1].trim().split(/\s+/)[0];
      expect(["opacity", "transform", "none"], `transition: ${m[1]}`).toContain(first);
    }
  });

  it("the old edge glow, grain and breathing are gone", () => {
    expect(ambient).not.toMatch(/mobile-rec-(glow|grain|pulse)|mobile-rec-breathe/);
    expect(ambient).not.toMatch(/--rec-glow-/);
    expect(tokens).not.toMatch(/--rec-glow-/);
  });

  it("prefers-reduced-motion: no entry animation, no transition, a static low band (per-column height from --g)", () => {
    const body = reducedMotionBody(ambient);
    expect(body).toMatch(/\.mobile-rec\s*\{\s*animation:\s*none/);
    expect(body).toMatch(/\.mobile-rec-bar\s*\{[^}]*transition:\s*none/);
    expect(body).toMatch(/\.mobile-rec-bar\s*\{[^}]*transform:\s*scaleY\(calc\(var\(--rec-eq-static\)\s*\*\s*var\(--g\)\)\)/);
  });

  it("while AI is busy the band is dimmed so the two never stack loudly", () => {
    expect(ambient).toMatch(/\.mobile-ambient\[data-ai="on"\]\s+\.mobile-rec\[data-rec="on"\]\s*\{[^}]*--rec-eq-ai-dim/);
  });

  it("paused dims the whole layer (the JS loop is what freezes the columns); stopping fades it out", () => {
    expect(ambient).toMatch(/\.mobile-rec\[data-rec="paused"\]\s*\{[^}]*--rec-eq-paused-opacity/);
    expect(ambient).toMatch(/\.mobile-rec\[data-rec="fading"\]\s*\{[^}]*opacity:\s*0/);
    expect(rule(ambient, ".mobile-rec")).toMatch(/transition:\s*opacity/);
  });
});

describe("tokens.css — REC-EQ", () => {
  const USED = [
    "--rec-eq-core", "--rec-eq-halo", "--rec-eq-height", "--rec-eq-rest", "--rec-eq-static",
    "--rec-eq-paused-opacity", "--rec-eq-ai-dim",
  ];
  it.each(USED)("%s is defined and consumed by mobileAmbient.css", (name) => {
    expect(tokens).toContain(`${name}:`);
    expect(ambient).toContain(`var(${name})`);
  });

  const dark = blockBody(tokens, /:root\s*\{\s*--rec-eq-core/);
  const light = blockBody(tokens, /:root\[data-theme='light'\]\s*\{\s*--rec-eq-core/);

  it("every colour token has a light-theme value", () => {
    for (const name of ["--rec-eq-core", "--rec-eq-halo"]) expect(light).toContain(`${name}:`);
  });

  it("the band is thin: at most 20% of the viewport at its tallest, and the resting height matches the loop's floor", () => {
    const h = tokenIn(dark, "--rec-eq-height");
    expect(h).toMatch(/^\d+(\.\d+)?%$/);
    expect(parseFloat(h)).toBeLessThanOrEqual(20); // 14% 는 S22 실기에서 거의 안 보였다(2026-10-08)
    expect(parseFloat(tokenIn(dark, "--rec-eq-rest"))).toBeCloseTo(EQ_FLOOR, 5);
    expect(parseFloat(tokenIn(dark, "--rec-eq-static"))).toBeLessThan(0.5);
  });

  it("the column count is a soft 20–28 and the band is built from exactly the tokens above", () => {
    expect(EQ_BARS).toBeGreaterThanOrEqual(20);
    expect(EQ_BARS).toBeLessThanOrEqual(28);
  });

  // ── 대비 증명 ───────────────────────────────────────────────────────────────────────────────
  // 이 레이어는 시트(불투명 .overlay) 위에 얹힌다. 띠가 겹치는 일시정지·완료·취소 버튼은 글자와 면이 함께 물든다.
  // 가장 센 자리(띠 바닥, 코어+할로 중첩)의 합성 알파로 글자(--text)와 시트 면(--app-canvas)을 같이 물들여
  // WCAG 대비가 본문 AA(4.5:1)를 지키는지 토큰 값 그대로 계산한다.
  type RGB = [number, number, number];
  const hex = (s: string): RGB => {
    const h = s.replace("#", "");
    const v = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16)) as RGB;
  };
  const rgba = (s: string): { c: RGB; a: number } => {
    const m = s.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/);
    if (!m) throw new Error(`not rgba: ${s}`);
    return { c: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] };
  };
  const lin = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = ([r, g, b]: RGB) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const ratio = (a: RGB, b: RGB) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const over = (fg: RGB, a: number, bg: RGB): RGB => fg.map((c, i) => c * a + bg[i] * (1 - a)) as RGB;

  /** 띠 바닥 한 점에서 코어 위에 할로가 겹친 합성 — 알파와 유효색. */
  function peak(body: string): { a: number; c: RGB } {
    const core = rgba(tokenIn(body, "--rec-eq-core"));
    const halo = rgba(tokenIn(body, "--rec-eq-halo"));
    const a = core.a + halo.a * (1 - core.a);
    const c = core.c.map((v, i) => (v * core.a + halo.c[i] * halo.a * (1 - core.a)) / a) as RGB;
    return { a, c };
  }
  // 시트 면·글자 — 다크는 첫 :root, 라이트는 :root[data-theme='light'] 블록의 값.
  const darkRoot = blockBody(tokens, /:root\s*\{/);
  const lightRoot = blockBody(tokens, /:root\[data-theme='light'\]\s*\{/);
  const THEMES = [
    { name: "dark", cap: 0.3, band: dark, canvas: hex(tokenIn(darkRoot, "--app-canvas")), text: hex(tokenIn(darkRoot, "--text")) },
    { name: "light", cap: 0.19, band: light, canvas: hex(tokenIn(lightRoot, "--app-canvas")), text: hex(tokenIn(lightRoot, "--text")) },
  ];

  it.each(THEMES)("$name: even at the band's strongest point the sheet's button text keeps AA contrast", ({ band, canvas, text, cap }) => {
    const { a, c } = peak(band);
    expect(a).toBeLessThanOrEqual(cap); // 상한을 따로 못 박아 토큰이 슬쩍 올라가는 걸 막는다(다크는 대비 여유가 커서 한 단 높다)
    const after = ratio(over(c, a, text), over(c, a, canvas));
    expect(after).toBeGreaterThanOrEqual(4.5);
    // AA 에 1.5 여유 — 시트 면은 사용자 설정(배경 어둡게·강조색)으로 조금씩 움직이므로 계산값 그대로의 경계선에 두지 않는다.
    expect(after).toBeGreaterThanOrEqual(6);
  });
});
