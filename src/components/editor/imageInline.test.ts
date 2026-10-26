import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

// Owner QA 6, item 7 (multiple images per line): the SCHEMA-level proof (two images end up as
// siblings in one paragraph and survive a byte-identical round-trip) lives in
// src/lib/mdSerialize.test.ts's "9b." case — that's the behavior the owner actually cares about.
// This file covers the DOM/CSS wiring that behavior depends on: ReactNodeViewRenderer only
// switches ImageNodeView's OUTER wrapper element to <span> automatically once the node is
// inline (checked indirectly by the schema test above actually working); the INNER wrapper
// (rendered by ImageNodeView.tsx itself, and its CSS) has to be updated by hand to match, which
// is what regresses silently if someone reverts the JSX/CSS without reverting the schema flag.
// Source-text assertions (same pattern as EditorPanel.colorSchema.test.tsx) rather than mounting
// a live NodeView — that needs ReactNodeViewRenderer's own context provider, which isn't
// constructible from outside the library.
describe("ImageNodeView wrapper is span/inline-block, not div/block (item 7)", () => {
  const nodeViewSrc = readFileSync("src/components/editor/ImageNodeView.tsx", "utf8");
  const tokensCss = readFileSync("src/styles/tokens.css", "utf8");

  it("NodeViewWrapper renders as=\"span\" (a <div> here would nest inside the outer inline <span> ProseMirror places in the doc)", () => {
    expect(nodeViewSrc).toMatch(/<NodeViewWrapper\s+as="span"/);
  });

  it("the inner width-carrying wrapper is a <span>, not a <div>", () => {
    expect(nodeViewSrc).toMatch(/<span\s*\n?\s*ref=\{wrapRef\}/);
    expect(nodeViewSrc).not.toMatch(/<div\s*\n?\s*ref=\{wrapRef\}/);
  });

  it("tokens.css sizes .brise-image-node/.brise-image-wrap as inline-block, not block", () => {
    expect(tokensCss).toMatch(/\.brise-image-node\s*\{[^}]*display:\s*inline-block/);
    expect(tokensCss).toMatch(/\.brise-image-wrap\s*\{[^}]*display:\s*inline-block/);
  });
});
