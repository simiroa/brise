import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// vitest stubs CSS imports and jsdom applies none of our CSS, so the layout of the phone sheet (full-bleed like the
// diagram host, filling the note stage) can only be pinned by reading the rule text. Same approach as
// mobileCss.contract.test.ts (vitest cwd = repo root).

const read = (path: string) => readFileSync(path, "utf8");
const sheet = read("src/styles/mobile/sheet.css");
const noteCapture = read("src/styles/mobile/note-capture.css");
const entry = read("src/styles/mobile.css");

/** Body of the first rule whose selector list (whitespace-collapsed) equals `selector`, comments stripped. */
function rule(css: string, selector: string): string {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of stripped.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (m[1].replace(/\s+/g, " ").trim() === selector) return m[2];
  }
  throw new Error(`no rule for selector: ${selector}`);
}

describe("sheet.css is wired into the mobile entry", () => {
  const imports = [...entry.matchAll(/@import "\.\/(mobile\/[\w-]+\.css)";/g)].map((m) => m[1]);

  it("is imported exactly once, after note-capture.css and editor-touch.css", () => {
    expect(imports.filter((i) => i === "mobile/sheet.css")).toHaveLength(1);
    const at = imports.indexOf("mobile/sheet.css");
    expect(at).toBeGreaterThan(imports.indexOf("mobile/note-capture.css"));
    expect(at).toBeGreaterThan(imports.indexOf("mobile/editor-touch.css"));
  });
});

describe("full-bleed sheet host (same idea as .mobile-diagram-host)", () => {
  it("pushes the gutter out with a negative inline margin and is a flex column that may shrink", () => {
    const body = rule(sheet, ".mobile-sheet-host");
    expect(body).toMatch(/margin-inline:\s*calc\(-1 \* var\(--m-gutter\)\)/);
    expect(body).toMatch(/display:\s*flex/);
    expect(body).toMatch(/flex-direction:\s*column/);
    // MobileNoteBody's inline `minHeight: 300` would otherwise push the edit bar below the fold when the keyboard is up.
    expect(body).toMatch(/min-height:\s*0\s*!important/);
  });

  it("mirrors the diagram host's gutter trick (so both sections bleed identically)", () => {
    const diagram = rule(read("src/styles/mobile/editor-touch.css"), ".mobile-diagram-host");
    expect(diagram).toMatch(/margin-inline:\s*calc\(-1 \* var\(--m-gutter\)\)/);
  });
});

