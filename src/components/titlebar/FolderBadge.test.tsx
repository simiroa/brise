import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Folder } from "../../lib/commands.gen";

const callMock = vi.fn();
const loadTreeMock = vi.fn(async () => {});
const selectNoteMock = vi.fn(async () => {});
const patchNoteSummaryMock = vi.fn();

vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  flushAll: vi.fn(async () => {}),
  registerFlush: () => () => {},
  emitNotice: vi.fn(),
}));

vi.mock("../../stores/notes", () => ({
  // lib/noteActions.ts::moveNote (exercised for real by "clicking a folder" below) now calls
  // this — always false here (this note is never locked in this file's fixtures).
  isNoteContentLocked: () => false,
  useNotesStore: Object.assign(
    (sel: (s: Record<string, unknown>) => unknown) =>
      sel({
        loadTree: loadTreeMock,
        selectNote: selectNoteMock,
        patchNoteSummary: patchNoteSummaryMock,
        activeNote: { note: { id: "n1", folder_id: "f1" } },
        getState: undefined,
      }),
    {
      getState: () => ({
        loadTree: loadTreeMock,
        selectNote: selectNoteMock,
        patchNoteSummary: patchNoteSummaryMock,
        activeNote: { note: { id: "n1", folder_id: "f1" } },
      }),
    },
  ),
}));

import { FolderBadge } from "./FolderBadge";

const folders: Folder[] = [
  {
    id: "f1",
    workspace_id: "ws",
    name: "Inbox",
    position: 0,
    is_open: true,
    note_count: 1,
    color_hue: null,
    icon: null,
    rules: null,
    search_excluded: false,
    ai_excluded: false,
  },
  {
    id: "f2",
    workspace_id: "ws",
    name: "Archive",
    position: 1,
    is_open: true,
    note_count: 0,
    color_hue: null,
    icon: null,
    rules: null,
    search_excluded: false,
    ai_excluded: false,
  },
];

describe("FolderBadge", () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockResolvedValue({ id: "n1", folder_id: "f2" });
    loadTreeMock.mockClear();
    selectNoteMock.mockClear();
    patchNoteSummaryMock.mockClear();
  });

  it("clicking a folder in the menu calls note_update and patches the tree with the returned row", async () => {
    render(<FolderBadge noteId="n1" folderId="f1" folders={folders} />);

    fireEvent.click(screen.getByTestId("folder-badge").querySelector("button")!);
    expect(screen.getByTestId("folder-badge-menu")).toBeTruthy();

    fireEvent.click(screen.getByRole("option", { name: /Archive/i }));

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("note_update", { id: "n1", folder_id: "f2" });
    });
    await waitFor(() => {
      expect(patchNoteSummaryMock).toHaveBeenCalledWith("n1", { id: "n1", folder_id: "f2" });
    });
    await waitFor(() => {
      expect(selectNoteMock).toHaveBeenCalledWith("n1");
    });
  });

  it("shows the leaf folder name on the badge", () => {
    render(<FolderBadge noteId="n1" folderId="f1" folders={folders} />);
    expect(screen.getByTestId("folder-badge").textContent).toContain("Inbox");
  });
});
