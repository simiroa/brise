import { describe, it, expect, vi, beforeEach } from "vitest";

let responses: Record<string, unknown> = {};
const callMock = vi.fn((...args: unknown[]) => Promise.resolve(responses[args[0] as string]));
const loadTreeMock = vi.fn(async () => {});

vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
}));

vi.mock("./notes", () => ({
  useNotesStore: {
    getState: () => ({ loadTree: loadTreeMock }),
  },
}));

import { useArchiveStore } from "./archive";

const note = (id: string, title: string): any => ({
  id,
  folder_id: "f1",
  title,
  year: 1900,
  is_favorite: false,
  exported_at: null,
  has_image: false,
  tag_names: [],
  region: null,
  status: null,
  icon: null,
});

describe("archive store (W7-f)", () => {
  beforeEach(() => {
    callMock.mockClear();
    loadTreeMock.mockClear();
    responses = {};
    useArchiveStore.setState({ archiveList: [], archiveCount: 0 });
  });

  it("loadArchive() calls note_archived_list with no args (active-workspace convention) and sets archiveList/archiveCount from the result", async () => {
    responses.note_archived_list = [note("n1", "A"), note("n2", "B")];

    await useArchiveStore.getState().loadArchive();

    expect(callMock).toHaveBeenCalledWith("note_archived_list", {});
    const state = useArchiveStore.getState();
    expect(state.archiveList).toHaveLength(2);
    expect(state.archiveCount).toBe(2);
  });

  it("loadArchiveCount() calls note_archived_count and sets only archiveCount (badge path)", async () => {
    responses.note_archived_count = { count: 3 };

    await useArchiveStore.getState().loadArchiveCount();

    expect(callMock).toHaveBeenCalledWith("note_archived_count", {});
    expect(useArchiveStore.getState().archiveCount).toBe(3);
    expect(useArchiveStore.getState().archiveList).toHaveLength(0);
  });

  it("loadArchive() swallows a failure and leaves the previous state untouched (best-effort background refresh)", async () => {
    useArchiveStore.setState({ archiveList: [note("n1", "A")], archiveCount: 1 });
    callMock.mockImplementationOnce(async () => {
      throw new Error("offline");
    });

    await expect(useArchiveStore.getState().loadArchive()).resolves.toBeUndefined();
    expect(useArchiveStore.getState().archiveCount).toBe(1);
  });

  it("archiveNote() calls note_archive, reloads the notes tree, then refreshes the archive list", async () => {
    responses.note_archived_list = [note("n1", "A")];

    await useArchiveStore.getState().archiveNote("n1");

    expect(callMock).toHaveBeenCalledWith("note_archive", { id: "n1" });
    expect(loadTreeMock).toHaveBeenCalledTimes(1);
    expect(useArchiveStore.getState().archiveCount).toBe(1);
  });

  it("unarchiveNote() calls note_unarchive, reloads the notes tree, then refreshes the archive list", async () => {
    useArchiveStore.setState({ archiveList: [note("n1", "A")], archiveCount: 1 });
    responses.note_archived_list = [];

    await useArchiveStore.getState().unarchiveNote("n1");

    expect(callMock).toHaveBeenCalledWith("note_unarchive", { id: "n1" });
    expect(loadTreeMock).toHaveBeenCalledTimes(1);
    expect(useArchiveStore.getState().archiveCount).toBe(0);
  });
});
