import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// W6: specs/features/mobile.yaml's tablet-portrait-notice entry (D3 — "gray out nothing, just a
// 1-line CSS banner that disappears on rotation") needs a verify path per check:features, but the
// feature itself is deliberately CSS-only (JS 0 lines, 0 state — see App.tsx's own comment next to
// `.tablet-portrait-banner`). Same shape as sectionToolbar.contract.test.ts: read the stylesheet as
// text and assert on the rule rather than rendering anything, since there's no DOM behavior here to
// mount for.
describe("tablet portrait banner contract (D3, W5/W6)", () => {
  const tokensCss = fs.readFileSync(path.resolve(__dirname, "tokens.css"), "utf-8");
  const appTsx = fs.readFileSync(path.resolve(__dirname, "../App.tsx"), "utf-8");

  it("tokens.css shows the banner only under orientation:portrait + min-width:768px + pointer:coarse", () => {
    expect(tokensCss).toMatch(
      /@media \(orientation: portrait\) and \(min-width: 768px\) and \(pointer: coarse\)\s*\{\s*\.tablet-portrait-banner\{/,
    );
  });

  it("tokens.css hides the banner by default (display:none outside the media query)", () => {
    expect(tokensCss).toContain(".tablet-portrait-banner{display:none}");
  });

  it("App.tsx renders the banner unconditionally (no browser/JS gate — the CSS alone decides visibility)", () => {
    expect(appTsx).toContain('<div className="tablet-portrait-banner overlay">{t("common.tablet_rotate_hint")}</div>');
  });
});
