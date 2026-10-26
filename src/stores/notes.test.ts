import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const callMock = vi.fn();
const flushAllMock = vi.fn(async () => {});
const emitNoticeMock = vi.fn();
// Simulates the real contract from lib/invoke.ts: call() always toasts on rejection (via
// emitError), callSilent() never does. Tracking that here lets tests assert on which path a
// failure took without re-testing invoke.ts's internals.
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

// W2b(모바일 재편 통합): stores/notesTree.ts::loadTree() reads isBrowser()/isMobileViewport() from
// lib/env.ts to decide whether to skip folder_list. Default both false so every existing loadTree()
// test in this file (which all assume the real desktop path) is untouched — only the dedicated
// "mobile browser path" describe block below flips these. Real window/sessionStorage manipulation
// (the env.test.ts style) proved unreliable in this file's shared jsdom context (other describe
// blocks in this large file touch window.location/history), so this mirrors the mutable-flag mock
// convention lib/remoteNoteWrite.test.ts already uses for the same isBrowser() seam.
let mockIsBrowser = false;
let mockIsMobileViewport = false;
vi.mock("../lib/env", () => ({
  isBrowser: () => mockIsBrowser,
  isMobileViewport: () => mockIsMobileViewport,
}));

import { useNotesStore, isNoteBodyEmpty, displayTitle } from "./notes";
import { usePresetsStore } from "./presets";
import { registerSectionInserter } from "../lib/aiSectionBridge";
import { useSearchStore } from "./search";
import { useSettingsStore } from "./settings";
import { useTabsStore } from "./tabs";

