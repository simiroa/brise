import { describe, it, expect, vi, beforeEach } from "vitest";

const callMock = vi.fn(async (_cmd: string, _args?: unknown): Promise<any> => ({}));
const callSilentMock = vi.fn(async (_cmd: string, _args?: unknown): Promise<any> => ({}));
vi.mock("../lib/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/invoke")>()),
  call: (cmd: string, args?: unknown) => callMock(cmd, args),
  callSilent: (cmd: string, args?: unknown) => callSilentMock(cmd, args),
  emitNotice: vi.fn(),
}));

import { useNotesStore } from "./notes";
import {
  clearAllSaveFailures,
  hasSaveFailed,
  fieldFailureKey,
  noteHasSaveFailure,
  retryFailedSaves,
} from "../lib/sectionSaveFailures";
import { getSectionToken, setSectionToken, __resetSectionTokens } from "../lib/sectionTokens";

function draftNoteWithFields() {
  return {
    note: {
      id: "__draft__",
      folder_id: "inbox1",
      title: "Custom Title",
      year: 2026,
      month: 10,
      day: 7,
      is_favorite: true,
      content_locked: false,
      exported_at: null,
      has_image: false,
      tag_names: ["tag1", "tag2"],
      region: "Seoul",
      status: "in_progress",
      icon: "star",
      lat: 37.5,
      lng: 127.0,
      created_at: "",
      updated_at: "",
    },
    sections: [{ id: "draft_sec", name: "Overview", body_md: "draft body", position: 0, kind: "text" }],
    sources: [],
    attachments: [],
  } as any;
}

function createdDetail() {
  const d = draftNoteWithFields();
  d.note.id = "real1";
  d.sections = [{ id: "sec_real", name: "Overview", body_md: "", position: 0, kind: "text", updated_at: "t0" }];
  return d;
}

describe("Draft field failures & retry (Wave DRAFT requirement 3)", () => {
  beforeEach(() => {
    clearAllSaveFailures();
    __resetSectionTokens();
    callMock.mockReset();
    callSilentMock.mockReset();
  });

  it("each field call failing records fieldFailureKey with retry closure, and other fields still go out", async () => {
    useNotesStore.setState({
      activeNote: draftNoteWithFields(),
      activeDraft: true,
      savedState: "saving",
      saveConflict: null,
      loadTree: vi.fn(async () => {}),
      ensureInboxId: vi.fn(async () => "inbox1"),
    } as any);

    const executedCommands: string[] = [];
    callMock.mockImplementation(async (cmd: string, args?: unknown): Promise<any> => {
      executedCommands.push(cmd);
      if (cmd === "note_create") return createdDetail();
      if (cmd === "section_update") return { section_updated_at: "t1", updated_at: "t1" };
      // Title update fails!
      if (cmd === "note_update" && (args as any)?.title) {
        throw { code: "IO", message: "title failed" };
      }
      return {};
    });

    // ensureMaterialized should NOT abort; it continues sending other fields
    await useNotesStore.getState().ensureMaterialized();

    // Verify other fields were still called
    expect(executedCommands).toContain("note_set_tags");
    expect(executedCommands).toContain("note_set_region");
    expect(executedCommands).toContain("note_set_location");
    expect(executedCommands).toContain("note_set_icon");
    expect(executedCommands).toContain("note_set_status");
    expect(executedCommands).toContain("note_toggle_favorite");

    // Title failure registered in sectionSaveFailures
    const titleKey = fieldFailureKey("real1", "title");
    expect(hasSaveFailed(titleKey)).toBe(true);
    expect(noteHasSaveFailure("real1", ["sec_real"])).toBe(true);
    expect(useNotesStore.getState().savedState).toBe("failed");

    // Other successful fields should NOT be marked failed
    expect(hasSaveFailed(fieldFailureKey("real1", "tags"))).toBe(false);
    expect(hasSaveFailed(fieldFailureKey("real1", "region"))).toBe(false);

    // Retrying failed saves should re-send title
    callMock.mockClear();
    callMock.mockImplementation(async (cmd: string, _args?: unknown): Promise<any> => {
      if (cmd === "note_update") return {};
      return {};
    });

    await retryFailedSaves();

    expect((callMock.mock.calls as Array<[string, ...unknown[]]>).some(([cmd]) => cmd === "note_update")).toBe(true);
    expect(hasSaveFailed(titleKey)).toBe(false);
    expect(noteHasSaveFailure("real1", ["sec_real"])).toBe(false);
  });
});

