// R2-a 분리: stores/notes.ts 의 디바운스 자동저장(제목/연도) 머신을 그대로 이주.
// flushTitle/flushYear were byte-identical apart from the field name + i18n key — one factory,
// instantiated twice by stores/notesActive.ts. Each instance owns its own pending-timer/value
// closure (setTitle/setNoteYear reach back into these via the returned `schedule`), so debouncing
// one field never clobbers the other's pending write. savedState itself stays store state (the
// setters below only set() it) — only this timer/flush machinery moved out.
import type { StoreApi } from "zustand";
import { callSilent, emitNotice, registerFlush } from "./invoke";
import { t } from "../i18n/t";
import type { NotesState } from "../stores/notes";
import { clearSaveFailed, fieldFailureKey, markSaveFailed } from "./sectionSaveFailures";

export function makeFieldFlush(
  set: StoreApi<NotesState>["setState"],
  get: () => Pick<NotesState, "patchNoteSummary">,
  field: "title" | "year",
  failKey: string
) {
  let pendingSave: ReturnType<typeof setTimeout> | null = null;
  let pendingValue: string | number | null = null;
  let pendingNoteId: string | null = null;

  const flush = async () => {
    if (pendingSave) {
      clearTimeout(pendingSave);
      pendingSave = null;
    }
    if (pendingValue === null || pendingNoteId === null) return;
    const value = pendingValue;
    const id = pendingNoteId;
    pendingValue = null;
    pendingNoteId = null;
    const key = fieldFailureKey(id, field);
    try {
      await callSilent("note_update", { id, [field]: value });
      clearSaveFailed(key);
      get().patchNoteSummary(id, { [field]: value });
      set({ savedState: "saved" });
    } catch (e: any) {
      if (e?.code === "NOT_FOUND") {
        clearSaveFailed(key);
        set({ savedState: "saved" });
      } else {
        // M-16: 값을 되살린다 — 안 그러면 [다시 시도](flushAll)가 보낼 것이 없어 "저장됨" 으로 바뀐다. 그 사이 더 새로 친 값이
        // 있으면(pendingValue 가 이미 채워짐) 그쪽이 이긴다. 토스트는 원문(HTTP 502 …)이 아니라 i18n 문구 — 원문은 callSilent 가 진단에 남겼다.
        if (pendingValue === null) {
          pendingValue = value;
          pendingNoteId = id;
        }
        markSaveFailed(key);
        set({ savedState: "failed" });
        emitNotice(t(failKey));
      }
    }
  };
  registerFlush(flush);

  return (value: string | number, noteId: string) => {
    pendingValue = value;
    pendingNoteId = noteId;
    if (pendingSave) clearTimeout(pendingSave);
    pendingSave = setTimeout(flush, 700);
  };
}
