import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Characterization/smoke tests for the note-editing data layer, written BEFORE the planned split
// of notes.ts + extraction of EditorPanel's section CRUD. Scope is deliberately the PUBLIC
// surface only (store API + which IPC command fires with which args) — no internal state shape
// or private closures are asserted, so these must keep passing across the refactor unless the
// user-observable contract itself changes.
//
// See notes.test.ts (1068L) for the existing suite this complements — draft lifecycle basics,
// activeBodyEmpty, selectNote() race guards, loadTree() derived state, setTags rollback,
// reloadActive() attachment revision, and the 60s snapshot scheduler are already covered there
// and NOT duplicated here.

const callMock = vi.fn();
const flushAllMock = vi.fn(async () => {});
const emitNoticeMock = vi.fn();
// Same contract as notes.test.ts's mock: call() always toasts on rejection, callSilent() never
// does — tracked here so failure-path tests can assert on which path a rejection took.
const toastMock = vi.fn();

vi.mock("../lib/invoke", () => ({
  call: async (...args: unknown[]) => {
    try {
      return await callMock(...args);
    } catch (e) {
      toastMock(e);
      throw e;
    }
  },
  callSilent: (...args: unknown[]) => callMock(...args),
  flushAll: () => flushAllMock(),
  registerFlush: () => () => {},
  emitNotice: (...args: unknown[]) => emitNoticeMock(...args),
}));

import { useNotesStore } from "./notes";
import { useSettingsStore } from "./settings";
import { useTabsStore } from "./tabs";

// Full NoteSummary shape — required because these literals get passed to useNotesStore.setState(),
// which type-checks against NotesState (activeNote: NoteDetail | null). Mirrors the `note()`
// factory in notes.test.ts's "loadTree() derived state" describe.
const note = (id: string, folder_id = "f1", overrides: Record<string, unknown> = {}) => ({
  id,
  folder_id,
  title: "Some Title",
  year: 2024,
  is_favorite: false,
  exported_at: null,
  has_image: false,
  tag_names: [] as string[],
  region: null,
  status: null,
  icon: null,
  lat: null,
  lng: null,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  month: null,
  day: null,
  ...overrides,
});

const detailFor = (n: ReturnType<typeof note>, bodyMd = "") => ({
  note: n,
  sections: [{ id: "sec1", name: "Main", body_md: bodyMd, position: 0, kind: "text" as const }],
  sources: [],
  attachments: [],
});