describe("M-8 second half: self-conflict after lost response + more typing (Requirement 6)", () => {
  beforeEach(() => {
    clearAllSaveFailures();
    __resetSectionTokens();
    callMock.mockReset();
    callSilentMock.mockReset();
  });

  it("token-carrying section_update fails with IO: adopts server token if server body matches, avoiding conflict on next edit", async () => {
    const note = createdDetail();
    note.sections[0].body_md = "original body";
    setSectionToken("sec_real", "t_initial");

    useNotesStore.setState({
      activeNote: note,
      activeDraft: false,
      savedState: "saved",
      saveConflict: null,
    } as any);

    // 1st update: client sends "write1".
    // Server actually committed it (so on server: body = "write1", updated_at = "t_server_new"),
    // but the network response timed out / dropped with IO.
    callMock.mockImplementation(async (cmd: string, _args?: unknown): Promise<any> => {
      if (cmd === "section_update") {
        throw { code: "IO", message: "connection timeout" };
      }
      return {};
    });

    // note_get returns the server state where the write actually committed
    callSilentMock.mockImplementation(async (cmd: string, _args?: unknown): Promise<any> => {
      if (cmd === "note_get") {
        return {
          note: { id: "real1" },
          sections: [{ id: "sec_real", body_md: "write1", updated_at: "t_server_new" }],
        };
      }
      return {};
    });

    // Execute first save
    await useNotesStore.getState().updateSectionBody("sec_real", "write1");

    // It failed with IO, but note_get confirmed server has "write1" → adopted "t_server_new"!
    expect(getSectionToken("sec_real")).toBe("t_server_new");
    // Pitfall 4: activeNote sections was NOT overwritten
    expect(useNotesStore.getState().activeNote?.sections[0].body_md).toBe("original body");

    // User types more text: "write1 + more typing"
    callMock.mockClear();
    callMock.mockImplementation(async (cmd: string, args?: unknown): Promise<any> => {
      if (cmd === "section_update") {
        // If client sends stale token, server would throw CONFLICT
        if ((args as any)?.expected_updated_at !== "t_server_new") {
          throw { code: "CONFLICT", message: "stale token" };
        }
        return { section_updated_at: "t_server_final", updated_at: "t_server_final" };
      }
      return {};
    });

    // Next save succeeds because token was updated to t_server_new!
    await useNotesStore.getState().updateSectionBody("sec_real", "write1 + more typing");

    expect(useNotesStore.getState().savedState).toBe("saved");
    expect(useNotesStore.getState().saveConflict).toBeNull();
    expect(getSectionToken("sec_real")).toBe("t_server_final");
  });

  it("token-carrying section_update fails with IO: does NOT adopt server token if server body differs", async () => {
    const note = createdDetail();
    setSectionToken("sec_real", "t_initial");

    useNotesStore.setState({
      activeNote: note,
      activeDraft: false,
      savedState: "saved",
      saveConflict: null,
    } as any);

    callMock.mockImplementation(async (cmd: string, _args?: unknown): Promise<any> => {
      if (cmd === "section_update") throw { code: "IO", message: "timeout" };
      return {};
    });

    // Server has a completely different body (e.g. written by another client)
    callSilentMock.mockImplementation(async (cmd: string, _args?: unknown): Promise<any> => {
      if (cmd === "note_get") {
        return {
          note: { id: "real1" },
          sections: [{ id: "sec_real", body_md: "remote edit by other device", updated_at: "t_remote" }],
        };
      }
      return {};
    });

    await useNotesStore.getState().updateSectionBody("sec_real", "my local edit");

    // Token must remain t_initial (not adopted)
    expect(getSectionToken("sec_real")).toBe("t_initial");
  });
});
