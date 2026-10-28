import { emit } from "@tauri-apps/api/event";
import { reportFallback } from "../../lib/diag";
import { PET_EVENT, type PetEventName } from "./bridge/petEvents";
import type { PendingSuggestion } from "./bridge/petSuggestionCards";

/**
 * 펫 제안의 수락·무시 디스패치 한 곳 — 제안 종류 → `PET_EVENT` 이름 + snake_case 페이로드. 예전엔 벨(메인 창)과 PetBubbleApp(펫 창)이
 * 각자 문자열 이벤트 이름을 손으로 쓰고(PET_EVENT 맵 우회), 한쪽은 실패를 삼켰다. 받는 쪽은 메인 창의 브리지들(App.tsx 의
 * PetSuggestionReviewBridge·PetSuggestionLinkBridge·…, plugins/pet/bridge/*)이다.
 *
 * 창마다 다른 부수 동작(펫 창은 pet_open_main 으로 메인을 앞으로 가져오고 말풍선을 닫는다 / 메인 창은 노트를 직접 선택한다)은 호출자 몫이다 —
 * 여기는 "이벤트를 낸다"까지다. 실패는 진단에 남기고(`reportFallback`) 호출자가 카드를 되돌릴 수 있게 `false` 를 돌려준다.
 */
export function suggestionAcceptEvent(s: PendingSuggestion): { name: PetEventName; payload: Record<string, unknown> } {
  switch (s.kind) {
    case "overlap":
      return { name: PET_EVENT.reviewSuggestion, payload: { id: s.id, note_id: s.noteId, related_note_id: s.relatedNoteId } };
    case "link":
      return {
        name: PET_EVENT.acceptLinkSuggestion,
        payload: { id: s.id, target_note_id: s.targetNoteId, title: s.title, summary: s.summary, url: s.url },
      };
    case "theme":
      return { name: PET_EVENT.acceptThemeSuggestion, payload: { id: s.id, note_ids: s.noteIds } };
    case "collect":
      return { name: PET_EVENT.acceptCollectSuggestion, payload: { id: s.id, note_id: s.noteId, model: s.postProcessModel } };
  }
}

async function emitOrReport(name: PetEventName, payload?: Record<string, unknown>): Promise<boolean> {
  try {
    await emit(name, payload);
    return true;
  } catch (e) {
    reportFallback("pet", "suggestion_emit_failed", `${name}: ${String(e)}`);
    return false;
  }
}

/** 제안 수락 이벤트를 낸다. 성공 여부를 돌려준다(실패는 이미 진단에 남았다). */
export function emitSuggestionAccept(s: PendingSuggestion): Promise<boolean> {
  const { name, payload } = suggestionAcceptEvent(s);
  return emitOrReport(name, payload);
}

/** 제안 무시 이벤트를 낸다(펫 쪽 브리지가 그 제안을 dismissed 로 표시한다). */
export function emitSuggestionDismiss(id: string): Promise<boolean> {
  return emitOrReport(PET_EVENT.suggestionDismiss, { id });
}

/** 메인 창이 뜰 때 한 번 — 펫 쪽 브리지에 현재 제안을 다시 방송해 달라고 한다. */
export function emitSuggestionsRefresh(): Promise<boolean> {
  return emitOrReport(PET_EVENT.suggestionsRefresh);
}