describe("notes store — draft lifecycle (P28)", () => {
  beforeEach(() => {
    callMock.mockReset();
    toastMock.mockClear();
    flushAllMock.mockClear();
    emitNoticeMock.mockReset();
    // Wave 2.1: inbox 의 SSOT 는 settings_store 의 `inbox_<workspace_id>` 키. loadTree() 가
    // persisted id 를 읽도록 activeWorkspaceId 를 테스트용 값으로 세팅한다.
    useSettingsStore.setState({ activeWorkspaceId: "w1" });
    useTabsStore.setState({ openTabs: [], activeTabId: null });
    useNotesStore.setState({ folders: [], activeNote: null, activeDraft: false, inboxId: null });
  });

  it("newNote() (ambiguous — no folderId, e.g. the '+' tab button) sets draft state locally without calling note_create", async () => {
    // P29 draft-page model: the "+" button / empty-state entry point (no explicit folderId)
    // must never touch the DB just by being opened — only an actual materialize trigger
    // (typing, a preset, AI, an attachment) may. Preseed inboxId so ensureInboxId() resolves
    // from local state instead of round-tripping folder_create/settings IPC — this test's only
    // concern is "no newNote() call site" here writes anything.
    useNotesStore.setState({ inboxId: "inbox1" });
    await useNotesStore.getState().newNote();

    expect(callMock).not.toHaveBeenCalledWith("note_create", expect.anything());
    expect(callMock).not.toHaveBeenCalledWith("folder_create", expect.anything());
    expect(useNotesStore.getState().activeDraft).toBe(true);
    expect(useNotesStore.getState().activeNote?.note.id).toBe("__draft__");
    expect(useNotesStore.getState().activeNote?.note.folder_id).toBe("inbox1");
  });

  it("draft leaves no DB trace: newNote() then leaving without filling anything in never calls note_create", async () => {
    // The core P29 invariant: opening the draft page and walking away (closing the tab bar's
    // "draft", clicking another tab, quitting) must leave zero rows behind. selectNote()/
    // TabBar's close paths both route through discardDraft() — simulate that full round trip.
    useNotesStore.setState({ inboxId: "inbox1" });
    await useNotesStore.getState().newNote();
    expect(useNotesStore.getState().activeDraft).toBe(true);

    useNotesStore.getState().discardDraft();

    expect(useNotesStore.getState().activeNote).toBeNull();
    expect(useNotesStore.getState().activeDraft).toBe(false);
    expect(callMock).not.toHaveBeenCalledWith("note_create", expect.anything());
  });

  it("newNote() (ambiguous) is a no-op when a draft is already open — doesn't reset in-progress typing", async () => {
    // Clicking "+" (or Ctrl+N) again while the draft page is already showing must not blow
    // away whatever title/body the user already typed into the still-unmaterialized draft.
    useNotesStore.setState({ inboxId: "inbox1" });
    await useNotesStore.getState().newNote();
    const draftBefore = useNotesStore.getState().activeNote;
    useNotesStore.setState({
      activeNote: { ...draftBefore!, note: { ...draftBefore!.note, title: "typing in progress" } },
    });

    await useNotesStore.getState().newNote();

    expect(useNotesStore.getState().activeNote?.note.title).toBe("typing in progress");
    expect(callMock).not.toHaveBeenCalledWith("note_create", expect.anything());
  });

  it("newNote() (ambiguous) clears settings activeTabId but leaves openTabs alone", async () => {
    // Item 3: "+" deactivates whatever tab was showing without closing any of them, so the tab
    // bar renders no highlighted tab while the draft page is up.
    useNotesStore.setState({ inboxId: "inbox1" });
    useTabsStore.setState({ openTabs: ["n1", "n2"], activeTabId: "n2" });

    await useNotesStore.getState().newNote();

    expect(useTabsStore.getState().openTabs).toEqual(["n1", "n2"]);
    expect(useTabsStore.getState().activeTabId).toBeNull();
  });

  it("newNote() draft section name follows uiLang and newNoteSectionName override", async () => {
    useNotesStore.setState({ inboxId: "inbox1" });

    // 1) uiLang = "ko" (default) -> "개요"
    useSettingsStore.setState({ uiLang: "ko", newNoteSectionName: "" });
    await useNotesStore.getState().newNote();
    expect(useNotesStore.getState().activeNote?.sections[0].name).toBe("개요");
    useNotesStore.getState().discardDraft();

    // 2) uiLang = "en" -> "Overview"
    useSettingsStore.setState({ uiLang: "en", newNoteSectionName: "" });
    await useNotesStore.getState().newNote();
    expect(useNotesStore.getState().activeNote?.sections[0].name).toBe("Overview");
    useNotesStore.getState().discardDraft();

    // 3) uiLang = "fr" -> "Aperçu"
    useSettingsStore.setState({ uiLang: "fr", newNoteSectionName: "" });
    await useNotesStore.getState().newNote();
    expect(useNotesStore.getState().activeNote?.sections[0].name).toBe("Aperçu");
    useNotesStore.getState().discardDraft();

    // 4) newNoteSectionName override wins regardless of language
    useSettingsStore.setState({ uiLang: "ko", newNoteSectionName: "  회의록  " });
    await useNotesStore.getState().newNote();
    expect(useNotesStore.getState().activeNote?.sections[0].name).toBe("회의록");
    useNotesStore.getState().discardDraft();
  });

  it("newNote(folderId) (explicit target, e.g. the tree row's hover '+') materializes immediately instead of staying a draft", async () => {
    // Spec: explicit-folder creation keeps the old immediate-creation behavior — unlike the
    // ambiguous "+" path above, this one is expected to write to the DB right away and open a
    // real tab, since the user pointed at a specific folder rather than landing on the
    // ambiguous draft page.
    // month/day match note_create's real default (today, same as newNote()'s own draft template)
    // so ensureMaterialized()'s eventPrecisionChanged stays false and replacePrimaryDate
    // (lib/primaryDate.ts) never fires — this test isn't about the date axis.
    const now = new Date();
    const detail = {
      note: {
        id: "n9", folder_id: "explicit-folder", title: "Untitled Note", year: 2026,
        month: now.getMonth() + 1, day: now.getDate(),
        is_favorite: false, exported_at: null, has_image: false, tag_names: [],
      },
      sections: [{ id: "sec1", body_md: "" }],
      sources: [],
      attachments: [],
    };
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "note_create") return Promise.resolve(detail);
      if (cmd === "folder_list" || cmd === "folder_list_meta") return Promise.resolve({ folders: [], notes_by_folder: {} });
      if (cmd === "note_tags_index") return Promise.resolve({ tags_by_note: {} });
      if (cmd === "tag_counts") return Promise.resolve({ counts: {} });
      return Promise.resolve();
    });

    await useNotesStore.getState().newNote("explicit-folder");

    // fid comes straight off the draft's folder_id — ensureInboxId (and its folder_create
    // fallback) must never be reached for an explicit target.
    expect(callMock).not.toHaveBeenCalledWith("folder_create", expect.anything());
    expect(callMock).toHaveBeenCalledWith("note_create", expect.objectContaining({ folder_id: "explicit-folder" }));
    expect(useNotesStore.getState().activeDraft).toBe(false);
    expect(useNotesStore.getState().activeNote?.note.id).toBe("n9");
    expect(useTabsStore.getState().openTabs).toContain("n9");
    expect(useTabsStore.getState().activeTabId).toBe("n9");
  });

  it("ensureMaterialized() creates inbox folder if missing, then note, and clears draft", async () => {
    // Wave 2.1: ensureInboxId() 는 settings_store 의 `inbox_<workspaceId>` 키로 persisted id 를
    // 읽고, 없으면 folder_create 후 settings_set 으로 영속. loadTree() 도 같은 키를 단일 SSOT
    // 로 본다. 테스트는 빈 settings 로 시작하여 ensureInboxId() 가 create → persist → loadTree
    // 가 그 id 를 다시 읽어 inboxId 를 동기화하는 전 라인을 검증한다.
    // month/day match note_create's real default (today) so ensureMaterialized()'s
    // eventPrecisionChanged stays false and replacePrimaryDate never fires for this test.
    const now = new Date();
    const detail = {
      note: {
        id: "n2", folder_id: "f2", title: "Untitled Note", year: 2024,
        month: now.getMonth() + 1, day: now.getDate(),
        is_favorite: false, exported_at: null, has_image: false, tag_names: [],
      },
      sections: [{ id: "sec1", body_md: "" }],
      sources: [],
      attachments: [],
    };
    callMock.mockImplementation((cmd: string, args: unknown) => {
      if (cmd === "folder_create") return Promise.resolve({ id: "f2", workspace_id: "w1", name: "Inbox", position: 0, is_open: true, note_count: 0 });
      if (cmd === "note_create") return Promise.resolve(detail);
      if (cmd === "folder_list" || cmd === "folder_list_meta") {
        // loadTree 가 도착하는 시점에는 inbox 가 이미 folder_create 로 만들어져 있음을 가정 —
        // ensureInboxId 의 setState 가 folders 에 [f2] 를 추가했지만, 다음 loadTree 가
        // folder_list 로 다시 그 folder 를 확인 (서버도 같은 폴더를 보유하고 있다는 시나리오).
        const folders = [{ id: "f2", workspace_id: "w1", name: "Inbox", position: 0, is_open: true, note_count: 1 }];
        return Promise.resolve({ folders, notes_by_folder: { f2: [detail.note] } });
      }
      if (cmd === "settings_set") {
        // 외부 settings_store 흉내 — settings_set 으로 들어온 inbox_w1 키를 기억해 settings_get_all
        // 에 노출한다. (real 워크스페이스 = Rust 의 settings table 과 같은 역할.)
        const a = args as { entries?: Record<string, unknown> } | undefined;
        if (a?.entries?.inbox_w1) persistedInboxId = a.entries.inbox_w1 as string;
        return Promise.resolve({ ok: true });
      }
      if (cmd === "settings_get_all") {
        return Promise.resolve({ settings: persistedInboxId ? { inbox_w1: persistedInboxId } : {} });
      }
      if (cmd === "note_tags_index") return Promise.resolve({ tags_by_note: {} });
      if (cmd === "tag_counts") return Promise.resolve({ counts: {} });
      return Promise.resolve();
    });

    let persistedInboxId: string | undefined;

    await useNotesStore.getState().newNote();
    const newId = await useNotesStore.getState().ensureMaterialized();

    expect(callMock).toHaveBeenCalledWith("folder_create", { name: "Inbox" });
    // settings_set 으로 inbox_w1 가 영속되었는지.
    expect(callMock).toHaveBeenCalledWith(
      "settings_set",
      expect.objectContaining({ entries: expect.objectContaining({ inbox_w1: "f2" }) }),
    );
    // note_create 는 이제 드래프트 연도(기본=생성일 올해)를 함께 넘긴다.
    expect(callMock).toHaveBeenCalledWith(
      "note_create",
      expect.objectContaining({ folder_id: "f2" }),
    );
    expect(useNotesStore.getState().activeDraft).toBe(false);
    expect(useNotesStore.getState().activeNote?.note.id).toBe("n2");
    expect(newId).toBe("n2");
    // loadTree 가 끝난 뒤에도 inboxId 는 persisted id ("f2") 로 유지 — 이름 매칭에 의존하지
    // 않고 settings_store 의 키만 본다.
    expect(useNotesStore.getState().inboxId).toBe("f2");
  });

  it("regression P0: concurrent ensureMaterialized() calls share one in-flight promise — note_create fires once", async () => {
    let resolveNoteCreate!: (v: unknown) => void;
    const noteCreatePending = new Promise((res) => {
      resolveNoteCreate = res;
    });
    // month/day match note_create's real default (today) so ensureMaterialized()'s
    // eventPrecisionChanged stays false and replacePrimaryDate never fires for this test.
    const nowP0 = new Date();
    const detail = {
      note: {
        id: "n2", folder_id: "f2", title: "Untitled Note", year: 2024,
        month: nowP0.getMonth() + 1, day: nowP0.getDate(),
        is_favorite: false, exported_at: null, has_image: false, tag_names: [],
      },
      sections: [{ id: "sec1", body_md: "" }],
      sources: [],
      attachments: [],
    };
    let noteCreateCalls = 0;
    let persistedInboxId: string | undefined;
    callMock.mockImplementation((cmd: string, args: unknown) => {
      if (cmd === "folder_create") return Promise.resolve({ id: "f2", workspace_id: "w1", name: "Inbox", position: 0, is_open: true, note_count: 0 });
      if (cmd === "note_create") {
        noteCreateCalls++;
        return noteCreatePending.then(() => detail);
      }
      if (cmd === "folder_list" || cmd === "folder_list_meta") return Promise.resolve({ folders: [], notes_by_folder: {} });
      if (cmd === "settings_set") {
        const a = args as { entries?: Record<string, unknown> } | undefined;
        if (a?.entries?.inbox_w1) persistedInboxId = a.entries.inbox_w1 as string;
        return Promise.resolve({ ok: true });
      }
      if (cmd === "settings_get_all") {
        return Promise.resolve({ settings: persistedInboxId ? { inbox_w1: persistedInboxId } : {} });
      }
      if (cmd === "note_tags_index") return Promise.resolve({ tags_by_note: {} });
      if (cmd === "tag_counts") return Promise.resolve({ counts: {} });
      return Promise.resolve();
    });

    // Wave 2: mock 설치 후 newNote() 호출 — newNote() 가 inbox 폴더를 lazy-create 할 때
    // folder_create mock 이 적용되어야 한다.
    await useNotesStore.getState().newNote();

    // Simulate two near-simultaneous triggers (e.g. two fast keystrokes in setTitle) — neither
    // awaited before the second fires, mirroring the real fire-and-forget call sites.
    const p1 = useNotesStore.getState().ensureMaterialized();
    const p2 = useNotesStore.getState().ensureMaterialized();

    // Let the first call's settings_get_all -> folder_create -> settings_set chain (P29/P30:
    // newNote() no longer pre-resolves inboxId itself, so ensureMaterialized()'s own
    // `if (!fid) fid = await ensureInboxId()` fallback does the round trip here) resolve and
    // note_create get invoked. A macrotask flush drains the whole microtask chain regardless of
    // its depth, unlike a fixed count of `await Promise.resolve()` ticks.
    await new Promise((r) => setTimeout(r, 0));

    // Both callers should be sharing the same in-flight note_create — it must not have resolved
    // or been invoked more than once.
    expect(noteCreateCalls).toBe(1);

    resolveNoteCreate(undefined);
    const [id1, id2] = await Promise.all([p1, p2]);

    expect(noteCreateCalls).toBe(1);
    expect(id1).toBe("n2");
    expect(id2).toBe("n2");
    expect(useNotesStore.getState().activeDraft).toBe(false);
    expect(useNotesStore.getState().activeNote?.note.id).toBe("n2");

    // A third call after materialization has completed must not re-create — it should hit the
    // early-return (activeDraft is now false).
    const id3 = await useNotesStore.getState().ensureMaterialized();
    expect(noteCreateCalls).toBe(1);
    expect(id3).toBe("n2");
  });

  it("loadTree() resolves inboxId from persisted id (id match, not name)", async () => {
    // Wave 2.1: SSOT = settings_store. settings 가 inbox_w1 = "inbox-existing" 를 알려주면
    // folder_list 의 "Inbox" 이름 폴더(다른 id) 는 inbox 로 잡히면 안 된다 — id 매칭이다.
    const folderList = [
      { id: "inbox-existing", workspace_id: "w1", name: "Inbox", position: 0, is_open: true, note_count: 0 },
      { id: "decoy", workspace_id: "w1", name: "Inbox", position: 1, is_open: true, note_count: 0 },
    ];
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "folder_list" || cmd === "folder_list_meta") return Promise.resolve({ folders: folderList, notes_by_folder: {} });
      if (cmd === "settings_get_all") return Promise.resolve({ settings: { inbox_w1: "inbox-existing" } });
      if (cmd === "note_tags_index") return Promise.resolve({ tags_by_note: {} });
      if (cmd === "tag_counts") return Promise.resolve({ counts: {} });
      return Promise.resolve();
    });

    await useNotesStore.getState().loadTree();
    expect(useNotesStore.getState().inboxId).toBe("inbox-existing");
  });

  it("loadTree() leaves inboxId null when persisted id points to a folder that no longer exists", async () => {
    // persisted id 가 stale — folder_list 에 그 id 가 없으면 inboxId = null. 자동 복구
    // (folder_create) 는 다음 newNote() 까지 미루는 것이 옳다 — 동기 force-create 는 부팅
    // 시 폴더 0 짜리 워크스페이스에서 의도치 않은 folder_create 를 촉발할 수 있다.
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "folder_list" || cmd === "folder_list_meta") return Promise.resolve({ folders: [], notes_by_folder: {} });
      if (cmd === "settings_get_all") return Promise.resolve({ settings: { inbox_w1: "stale-id" } });
      if (cmd === "note_tags_index") return Promise.resolve({ tags_by_note: {} });
      if (cmd === "tag_counts") return Promise.resolve({ counts: {} });
      return Promise.resolve();
    });

    await useNotesStore.getState().loadTree();
    expect(useNotesStore.getState().inboxId).toBeNull();
  });

  it("ensureInboxId() surfaces settings_set failure (no silent swallow)", async () => {
    // Wave 2.1: settings_set 실패는 inbox id 영속 손실 = 단절된 숨김 폴더. 더 이상 silently
    // swallow 하지 않고 call() 의 throw 가 위로 전파돼 사용자가 인지한다.
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "folder_create") return Promise.resolve({ id: "f-new", workspace_id: "w1", name: "Inbox", position: 0, is_open: true, note_count: 0 });
      if (cmd === "settings_set") return Promise.reject({ code: "DB", message: "ipc down" });
      if (cmd === "settings_get_all") return Promise.resolve({ settings: {} });
      return Promise.resolve();
    });

    // call() 의 reject 는 lib/invoke.ts 의 emitError 경로로 토스트 + re-throw.
    await expect(useNotesStore.getState().ensureInboxId()).rejects.toBeDefined();
    // 실패 후 inboxId 는 그대로 null — 부분 상태를 노출하지 않는다.
    expect(useNotesStore.getState().inboxId).toBeNull();
  });

  // "newNote(folderId) targets the given folder without going through ensureInboxId" — folded
  // into the "materializes immediately" test above (P29): explicit-folder no longer stays a
  // draft, so the ensureInboxId-skip assertion now lives there alongside the materialize check.

  it("discardDraft() discards the draft quietly", async () => {
    // Ambiguous path (no folderId) — explicit-folder now materializes immediately (see above),
    // so it's no longer a lightweight way to reach a discardable draft. Preseed inboxId to
    // avoid the ensureInboxId round-trip; this test's only concern is discard semantics.
    useNotesStore.setState({ inboxId: "inbox1" });
    await useNotesStore.getState().newNote();
    expect(useNotesStore.getState().activeDraft).toBe(true);

    useNotesStore.getState().discardDraft();
    expect(useNotesStore.getState().activeDraft).toBe(false);
    expect(useNotesStore.getState().activeNote).toBeNull();
  });
});

