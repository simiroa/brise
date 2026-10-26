import { describe, it, expect } from "vitest";
import { shouldSkipReloadRepaint } from "./EditorPanel";

// Owner QA 6, item 4 ("이미지 삽입이 캐럿 위치에 안 들어간다") — a plausible contributor found while
// auditing this path, not a confirmed reproduction of the report: reloadActive() (used by the
// toolbar image insert and paste-image paths) always flushes pending edits before re-fetching,
// then replaces `activeNote` with a NEW object reference even when the flushed content is exactly
// what's already live. The note-load effect (EditorPanel.tsx) re-runs on ANY new `activeNote`
// reference and used to unconditionally call setContent(), which rebuilds the whole ProseMirror
// doc and resets the selection — even when the insert itself lands at the right spot, the caret
// could then visibly jump away right after, which would read as "the insert didn't land where I
// clicked." shouldSkipReloadRepaint is the pure decision behind the guard that closes this
// without needing a live editor/IPC harness to exercise the effect itself.
describe("shouldSkipReloadRepaint", () => {
  it("skips when the reload brought back the SAME section with byte-identical content (the reloadActive race)", () => {
    expect(shouldSkipReloadRepaint(true, "sec-1", "text", "sec-1", "hello ![](x.png)", "hello ![](x.png)")).toBe(
      true
    );
  });

  it("does NOT skip a genuine section switch, even within the same note", () => {
    expect(shouldSkipReloadRepaint(true, "sec-1", "text", "sec-2", "same", "same")).toBe(false);
  });

  it("does NOT skip a note switch (sameNote false)", () => {
    expect(shouldSkipReloadRepaint(false, "sec-1", "text", "sec-1", "same", "same")).toBe(false);
  });

  it("does NOT skip when the incoming body genuinely differs (e.g. an AI insert into the mounted section)", () => {
    expect(shouldSkipReloadRepaint(true, "sec-1", "text", "sec-1", "new content", "old content")).toBe(false);
  });

  it("does NOT skip a diagram section — DiagramSection owns its own body, this effect must not short-circuit it", () => {
    expect(shouldSkipReloadRepaint(true, "sec-1", "diagram", "sec-1", "same", "same")).toBe(false);
  });

  it("does NOT skip on first mount (currentSectionId undefined)", () => {
    expect(shouldSkipReloadRepaint(false, undefined, undefined, "sec-1", "same", "same")).toBe(false);
  });
});
