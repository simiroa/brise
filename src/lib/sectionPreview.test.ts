import { describe, it, expect, vi, beforeEach } from "vitest";
import { resolvePreviewItem } from "./previewResolver";
import { registerSectionNavigator, navigateToSection } from "./presetBridge";
import { useUiStore, previewItemsEqual } from "../stores/ui";
import type { Attachment, NoteDetail } from "./commands.gen";

describe("Section Preview Architecture & Logic", () => {
  beforeEach(() => {
    useUiStore.setState({ previewItem: null, sectionSaveEvent: null, previewPast: [], previewFuture: [] });
  });

  const mockNote: NoteDetail = {
    note: {
      id: "note-1",
      folder_id: "folder-1",
      title: "Test Note",
      year: 2026,
      month: null,
      day: null,
      is_favorite: false,
      tag_names: [],
      region: null,
      lat: null,
      lng: null,
      status: null,
      icon: null,
      has_image: false,
      exported_at: null,
      created_at: "2026-08-01",
      updated_at: "2026-08-01",
    },
    sections: [
      { id: "sec-1", name: "Section 1", body_md: "Body 1", kind: "text", position: 0 },
      { id: "sec-2", name: "Section 2", body_md: "Body 2", kind: "text", position: 1 },
      { id: "sec-diag", name: "Diagram", body_md: "graph TD\nA-->B", kind: "diagram", position: 2 },
    ],
    attachments: [],
    sources: [],
  };

  it("resolves valid section preview item for active note", () => {
    const item = { kind: "section" as const, noteId: "note-1", sectionId: "sec-1" };
    const resolved = resolvePreviewItem(item, mockNote);
    expect(resolved).toEqual({ kind: "section", noteId: "note-1", sectionId: "sec-1" });
  });

  it("returns null when preview section belongs to another note (auto-release on note switch)", () => {
    const item = { kind: "section" as const, noteId: "other-note", sectionId: "sec-1" };
    const resolved = resolvePreviewItem(item, mockNote);
    expect(resolved).toBeNull();
  });

  it("returns null when sectionId is not in activeNote.sections", () => {
    const item = { kind: "section" as const, noteId: "note-1", sectionId: "deleted-sec" };
    const resolved = resolvePreviewItem(item, mockNote);
    expect(resolved).toBeNull();
  });

  it("bridges navigateToSection to registered EditorPanel callback", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const unregister = registerSectionNavigator(fn);

    await navigateToSection("sec-2");
    expect(fn).toHaveBeenCalledWith("sec-2");

    unregister();
  });

  it("notifies section saved and increments save counter with sectionId", () => {
    const store = useUiStore.getState();
    expect(store.sectionSaveEvent).toBeNull();

    store.notifySectionSaved("sec-1");
    let event = useUiStore.getState().sectionSaveEvent;
    expect(event).toEqual({ sectionId: "sec-1", tick: 1 });

    store.notifySectionSaved("sec-1");
    event = useUiStore.getState().sectionSaveEvent;
    expect(event).toEqual({ sectionId: "sec-1", tick: 2 });

    store.notifySectionSaved("sec-2");
    event = useUiStore.getState().sectionSaveEvent;
    expect(event).toEqual({ sectionId: "sec-2", tick: 3 });
  });

  /* 각주 뷰 — 노트 스코프 단일 목록. 첨부 단위 프리뷰가 사라졌으므로 resolver 가 옛
     {kind:"attachment"} 각주 항목까지 여기로 흡수한다. */
  describe("footnotes preview item", () => {
    const fn = (id: string): Attachment =>
      // kind='footnote' is a runtime value commands.gen's closed union does not carry yet.
      ({ id, name: `${id}.md`, kind: "footnote", rel_path: `n/${id}.md`, url: null, size_bytes: 1, position: 0 }) as unknown as Attachment;
    const withFootnotes: NoteDetail = { ...mockNote, attachments: [fn("f1"), fn("f2")] };

    it("resolves when the active note has at least one footnote, preserving focusId", () => {
      expect(resolvePreviewItem({ kind: "footnotes" }, withFootnotes)).toEqual({
        kind: "footnotes",
        focusId: undefined,
      });
      expect(resolvePreviewItem({ kind: "footnotes", focusId: "f2" }, withFootnotes)).toEqual({
        kind: "footnotes",
        focusId: "f2",
      });
    });

    it("returns null on a note with no footnotes (panel falls back as before)", () => {
      expect(resolvePreviewItem({ kind: "footnotes", focusId: "f2" }, mockNote)).toBeNull();
    });

    it("degrades a stale attachment-kind footnote item into the focused list", () => {
      expect(resolvePreviewItem({ kind: "attachment", id: "f2" }, withFootnotes)).toEqual({
        kind: "footnotes",
        focusId: "f2",
      });
    });

    it("previewItemsEqual treats a different focusId as a different item", () => {
      expect(previewItemsEqual({ kind: "footnotes" }, { kind: "footnotes" })).toBe(true);
      expect(previewItemsEqual({ kind: "footnotes", focusId: "a" }, { kind: "footnotes", focusId: "b" })).toBe(false);
      expect(previewItemsEqual({ kind: "footnotes", focusId: "a" }, { kind: "footnotes" })).toBe(false);
      expect(previewItemsEqual({ kind: "footnotes" }, { kind: "note", id: "n1" })).toBe(false);
      expect(previewItemsEqual({ kind: "note", id: "n1" }, { kind: "footnotes" })).toBe(false);
    });

    it("marker→marker focus moves replace history instead of flooding it", () => {
      const { setPreviewItem } = useUiStore.getState();
      setPreviewItem({ kind: "note", id: "n1" });
      setPreviewItem({ kind: "footnotes", focusId: "f1" });
      const pastAfterOpen = useUiStore.getState().previewPast.length;

      setPreviewItem({ kind: "footnotes", focusId: "f2" });
      setPreviewItem({ kind: "footnotes", focusId: "f1" });
      expect(useUiStore.getState().previewItem).toEqual({ kind: "footnotes", focusId: "f1" });
      expect(useUiStore.getState().previewPast.length).toBe(pastAfterOpen);

      // Back still leaves the footnotes view entirely (one history entry for the whole screen).
      useUiStore.getState().previewHistoryBack();
      expect(useUiStore.getState().previewItem).toEqual({ kind: "note", id: "n1" });
    });
  });
});