describe("notes store — activeBodyEmpty (preset-visibility signal, P30)", () => {
  beforeEach(() => {
    callMock.mockReset();
    toastMock.mockClear();
    flushAllMock.mockClear();
    emitNoticeMock.mockReset();
    useSettingsStore.setState({ activeWorkspaceId: "w1" });
    useTabsStore.setState({ openTabs: [], activeTabId: null });
    useNotesStore.setState({ activeNote: null, activeDraft: false, activeBodyEmpty: true, inboxId: null });
  });

  const noteDetail = (bodyMd: string) => ({
    note: {
      id: "n1", folder_id: "f1", title: "Some Title", year: 2024, is_favorite: false,
      exported_at: null, has_image: false, tag_names: [] as string[], region: null, status: null,
      icon: null, lat: null, lng: null, created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z", month: null, day: null,
    },
    sections: [{ id: "sec1", name: "Overview", body_md: bodyMd, position: 0, kind: "text" as const }],
    sources: [],
    attachments: [],
  });

  it("updateSectionBody (non-draft) flips activeBodyEmpty reactively without replacing activeNote.sections (no caret-reset risk)", async () => {
    const detail = noteDetail("some text");
    useNotesStore.setState({ activeNote: detail, activeDraft: false, activeBodyEmpty: false });
    callMock.mockResolvedValue({ updated_at: "2024-02-02T00:00:00Z" });
    const sectionsBefore = useNotesStore.getState().activeNote!.sections;

    await useNotesStore.getState().updateSectionBody("sec1", "");

    expect(useNotesStore.getState().activeBodyEmpty).toBe(true);
    // The section array/object identity must be untouched — EditorPanel's note-load effect calls
    // setContent() on any new activeNote reference, which would reset the caret mid-typing.
    expect(useNotesStore.getState().activeNote!.sections).toBe(sectionsBefore);

    await useNotesStore.getState().updateSectionBody("sec1", "back to real content");
    expect(useNotesStore.getState().activeBodyEmpty).toBe(false);
  });

  it("updateSectionBody (draft) flips activeBodyEmpty and does replace the draft's local section (existing behavior)", async () => {
    useNotesStore.setState({
      activeNote: noteDetail(""),
      activeDraft: true,
      activeBodyEmpty: true,
    });
    // Non-empty body on a draft triggers ensureMaterialized() (noteDetail()'s folder_id "f1" is
    // truthy, so it skips ensureInboxId and goes straight to note_create) — give it a resolvable
    // response so the await completes; only the emptiness flag is actually under test here.
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "note_create") return Promise.resolve(noteDetail("x"));
      if (cmd === "folder_list" || cmd === "folder_list_meta") return Promise.resolve({ folders: [], notes_by_folder: {} });
      if (cmd === "note_tags_index") return Promise.resolve({ tags_by_note: {} });
      if (cmd === "tag_counts") return Promise.resolve({ counts: {} });
      return Promise.resolve();
    });

    await useNotesStore.getState().updateSectionBody("sec1", "x");

    expect(useNotesStore.getState().activeBodyEmpty).toBe(false);
  });

  it("whitespace-only body counts as empty (strip + trim, not just body_md === '')", async () => {
    const detail = noteDetail("was full");
    useNotesStore.setState({ activeNote: detail, activeDraft: false, activeBodyEmpty: false });
    callMock.mockResolvedValue({ updated_at: "2024-02-02T00:00:00Z" });

    await useNotesStore.getState().updateSectionBody("sec1", "   \n\t  ");

    expect(useNotesStore.getState().activeBodyEmpty).toBe(true);
  });

  it("applyPreset() on an existing (materialized) empty note applies in place — no newNote()/note_create, tab state untouched", async () => {
    // P30 item 1: PresetList only shows for a non-draft note when it's already content-empty —
    // applying a preset must fill that same note, not spin up a competing draft (which would
    // deactivate the tab entirely).
    const detail = noteDetail("");
    useNotesStore.setState({ activeNote: detail, activeDraft: false, activeBodyEmpty: true });
    useTabsStore.setState({ openTabs: ["n1"], activeTabId: "n1" });
    callMock.mockResolvedValue({ updated_at: "2024-02-02T00:00:00Z" });

    const secId = await useNotesStore.getState().applyPreset("# To-do\n- [ ] one", "My Preset Title");

    expect(secId).toBe("sec1");
    expect(callMock).toHaveBeenCalledWith(
      "section_update",
      expect.objectContaining({ id: "sec1", body_md: "# To-do\n- [ ] one" }),
    );
    expect(callMock).not.toHaveBeenCalledWith("note_create", expect.anything());
    expect(useNotesStore.getState().activeNote?.note.id).toBe("n1");
    expect(useNotesStore.getState().activeDraft).toBe(false);
    expect(useNotesStore.getState().activeBodyEmpty).toBe(false);
    // The tab that was already open for this note stays exactly as it was — applying a preset
    // in place must not touch openTabs/activeTabId (that's what a real newNote() call would do).
    expect(useTabsStore.getState().openTabs).toEqual(["n1"]);
    expect(useTabsStore.getState().activeTabId).toBe("n1");
  });

  it("applyPreset() on a note that HAS content appends a new section instead — sections[0] is never overwritten", async () => {
    // Owner feedback: the click must not be refused, and must not clobber the body. The gate is
    // the same targetState PresetList labels the row with (stores/presets.ts), and the insert
    // reuses EditorPanel's registered section inserter (lib/aiSectionBridge).
    const detail = noteDetail("already written");
    useNotesStore.setState({ activeNote: detail, activeDraft: false, activeBodyEmpty: false });
    usePresetsStore.setState({ targetState: "has_content" });
    const inserter = vi.fn(async () => null);
    const unregister = registerSectionInserter(inserter as never);
    try {
      const secId = await useNotesStore.getState().applyPreset("# To-do\n- [ ] one", "My Preset Title");

      expect(secId).toBeNull(); // the inserter repaints the editor itself — no double-sync
      // W5: a template skeleton is not AI-written content, so ai_origin stays undefined — but
      // insertAiSection still forwards all 5 positional slots to the registered inserter.
      expect(inserter).toHaveBeenCalledWith(
        "My Preset Title",
        "# To-do\n- [ ] one",
        "n1",
        undefined,
        undefined,
      );
      expect(callMock).not.toHaveBeenCalledWith("section_update", expect.anything());
      expect(useNotesStore.getState().activeNote?.sections[0].body_md).toBe("already written");
    } finally {
      unregister();
      usePresetsStore.setState({ targetState: "ready" });
    }
  });

  it("applyPreset() with no note open falls through to the draft-creation path (existing behavior)", async () => {
    useNotesStore.setState({ inboxId: "inbox1", activeNote: null, activeDraft: false });
    // month/day match note_create's real default (today) so ensureMaterialized()'s
    // eventPrecisionChanged stays false and replacePrimaryDate never fires for this test.
    const nowPreset = new Date();
    const created = {
      note: {
        id: "n9", folder_id: "inbox1", title: "Untitled Note", year: 2024, is_favorite: false,
        exported_at: null, has_image: false, tag_names: [] as string[], region: null, status: null,
        icon: null, lat: null, lng: null, created_at: "2024-01-01T00:00:00Z",
        updated_at: "2024-01-01T00:00:00Z", month: nowPreset.getMonth() + 1, day: nowPreset.getDate(),
      },
      sections: [{ id: "sec9", name: "Overview", body_md: "", position: 0, kind: "text" as const }],
      sources: [],
      attachments: [],
    };
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "note_create") return Promise.resolve(created);
      if (cmd === "folder_list" || cmd === "folder_list_meta") return Promise.resolve({ folders: [], notes_by_folder: {} });
      if (cmd === "note_tags_index") return Promise.resolve({ tags_by_note: {} });
      if (cmd === "tag_counts") return Promise.resolve({ counts: {} });
      return Promise.resolve();
    });

    const secId = await useNotesStore.getState().applyPreset("blank body", "Blank");

    // null: the fresh-draft path changes activeNote's identity itself (newNote()/
    // ensureMaterialized both set() a new object) — EditorPanel's note-load effect repaints the
    // editor on its own, so applyPreset() must not tell the caller to double-sync.
    expect(secId).toBeNull();
    expect(callMock).toHaveBeenCalledWith("note_create", expect.anything());
    expect(useNotesStore.getState().activeNote?.note.title).toBe("Blank");
  });

  it("isNoteBodyEmpty() strips tags and whitespace (draft/materialize passthrough content is HTML, not markdown)", () => {
    expect(isNoteBodyEmpty([{ body_md: "" }])).toBe(true);
    expect(isNoteBodyEmpty([{ body_md: "   \n  " }])).toBe(true);
    expect(isNoteBodyEmpty([{ body_md: "<p></p>" }])).toBe(true);
    expect(isNoteBodyEmpty([{ body_md: "<p>hi</p>" }])).toBe(false);
    expect(isNoteBodyEmpty([{ body_md: "" }, { body_md: "x" }])).toBe(false);
  });
});

