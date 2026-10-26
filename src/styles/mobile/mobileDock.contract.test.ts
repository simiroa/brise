import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// jsdom applies none of our CSS, so the rule text itself is what a behaviour test can pin (same approach as
// mobileCss.contract.test.ts). These are the CSS-only halves of the 2026-10-07 "C 두 상태" decision:
// keyboard closed = overview, keyboard open = body + dock.

// 주석을 먼저 걷는다 — 주석 속 셀렉터 이름이 "규칙이 있다/없다" 판정에 섞이면 안 된다.
const part = (name: string) => readFileSync(`src/styles/mobile/${name}.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
/** `.mobile-app[data-kbd="open"] …` 규칙 중 selector 목록에 `needle` 이 든 것의 본문. */
function kbdRuleBody(css: string, needle: string): string | null {
  for (const m of css.matchAll(/([^{}]*\.mobile-app\[data-kbd="open"\][^{}]*)\{([^}]*)\}/g)) {
    if (m[1].includes(needle)) return m[2];
  }
  return null;
}

describe('keyboard open (`.mobile-app[data-kbd="open"]`) — C 두 상태', () => {
  const tabbar = part("tabbar");
  it.each([".mobile-tabbar", ".mobile-note-badges", ".mobile-section-strip", ".mobile-input-chips"])(
    "hides %s",
    (sel) => {
      const body = kbdRuleBody(tabbar, `.mobile-app[data-kbd="open"] ${sel}`);
      expect(body, sel).not.toBeNull();
      expect(body).toMatch(/display:\s*none/);
    }
  );

  it("keeps the dock, the typing-nudge row and the presets (they live in the dock now)", () => {
    for (const keep of [".mobile-capture-bar", ".mobile-nudge-row", ".mobile-dock-slot", ".mobile-preset-row", ".mobile-note-fab"]) {
      expect(kbdRuleBody(tabbar, keep), `${keep} must not be hidden while typing`).toBeNull();
    }
  });

  it("slims the header but keeps the status-bar safe area", () => {
    const body = kbdRuleBody(part("note-header"), ".mobile-note-header");
    expect(body).not.toBeNull();
    expect(body).toMatch(/padding-top:\s*env\(safe-area-inset-top\)/);
    expect(body).toMatch(/padding-bottom:\s*0/);
  });
});

describe("dock layout", () => {
  const cap = part("note-capture");
  it("the tool slot takes the free width and scrolls sideways instead of wrapping", () => {
    expect(cap).toMatch(/\.mobile-dock-slot\s*\{[^}]*flex:\s*1;[^}]*min-width:\s*0;[^}]*overflow-x:\s*auto/);
    expect(cap).toMatch(/\.mobile-preset-row\s*\{[^}]*flex-wrap:\s*nowrap/);
  });

  it("✨ and 저장하기 left the dock (owner 2026-10-10) — their rules are gone, and the slot alone keeps the 48px row height", () => {
    expect(cap).not.toContain(".mobile-ai-bubble");
    expect(cap).not.toContain(".mobile-capture-save");
    expect(cap).toMatch(/\.mobile-dock-slot\s*\{[^}]*min-height:\s*48px/);
  });

  it("the old top toolbar row is gone", () => {
    expect(cap).not.toContain(".mobile-note-toolbar");
  });
});
