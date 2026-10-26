import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const call = vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => ({}));
vi.mock("../lib/invoke", () => ({
  call: (cmd: string, args?: Record<string, unknown>) => call(cmd, args),
  callSilent: (cmd: string, args?: Record<string, unknown>) => call(cmd, args),
  emitNotice: vi.fn(),
  registerFlush: vi.fn(() => () => {}),
  flushAll: vi.fn(async () => {}),
}));

import { useTrashStore } from "../stores/trash";
import { useArchiveStore } from "../stores/archive";
import { t } from "../i18n/t";
import type { NoteSummary } from "../lib/commands.gen";
import { MobileTrashArchiveOverlay } from "./MobileTrashArchiveOverlay";

function note(id: string, title: string): NoteSummary {
  return {
    id, folder_id: "f1", title, year: 2026, is_favorite: false, exported_at: null, has_image: false,
    tag_names: [], region: null, status: null, icon: null, lat: null, lng: null,
    created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", month: null, day: null,
  };
}

let loadTrash: ReturnType<typeof vi.fn>;
let loadArchive: ReturnType<typeof vi.fn>;
let restoreNote: ReturnType<typeof vi.fn>;
let unarchiveNote: ReturnType<typeof vi.fn>;

beforeEach(() => {
  call.mockReset();
  call.mockImplementation(async () => ({}));
  loadTrash = vi.fn(async () => {});
  loadArchive = vi.fn(async () => {});
  restoreNote = vi.fn(async () => {});
  unarchiveNote = vi.fn(async () => {});
  useTrashStore.setState({ trashList: [note("t1", "Trashed one")], loadTrash, restoreNote } as any);
  useArchiveStore.setState({
    archiveList: [note("a1", "Archived one")],
    loadArchive,
    unarchiveNote,
    loadArchiveCount: vi.fn(async () => {}),
  } as any);
});

describe("MobileTrashArchiveOverlay", () => {
  it("trash: lists the trashed notes, loads them on mount, and restore goes through the trash store then reloads", async () => {
    render(<MobileTrashArchiveOverlay kind="trash" onClose={() => {}} />);
    expect(screen.getByText("Trashed one")).toBeTruthy();
    await waitFor(() => expect(loadTrash).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: t("trash.restore") }));
    await waitFor(() => expect(restoreNote).toHaveBeenCalledWith("t1"));
    await waitFor(() => expect(loadTrash.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("a failed restore is swallowed (the store's call() already toasted) and the button comes back", async () => {
    restoreNote.mockRejectedValue(new Error("boom"));
    render(<MobileTrashArchiveOverlay kind="trash" onClose={() => {}} />);
    const btn = screen.getByRole("button", { name: t("trash.restore") }) as HTMLButtonElement;
    fireEvent.click(btn);
    await waitFor(() => expect(restoreNote).toHaveBeenCalled());
    await waitFor(() => expect(btn.disabled).toBe(false));
  });

  it("delete-forever asks for confirmation before note_purge", async () => {
    render(<MobileTrashArchiveOverlay kind="trash" onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: t("trash.delete_forever") }));
    expect(call).not.toHaveBeenCalledWith("note_purge", expect.anything());
    expect(screen.getByText(t("trash.delete_confirm", { title: "Trashed one" }))).toBeTruthy();

    const confirm = screen.getAllByRole("button", { name: t("common.delete") }).find((b) => b.className.includes("mobile-text-btn--danger"))!;
    fireEvent.click(confirm);
    await waitFor(() => expect(call).toHaveBeenCalledWith("note_purge", { id: "t1" }));
  });

  it("archive: lists the archived notes and unarchive goes through the archive store", async () => {
    render(<MobileTrashArchiveOverlay kind="archive" onClose={() => {}} />);
    expect(screen.getByText("Archived one")).toBeTruthy();
    await waitFor(() => expect(loadArchive).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: t("archive.unarchive") }));
    await waitFor(() => expect(unarchiveNote).toHaveBeenCalledWith("a1"));
  });

  it("shows the empty state when there is nothing in the list", () => {
    useTrashStore.setState({ trashList: [] } as any);
    render(<MobileTrashArchiveOverlay kind="trash" onClose={() => {}} />);
    expect(screen.getByText(t("trash.empty_state"))).toBeTruthy();
  });
});
