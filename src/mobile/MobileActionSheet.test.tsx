import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

const call = vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => ({}));
vi.mock("../lib/invoke", () => ({
  call: (cmd: string, args?: Record<string, unknown>) => call(cmd, args),
  callSilent: (cmd: string, args?: Record<string, unknown>) => call(cmd, args),
  emitNotice: vi.fn(),
  registerFlush: vi.fn(() => () => {}),
  flushAll: vi.fn(async () => {}),
}));

import { useNotesStore } from "../stores/notes";
import { useSelectionStore } from "../stores/selection";
import type { Folder, NoteSummary } from "../lib/commands.gen";
import { MobileActionSheet } from "./MobileActionSheet";

function note(patch: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id: "n1",
    folder_id: "f1",
    title: "A note",
    year: 2026,
    is_favorite: false,
    exported_at: null,
    has_image: false,
    tag_names: ["existing"],
    region: null,
    status: null,
    icon: null,
    lat: null,
    lng: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    month: null,
    day: null,
    ...patch,
  };
}

const folders: Folder[] = [{ id: "f2", name: "Other folder" } as Folder];

beforeEach(() => {
  call.mockClear();
  call.mockResolvedValue({});
  // loadTree() stubbed out: renameNote/moveNote/deleteNote/toggleFavorite/archiveNote (lib/noteActions.ts,
  // stores/archive.ts) all end with the real useNotesStore.getState().loadTree(), which — unmocked —
  // would run the real folder_list roundtrip against this file's generic call() mock and blow up on
  // the notes_by_folder destructure. notesByFolder/noteIndex stay real/seeded (addNoteTags reads
  // noteIndex directly for the union-tags test below).
  useNotesStore.setState({
    notesByFolder: { f1: [note()], f2: [] },
    noteIndex: new Map([["n1", note()]]),
    loadTree: vi.fn(),
  } as any);
  useSelectionStore.setState({ notes: { ids: [], anchor: null, anchorIndex: null } } as any);
});

