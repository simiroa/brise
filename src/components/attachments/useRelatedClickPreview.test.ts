import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRelatedClickPreview, followPreviewToNote } from "./useRelatedClickPreview";
import { useUiStore } from "../../stores/ui";
import { useNotesStore } from "../../stores/notes";

describe("useRelatedClickPreview", () => {
  const selectNote = vi.fn(async () => {});

  beforeEach(() => {
    selectNote.mockReset();
    useNotesStore.setState({ selectNote } as never);
    useUiStore.setState({ previewItem: null, previewPast: [], previewFuture: [] });
  });

  it("double-click open updates the preview to that note", () => {
    const { result } = renderHook(() => useRelatedClickPreview());
    act(() => {
      result.current.openRelatedNote("n2");
    });
    expect(useUiStore.getState().previewItem).toEqual({ kind: "note", id: "n2" });
    expect(selectNote).toHaveBeenCalledWith("n2");
  });

  it("tab follow only moves an already-open note preview", () => {
    followPreviewToNote("n2");
    expect(useUiStore.getState().previewItem).toBeNull();

    useUiStore.setState({ previewItem: { kind: "note", id: "n1" } });
    followPreviewToNote("n2");
    expect(useUiStore.getState().previewItem).toEqual({ kind: "note", id: "n2" });
  });
});
