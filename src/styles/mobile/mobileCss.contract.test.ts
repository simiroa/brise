import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// vitest stubs CSS imports, so a typo in an @import path would pass every other test. These checks
// read the stylesheet sources directly (vitest cwd = repo root, like the other src/styles contract tests).

const ENTRY = "src/styles/mobile.css";
const PARTS_DIR = "src/styles/mobile";
const entry = readFileSync(ENTRY, "utf8");
const imports = [...entry.matchAll(/@import "\.\/(mobile\/[\w-]+\.css)";/g)].map((m) => m[1]);
const part = (name: string) => readFileSync(`${PARTS_DIR}/${name}.css`, "utf8");
const order = (name: string) => imports.indexOf(`mobile/${name}.css`);

describe("mobile.css entry", () => {
  it("is imports only — no rules of its own (they would cascade after every part)", () => {
    const body = entry.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@import "[^"]+";/g, "").trim();
    expect(body).toBe("");
  });

  it("imports every part file exactly once, and every import exists", () => {
    const onDisk = readdirSync(PARTS_DIR).filter((f) => f.endsWith(".css")).map((f) => `mobile/${f}`).sort();
    expect(new Set(imports).size).toBe(imports.length);
    expect([...imports].sort()).toEqual(onDisk);
    for (const rel of imports) expect(existsSync(`src/styles/${rel}`), rel).toBe(true);
  });

  // Same-specificity rules resolve by position; each pair below is a part restyling a class an
  // earlier part defines (or a catch-all that must come last), so the order is the contract.
  it("keeps the cascade-order dependencies between parts", () => {
    const before: [string, string][] = [
      ["shell", "lists-cards"], // role-ramp tokens + root reset first
      ["tabbar", "reduced-motion"], // .mobile-tab-icon transition
      ["note-header", "reduced-motion"], // .mobile-icon-btn transition
      ["overlays", "editor-touch"], // diagram action rows reuse mobile-sheet-up
      ["notes-tab", "notes-tab-filters"], // .mobile-tree-row, then its --section/--note refinements
      ["modal-contents", "note-views"], // .mobile-filter-pill, reused by timeline/gallery chips
      ["lists-cards", "note-views"], // .mobile-card, then .mobile-calendar-note.mobile-card
    ];
    for (const [a, b] of before) {
      expect(order(a), `${a} is imported`).toBeGreaterThanOrEqual(0);
      expect(order(a), `${a} must come before ${b}`).toBeLessThan(order(b));
    }
  });
});

// jsdom applies none of our CSS, so the rule text itself is what a behaviour test can pin. These two
// used to be asserted against the monolithic mobile.css (MobileNote.test.tsx / MobileNoteTree.test.tsx).
describe("rules other tests depend on", () => {
  it("the diagram view-tools row (폭 맞춤/확대/축소) is removed from the mobile surface", () => {
    // Losing it strands a zoomed-out user: `zoom` starts null (=fit) and the ± buttons only ever set
    // a number, so only 폭 맞춤 returns to fit.
    expect(part("editor-touch")).toMatch(
      /\.mobile-diagram-host \[data-testid="diagram-view-tools"\]\s*\{[^}]*display:\s*none/
    );
  });

  it("overrides .treeact's hover-only opacity so the row badges are visible without :hover (Δ3 fix)", () => {
    expect(part("notes-tab-filters")).toMatch(/\.mobile-app\s+\.treeact\s*\{\s*opacity:\s*1\s*;?\s*\}/);
  });
});