describe("notes store — selectNote() request-ordering guard (Bug fix)", () => {
  beforeEach(() => {
    callMock.mockReset();
    toastMock.mockClear();
    flushAllMock.mockClear();
    emitNoticeMock.mockReset();
    useTabsStore.setState({ openTabs: [], activeTabId: null });
    useNotesStore.setState({ activeNote: null, activeDraft: false, loadingNoteId: null });
  });

  it("A→B switch: a stale note_get response for A (resolving after B's) must not clobber B's activeNote", async () => {
    let resolveA!: (v: unknown) => void;
    let resolveB!: (v: unknown) => void;
    const noteA = { note: { id: "A", title: "Note A" }, sections: [] };
    const noteB = { note: { id: "B", title: "Note B" }, sections: [] };
    callMock.mockImplementation((cmd: string, args: any) => {
      if (cmd === "note_get" && args?.id === "A") return new Promise((res) => { resolveA = res; });
      if (cmd === "note_get" && args?.id === "B") return new Promise((res) => { resolveB = res; });
      return Promise.resolve({});
    });

    const pA = useNotesStore.getState().selectNote("A");
    await Promise.resolve();
    await Promise.resolve();
    const pB = useNotesStore.getState().selectNote("B");
    await Promise.resolve();
    await Promise.resolve();

    // B's note_get resolves first (the more recent switch wins the race).
    resolveB(noteB);
    await pB;
    expect(useNotesStore.getState().activeNote?.note.id).toBe("B");

    // A's response — from the older, superseded selectNote("A") call — arrives after.
    resolveA(noteA);
    await pA;

    // Must still be B: A's stale response is discarded, not applied.
    expect(useNotesStore.getState().activeNote?.note.id).toBe("B");
  });

  it("same-id re-click while already loading is still deduped (unaffected by the ordering fix)", async () => {
    let resolveCalls = 0;
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "note_get") {
        resolveCalls++;
        return new Promise(() => {}); // never resolves — we only care whether it's re-invoked
      }
      return Promise.resolve({});
    });

    void useNotesStore.getState().selectNote("A");
    await Promise.resolve();
    await Promise.resolve();
    expect(useNotesStore.getState().loadingNoteId).toBe("A");

    // Re-clicking the SAME id while it's already loading must not fire a second note_get.
    void useNotesStore.getState().selectNote("A");
    await Promise.resolve();
    await Promise.resolve();

    expect(resolveCalls).toBe(1);
  });

  it("sets loadingNoteId synchronously, before the flushAll() await — closes the eager-draft race window (P30)", async () => {
    // EditorPanel's empty-state eager-draft effect only fires when activeNote, loadingNoteId,
    // AND activeTabId are all null. discardDraft() (activeNote -> null) and this set() (loadingNoteId
    // -> id) both run synchronously with no await between them, so no React render can land in
    // between and observe both null at once — unlike the old order, which awaited flushAll()
    // first and left a real (React-observable) tick where a competing newNote() could fire.
    let flushAllResolve!: () => void;
    flushAllMock.mockImplementation(() => new Promise<void>((res) => { flushAllResolve = res; }));
    callMock.mockResolvedValue({ note: { id: "A", title: "Note A" }, sections: [] });

    const p = useNotesStore.getState().selectNote("A");
    // flushAll() hasn't resolved yet (we control it above) — loadingNoteId must already be set.
    expect(useNotesStore.getState().loadingNoteId).toBe("A");

    flushAllResolve();
    await p;
    flushAllMock.mockImplementation(async () => {});
  });

  it("clears activeDraft on a successful switch, even if it was already true going in (backstop)", async () => {
    // Belt-and-suspenders alongside discardDraft() at the top of selectNote(): if anything ever
    // leaves activeDraft stuck true through a switch, the next edit on the now-real note would
    // wrongly take updateSectionBody's draft branch and materialize a duplicate note.
    useNotesStore.setState({ activeDraft: true });
    callMock.mockResolvedValue({ note: { id: "A", title: "Note A" }, sections: [] });

    await useNotesStore.getState().selectNote("A");

    expect(useNotesStore.getState().activeDraft).toBe(false);
    expect(useNotesStore.getState().activeNote?.note.id).toBe("A");
  });

  it("Bug fix: writes the fetched note into noteIndex for instant tab-title paint (id-only opens never populate it otherwise)", async () => {
    useNotesStore.setState({ noteIndex: new Map() });
    callMock.mockResolvedValue({
      note: { id: "A", folder_id: "f1", title: "Note A" },
      sections: [],
    });

    await useNotesStore.getState().selectNote("A");

    expect(useNotesStore.getState().noteIndex.get("A")?.title).toBe("Note A");
  });
});