describe("notes store — draft lifecycle: a metadata setter on a draft applies locally then materializes (P28/P29)", () => {
  beforeEach(() => {
    callMock.mockReset();
    toastMock.mockClear();
    flushAllMock.mockClear();
    emitNoticeMock.mockReset();
    useSettingsStore.setState({ activeWorkspaceId: "w1" });
    useTabsStore.setState({ openTabs: [], activeTabId: null });
    useNotesStore.setState({ folders: [], activeNote: null, activeDraft: false, inboxId: "inbox1" });
  });

  // Minimal note_create response shapes below deliberately omit fields not read by
  // ensureMaterialized (region/status/icon/lat/lng/created_at/updated_at/month/day) — these only
  // ever flow through the untyped callMock, never through useNotesStore.setState(), so TS doesn't
  // require the full NoteSummary shape here (same convention as notes.test.ts line ~108).
  const mockMaterializeIpc = (created: { note: Record<string, unknown> } & Record<string, unknown>) => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "note_create") return Promise.resolve(created);
      if (cmd === "folder_list" || cmd === "folder_list_meta") return Promise.resolve({ folders: [], notes_by_folder: {} });
      if (cmd === "note_tags_index") return Promise.resolve({ tags_by_note: {} });
      if (cmd === "tag_counts") return Promise.resolve({ counts: {} });
      // PLAN-2026-09-08-dates-rebuild.md W4: setEventPrecision/setEventEnd/setSchedule now go
      // through lib/primaryDate.ts::replacePrimaryDate — a safe no-op composite here (echoes
      // `created.note` back unchanged) so every OTHER setter in this describe block (which
      // doesn't care about the date axis at all) doesn't crash if ensureMaterialized's
      // eventPrecisionChanged happens to fire. Tests that actually exercise the date axis
      // override these three below.
      if (cmd === "note_get") {
        return Promise.resolve({ note: created.note, sections: [], sources: [], attachments: [] });
      }
      // W4b: note_dates_list 가 대표(position 0)를 첫 항목으로 돌려주고, 대표 편집은
      // note_date_update 한 번이다(옛 add+승격+삭제 컴포지트는 사라졌다).
      if (cmd === "note_dates_list") return Promise.resolve({ dates: [{ id: "primary-row", note_id: "n", position: 0, year: 2026, month: null, day: null, end_year: null, end_month: null, end_day: null, remind: false, created_at: "", start_time: null, end_time: null, remind_offset_min: null, rrule: null }] });
      if (cmd === "note_date_update") return Promise.resolve({ id: "primary-row", note_id: "n", position: 0, year: 2026, month: null, day: null, end_year: null, end_month: null, end_day: null, remind: false, created_at: "", start_time: null, end_time: null, remind_offset_min: null, rrule: null });
      return Promise.resolve();
    });
  };

  it("toggleFavorite() on a draft flips is_favorite locally, then materializes (note_create + note_toggle_favorite)", async () => {
    await useNotesStore.getState().newNote();
    expect(useNotesStore.getState().activeDraft).toBe(true);

    mockMaterializeIpc({
      note: { id: "n5", folder_id: "inbox1", title: "Untitled Note", year: 2026, is_favorite: true, exported_at: null, has_image: false, tag_names: [] as string[] },
      sections: [{ id: "sec1", name: "Overview", body_md: "", position: 0, kind: "text" as const }],
      sources: [],
      attachments: [],
    });

    await useNotesStore.getState().toggleFavorite();

    expect(callMock).toHaveBeenCalledWith("note_create", expect.objectContaining({ folder_id: "inbox1" }));
    // draft.note.is_favorite is read back off the (already-flipped) activeNote right after
    // note_create resolves — so the post-materialize sync call carries the NEW id, not "__draft__".
    expect(callMock).toHaveBeenCalledWith("note_toggle_favorite", { id: "n5" });
    expect(useNotesStore.getState().activeDraft).toBe(false);
    expect(useNotesStore.getState().activeNote?.note.id).toBe("n5");
    expect(useNotesStore.getState().activeNote?.note.is_favorite).toBe(true);
  });

  it("setStatus() on a draft applies locally, then materializes (note_create + note_set_status)", async () => {
    await useNotesStore.getState().newNote();

    mockMaterializeIpc({
      note: { id: "n6", folder_id: "inbox1", title: "Untitled Note", year: 2026, is_favorite: false, exported_at: null, has_image: false, tag_names: [] as string[] },
      sections: [{ id: "sec1", name: "Overview", body_md: "", position: 0, kind: "text" as const }],
      sources: [],
      attachments: [],
    });

    await useNotesStore.getState().setStatus("in_progress");

    expect(callMock).toHaveBeenCalledWith("note_create", expect.objectContaining({ folder_id: "inbox1" }));
    expect(callMock).toHaveBeenCalledWith("note_set_status", { id: "n6", status: "in_progress" });
    expect(useNotesStore.getState().activeDraft).toBe(false);
    expect(useNotesStore.getState().activeNote?.note.status).toBe("in_progress");
  });

  // Regression (2026-09-03 owner repro): picking a place on a still-draft note (new note ->
  // titlebar region badge -> geocode search) silently dropped lat/lng at materialize time — the
  // region NAME was copied onto the freshly-created note and re-applied via note_set_region, but
  // lat/lng were neither copied onto `detail.note` nor re-applied via note_set_location, so the
  // saved note ended up with a region string and null coords: stuck forever in the sidebar's
  // "no location" bucket (server-side coords:none query) and missing its primary map pin.
  it("setLocation() on a draft applies locally, then materializes (note_create + note_set_location)", async () => {
    await useNotesStore.getState().newNote();

    mockMaterializeIpc({
      note: { id: "n7", folder_id: "inbox1", title: "Untitled Note", year: 2026, is_favorite: false, exported_at: null, has_image: false, tag_names: [] as string[] },
      sections: [{ id: "sec1", name: "Overview", body_md: "", position: 0, kind: "text" as const }],
      sources: [],
      attachments: [],
    });

    await useNotesStore.getState().setLocation(37.5, 127.1);

    expect(callMock).toHaveBeenCalledWith("note_create", expect.objectContaining({ folder_id: "inbox1" }));
    expect(callMock).toHaveBeenCalledWith("note_set_location", { id: "n7", lat: 37.5, lng: 127.1 });
    expect(useNotesStore.getState().activeDraft).toBe(false);
    expect(useNotesStore.getState().activeNote?.note.lat).toBe(37.5);
    expect(useNotesStore.getState().activeNote?.note.lng).toBe(127.1);
  });

  // Same class as setLocation above, found while auditing every patchActiveNote-based setter for
  // the same gap: ensureMaterialized's copy+re-apply lists were a hand-maintained allowlist that
  // only ever covered title/tags/region/status/favorite/body — icon, event precision, event end,
  // remind, and schedule (all reachable on a still-draft note via DateBadge/ReminderModal/the
  // titlebar icon control, none of which guard on activeDraft) silently dropped whatever the user
  // picked before the note's first materializing action.
  it("setIcon() on a draft applies locally, then materializes (note_create + note_set_icon)", async () => {
    await useNotesStore.getState().newNote();

    mockMaterializeIpc({
      note: { id: "n8", folder_id: "inbox1", title: "Untitled Note", year: 2026, is_favorite: false, exported_at: null, has_image: false, tag_names: [] as string[] },
      sections: [{ id: "sec1", name: "Overview", body_md: "", position: 0, kind: "text" as const }],
      sources: [],
      attachments: [],
    });

    await useNotesStore.getState().setIcon("emoji:🌲");

    expect(callMock).toHaveBeenCalledWith("note_set_icon", { id: "n8", icon: "emoji:🌲" });
    expect(useNotesStore.getState().activeNote?.note.icon).toBe("emoji:🌲");
  });

  it("setEventPrecision() on a draft re-applies month/day at materialize when it differs from note_create's default", async () => {
    await useNotesStore.getState().newNote();

    mockMaterializeIpc({
      // note_create's own default (today) — deliberately NOT 3/15, so the re-apply fires.
      note: { id: "n9", folder_id: "inbox1", title: "Untitled Note", year: 2026, is_favorite: false, exported_at: null, has_image: false, tag_names: [] as string[], month: 1, day: 1 },
      sections: [{ id: "sec1", name: "Overview", body_md: "", position: 0, kind: "text" as const }],
      sources: [],
      attachments: [],
    });

    await useNotesStore.getState().setEventPrecision(3, 15);

    // note_set_event_precision was deleted (PLAN-2026-09-08-dates-rebuild.md W3) — the re-apply
    // now goes through lib/primaryDate.ts::replacePrimaryDate's add+promote composite (no id-free
    // command exists to write the primary row directly, see that file's header).
    expect(callMock).not.toHaveBeenCalledWith("note_set_event_precision", expect.anything());
    expect(callMock).toHaveBeenCalledWith(
      "note_date_update",
      expect.objectContaining({ id: "primary-row", month: 3, day: 15 }),
    );
    expect(useNotesStore.getState().activeNote?.note.month).toBe(3);
    expect(useNotesStore.getState().activeNote?.note.day).toBe(15);
  });

  it("does not re-send month/day at materialize when the draft's date matches note_create's own default (no redundant round trip)", async () => {
    await useNotesStore.getState().newNote();
    const draftDate = useNotesStore.getState().activeNote!.note;

    mockMaterializeIpc({
      // note_create echoes the exact same date the draft already had — nothing was ever
      // changed via DateBadge, so ensureMaterialized must not re-apply the primary's precision.
      note: { id: "n10", folder_id: "inbox1", title: "Untitled Note", year: 2026, is_favorite: false, exported_at: null, has_image: false, tag_names: [] as string[], month: draftDate.month, day: draftDate.day },
      sections: [{ id: "sec1", name: "Overview", body_md: "", position: 0, kind: "text" as const }],
      sources: [],
      attachments: [],
    });

    await useNotesStore.getState().ensureMaterialized();

    expect(callMock).not.toHaveBeenCalledWith("note_date_update", expect.anything());
  });

  it("setEventEnd() on a draft applies locally, then materializes (note_create + replacePrimaryDate)", async () => {
    await useNotesStore.getState().newNote();
    const draftDate = useNotesStore.getState().activeNote!.note;

    mockMaterializeIpc({
      note: {
        id: "n11", folder_id: "inbox1", title: "Untitled Note", year: 2026, is_favorite: false,
        exported_at: null, has_image: false, tag_names: [] as string[],
        month: draftDate.month, day: draftDate.day,
      },
      sections: [{ id: "sec1", name: "Overview", body_md: "", position: 0, kind: "text" as const }],
      sources: [],
      attachments: [],
    });

    await useNotesStore.getState().setEventEnd(2026, 6, 20);

    // note_set_event_end was deleted — replacePrimaryDate's add+promote composite absorbs it.
    expect(callMock).not.toHaveBeenCalledWith("note_set_event_end", expect.anything());
    expect(callMock).toHaveBeenCalledWith(
      "note_date_update",
      expect.objectContaining({ id: "primary-row", end_year: 2026, end_month: 6, end_day: 20 }),
    );
    expect(useNotesStore.getState().activeNote?.note.end_year).toBe(2026);
  });

  it("setRemind() on a draft applies locally, then materializes (note_create + note_update)", async () => {
    await useNotesStore.getState().newNote();

    mockMaterializeIpc({
      note: { id: "n12", folder_id: "inbox1", title: "Untitled Note", year: 2026, is_favorite: false, exported_at: null, has_image: false, tag_names: [] as string[] },
      sections: [{ id: "sec1", name: "Overview", body_md: "", position: 0, kind: "text" as const }],
      sources: [],
      attachments: [],
    });

    await useNotesStore.getState().setRemind(true);

    expect(callMock).toHaveBeenCalledWith("note_update", { id: "n12", remind: true });
    expect(useNotesStore.getState().activeNote?.note.remind).toBe(true);
  });

  it("setSchedule() on a draft applies locally, then materializes (note_create + replacePrimaryDate)", async () => {
    await useNotesStore.getState().newNote();
    const draftDate = useNotesStore.getState().activeNote!.note;

    mockMaterializeIpc({
      note: {
        id: "n13", folder_id: "inbox1", title: "Untitled Note", year: 2026, is_favorite: false,
        exported_at: null, has_image: false, tag_names: [] as string[],
        month: draftDate.month, day: draftDate.day,
      },
      sections: [{ id: "sec1", name: "Overview", body_md: "", position: 0, kind: "text" as const }],
      sources: [],
      attachments: [],
    });

    await useNotesStore.getState().setSchedule({
      start_time: "09:00",
      end_time: "10:00",
      remind_offset_min: 15,
      rrule: "FREQ=WEEKLY",
    });

    // note_set_schedule was deleted — replacePrimaryDate's add+promote composite absorbs it.
    expect(callMock).not.toHaveBeenCalledWith("note_set_schedule", expect.anything());
    expect(callMock).toHaveBeenCalledWith(
      "note_date_update",
      expect.objectContaining({
        id: "primary-row",
        start_time: "09:00",
        end_time: "10:00",
        remind_offset_min: 15,
        rrule: "FREQ=WEEKLY",
      }),
    );
    expect(useNotesStore.getState().activeNote?.note.rrule).toBe("FREQ=WEEKLY");
  });

  // discardDraft()'s own cleanup semantics (activeNote -> null, activeDraft -> false, no
  // note_create call) are already covered by notes.test.ts's "draft leaves no DB trace" and
  // "discardDraft() discards the draft quietly" tests — not duplicated here.
});

