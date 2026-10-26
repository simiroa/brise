import { describe, it, expect, vi, beforeEach } from "vitest";

const emitNoticeMock = vi.fn();

const showToastOnlyMock = vi.fn();
vi.mock("./undo", () => ({ showToastOnly: (...args: unknown[]) => showToastOnlyMock(...args) }));
vi.mock("./invoke", () => ({
  call: vi.fn(),
  callSilent: vi.fn(),
  emitNotice: (...args: unknown[]) => emitNoticeMock(...args),
  flushAll: vi.fn(async () => {}),
  registerFlush: () => () => {},
}));

vi.mock("../stores/notes", async () => {
  const { create } = await import("zustand");
  const useNotesStore = create(() => ({
    activeNote: null as { note: { id: string; content_locked?: boolean } } | null,
    noteIndex: new Map<string, { content_locked?: boolean }>(),
  }));
  return {
    useNotesStore,
    // aiSectionBridge.ts::insertAiSection (exercised directly below via the real module) now
    // guards on this — a real, if minimal, implementation so the "n1" targets here (never
    // locked) behave exactly as before this guard existed.
    isNoteContentLocked: (id: string) => {
      const s = useNotesStore.getState();
      if (s.activeNote?.note.id === id) return !!s.activeNote.note.content_locked;
      return !!s.noteIndex.get(id)?.content_locked;
    },
  };
});

vi.mock("../stores/settings", async () => {
  const { create } = await import("zustand");
  return { useSettingsStore: create(() => ({ aiPostProcess: true })) };
});

import { schedulePostProcess, _resetAiPostProcessForTests } from "./aiPostProcess";
import { insertAiSection, registerSectionInserter } from "./aiSectionBridge";
import { useAiStore } from "../stores/ai";
import { useNotesStore } from "../stores/notes";
import { useSettingsStore } from "../stores/settings";

const PROPOSAL = { title: "T", tag_names: ["a"], confidence: 0.9 } as never;

function setActive(id: string | null) {
  useNotesStore.setState({ activeNote: id ? { note: { id } } : null } as never);
}

/** Let the fire-and-forget chain (dynamic import of aiPostProcess/aiPresets + awaits) settle. */
async function settle(rounds = 30) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

let organizeMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _resetAiPostProcessForTests();
  emitNoticeMock.mockReset();
  showToastOnlyMock.mockReset();
  useSettingsStore.setState({ aiPostProcess: true } as never);
  useNotesStore.setState({ noteIndex: new Map([["n1", { id: "n1" }]]) } as never);
  setActive("n1");
  organizeMock = vi.fn(async (noteId?: string) => {
    useAiStore.setState({ backgroundProposals: new Map([[noteId ?? "n1", PROPOSAL]]) });
  });
  useAiStore.setState({
    translateGateOk: true,
    lastProposal: null,
    lastProposalOrigin: null,
    lastProposalNoteId: null,
    backgroundProposals: new Map(),
    manualProposals: new Map(),
    organizeCurrentNote: organizeMock as never,
  });
});