// W2b(모바일 재편 통합): loadTree() 는 이제 isBrowser()&&isMobileViewport() 를 스스로 판정해
// 모바일 브라우저 경로에서 folder_list 전수 조회를 건너뛴다 — mobile/mobileRows.ts 가 갖고 있던
// mobile* 헬퍼 7개(loadTree() 를 피하려고 call()+patchNoteSummary()/bumpNoteQueryVersion() 를
// 복제했던 것들)를 지우고 이 한 곳으로 옮긴 판단이 여기서 검증된다
// (WORKORDER-2026-09-02-mobile-rework.md 작업 A).
describe("loadTree() — mobile browser path (W2b)", () => {
  beforeEach(() => {
    // Not this block's concern (activeWorkspaceId/inbox resolution) — an earlier describe's
    // beforeEach leaves "w1" set, which without a matching settings_get_all shape in these tests'
    // minimal callMock would crash on settingsRes.settings being undefined.
    useSettingsStore.setState({ activeWorkspaceId: null });
  });
  afterEach(() => {
    mockIsBrowser = false;
    mockIsMobileViewport = false;
  });

  it("skips folder_list entirely and only bumps the note-query version when isBrowser()&&isMobileViewport()", async () => {
    mockIsBrowser = true;
    mockIsMobileViewport = true;
    callMock.mockReset();

    await useNotesStore.getState().loadTree();

    expect(callMock).not.toHaveBeenCalled(); // no folder_list, no settings_get_all — nothing at all
  });

  it("takes the normal desktop path (folder_list) when not running as a mobile browser tab", async () => {
    callMock.mockReset();
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "folder_list" || cmd === "folder_list_meta") {
        return Promise.resolve({ folders: [], notes_by_folder: {} });
      }
      return Promise.resolve({});
    });

    await useNotesStore.getState().loadTree();

    expect(callMock).toHaveBeenCalledWith("folder_list");
  });

  it("still takes the desktop path when only one of isBrowser()/isMobileViewport() is true (both required)", async () => {
    mockIsBrowser = true;
    mockIsMobileViewport = false; // e.g. a wide browser tab — not narrow enough to be "mobile"
    callMock.mockReset();
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "folder_list" || cmd === "folder_list_meta") {
        return Promise.resolve({ folders: [], notes_by_folder: {} });
      }
      return Promise.resolve({});
    });

    await useNotesStore.getState().loadTree();

    expect(callMock).toHaveBeenCalledWith("folder_list");
  });
});

