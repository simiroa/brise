import { create } from "zustand";
import { callSilent } from "../lib/invoke";
import type { Suggestion, SuggestionsListOutput } from "../lib/commands.gen";
import { useNotesStore } from "./notes";
import { acceptSuggestion as bridgeAccept, dismissSuggestion as bridgeDismiss } from "../plugins/pet/bridge/petSuggestionsBridge";
import { addInternalAttachment } from "../lib/attachmentService";

export interface SuggestionsState {
  suggestions: Suggestion[];
  loading: boolean;
  error: string | null;
  loadSuggestions: (workspaceId?: string) => Promise<void>;
  acceptSuggestion: (
    suggestionId: string,
    sourceNoteId?: string,
    targetNoteId?: string,
    targetTitle?: string,
  ) => Promise<void>;
  dismissSuggestion: (suggestionId: string) => Promise<void>;
  getPendingOverlap: (noteId1: string, noteId2: string) => Suggestion | undefined;
  reset: () => void;
}

const initialState = {
  suggestions: [] as Suggestion[],
  loading: false,
  error: null as string | null,
};

export const useSuggestionsStore = create<SuggestionsState>((set, get) => ({
  ...initialState,

  loadSuggestions: async (workspaceId?: string) => {
    set({ loading: true, error: null });
    try {
      const res = await callSilent<SuggestionsListOutput>("suggestions_list", {
        status: "pending",
        workspace_id: workspaceId,
      });
      const list = res?.suggestions ?? [];
      set({ suggestions: list, loading: false });
    } catch (err: unknown) {
      set({ error: (err as Error)?.message ?? String(err), loading: false });
    }
  },

  acceptSuggestion: async (
    suggestionId: string,
    sourceNoteId?: string,
    targetNoteId?: string,
    targetTitle?: string,
  ) => {
    // 1) If source and target note IDs are provided, add internal attachment link
    if (sourceNoteId && targetNoteId) {
      await addInternalAttachment(sourceNoteId, targetNoteId, targetTitle || "Internal Link");
    }

    // 2) Update suggestion status to accepted + refresh pet badge (petSuggestionsBridge —
    // consolidates the "suggestion_set_status + pet-suggestions-refresh emit" pair so the pet
    // window doesn't wait up to 60s for its own poll).
    await bridgeAccept(suggestionId);

    // 3) Update local state
    set((state) => ({
      suggestions: state.suggestions.filter((s) => s.id !== suggestionId),
    }));

    // 4) Refresh active note and tree if applicable
    const activeNote = useNotesStore.getState().activeNote;
    if (activeNote && (activeNote.note.id === sourceNoteId || activeNote.note.id === targetNoteId)) {
      await useNotesStore.getState().selectNote(activeNote.note.id);
      useNotesStore.getState().bumpAttachmentRevision();
    }
  },

  dismissSuggestion: async (suggestionId: string) => {
    await bridgeDismiss(suggestionId);
    set((state) => ({
      suggestions: state.suggestions.filter((s) => s.id !== suggestionId),
    }));
  },

  getPendingOverlap: (noteId1: string, noteId2: string) => {
    const list = get().suggestions;
    return list.find(
      (s) =>
        s.kind === "overlap" &&
        ((s.note_id === noteId1 && s.related_note_id === noteId2) ||
          (s.note_id === noteId2 && s.related_note_id === noteId1)),
    );
  },

  reset: () => {
    set(initialState);
  },
}));