describe("notes store — optimistic metadata setters, success/failure symmetry (characterization)", () => {
  beforeEach(() => {
    callMock.mockReset();
    toastMock.mockClear();
    flushAllMock.mockClear();
    emitNoticeMock.mockReset();
  });

  describe.each([
    { setter: "setStatus" as const, field: "status" as const, ipc: "note_set_status", before: "todo", next: "done", serverEcho: "done" },
    { setter: "setRegion" as const, field: "region" as const, ipc: "note_set_region", before: "kr", next: "jp", serverEcho: "jp" },
  ])("$setter (non-draft)", ({ setter, field, ipc, before, next, serverEcho }) => {
    const setup = () => {
      const n1 = note("n1", "f1", { [field]: before });
      const detail = detailFor(n1);
      useNotesStore.setState({
        activeNote: detail,
        activeDraft: false,
        notesByFolder: { f1: [n1] },
        noteIndex: new Map([["n1", n1]]),
      });
      return n1;
    };

    it("success: sets savedState 'saving' synchronously, then applies the server echo to both activeNote and the tree summary", async () => {
      setup();
      callMock.mockImplementation((cmd: string) =>
        cmd === ipc ? Promise.resolve({ [field]: serverEcho }) : Promise.resolve()
      );

      const p = (useNotesStore.getState()[setter] as (v: string | null) => Promise<void>)(next);
      expect(useNotesStore.getState().savedState).toBe("saving");
      await p;

      expect(callMock).toHaveBeenCalledWith(ipc, { id: "n1", [field]: next });
      const state = useNotesStore.getState();
      expect((state.activeNote?.note as unknown as Record<string, unknown>)[field]).toBe(serverEcho);
      expect((state.noteIndex.get("n1") as unknown as Record<string, unknown>)[field]).toBe(serverEcho);
      expect(state.savedState).toBe("saved");
    });

    it("failure: rolls back BOTH activeNote and the tree summary (patchNoteSummary) to the pre-edit value, marks savedState 'failed', no notice", async () => {
      setup();
      callMock.mockImplementation((cmd: string) => (cmd === ipc ? Promise.reject(new Error("network error")) : Promise.resolve()));

      await (useNotesStore.getState()[setter] as (v: string | null) => Promise<void>)(next);

      const state = useNotesStore.getState();
      expect((state.activeNote?.note as unknown as Record<string, unknown>)[field]).toBe(before);
      expect((state.noteIndex.get("n1") as unknown as Record<string, unknown>)[field]).toBe(before);
      expect(state.savedState).toBe("failed");
      // Unlike setEventPrecision/setEventEnd, setStatus/setRegion's catch block never calls
      // emitNotice — locking that asymmetry in so a refactor can't silently add/drop it either way.
      expect(emitNoticeMock).not.toHaveBeenCalled();
    });
  });

  describe("toggleFavorite (non-draft) — a DIFFERENT shape from setStatus/setRegion: it awaits call() before touching state at all, so there is no optimistic value to roll back", () => {
    it("success: updates activeNote + tree summary from the IPC response (no optimistic pre-set)", async () => {
      const n1 = note("n1", "f1", { is_favorite: false });
      const detail = detailFor(n1);
      useNotesStore.setState({
        activeNote: detail,
        activeDraft: false,
        notesByFolder: { f1: [n1] },
        noteIndex: new Map([["n1", n1]]),
      });
      callMock.mockImplementation((cmd: string) =>
        cmd === "note_toggle_favorite" ? Promise.resolve({ is_favorite: true }) : Promise.resolve()
      );

      await useNotesStore.getState().toggleFavorite();

      expect(callMock).toHaveBeenCalledWith("note_toggle_favorite", { id: "n1" });
      const state = useNotesStore.getState();
      expect(state.activeNote?.note.is_favorite).toBe(true);
      expect(state.noteIndex.get("n1")?.is_favorite).toBe(true);
    });

    it("failure: call() rejection propagates UNCAUGHT out of toggleFavorite() — activeNote/tree summary are untouched (there was nothing to roll back)", async () => {
      const n1 = note("n1", "f1", { is_favorite: false });
      const detail = detailFor(n1);
      useNotesStore.setState({
        activeNote: detail,
        activeDraft: false,
        notesByFolder: { f1: [n1] },
        noteIndex: new Map([["n1", n1]]),
      });
      callMock.mockImplementation((cmd: string) =>
        cmd === "note_toggle_favorite" ? Promise.reject(new Error("net down")) : Promise.resolve()
      );

      // No try/catch inside toggleFavorite's non-draft branch — the rejection is not swallowed.
      await expect(useNotesStore.getState().toggleFavorite()).rejects.toThrow("net down");

      const state = useNotesStore.getState();
      expect(state.activeNote?.note.is_favorite).toBe(false);
      expect(state.noteIndex.get("n1")?.is_favorite).toBe(false);
      // call()'s own toast-on-reject path (lib/invoke.ts) still fired even though the store
      // itself never catches this one.
      expect(toastMock).toHaveBeenCalled();
    });
  });
});

