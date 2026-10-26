import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";

const callMock = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => ({}));
vi.mock("../lib/invoke", async (orig) => {
  const actual = await orig<typeof import("../lib/invoke")>();
  return {
    ...actual,
    call: (cmd: string, args?: unknown) => callMock(cmd, args),
    callSilent: (cmd: string, args?: unknown) => callMock(cmd, args),
  };
});

const serialized = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("../lib/mdSerialize", async (orig) => {
  const m = await orig<typeof import("../lib/mdSerialize")>();
  return {
    ...m,
    mdSerializeEditor: (e: Parameters<typeof m.mdSerializeEditor>[0]) =>
      serialized.value !== null ? serialized.value : m.mdSerializeEditor(e),
  };
});

import { EditorPanel } from "./EditorPanel";
import { useNotesStore } from "../stores/notes";
import { flushAll } from "../lib/invoke";
import { clearAllSaveFailures, hasSaveFailed } from "../lib/sectionSaveFailures";
import { clearConflictBodies, holdConflictBody } from "../lib/sectionTokens";
import type { NoteDetail } from "../lib/commands.gen";

function makeNote(noteId = "n1", secId = "s1", body = "initial body"): NoteDetail {
  return {
    note: {
      id: noteId,
      folder_id: "inbox1",
      title: "Title",
      year: 2026,
      month: 10,
      day: 7,
      is_favorite: false,
      content_locked: false,
      exported_at: null,
      has_image: false,
      tag_names: [],
      region: null,
      status: null,
      icon: null,
      lat: null,
      lng: null,
      created_at: "",
      updated_at: "",
    },
    sections: [{ id: secId, name: "Section 1", body_md: body, position: 0, kind: "text" }],
    sources: [],
    attachments: [],
  } as unknown as NoteDetail;
}

describe("EditorPanel save failures (Wave DRAFT requirements 1 & 2)", () => {
  beforeEach(() => {
    callMock.mockClear();
    serialized.value = null;
    clearAllSaveFailures();
    clearConflictBodies();
  });

  it("desktop text save fails → sec.body rolls back and section id goes into registry → next flush re-sends", async () => {
    const note = makeNote("n1", "s1", "initial");
    useNotesStore.setState({
      activeNote: note,
      activeDraft: false,
      savedState: "saved",
      isBooting: false,
    });

    const { unmount } = render(<EditorPanel />);

    // Simulate user editing text in editor
    serialized.value = "edited text";

    // 1st flush fails
    callMock.mockImplementation(async (cmd) => {
      if (cmd === "section_update") {
        throw { code: "IO", message: "disk error" };
      }
      return {};
    });

    await act(async () => {
      await flushAll();
    });

    expect(hasSaveFailed("s1")).toBe(true);
    expect(useNotesStore.getState().savedState).toBe("failed");

    // 2nd flush with no new typing (serialized.value is still "edited text")
    // Now server succeeds
    callMock.mockClear();
    callMock.mockImplementation(async (cmd) => {
      if (cmd === "section_update") {
        return { section_updated_at: "t1", updated_at: "t1" };
      }
      return {};
    });

    await act(async () => {
      await flushAll();
    });

    const sectionUpdates = callMock.mock.calls.filter(([cmd]) => cmd === "section_update");
    expect(sectionUpdates.length).toBe(1);
    expect(sectionUpdates[0][1]).toEqual(expect.objectContaining({ id: "s1", body_md: "edited text" }));
    expect(hasSaveFailed("s1")).toBe(false);
    expect(useNotesStore.getState().savedState).toBe("saved");

    unmount();
  });

  it("desktop first save fails on body write → next flush re-sends to the real section id", async () => {
    const draft = makeNote("__draft__", "sec_draft", "");
    useNotesStore.setState({
      activeNote: draft,
      activeDraft: true,
      savedState: "saved",
      isBooting: false,
      loadTree: vi.fn(async () => {}),
      ensureInboxId: vi.fn(async () => "inbox1"),
    });

    const { unmount } = render(<EditorPanel />);

    serialized.value = "typed draft body";

    // First save: note_create succeeds, but section_update fails
    callMock.mockImplementation(async (cmd) => {
      if (cmd === "note_create") {
        return makeNote("real_note_1", "real_sec_1", "");
      }
      if (cmd === "section_update") {
        throw { code: "IO", message: "network timeout" };
      }
      return {};
    });

    await act(async () => {
      try {
        await flushAll();
      } catch {
        // ensureMaterialized throws on draft write failure
      }
    });

    // ensureMaterialized should have marked the real section id as failed
    expect(hasSaveFailed("real_sec_1")).toBe(true);
    expect(useNotesStore.getState().savedState).toBe("failed");
    expect(useNotesStore.getState().activeNote?.note.id).toBe("real_note_1");

    // Next flush: body unchanged, but mustSend re-sends to real_sec_1
    callMock.mockClear();
    callMock.mockImplementation(async (cmd) => {
      if (cmd === "section_update") {
        return { section_updated_at: "t2", updated_at: "t2" };
      }
      return {};
    });

    await act(async () => {
      await flushAll();
    });

    const sectionUpdates = callMock.mock.calls.filter(([cmd]) => cmd === "section_update");
    expect(sectionUpdates.length).toBe(1);
    expect(sectionUpdates[0][1]).toEqual(expect.objectContaining({ id: "real_sec_1", body_md: "typed draft body" }));
    expect(hasSaveFailed("real_sec_1")).toBe(false);

    unmount();
  });

  it("desktop flush does NOT re-send a section held by conflict gate", async () => {
    const note = makeNote("n1", "s_gated", "my text");
    useNotesStore.setState({
      activeNote: note,
      activeDraft: false,
      savedState: "failed",
      isBooting: false,
    });

    const { unmount } = render(<EditorPanel />);
    serialized.value = "my text";

    // Mark as failed, but also hold in conflict gate
    holdConflictBody("s_gated", "server conflict text");

    callMock.mockClear();
    await act(async () => {
      await flushAll();
    });

    // Must NOT send because it is gated
    const sectionUpdates = callMock.mock.calls.filter(([cmd]) => cmd === "section_update");
    expect(sectionUpdates.length).toBe(0);

    unmount();
  });
});
