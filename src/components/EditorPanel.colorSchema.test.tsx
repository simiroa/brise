import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

// Bug: ColorButton's setColor() rendered fine in the live DOM but was silently stripped on the
// very next autosave/reload. Root cause: mdSerialize.ts's BriseTextStyle (TextStyle.extend with
// a renderMarkdown that keeps the color attr) already existed and was already covered by
// mdSerialize.test.ts's "color span round-trips" case — but EditorPanel.tsx's LIVE editor
// (the one mdSerializeEditor is actually called on, in onUpdate/flushRef) registered plain stock
// TextStyle instead, a second, out-of-sync copy of the schema. The existing round-trip test kept
// passing throughout because it only ever exercised mdSerialize.ts's own (already-correct)
// schema, never EditorPanel's — so a full green test suite coexisted with a broken feature.
//
// A source-text assertion (same pattern as src/mobile/MobileNote.test.tsx's CSS check) is used
// here rather than mounting EditorPanel: the live extensions array isn't exported (by design —
// see the file's own "PREVIEW_EXTENSIONS mirrors the live editor's schema" comment), and mounting
// the full component needs a note/IPC/store harness with no bearing on this specific regression.
//
// Wave R1-b dedup: the live editor no longer lists BriseTextStyle (or any of the other
// schema-affecting extensions) inline — it spreads editorExtensions.ts's PREVIEW_EXTENSIONS,
// which is built by mdSerialize.ts's markdownSchemaExtensions. So the regression guard now checks
// both ends of that indirection: EditorPanel.tsx actually spreads PREVIEW_EXTENSIONS (not some
// re-forked local list), and the builder it ultimately comes from registers BriseTextStyle, not
// stock TextStyle.
describe("EditorPanel live editor registers the round-trip-safe TextStyle variant", () => {
  const editorPanelSrc = readFileSync("src/components/EditorPanel.tsx", "utf8"); // vitest cwd = repo root
  const mdSerializeSrc = readFileSync("src/lib/mdSerialize.ts", "utf8");

  it("live editor spreads PREVIEW_EXTENSIONS, not a re-forked local list", () => {
    expect(editorPanelSrc).toMatch(/import\s*\{[^}]*PREVIEW_EXTENSIONS[^}]*\}\s*from\s*"\.\.\/lib\/editorExtensions"/);
    const liveExtensions = editorPanelSrc.slice(
      editorPanelSrc.indexOf("const editor = useEditor("),
      editorPanelSrc.indexOf("content: \"\","),
    );
    expect(liveExtensions).toMatch(/\.\.\.PREVIEW_EXTENSIONS/);
    // Stock TextStyle must not be imported directly anymore — that was the bug: two schemas,
    // only one of which (mdSerialize.ts's) had the color-preserving renderMarkdown.
    expect(editorPanelSrc).not.toMatch(/from\s*"@tiptap\/extension-text-style"/);
  });

  it("markdownSchemaExtensions (PREVIEW_EXTENSIONS' builder) registers BriseTextStyle, not bare TextStyle", () => {
    const builder = mdSerializeSrc.slice(
      mdSerializeSrc.indexOf("export function markdownSchemaExtensions("),
      mdSerializeSrc.indexOf("export function createMarkdownSchemaExtensions("),
    );
    expect(builder).toMatch(/\bBriseTextStyle\b/);
    // A bare `TextStyle,` entry (not `BriseTextStyle,`) would silently reintroduce the bug. `\b`
    // alone already excludes the "TextStyle" tail inside "BriseTextStyle," (no word boundary
    // between "e" and "T" there), so this only fires on a real standalone `TextStyle,`.
    expect(builder).not.toMatch(/\bTextStyle,/);
  });
});

// Bug: portalling LinkButton/ColorButton's popovers to <body> (buttons.tsx's useFloatingPopover,
// moved to toolbar/popover.ts — fixes the two items above) made them DOM siblings of the
// selection BubbleMenu instead of descendants of its own floating `element`. The BubbleMenu's
// shouldShow (below) was hiding it — and therefore the LinkButton/ColorButton trigger buttons
// themselves — the instant a popover's autoFocus'd input or a swatch button took DOM focus,
// since `element.contains(document.activeElement)` went from true to false at exactly that
// moment. `[data-editor-pop]` closes that gap: both popovers carry it, and shouldShow treats
// focus anywhere under it as "still in this menu". Guarded here (not by mounting the full
// BubbleMenu, which needs a live ProseMirror view + ResizeObserver + floating-ui — more harness
// than this specific wiring question needs) the same way the schema check above is.
//
// Owner QA 6, item 8 code split: shouldShow now lives in toolbar/TextBubbleMenu.tsx (moved out
// of EditorPanel.tsx along with the rest of the selection BubbleMenu), and both popovers live in
// toolbar/buttons.tsx.
describe("selection BubbleMenu's shouldShow recognizes portalled popovers", () => {
  const buttonsSrc = readFileSync("src/components/editor/toolbar/buttons.tsx", "utf8");
  const textBubbleMenuSrc = readFileSync("src/components/editor/toolbar/TextBubbleMenu.tsx", "utf8");

  it("LinkButton, ColorButton, and TableButton popovers carry the data-editor-pop marker", () => {
    const matches = buttonsSrc.match(/data-editor-pop=""/g) ?? [];
    expect(matches.length).toBe(3);
  });

  it("shouldShow's isChildOfMenu also accepts focus inside [data-editor-pop]", () => {
    const shouldShow = textBubbleMenuSrc.slice(
      textBubbleMenuSrc.indexOf("shouldShow={({ editor: ed, element, view, state, from, to })"),
      textBubbleMenuSrc.indexOf("getReferencedVirtualElement={() => {")
    );
    expect(shouldShow).toMatch(/data-editor-pop/);
  });
});