// Scale quick-win (docs/SCALABILITY.md §Phase 0): loadTree() now derives totalNotes/noteIndex
// alongside notesByFolder in the same set() call, so YearFilter/TabBar/ContextMenu can read a
// cheap counter / O(1) map instead of flattening or linear-scanning the whole corpus on every
// keystroke. These tests guard that the derived state is built correctly and never goes stale
// relative to notesByFolder.
describe("notes store — loadTree() derived state (totalNotes / noteIndex)", () => {
  beforeEach(() => {
    callMock.mockReset();
    toastMock.mockClear();
    flushAllMock.mockClear();
    emitNoticeMock.mockReset();
    useNotesStore.setState({
      folders: [],
      notesByFolder: {},
      totalNotes: 0,
      noteIndex: new Map(),
      tagCounts: null,
      activeNote: null,
      activeDraft: false,
    });
  });

  const note = (id: string, folder_id: string, title = `Note ${id}`) => ({
    id,
    folder_id,
    title,
    year: 2024,
    is_favorite: false,
    content_locked: false,
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
  });

  it("loadTree() populates totalNotes and noteIndex from notes_by_folder across all folders", async () => {
    const notesByFolder = {
      f1: [note("n1", "f1"), note("n2", "f1")],
      f2: [note("n3", "f2")],
    };
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "folder_list" || cmd === "folder_list_meta") {
        return Promise.resolve({
          folders: [{ id: "f1" }, { id: "f2" }],
          notes_by_folder: notesByFolder,
        });
      }
      if (cmd === "note_tags_index") {
        return Promise.resolve({ tags_by_note: {} });
      }
      if (cmd === "tag_counts") {
        return Promise.resolve({ counts: {} });
      }
      if (cmd === "tag_colors") {
        return Promise.resolve({ colors: {} });
      }
      if (cmd === "note_year_histogram") {
        return Promise.resolve({ counts: [] });
      }
      return Promise.resolve();
    });

    await useNotesStore.getState().loadTree();
    await new Promise((r) => setTimeout(r, 0));

    const state = useNotesStore.getState();
    expect(state.totalNotes).toBe(3);
    expect(state.noteIndex.size).toBe(3);
    expect(state.noteIndex.get("n1")?.title).toBe("Note n1");
    expect(state.noteIndex.get("n3")?.title).toBe("Note n3");
    expect(state.noteIndex.get("missing")).toBeUndefined();
    // After tag enrich, notesByFolder is a new object with same structure (tags merged).
    expect(state.notesByFolder.f1).toHaveLength(2);
    expect(state.notesByFolder.f2).toHaveLength(1);
    expect(state.tagCounts).toEqual({});
  });

  it("a second loadTree() with a shrunken corpus fully replaces stale entries (no leftover ids)", async () => {
    let call = 0;
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "folder_list" || cmd === "folder_list_meta") {
        call++;
        if (call === 1) {
          return Promise.resolve({
            folders: [{ id: "f1" }],
            notes_by_folder: { f1: [note("n1", "f1"), note("n2", "f1")] },
          });
        }
        return Promise.resolve({
          folders: [{ id: "f1" }],
          notes_by_folder: { f1: [note("n1", "f1")] },
        });
      }
      if (cmd === "note_tags_index") {
        return Promise.resolve({ tags_by_note: {} });
      }
      if (cmd === "tag_counts") {
        return Promise.resolve({ counts: {} });
      }
      return Promise.resolve();
    });

    await useNotesStore.getState().loadTree();
    expect(useNotesStore.getState().totalNotes).toBe(2);

    await useNotesStore.getState().loadTree();
    const state = useNotesStore.getState();
    expect(state.totalNotes).toBe(1);
    expect(state.noteIndex.size).toBe(1);
    expect(state.noteIndex.has("n2")).toBe(false);
    expect(state.noteIndex.get("n1")?.id).toBe("n1");
  });

  it("empty notes_by_folder yields totalNotes 0 and an empty noteIndex", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "folder_list" || cmd === "folder_list_meta") {
        return Promise.resolve({ folders: [], notes_by_folder: {} });
      }
      if (cmd === "note_tags_index") {
        return Promise.resolve({ tags_by_note: {} });
      }
      if (cmd === "tag_counts") {
        return Promise.resolve({ counts: {} });
      }
      return Promise.resolve();
    });

    await useNotesStore.getState().loadTree();

    const state = useNotesStore.getState();
    expect(state.totalNotes).toBe(0);
    expect(state.noteIndex.size).toBe(0);
  });

  it("loadTree() merges note_tags_index into note summaries", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "folder_list" || cmd === "folder_list_meta") {
        return Promise.resolve({
          folders: [{ id: "f1" }],
          notes_by_folder: { f1: [note("n1", "f1"), note("n2", "f1")] },
        });
      }
      if (cmd === "note_tags_index") {
        return Promise.resolve({ tags_by_note: { n1: ["alpha", "beta"] } });
      }
      if (cmd === "tag_counts") {
        return Promise.resolve({ counts: { alpha: 1, beta: 1 } });
      }
      return Promise.resolve();
    });

    await useNotesStore.getState().loadTree();
    await new Promise((r) => setTimeout(r, 0));
    const state = useNotesStore.getState();
    expect(state.noteIndex.get("n1")?.tag_names).toEqual(["alpha", "beta"]);
    expect(state.notesByFolder.f1.find((n) => n.id === "n1")?.tag_names).toEqual(["alpha", "beta"]);
    expect(state.noteIndex.get("n2")?.tag_names).toEqual([]);
    expect(state.tagCounts).toEqual({ alpha: 1, beta: 1 });
  });

  it("loadTree() leaves tagCounts null when tag_counts IPC fails (client fallback)", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "folder_list" || cmd === "folder_list_meta") {
        return Promise.resolve({
          folders: [{ id: "f1" }],
          notes_by_folder: { f1: [note("n1", "f1")] },
        });
      }
      if (cmd === "note_tags_index") {
        return Promise.resolve({ tags_by_note: { n1: ["x"] } });
      }
      if (cmd === "tag_counts") {
        return Promise.reject(new Error("ipc down"));
      }
      return Promise.resolve();
    });

    await useNotesStore.getState().loadTree();
    await new Promise((r) => setTimeout(r, 0));
    expect(useNotesStore.getState().tagCounts).toBeNull();
    expect(useNotesStore.getState().noteIndex.get("n1")?.tag_names).toEqual(["x"]);
  });

  it("patchNoteSummary updates notesByFolder and noteIndex without folder_list", () => {
    const n1 = note("n1", "f1");
    useNotesStore.setState({
      folders: [],
      notesByFolder: { f1: [n1, note("n2", "f1")] },
      totalNotes: 2,
      noteIndex: new Map([
        ["n1", n1],
        ["n2", note("n2", "f1")],
      ]),
    });

    useSearchStore.setState({
      searchResults: [{ ...n1 }],
    });

    useNotesStore.getState().patchNoteSummary("n1", {
      is_favorite: true,
      tag_names: ["x"],
      icon: "star",
    });
    const state = useNotesStore.getState();
    expect(state.noteIndex.get("n1")?.is_favorite).toBe(true);
    expect(state.noteIndex.get("n1")?.tag_names).toEqual(["x"]);
    expect(state.noteIndex.get("n1")?.icon).toBe("star");
    expect(state.notesByFolder.f1.find((n) => n.id === "n1")?.is_favorite).toBe(true);
    expect(useSearchStore.getState().searchResults[0]?.icon).toBe("star");
    expect(useSearchStore.getState().searchResults[0]?.tag_names).toEqual(["x"]);
    expect(state.totalNotes).toBe(2);
  });

  it("setTitle patches notesByFolder + noteIndex without refetching a folder window", () => {
    const n1 = note("n1", "f1", "Old title");
    const detail = {
      note: { ...n1 },
      sections: [{ id: "sec1", name: "Main", body_md: "", position: 0, kind: "text" as const }],
      sources: [],
      attachments: [],
    };
    useNotesStore.setState({
      activeNote: detail,
      activeDraft: false,
      notesByFolder: { f1: [n1, note("n2", "f1")] },
      noteIndex: new Map([
        ["n1", n1],
        ["n2", note("n2", "f1")],
      ]),
      totalNotes: 2,
    });
    useSearchStore.setState({
      searchResults: [{ ...n1 }],
    });

    const ipcBefore = callMock.mock.calls.length;
    useNotesStore.getState().setTitle("Renamed in tree");
    const state = useNotesStore.getState();

    expect(state.activeNote?.note.title).toBe("Renamed in tree");
    expect(state.notesByFolder.f1.find((n) => n.id === "n1")?.title).toBe("Renamed in tree");
    expect(state.noteIndex.get("n1")?.title).toBe("Renamed in tree");
    expect(useSearchStore.getState().searchResults[0]?.title).toBe("Renamed in tree");
    // No note_query / folder_list / loadTree — tree update is a local patch only.
    expect(callMock.mock.calls.length).toBe(ipcBefore);
    expect(
      callMock.mock.calls.some(
        (c) => c[0] === "note_query" || c[0] === "folder_list" || c[0] === "folder_list_meta"
      )
    ).toBe(false);
  });

  it("setNoteYear patches notesByFolder + noteIndex without refetching a folder window", () => {
    const n1 = note("n1", "f1");
    n1.year = 1900;
    const detail = {
      note: { ...n1 },
      sections: [{ id: "sec1", name: "Main", body_md: "", position: 0, kind: "text" as const }],
      sources: [],
      attachments: [],
    };
    useNotesStore.setState({
      activeNote: detail,
      activeDraft: false,
      notesByFolder: { f1: [n1] },
      noteIndex: new Map([["n1", n1]]),
      totalNotes: 1,
    });

    useNotesStore.getState().setNoteYear(1848);
    const state = useNotesStore.getState();
    expect(state.activeNote?.note.year).toBe(1848);
    expect(state.notesByFolder.f1[0]?.year).toBe(1848);
    expect(state.noteIndex.get("n1")?.year).toBe(1848);
  });

  it("optimistic update rollback: failed setTags reverts activeNote and noteIndex to previous values", async () => {
    const n1 = note("n1", "f1");
    const tags: string[] = ["original"];
    n1.tag_names = tags;
    const detail = {
      note: { ...n1 },
      sections: [{ id: "sec1", name: "Main", body_md: "", position: 0, kind: "text" as const }],
      sources: [],
      attachments: [],
    };

    useNotesStore.setState({
      activeNote: detail,
      activeDraft: false,
      notesByFolder: { f1: [n1] },
      noteIndex: new Map([["n1", n1]]),
    });

    callMock.mockImplementation((cmd: string) => {
      if (cmd === "note_set_tags") return Promise.reject(new Error("network error"));
      return Promise.resolve();
    });

    await useNotesStore.getState().setTags(["new_tag"]);

    const state = useNotesStore.getState();
    expect(state.savedState).toBe("failed");
    expect(state.activeNote?.note.tag_names).toEqual(["original"]);
    expect(state.noteIndex.get("n1")?.tag_names).toEqual(["original"]);
  });

  // F-N09 확장: 내용잠금 강제 범위가 스펙보다 좁았던 갭 — 메타데이터 세터 8개(patchActiveNote
  // 경유)와 setTitle/setNoteYear(디바운스 때문에 별도 코딩) 모두 잠긴 노트에서 아무것도 바꾸지
  // 않아야 한다. is_favorite는 예외이므로(toggleFavorite는 이 헬퍼를 안 씀) 여기서 검증할
  // 대상이 아니다.
  it("잠긴 노트에서 setTags(patchActiveNote 경유)는 아무것도 바꾸지 않고 잠금 안내를 띄운다", async () => {
    const n1 = note("n1", "f1");
    n1.content_locked = true;
    n1.tag_names = ["original"];
    const detail = {
      note: { ...n1 },
      sections: [{ id: "sec1", name: "Main", body_md: "", position: 0, kind: "text" as const }],
      sources: [],
      attachments: [],
    };
    useNotesStore.setState({
      activeNote: detail,
      activeDraft: false,
      notesByFolder: { f1: [n1] },
      noteIndex: new Map([["n1", n1]]),
    });

    const ipcBefore = callMock.mock.calls.length;
    await useNotesStore.getState().setTags(["new_tag"]);

    const state = useNotesStore.getState();
    expect(state.activeNote?.note.tag_names).toEqual(["original"]);
    expect(callMock.mock.calls.length).toBe(ipcBefore);
    expect(emitNoticeMock).toHaveBeenCalledWith("Content is locked — editing disabled");
  });

  it("잠긴 노트에서 setTitle은 제목을 바꾸지 않는다", () => {
    const n1 = note("n1", "f1", "Old title");
    n1.content_locked = true;
    const detail = {
      note: { ...n1 },
      sections: [{ id: "sec1", name: "Main", body_md: "", position: 0, kind: "text" as const }],
      sources: [],
      attachments: [],
    };
    useNotesStore.setState({ activeNote: detail, activeDraft: false });

    useNotesStore.getState().setTitle("Renamed while locked");

    expect(useNotesStore.getState().activeNote?.note.title).toBe("Old title");
  });

  it("잠긴 노트에서 setNoteYear는 연도를 바꾸지 않는다", () => {
    const n1 = note("n1", "f1");
    n1.content_locked = true;
    n1.year = 1900;
    const detail = {
      note: { ...n1 },
      sections: [{ id: "sec1", name: "Main", body_md: "", position: 0, kind: "text" as const }],
      sources: [],
      attachments: [],
    };
    useNotesStore.setState({ activeNote: detail, activeDraft: false });

    useNotesStore.getState().setNoteYear(1848);

    expect(useNotesStore.getState().activeNote?.note.year).toBe(1900);
  });
});
describe("notes store — reloadActive() attachment revision", () => {
  const summary = {
    id: "n1",
    folder_id: "f1",
    title: "Note n1",
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
  };
  const att = (id: string) => ({
    id,
    name: `${id}.png`,
    kind: "image" as const,
    rel_path: `n1/${id}.png`,
    url: null,
    size_bytes: 1,
    position: 0,
  });
  const detail = (attachments: ReturnType<typeof att>[]) => ({
    note: { ...summary },
    sections: [{ id: "sec1", name: "Main", body_md: "", position: 0, kind: "text" as const }],
    sources: [],
    attachments,
  });

  beforeEach(() => {
    callMock.mockReset();
    useNotesStore.setState({
      activeNote: detail([]),
      activeDraft: false,
      attachmentRevision: 0,
    });
  });

  // The dropped-image bug: the drag&drop path reloads the note but used to leave
  // attachmentRevision alone, so useAttachmentThumbs never refetched and the new tile
  // kept its placeholder until something else remounted it.
  it("bumps attachmentRevision when the attachment set changed", async () => {
    callMock.mockResolvedValue(detail([att("a1")]));
    await useNotesStore.getState().reloadActive();
    expect(useNotesStore.getState().attachmentRevision).toBe(1);
  });

  it("leaves attachmentRevision alone for a section-only reload", async () => {
    callMock.mockResolvedValue(detail([]));
    await useNotesStore.getState().reloadActive();
    expect(useNotesStore.getState().attachmentRevision).toBe(0);
  });

  it("bumps on removal too", async () => {
    useNotesStore.setState({ activeNote: detail([att("a1")]), attachmentRevision: 0 });
    callMock.mockResolvedValue(detail([]));
    await useNotesStore.getState().reloadActive();
    expect(useNotesStore.getState().attachmentRevision).toBe(1);
  });

  // Bug this closes: every reloadActive() caller inserts something (a dropped file, a pasted
  // image, dictation text) then reloads to pick it up. Without flushing the editor's pending
  // 700ms autosave debounce FIRST, note_get can race it and return the pre-insert body, which
  // the note-load effect then repaints over the live doc — silently reverting the insert. See
  // EditorPanel.tsx's clipboard-image-paste path for the concrete repro.
  it("flushes pending edits (registerFlush) before re-fetching, not after", async () => {
    const order: string[] = [];
    flushAllMock.mockImplementationOnce(async () => {
      order.push("flush");
    });
    callMock.mockImplementationOnce(async () => {
      order.push("note_get");
      return detail([]);
    });
    await useNotesStore.getState().reloadActive();
    expect(order).toEqual(["flush", "note_get"]);
  });
});

