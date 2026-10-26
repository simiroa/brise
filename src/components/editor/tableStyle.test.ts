import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Owner QA 6, item 6 ("표 컬럼 비율이 내장 텍스트길이에 따라 바뀌는데" — table columns should be
// equal-width by default, not sized by cell content). The fix lives entirely in tokens.css
// (table-layout:fixed on the table rule, overflow-wrap on th/td) — extension-table always renders
// a <colgroup>/<col> per column regardless of our `resizable:false` config, but with no colwidth
// ever set, table-layout:fixed is what makes the browser split the table's own width equally
// across those width-less columns instead of sizing them off cell content.
//
// tokens.css isn't loaded/cascaded in this project's component tests (no jsdom stylesheet
// pipeline), so this asserts directly against the source rule text rather than a computed style —
// a real regression guard: if the table-layout:fixed declaration is ever removed or the selector
// stops covering both `.ProseMirror table` (live editor) and `.mdbody table` (read-only previews,
// ghost preview, exports), this fails.

const tokensCssPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "styles",
  "tokens.css"
);
const css = readFileSync(tokensCssPath, "utf8");

/** Extracts the declaration block for a selector list that starts with the given prefix
 *  (tokens.css is minified to one rule per line, not one selector per line). */
function ruleFor(selectorPrefix: string): string {
  const lineStart = css.indexOf(selectorPrefix);
  expect(lineStart, `selector "${selectorPrefix}" not found in tokens.css`).toBeGreaterThanOrEqual(0);
  const openBrace = css.indexOf("{", lineStart);
  const closeBrace = css.indexOf("}", openBrace);
  return css.slice(openBrace + 1, closeBrace);
}

describe("tokens.css — table equal-column layout (owner QA 6, item 6)", () => {
  it("the table rule covers both the live editor and read-only .mdbody previews, and sets table-layout:fixed + width:100%", () => {
    const rule = ruleFor(".ProseMirror table, .mdbody table");
    expect(rule).toContain("table-layout:fixed");
    expect(rule).toContain("width:100%");
  });

  it("th/td wrap long content instead of exploding the (now fixed) column", () => {
    const rule = ruleFor(".ProseMirror th, .mdbody th, .ProseMirror td, .mdbody td");
    expect(rule).toContain("overflow-wrap:break-word");
  });
});

// Table markdown round-trip is unaffected by this CSS-only fix — no colwidth or other per-column
// value gets attached to nodes/attrs, so there's nothing new for the markdown serializer to
// persist. Table round-trip itself is already covered end-to-end by mdSerialize.test.ts's table
// cases (byte-identical double round-trip, JSON shape after reload); not re-asserted here.