describe("notes store — debounced title/year autosave (characterization)", () => {
  const detail = (id: string) => detailFor(note(id, "f1"));

  beforeEach(() => {
    vi.useFakeTimers();
    useNotesStore.setState({ activeNote: null, activeDraft: false, savedState: "saved" });
    callMock.mockReset();
    toastMock.mockClear();
    emitNoticeMock.mockReset();
  });

  afterEach(() => {
    useNotesStore.setState({ activeNote: null, activeDraft: false });
    vi.useRealTimers();
  });

  it("setTitle() (non-draft): local state + savedState 'saving' apply synchronously; the IPC write only fires 700ms later via callSilent(note_update)", async () => {
    useNotesStore.setState({ activeNote: detail("n1"), activeDraft: false });
    callMock.mockResolvedValue({});

    useNotesStore.getState().setTitle("New Title");

    expect(useNotesStore.getState().activeNote?.note.title).toBe("New Title");
    expect(useNotesStore.getState().savedState).toBe("saving");
    expect(callMock).not.toHaveBeenCalledWith("note_update", expect.anything());

    await vi.advanceTimersByTimeAsync(700);

    expect(callMock).toHaveBeenCalledWith("note_update", { id: "n1", title: "New Title" });
    expect(useNotesStore.getState().savedState).toBe("saved");
  });

  it("setTitle() flush failure (generic error): savedState becomes 'failed' and a notice fires", async () => {
    useNotesStore.setState({ activeNote: detail("n1"), activeDraft: false });
    callMock.mockRejectedValue(new Error("offline"));

    useNotesStore.getState().setTitle("New Title");
    await vi.advanceTimersByTimeAsync(700);

    expect(useNotesStore.getState().savedState).toBe("failed");
    expect(emitNoticeMock).toHaveBeenCalled();
  });

  it("setTitle() flush failure with a NOT_FOUND error is treated as saved, not failed (note was deleted elsewhere — not a save error), and does not notice", async () => {
    useNotesStore.setState({ activeNote: detail("n1"), activeDraft: false });
    callMock.mockRejectedValue({ code: "NOT_FOUND" });

    useNotesStore.getState().setTitle("New Title");
    await vi.advanceTimersByTimeAsync(700);

    expect(useNotesStore.getState().savedState).toBe("saved");
    expect(emitNoticeMock).not.toHaveBeenCalled();
  });

  it("setNoteYear() (non-draft): same 700ms-debounce shape, flushes via callSilent(note_update) with { id, year }", async () => {
    useNotesStore.setState({ activeNote: detail("n1"), activeDraft: false });
    callMock.mockResolvedValue({});

    useNotesStore.getState().setNoteYear(1999);
    expect(useNotesStore.getState().activeNote?.note.year).toBe(1999);
    expect(callMock).not.toHaveBeenCalledWith("note_update", expect.anything());

    await vi.advanceTimersByTimeAsync(700);

    expect(callMock).toHaveBeenCalledWith("note_update", { id: "n1", year: 1999 });
    expect(useNotesStore.getState().savedState).toBe("saved");
  });

  it("setNoteYear() flush failure (generic error): savedState becomes 'failed'", async () => {
    useNotesStore.setState({ activeNote: detail("n1"), activeDraft: false });
    callMock.mockRejectedValue(new Error("offline"));

    useNotesStore.getState().setNoteYear(1999);
    await vi.advanceTimersByTimeAsync(700);

    expect(useNotesStore.getState().savedState).toBe("failed");
  });

  it("a second setTitle() edit before the first 700ms elapses replaces the pending write — only ONE callSilent(note_update) fires, with the latest title", async () => {
    useNotesStore.setState({ activeNote: detail("n1"), activeDraft: false });
    callMock.mockResolvedValue({});

    useNotesStore.getState().setTitle("first edit");
    await vi.advanceTimersByTimeAsync(400);
    useNotesStore.getState().setTitle("second edit");
    await vi.advanceTimersByTimeAsync(700);

    expect(callMock.mock.calls.filter((c) => c[0] === "note_update")).toHaveLength(1);
    expect(callMock).toHaveBeenCalledWith("note_update", { id: "n1", title: "second edit" });
  });
});