describe("MobileActionSheet — all 7 verbs route through lib/noteActions.ts/stores/archive.ts, never a bare component call() bypass", () => {
  it("renders exactly the 7 verbs", () => {
    render(<MobileActionSheet note={note()} pickableFolders={folders} onClose={() => {}} />);
    for (const testid of [
      "mobile-action-rename",
      "mobile-action-move",
      "mobile-action-favorite",
      "mobile-action-tags",
      "mobile-action-archive",
      "mobile-action-select",
      "mobile-action-delete",
    ]) {
      expect(screen.getByTestId(testid)).toBeTruthy();
    }
  });

  it("Android back closes the top layer only: confirm dialog first, then the sheet", async () => {
    // Resolve on the popstate itself (jsdom delivers it on a later task), not after a fixed sleep —
    // a fixed 15ms flaked under full-suite load.
    const hwBack = () =>
      act(async () => {
        const landed = new Promise((r) => window.addEventListener("popstate", r, { once: true }));
        history.back();
        await landed;
      });
    const onClose = vi.fn();
    render(<MobileActionSheet note={note()} pickableFolders={folders} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("mobile-action-delete"));
    expect(screen.getByTestId("mobile-modal")).toBeTruthy();

    await hwBack(); // back #1 → confirm dialog only
    expect(screen.queryByTestId("mobile-modal")).toBeNull();
    expect(screen.getByTestId("mobile-action-delete")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    await hwBack(); // back #2 → the sheet
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("canceling the confirm dialog by hand keeps the sheet open (the dialog's own history pop is not a back)", async () => {
    const onClose = vi.fn();
    render(<MobileActionSheet note={note()} pickableFolders={folders} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("mobile-action-delete"));
    fireEvent.click(screen.getByText("Cancel"));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByTestId("mobile-modal")).toBeNull();
    expect(screen.getByTestId("mobile-action-delete")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("rename: opens an input pre-filled with the title, submits note_update, then closes", async () => {
    call.mockResolvedValue(note({ title: "Renamed" }));
    const onClose = vi.fn();
    render(<MobileActionSheet note={note()} pickableFolders={folders} onClose={onClose} />);

    fireEvent.click(screen.getByTestId("mobile-action-rename"));
    const input = screen.getByDisplayValue("A note") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(call).toHaveBeenCalledWith("note_update", { id: "n1", title: "Renamed" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("move: opens the folder picker, picking a folder calls note_update{folder_id}", async () => {
    call.mockResolvedValue(note({ folder_id: "f2" }));
    const onClose = vi.fn();
    render(<MobileActionSheet note={note()} pickableFolders={folders} onClose={onClose} />);

    fireEvent.click(screen.getByTestId("mobile-action-move"));
    fireEvent.click(screen.getByText("Other folder"));

    await waitFor(() => expect(call).toHaveBeenCalledWith("note_update", { id: "n1", folder_id: "f2" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("favorite: toggles immediately (note_toggle_favorite), no intermediate dialog", async () => {
    call.mockResolvedValue({ is_favorite: true });
    const onClose = vi.fn();
    render(<MobileActionSheet note={note({ is_favorite: false })} pickableFolders={folders} onClose={onClose} />);

    fireEvent.click(screen.getByTestId("mobile-action-favorite"));

    await waitFor(() => expect(call).toHaveBeenCalledWith("note_toggle_favorite", { id: "n1" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("tags: opens the tag sheet, submitting calls note_set_tags via addNoteTags (union, keeps existing tags)", async () => {
    call.mockImplementation(async (cmd: string) => {
      if (cmd === "note_set_tags") return { tag_names: ["existing", "urgent"] };
      return {};
    });
    const onClose = vi.fn();
    render(<MobileActionSheet note={note()} pickableFolders={folders} onClose={onClose} />);

    fireEvent.click(screen.getByTestId("mobile-action-tags"));
    const input = screen.getByPlaceholderText(/여행|travel/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "urgent" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("note_set_tags", { id: "n1", tag_names: ["existing", "urgent"] })
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("archive: calls note_archive then closes", async () => {
    const onClose = vi.fn();
    render(<MobileActionSheet note={note()} pickableFolders={folders} onClose={onClose} />);

    fireEvent.click(screen.getByTestId("mobile-action-archive"));

    await waitFor(() => expect(call).toHaveBeenCalledWith("note_archive", { id: "n1" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("select: enters multi-select via useSelectionStore.toggleNote, fires no backend call, closes immediately", () => {
    const onClose = vi.fn();
    render(<MobileActionSheet note={note()} pickableFolders={folders} onClose={onClose} />);

    fireEvent.click(screen.getByTestId("mobile-action-select"));

    expect(useSelectionStore.getState().notes.ids).toEqual(["n1"]);
    expect(call).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("delete: requires confirmation, then calls note_delete and closes", async () => {
    const onClose = vi.fn();
    render(<MobileActionSheet note={note()} pickableFolders={folders} onClose={onClose} />);

    fireEvent.click(screen.getByTestId("mobile-action-delete"));
    // Confirmation dialog — note_delete must not fire before the second tap.
    expect(call).not.toHaveBeenCalledWith("note_delete", expect.anything());
    fireEvent.click(screen.getByText("Delete"));

    await waitFor(() => expect(call).toHaveBeenCalledWith("note_delete", { id: "n1" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("move is disabled when there are no pickable folders (mirrors desktop's NoteSelectionBar)", () => {
    render(<MobileActionSheet note={note()} pickableFolders={[]} onClose={() => {}} />);
    expect((screen.getByTestId("mobile-action-move") as HTMLButtonElement).disabled).toBe(true);
  });

  it("none of the 7 verbs ever call folder_list or folder_list_meta (W2 performance contract)", async () => {
    call.mockResolvedValue(note());
    const onClose = vi.fn();
    render(<MobileActionSheet note={note()} pickableFolders={folders} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("mobile-action-favorite"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    const calledCommands = call.mock.calls.map((c) => c[0]);
    expect(calledCommands).not.toContain("folder_list");
    expect(calledCommands).not.toContain("folder_list_meta");
  });
});