describe("notes store — editor autosave snapshot scheduler (owner spec, 2026-08-01)", () => {
  const summary = {
    id: "n1",
    folder_id: "f1",
    title: "Note",
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
  };
  const detail = (id: string) => ({
    note: { ...summary, id },
    sections: [{ id: "sec1", name: "Main", body_md: "", position: 0, kind: "text" as const }],
    sources: [],
    attachments: [],
  });

  beforeEach(() => {
    vi.useFakeTimers();
    // Settle any note/timer/dirty state a previous describe block's test left behind BEFORE
    // resetting the mocks — the scheduler's subscriber fires callMock synchronously inside
    // this setState() call (zustand subscribers run sync), so clearing mocks right after this
    // line, not before, guarantees a clean call history for the assertions below.
    useNotesStore.setState({ activeNote: null, activeDraft: false });
    callMock.mockReset();
    callMock.mockResolvedValue({ updated_at: "2024-01-01T00:00:01Z" });
  });

  afterEach(() => {
    useNotesStore.setState({ activeNote: null, activeDraft: false });
    vi.useRealTimers();
  });

  it("skips the 60s capture when nothing changed since the note opened", async () => {
    useNotesStore.setState({ activeNote: detail("n1"), activeDraft: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(callMock).not.toHaveBeenCalledWith("note_snapshot_capture", expect.anything());
  });

  it("captures on the 60s tick once a body edit made the note dirty", async () => {
    useNotesStore.setState({ activeNote: detail("n1"), activeDraft: false });
    await useNotesStore.getState().updateSectionBody("sec1", "edited");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(callMock).toHaveBeenCalledWith("note_snapshot_capture", { note_id: "n1" });
  });

  it("does not re-capture on the next tick after a clean one (dirty flag consumed)", async () => {
    useNotesStore.setState({ activeNote: detail("n1"), activeDraft: false });
    await useNotesStore.getState().updateSectionBody("sec1", "edited");
    await vi.advanceTimersByTimeAsync(60_000);
    const snapshotCalls = () => callMock.mock.calls.filter((c) => c[0] === "note_snapshot_capture");
    expect(snapshotCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(snapshotCalls()).toHaveLength(1);
  });

  it("captures once immediately when switching away from a dirty note, before the next tick", async () => {
    useNotesStore.setState({ activeNote: detail("n1"), activeDraft: false });
    await useNotesStore.getState().updateSectionBody("sec1", "edited");

    useNotesStore.setState({ activeNote: detail("n2"), activeDraft: false });

    expect(callMock).toHaveBeenCalledWith("note_snapshot_capture", { note_id: "n1" });
    expect(callMock).not.toHaveBeenCalledWith("note_snapshot_capture", { note_id: "n2" });
  });

  it("does not capture on switch away from a clean note", async () => {
    useNotesStore.setState({ activeNote: detail("n1"), activeDraft: false });
    useNotesStore.setState({ activeNote: detail("n2"), activeDraft: false });
    expect(callMock).not.toHaveBeenCalledWith("note_snapshot_capture", expect.anything());
  });

  it("never ticks while no note is open", async () => {
    await vi.advanceTimersByTimeAsync(120_000);
    expect(callMock).not.toHaveBeenCalled();
  });
});

describe("displayTitle helper", () => {
  it("formats blank, whitespace, literal 'Untitled Note', and real titles correctly", () => {
    expect(displayTitle("")).toBe("Untitled Note");
    expect(displayTitle("   ")).toBe("Untitled Note");
    expect(displayTitle("Untitled Note")).toBe("Untitled Note");
    expect(displayTitle("My Custom Note")).toBe("My Custom Note");
  });
});