describe("notes store — updateSectionBody freshness quirk + read-back via flush+note_get (characterization)", () => {
  beforeEach(() => {
    callMock.mockReset();
    flushAllMock.mockClear();
    useNotesStore.setState({
      activeNote: detailFor(note("n1", "f1"), "original body"),
      activeDraft: false,
      activeBodyEmpty: false,
    });
  });

  it("after updateSectionBody(), activeNote.sections keeps the OLD body_md locally (documented quirk); the true value only surfaces after a flush+note_get round trip", async () => {
    callMock.mockResolvedValue({ updated_at: "2024-02-02T00:00:00Z" });

    await useNotesStore.getState().updateSectionBody("sec1", "edited live");

    // The edit WAS sent to the server...
    expect(callMock).toHaveBeenCalledWith("section_update", { id: "sec1", body_md: "edited live" });
    // ...but notes.ts's own comment on this branch is explicit: "activeBodyEmpty only — never
    // patch activeNote.sections here" (caret-reset guard). Assert that quirk directly so a
    // refactor can't silently start eagerly patching sections and break the caret-preservation
    // contract EditorPanel relies on.
    expect(useNotesStore.getState().activeNote?.sections[0]?.body_md).toBe("original body");

    // The only sanctioned way to read the real persisted body back is a flush + note_get —
    // reloadActive() does exactly that (flushAll() then note_get()), and is the seam this store
    // exposes for it.
    callMock.mockResolvedValueOnce(detailFor(note("n1", "f1"), "edited live"));
    await useNotesStore.getState().reloadActive();

    expect(flushAllMock).toHaveBeenCalled();
    expect(useNotesStore.getState().activeNote?.sections[0]?.body_md).toBe("edited live");
  });
});

