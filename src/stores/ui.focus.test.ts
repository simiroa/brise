import { afterEach, describe, expect, it } from "vitest";
import { useUiStore } from "./ui";

// A1: setPreviewItem 이 집중 모드 관문 역할도 한다 — SourcePanel 이 언마운트된 상태에서
// 프리뷰 요청이 조용히 사라지지 않도록, item 이 있으면 focusMode 를 먼저 끈다.
afterEach(() => {
  useUiStore.setState({ focusMode: false, previewItem: null, previewPast: [], previewFuture: [] });
});

describe("useUiStore.setPreviewItem — 집중 모드 관문", () => {
  it("focusMode 중 non-null 아이템을 요청하면 focusMode 가 꺼지고 previewItem 이 설정된다", () => {
    useUiStore.setState({ focusMode: true });
    useUiStore.getState().setPreviewItem({ kind: "note", id: "n1" });
    const state = useUiStore.getState();
    expect(state.focusMode).toBe(false);
    expect(state.previewItem).toEqual({ kind: "note", id: "n1" });
  });

  it("focusMode 중 setPreviewItem(null) 은 focusMode 를 건드리지 않는다", () => {
    useUiStore.setState({ focusMode: true, previewItem: { kind: "note", id: "n1" } });
    useUiStore.getState().setPreviewItem(null);
    const state = useUiStore.getState();
    expect(state.focusMode).toBe(true);
    expect(state.previewItem).toBeNull();
  });

  it("집중 전에 이미 열려 있던 같은 항목을 다시 요청해도 focusMode 는 꺼진다", () => {
    useUiStore.setState({ focusMode: true, previewItem: { kind: "note", id: "n1" } });
    useUiStore.getState().setPreviewItem({ kind: "note", id: "n1" });
    const state = useUiStore.getState();
    expect(state.focusMode).toBe(false);
    expect(state.previewPast).toEqual([]);
  });

  it("footnotes→footnotes replace 분기도 focusMode 를 끈다", () => {
    useUiStore.setState({ focusMode: true, previewItem: { kind: "footnotes", focusId: "a" } });
    useUiStore.getState().setPreviewItem({ kind: "footnotes", focusId: "b" });
    const state = useUiStore.getState();
    expect(state.focusMode).toBe(false);
    expect(state.previewItem).toEqual({ kind: "footnotes", focusId: "b" });
  });
});
