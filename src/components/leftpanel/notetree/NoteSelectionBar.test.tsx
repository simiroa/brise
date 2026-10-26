import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const archiveNote = vi.fn(async (_id: string) => {});
const unarchiveNote = vi.fn(async (_id: string) => {});
const emitNotice = vi.fn();
const showUndoToast = vi.fn();

vi.mock("../../../lib/invoke", () => ({
  call: vi.fn(async () => ({})),
  callSilent: vi.fn(async () => ({})),
  emitNotice: (...args: unknown[]) => emitNotice(...args),
  flushAll: vi.fn(async () => {}),
  registerFlush: vi.fn(() => () => {}),
}));
vi.mock("../../../lib/undo", () => ({ showUndoToast: (...a: unknown[]) => showUndoToast(...a) }));
vi.mock("../../../stores/archive", () => ({
  useArchiveStore: { getState: () => ({ archiveNote, unarchiveNote }) },
}));
vi.mock("../../../stores/trash", () => ({
  useTrashStore: { getState: () => ({ loadTrash: vi.fn(), restoreNote: vi.fn() }) },
}));
vi.mock("../../../stores/notes", () => ({
  useNotesStore: (sel: (s: unknown) => unknown) =>
    sel({ folders: [{ id: "f1", name: "Folder 1" }], inboxId: "inbox" }),
}));
vi.mock("../../../stores/settings", () => {
  const state = { aiEnabled: false, uiLang: "en" };
  // i18n/t 가 getState().uiLang 를 읽으므로 훅 형태 + getState 둘 다 필요하다.
  const useSettingsStore = (sel: (s: unknown) => unknown) => sel(state);
  useSettingsStore.getState = () => state;
  return { useSettingsStore };
});
// AiBatchOrganizeModal 은 이 테스트에서 열지 않는다 — 무거운 AI 스토어 의존을 끌어오지 않도록 스텁.
vi.mock("../../AiBatchOrganizeModal", () => ({ AiBatchOrganizeModal: () => null }));

import { NoteSelectionBar } from "./NoteSelectionBar";
import { EMPTY_SELECTION, useSelectionStore } from "../../../stores/selection";

function selectNotes(ids: string[]) {
  useSelectionStore.setState({ notes: { ids, anchor: ids[ids.length - 1] ?? null, anchorIndex: null } });
}

describe("NoteSelectionBar — batch archive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSelectionStore.setState({ notes: EMPTY_SELECTION, attachments: EMPTY_SELECTION });
  });

  it("stays hidden below two selected items (single-item affordances already cover that)", () => {
    selectNotes(["n1"]);
    render(<NoteSelectionBar />);
    expect(screen.queryByTestId("selection-action-bar")).toBeNull();
  });

  it("loops the single-id archive command once per selected note and clears the selection", async () => {
    selectNotes(["n1", "n2", "n3"]);
    render(<NoteSelectionBar />);
    fireEvent.click(screen.getByTestId("selection-archive"));

    await waitFor(() => expect(archiveNote).toHaveBeenCalledTimes(3));
    expect(archiveNote.mock.calls.map((c) => c[0])).toEqual(["n1", "n2", "n3"]);
    await waitFor(() => expect(useSelectionStore.getState().notes.ids).toEqual([]));
    expect(showUndoToast).toHaveBeenCalled();
  });

  it("on a mid-batch failure: finishes the rest, reports, and leaves the failed note selected", async () => {
    archiveNote.mockImplementation(async (id: string) => {
      if (id === "n2") throw new Error("boom");
    });
    selectNotes(["n1", "n2", "n3"]);
    render(<NoteSelectionBar />);
    fireEvent.click(screen.getByTestId("selection-archive"));

    // 실패해도 멈추지 않는다 — 3개 모두 시도한다.
    await waitFor(() => expect(archiveNote).toHaveBeenCalledTimes(3));
    // 성공을 가장하지 않는다: 부분 실패 문구가 나가고, 실패한 것만 선택에 남는다.
    await waitFor(() => expect(useSelectionStore.getState().notes.ids).toEqual(["n2"]));
    expect(emitNotice).toHaveBeenCalled();
  });
});