// EditorPanel's section CRUD (handleAddSection/handleDeleteSection/handleReorderSection/
// handleDropReorder, ~lines 809-963) are closures inside the component that call() section_create/
// section_delete/section_reorder directly — they are NOT store actions, so there is no store-level
// seam to assert their exact IPC args from here, and mounting a full EditorPanel needs a live
// Tiptap editor + note/IPC harness disproportionate to a characterization smoke test. Two things
// already de-risk this for the refactor without that mount:
//   1. EditorPanel.diagram.test.tsx already locks in the pure payload-building helpers
//      (buildDiagramSectionArgs / buildAiInsertSectionArgs / resolveActiveSection) that those
//      handlers call into.
//   2. The one store-level seam every section CRUD path shares afterward — re-reading a section's
//      true body only via flush+note_get, never via a stale local copy — is covered by the
//      updateSectionBody freshness-quirk test directly above.
// Skipped: a full handleAddSection/handleDeleteSection/handleReorderSection component-level test.
describe("notes store — tab switch/reselect: A → edit → B → A (characterization)", () => {
  beforeEach(() => {
    callMock.mockReset();
    flushAllMock.mockClear();
    useTabsStore.setState({ openTabs: [], activeTabId: null });
    useNotesStore.setState({ activeNote: null, activeDraft: false, loadingNoteId: null });
  });

  it("selectNote(A) → setTitle edit → selectNote(B) → selectNote(A): every switch flushes first (flushAll before note_get) and lands on the freshly-fetched note, no stale carryover", async () => {
    const noteA = { note: { id: "A", title: "Note A" }, sections: [] };
    const noteASecondVisit = { note: { id: "A", title: "Note A (round 2)" }, sections: [] };
    const noteB = { note: { id: "B", title: "Note B" }, sections: [] };
    let getCallsForA = 0;
    callMock.mockImplementation((cmd: string, args: any) => {
      if (cmd === "note_get" && args?.id === "A") {
        getCallsForA++;
        return Promise.resolve(getCallsForA === 1 ? noteA : noteASecondVisit);
      }
      if (cmd === "note_get" && args?.id === "B") return Promise.resolve(noteB);
      return Promise.resolve({});
    });

    await useNotesStore.getState().selectNote("A");
    expect(useNotesStore.getState().activeNote?.note.id).toBe("A");
    expect(flushAllMock).toHaveBeenCalledTimes(1);

    // "edit" — setTitle()'s local half (the debounced remote write itself is covered in the
    // dedicated autosave describe above; this test's concern is switch ordering/data integrity).
    useNotesStore.getState().setTitle("edited while on A");
    expect(useNotesStore.getState().activeNote?.note.title).toBe("edited while on A");

    await useNotesStore.getState().selectNote("B");
    expect(flushAllMock).toHaveBeenCalledTimes(2); // switching away flushes first, every time
    expect(useNotesStore.getState().activeNote?.note.id).toBe("B");

    await useNotesStore.getState().selectNote("A");
    expect(flushAllMock).toHaveBeenCalledTimes(3);
    expect(useNotesStore.getState().activeNote?.note.id).toBe("A");
    // Re-selecting A re-fetches from the server rather than replaying anything cached locally —
    // no leftover edit from the first visit leaks in as a stale value.
    expect(useNotesStore.getState().activeNote?.note.title).toBe("Note A (round 2)");
  });
});
