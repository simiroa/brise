import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUBBLE_GUTTER_PX, BUBBLE_GAP_PX } from "../../mobile/useNudgeBubblePlacement";

// jsdom applies none of our CSS, so the rule text is what a behaviour test can pin (same approach as
// mobileDock.contract.test.ts). These are the CSS halves of the date/region bubble (MobileNudgeBubble) —
// the placement math is in useNudgeBubblePlacement.test.ts, the wiring in MobileNudgeBubble.test.tsx.

const part = (name: string) => readFileSync(`src/styles/mobile/${name}.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const aids = part("note-editor-aids");

/** 정확히 이 selector 목록의 규칙 본문(중첩 없는 평평한 CSS 라고 가정 — 주석은 이미 걷었다). 줄바꿈·공백 차이는 무시한다. */
function body(css: string, selector: string): string {
  const flat = selector.replace(/\s*,\s*/g, ",").trim();
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (m[1].replace(/\s*,\s*/g, ",").replace(/\s+/g, " ").trim() === flat) return m[2];
  }
  throw new Error(`rule not found: ${selector}`);
}

describe("date/region bubble CSS", () => {
  it("is an absolute overlay at the stage origin, placed by transform (a `left` offset would shrink its width)", () => {
    const b = body(aids, ".mobile-nudge-bubble");
    expect(b).toMatch(/position:\s*absolute/);
    expect(b).toMatch(/left:\s*0/);
    expect(b).toMatch(/top:\s*0/);
    expect(b).toMatch(/width:\s*max-content/);
    expect(b).toMatch(/max-width:\s*calc\(100%\s*-\s*2\s*\*\s*var\(--m-gutter\)\)/);
    expect(b).toMatch(/z-index:\s*var\(--z-overlay\)/);
  });

  it("the TS gutter is the --m-gutter token (the clamp and the max-width must agree)", () => {
    const shell = readFileSync("src/styles/mobile/shell.css", "utf8");
    expect(shell).toMatch(new RegExp(`--m-gutter:\\s*${BUBBLE_GUTTER_PX}px`));
  });

  it("hidden / unmeasured stay in the DOM but invisible and untappable", () => {
    const b = body(aids, '.mobile-nudge-bubble[data-placement="hidden"], .mobile-nudge-bubble[data-placement="unmeasured"]');
    expect(b).toMatch(/visibility:\s*hidden/);
    expect(b).toMatch(/pointer-events:\s*none/);
  });

  it("the surface is the .overlay recipe but un-clipped, so the widened hit zones outside the 38px pill are tappable", () => {
    const b = body(aids, ".mobile-nudge-bubble .mobile-nudge-bubble-surface");
    expect(b).toMatch(/min-height:\s*38px/);
    expect(b).toMatch(/flex-wrap:\s*nowrap/); // 한 줄(2026-10-07 S22) — 두 줄이면 윗글 두 줄을 덮는다. 날짜를 짧게 줄여 맞춘다
    expect(b).toMatch(/overflow:\s*visible/);
    expect(b).toMatch(/border-radius:\s*var\(--radius-pill\)/);
  });

  it("tap targets are 48px high (32 + 8 + 8 hit zone) and the × is 48px wide (24 + 12 + 12)", () => {
    expect(body(aids, ".mobile-nudge-bubble-main, .mobile-nudge-bubble-x")).toMatch(/height:\s*32px/);
    const zone = body(aids, ".mobile-nudge-bubble-main::after, .mobile-nudge-bubble-x::after");
    expect(zone).toMatch(/top:\s*-8px/);
    expect(zone).toMatch(/bottom:\s*-8px/);
    expect(body(aids, ".mobile-nudge-bubble-x")).toMatch(/width:\s*24px/);
    const xZone = body(aids, ".mobile-nudge-bubble-x::after");
    expect(xZone).toMatch(/left:\s*-12px/);
    expect(xZone).toMatch(/right:\s*-12px/);
  });

  it("the tail never takes taps and flips with the placement", () => {
    expect(body(aids, ".mobile-nudge-bubble::after")).toMatch(/pointer-events:\s*none/);
    expect(aids).toMatch(/\.mobile-nudge-bubble\[data-placement="below"\]::after/);
  });

  it("the tail (9px rotated 45deg, ~5px outside) fits inside the gap the placement math leaves", () => {
    expect(BUBBLE_GAP_PX).toBeGreaterThanOrEqual(6);
  });

  it("is never hidden by the keyboard-open rules (it only exists while a suggestion does; typing is when it matters)", () => {
    const tabbar = part("tabbar");
    for (const m of tabbar.matchAll(/([^{}]*\.mobile-app\[data-kbd="open"\][^{}]*)\{([^}]*)\}/g)) {
      expect(m[1], "keyboard-open rule must not touch the bubble").not.toContain("mobile-nudge-bubble");
    }
  });
});
