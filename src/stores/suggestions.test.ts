import { describe, it, expect, vi, beforeEach } from "vitest";
import { useSuggestionsStore } from "./suggestions";
import { useNotesStore } from "./notes";
import type { Suggestion } from "../lib/commands.gen";

const callMock = vi.fn();
const callSilentMock = vi.fn();

vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callSilentMock(...args),
  emitNotice: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(),
}));

// suggestions.ts now routes through petSuggestionsBridge.ts, which emits a Tauri event after
// every status change (pet badge refresh) — mock it out the same way petSuggestionsBridge.test.ts
// and PetPersonaSection.test.tsx already do.
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn().mockResolvedValue(undefined),
  listen: vi.fn().mockResolvedValue(() => {}),
}));

describe("useSuggestionsStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSuggestionsStore.getState().reset();
    useNotesStore.setState({
      activeNote: null,
      selectNote: vi.fn().mockResolvedValue(undefined),
      bumpAttachmentRevision: vi.fn(),
    } as any);
  });

  it("loads pending suggestions via suggestions_list", async () => {
    const mockSuggestions: Suggestion[] = [
      {
        id: "s1",
        kind: "overlap",
        note_id: "n1",
        note_title: "Note 1",
        related_note_id: "n2",
        related_note_title: "Note 2",
        payload: "",
        score: 0.85,
        created_at: "2026-08-24T00:00:00Z",
      },
    ];
    callSilentMock.mockResolvedValueOnce({ suggestions: mockSuggestions });

    await useSuggestionsStore.getState().loadSuggestions("ws-1");

    expect(callSilentMock).toHaveBeenCalledWith("suggestions_list", {
      status: "pending",
      workspace_id: "ws-1",
    });
    expect(useSuggestionsStore.getState().suggestions).toEqual(mockSuggestions);
    expect(useSuggestionsStore.getState().loading).toBe(false);
  });

  it("acceptSuggestion adds internal attachment and updates suggestion status", async () => {
    const s1: Suggestion = {
      id: "s1",
      kind: "overlap",
      note_id: "n1",
      note_title: "Note 1",
      related_note_id: "n2",
      related_note_title: "Note 2",
      payload: "",
      score: 0.85,
      created_at: "2026-08-24T00:00:00Z",
    };
    useSuggestionsStore.setState({ suggestions: [s1] });

    const selectNoteMock = vi.fn().mockResolvedValue(undefined);
    const bumpAttachmentRevisionMock = vi.fn();
    useNotesStore.setState({
      activeNote: { note: { id: "n1" } } as any,
      selectNote: selectNoteMock,
      bumpAttachmentRevision: bumpAttachmentRevisionMock,
    } as any);

    callMock.mockResolvedValue({ ok: true });
    callSilentMock.mockResolvedValue({ ok: true });

    await useSuggestionsStore.getState().acceptSuggestion("s1", "n1", "n2", "Note 2");

    // addInternalAttachment() (attachmentService.ts) goes through call(), not callSilent().
    expect(callMock).toHaveBeenCalledWith("attachment_add_internal", {
      note_id: "n1",
      target_note_id: "n2",
      name: "Note 2",
    });
    // acceptSuggestion() (petSuggestionsBridge.ts) sets status via callSilent().
    expect(callSilentMock).toHaveBeenCalledWith("suggestion_set_status", {
      id: "s1",
      status: "accepted",
    });
    expect(useSuggestionsStore.getState().suggestions).toEqual([]);
    expect(selectNoteMock).toHaveBeenCalledWith("n1");
    expect(bumpAttachmentRevisionMock).toHaveBeenCalled();
  });

  it("dismissSuggestion sets status to dismissed and removes it from list", async () => {
    const s1: Suggestion = {
      id: "s1",
      kind: "overlap",
      note_id: "n1",
      note_title: "Note 1",
      related_note_id: "n2",
      related_note_title: "Note 2",
      payload: "",
      score: 0.85,
      created_at: "2026-08-24T00:00:00Z",
    };
    useSuggestionsStore.setState({ suggestions: [s1] });
    callSilentMock.mockResolvedValue({ ok: true });

    await useSuggestionsStore.getState().dismissSuggestion("s1");

    // dismissSuggestion() (petSuggestionsBridge.ts) sets status via callSilent().
    expect(callSilentMock).toHaveBeenCalledWith("suggestion_set_status", {
      id: "s1",
      status: "dismissed",
    });
    expect(useSuggestionsStore.getState().suggestions).toEqual([]);
  });

  it("getPendingOverlap finds pending overlap suggestions symmetrically", () => {
    const s1: Suggestion = {
      id: "s1",
      kind: "overlap",
      note_id: "n1",
      note_title: "Note 1",
      related_note_id: "n2",
      related_note_title: "Note 2",
      payload: "",
      score: 0.85,
      created_at: "2026-08-24T00:00:00Z",
    };
    useSuggestionsStore.setState({ suggestions: [s1] });

    expect(useSuggestionsStore.getState().getPendingOverlap("n1", "n2")).toEqual(s1);
    expect(useSuggestionsStore.getState().getPendingOverlap("n2", "n1")).toEqual(s1);
    expect(useSuggestionsStore.getState().getPendingOverlap("n1", "n3")).toBeUndefined();
  });
});
