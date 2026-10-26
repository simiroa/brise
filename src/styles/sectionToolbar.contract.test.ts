import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("sectionToolbar contract", () => {
  const tokensCss = fs.readFileSync(path.resolve(__dirname, "tokens.css"), "utf-8");
  const sheetSectionCss = fs.readFileSync(
    path.resolve(__dirname, "../components/sheet/sheetSection.css"),
    "utf-8"
  );

  it("tokens.css defines --row-toolbar", () => {
    expect(tokensCss).toMatch(/--row-toolbar:\s*calc\(18px \+ 14px\*var\(--fs\)\);/);
  });

  it(".section-toolbar block has height:var(--row-toolbar)", () => {
    const sectionToolbarMatch = tokensCss.match(/\.section-toolbar\s*\{([^}]+)\}/);
    expect(sectionToolbarMatch).toBeTruthy();
    expect(sectionToolbarMatch![1]).toContain("height:var(--row-toolbar)");
  });

  it(".sheet-toolbar block does not use flex-wrap:wrap and has overflow-x:auto", () => {
    const sheetToolbarMatch = sheetSectionCss.match(/\.sheet-toolbar\s*\{([^}]+)\}/);
    expect(sheetToolbarMatch).toBeTruthy();
    expect(sheetToolbarMatch![1]).not.toContain("flex-wrap: wrap");
    expect(sheetToolbarMatch![1]).not.toContain("flex-wrap:wrap");
    expect(sheetToolbarMatch![1]).toContain("overflow-x: auto");
  });

  it("tokens.css defines .toolbar-btn--text", () => {
    expect(tokensCss).toContain(".toolbar-btn--text");
  });
});