describe("schedulePostProcess — guards", () => {
  it("does nothing when the ai_post_process kill switch is off", async () => {
    useSettingsStore.setState({ aiPostProcess: false } as never);
    await schedulePostProcess("n1");
    expect(organizeMock).not.toHaveBeenCalled();
  });

  it("does nothing when the AI gate is closed", async () => {
    useAiStore.setState({ translateGateOk: false });
    await schedulePostProcess("n1");
    expect(organizeMock).not.toHaveBeenCalled();
  });

  it("does nothing when the note no longer exists (not active, not in the tree index)", async () => {
    setActive(null);
    useNotesStore.setState({ noteIndex: new Map() } as never);
    await schedulePostProcess("n1");
    expect(organizeMock).not.toHaveBeenCalled();
  });

  it("dedups per note — a second insert while one is in flight is skipped", async () => {
    let release!: () => void;
    organizeMock.mockImplementation(
      () => new Promise<void>((r) => (release = r)),
    );
    const first = schedulePostProcess("n1");
    // let the first request actually reach organizeCurrentNote (dynamic import in between)
    await vi.waitFor(() => expect(organizeMock).toHaveBeenCalledTimes(1));
    await schedulePostProcess("n1");
    expect(organizeMock).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it("proposes with the full metadata field set, silently", async () => {
    await schedulePostProcess("n1");
    expect(organizeMock).toHaveBeenCalledWith(
      "n1",
      ["title", "tags", "year", "region", "folder"],
      expect.any(String),
      true,
    );
  });
});

describe("schedulePostProcess — modal vs notice", () => {
  it("still on the note: does NOT auto-open the modal — shows a '보기' toast, and the toast action opens it", async () => {
    await schedulePostProcess("n1");
    // AUDIT-2026-09-05 §2-1: 게이트 [삽입] 직후 모달이 연달아 뜨지 않는다.
    expect(useAiStore.getState().lastProposal).toBeNull();
    expect(emitNoticeMock).not.toHaveBeenCalled();
    expect(showToastOnlyMock).toHaveBeenCalledTimes(1);
    const [, onView, opts] = showToastOnlyMock.mock.calls[0];
    expect(opts).toMatchObject({ ttlMs: 10_000 });
    onView();
    expect(useAiStore.getState().lastProposal).toBe(PROPOSAL);
    expect(useAiStore.getState().lastProposalNoteId).toBe("n1");
  });

  it("still on the note, toast ignored: the proposal waits and restores when the note is reopened", async () => {
    await schedulePostProcess("n1");
    expect(useAiStore.getState().lastProposal).toBeNull();
    setActive("n2");
    setActive("n1");
    expect(useAiStore.getState().lastProposal).toBe(PROPOSAL);
  });

  it("navigated away: holds the proposal back (no modal), notices, and restores it on return", async () => {
    organizeMock.mockImplementation(async (noteId?: string) => {
      setActive("n2"); // user moved on while the request was in flight
      useAiStore.setState({ backgroundProposals: new Map([[noteId ?? "n1", PROPOSAL]]) });
    });

    await schedulePostProcess("n1");
    expect(useAiStore.getState().lastProposal).toBeNull();
    expect(emitNoticeMock).toHaveBeenCalledTimes(1);

    setActive("n1");
    expect(useAiStore.getState().lastProposal).toBe(PROPOSAL);
    expect(useAiStore.getState().lastProposalNoteId).toBe("n1");
  });

  it("never replaces an active manual proposal and restores the waiting background proposal after cancel", async () => {
    useAiStore.setState({
      lastProposal: { title: "manual", confidence: 1 } as never,
      lastProposalNoteId: "n2",
      lastProposalOrigin: "manual",
    });

    await schedulePostProcess("n1");
    expect(useAiStore.getState().lastProposal).toEqual({ title: "manual", confidence: 1 });
    expect(useAiStore.getState().backgroundProposals.get("n1")).toBe(PROPOSAL);

    useAiStore.getState().clearProposal();
    expect(useAiStore.getState().lastProposal).toBe(PROPOSAL);
    expect(useAiStore.getState().lastProposalNoteId).toBe("n1");
    expect(useAiStore.getState().lastProposalOrigin).toBe("background");
  });

  it("a failed propose leaves nothing behind and says nothing", async () => {
    organizeMock.mockImplementation(async () => {});
    await schedulePostProcess("n1");
    expect(useAiStore.getState().lastProposal).toBeNull();
    expect(emitNoticeMock).not.toHaveBeenCalled();
  });
});

describe("insertAiSection chokepoint", () => {
  beforeEach(() => {
    registerSectionInserter(async () => ({ id: "sec-1", name: "n", body_md: "", position: 0, kind: "text" }));
  });

  it("an AI section insert schedules post-processing for that note", async () => {
    await insertAiSection("AI", "body", "n1");
    await vi.waitFor(() =>
      expect(organizeMock).toHaveBeenCalledWith("n1", expect.any(Array), expect.any(String), true),
    );
  });

  it("postProcess:false (translate / template presets) does not", async () => {
    await insertAiSection("Translation (EN)", "body", "n1", undefined, { postProcess: false });
    await settle();
    expect(organizeMock).not.toHaveBeenCalled();
  });
});