describe("note body scroller around a sheet", () => {
  const WRAP = ".mobile-note-stage .mobile-note-body-wrap:has(> .mobile-sheet-host)";

  it("drops its vertical padding so the host fills the stage — and beats note-capture's padding-bottom by specificity", () => {
    expect(rule(sheet, WRAP)).toMatch(/padding-block:\s*0\s*;/);
    // The stage rule is `.mobile-note-stage .mobile-note-body-wrap` = (0,2,0). :has(> .x) adds (0,1,0), so (0,3,0) wins
    // regardless of import order. If this selector loses `.mobile-note-stage`, it drops to (0,2,0) and order decides.
    expect(noteCapture).toMatch(/\.mobile-note-stage \.mobile-note-body-wrap\s*\{[^}]*padding-bottom:\s*var\(--m-fab-clear\)/);
  });

  it("stays a scroller (no overflow:hidden) — attachments render after the sheet host in the same box", () => {
    expect(rule(sheet, WRAP)).not.toMatch(/overflow/);
  });

  it("gives the bottom clearance back to the attachment list that now ends the scroller (thin when the FAB lives in the dock)", () => {
    expect(rule(sheet, `${WRAP} .mobile-attach-section`)).toMatch(/padding-bottom:\s*var\(--m-fab-clear\)/);
    expect(
      rule(sheet, `.mobile-note-stage[data-fab="dock"] .mobile-note-body-wrap:has(> .mobile-sheet-host) .mobile-attach-section`)
    ).toMatch(/padding-bottom:\s*var\(--space-5\)/);
  });

  it("the stage really carries data-fab=dock on sheet sections (the thin clearance keys off it)", () => {
    expect(noteCapture).toMatch(/\.mobile-note-stage\[data-fab="dock"\] \.mobile-note-body-wrap\s*\{/);
    expect(read("src/mobile/MobileNote.tsx")).toMatch(/data-fab=/);
  });

  it("--m-fab-clear is still declared on .mobile-note-stage (the variable is the contract with the FAB)", () => {
    expect(noteCapture).toMatch(/\.mobile-note-stage\s*\{[^}]*--m-fab-clear:\s*\d+px/);
  });
});

describe("sheet root and grid scroller", () => {
  it("the sheet paints no frame: no border, radius, background or shadow (surface contract + owner feedback)", () => {
    const body = rule(sheet, ".mobile-sheet-editor");
    expect(body).not.toMatch(/border|radius|background|shadow/);
    expect(body).toMatch(/flex:\s*1\s*;/);
    expect(body).toMatch(/min-height:\s*0/);
  });

  it("the grid fills the stage's height and scrolls itself: min-height 0, bottom clearance inside, no horizontal chaining", () => {
    const body = rule(sheet, ".mobile-sheet-grid-container");
    expect(body).toMatch(/min-height:\s*0/);
    // Default = the full FAB clearance (fail-safe if the data-fab attribute is renamed); dock mode = thin.
    expect(body).toMatch(/padding-bottom:\s*var\(--m-fab-clear\)/);
    expect(rule(sheet, '.mobile-note-stage[data-fab="dock"] .mobile-sheet-grid-container')).toMatch(
      /padding-bottom:\s*var\(--space-5\)/
    );
    expect(body).toMatch(/overscroll-behavior-x:\s*contain/);
  });

  it("frozen header hairlines survive scrolling: separate borders, because collapsed borders of sticky cells scroll away", () => {
    const body = rule(sheet, ".mobile-sheet-grid-container table");
    // `!important` is load-bearing — MobileSheetGrid sets `borderCollapse: "collapse"` inline.
    expect(body).toMatch(/border-collapse:\s*separate\s*!important/);
    expect(body).toMatch(/border-spacing:\s*0/);
    expect(read("src/mobile/MobileSheetGrid.tsx")).toMatch(/borderCollapse:\s*"collapse"/);
  });
});

describe("toolbar", () => {
  it("is a slim gutter-aligned row without a band: no background, no border", () => {
    const body = rule(sheet, ".mobile-sheet-toolbar");
    expect(body).toMatch(/padding-inline:[^;]*var\(--m-gutter\)/);
    expect(body).not.toMatch(/background|border/);
  });

  it("keeps 48px touch targets for the text tools", () => {
    expect(rule(sheet, ".mobile-sheet-tool")).toMatch(/min-height:\s*48px/);
  });

  it("is dropped while the on-screen keyboard is open (same rule as the tab bar / chip rows)", () => {
    expect(rule(sheet, '.mobile-app[data-kbd="open"] .mobile-sheet-toolbar')).toMatch(/display:\s*none/);
  });
});

describe("cell edit bar dock", () => {
  const bar = rule(sheet, ".mobile-sheet-editbar.overlay");

  it("is a full-width dock: top hairline only, no radius, no scale-pop animation", () => {
    expect(bar).toMatch(/border-width:\s*1px 0 0/);
    expect(bar).toMatch(/border-radius:\s*0/);
    expect(bar).toMatch(/animation:\s*none/);
  });

  it("has no z-index: the dock's ＋ speed dial (z-overlay, opens upward over the body) must paint above it", () => {
    expect(bar).not.toMatch(/z-index/);
    expect(bar).not.toMatch(/position:/);
    // The dial layer really is at --z-overlay, anchored to the dock bar (if it moves, revisit this).
    expect(rule(noteCapture, ".mobile-speed-dial-layer")).toMatch(/z-index:\s*var\(--z-overlay\)/);
  });

  it("its buttons are thumb-sized (2026-10-07 리뷰: 조각 21×17px, 확인 40×26px 이었다) and the confirm keeps the primary tokens", () => {
    const snippet = rule(sheet, ".mobile-sheet-snippet");
    expect(snippet).toMatch(/min-width:\s*44px/);
    expect(snippet).toMatch(/min-height:\s*44px/);
    expect(rule(sheet, ".mobile-sheet-snippets")).toMatch(/overflow-x:\s*auto/);
    const confirm = rule(sheet, ".mobile-sheet-confirm");
    expect(confirm).toMatch(/width:\s*48px/);
    expect(confirm).toMatch(/height:\s*48px/);
    expect(confirm).toMatch(/background:\s*var\(--btn-primary-bg\)/);
    expect(confirm).toMatch(/color:\s*var\(--btn-primary-fg\)/);
  });
});
