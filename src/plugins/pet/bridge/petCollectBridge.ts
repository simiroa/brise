/**
 * collect_post_process 후행 제안(docs/SUGGESTIONS.md §3) — 펫 채팅 카드/사이드바 카드의
 * "정리하기" → 해당 노트를 열고 기존 organize propose/apply 계약(ai_organize_note →
 * lastProposal → AiConfirmModal → ai_apply_organize)을 그 노트에 대해 실행한다. 새 파이프라인을
 * 만들지 않는다 — lib/aiPostProcess.ts::schedulePostProcess 와 같은 metadata guidance 를 쓴다.
 *
 * silent=false: 사용자가 카드를 명시적으로 눌렀으니 실패하면 토스트로 알려야 한다(schedulePostProcess
 * 의 자동 백그라운드 호출과 달리 "사용자가 요청한 적 없는 작업"이 아니다). aiPostProcess(킬 스위치)
 * 설정은 확인하지 않는다 — 그건 자동 트리거 전용이고 이건 이미 뜬 카드에 대한 명시적 수락이다.
 *
 * pet-bubble 은 organizeCurrentNote/노트 선택/acceptSuggestion 을 직접 못 부른다
 * (PET_ALLOWED_COMMANDS 좁은 allowlist, pet_window.rs) — petLinkBridge.ts/petThemeBridge.ts 와
 * 같은 이유로, pet-bubble 이 emit() 한 "pet-accept-collect-suggestion" 을 이 창(메인 창)이 받아
 * 대신 처리한다. SidebarChat(메인 창 UI, 같은 카드의 "정리하기")도 acceptCollectSuggestion() 을
 * 그대로 호출해 두 진입점이 한 함수로 수렴한다(중복 구현 금지).
 *
 * App.tsx 는 마운트 시(펫이 켜져 있을 때만) listenPetCollectBridge() 를 한 번 등록한다.
 */
import { emit } from "@tauri-apps/api/event";
import { useAiStore } from "../../../stores/ai";
import { useAiPresetsStore } from "../../../stores/aiPresets";
import { useNotesStore } from "../../../stores/notes";
import { AI_METADATA_FIELDS } from "../../../stores/aiPrompts";
import { acceptSuggestion } from "./petSuggestionsBridge";
import { listenMany } from "../../../lib/tauriListen";
import { PET_EVENT } from "./petEvents";

export interface AcceptCollectRequest {
  id: string;
  noteId: string;
  /** collect_source 의 post_process_model — 있으면 사용자의 기본 AI 모델을 오버라이드한다. */
  model?: string | null;
}

/** 펫 카드/사이드바 카드 "정리하기" 공용 핸들러 — 두 진입점이 이 함수 하나로 수렴한다
 *  (①accept → ②노트 열기 → ③organize propose, 순서대로 — accept가 실패하면 나머지는 돌지 않는다:
 *  제안 자체가 처리 안 됐는데 모달만 뜨는 상태를 피한다). */
export async function acceptCollectSuggestion(req: AcceptCollectRequest): Promise<void> {
  await acceptSuggestion(req.id);
  await useNotesStore.getState().selectNote(req.noteId);
  // 사용자가 설정에서 편집한 metadata 액션의 guidance 를 그대로 쓴다 — 수동 실행과 같은 결과
  // (schedulePostProcess 와 동일한 조회 패턴).
  const guidance = useAiPresetsStore.getState().list.find((p) => p.id === "metadata")?.prompt;
  await useAiStore.getState().organizeCurrentNote(req.noteId, [...AI_METADATA_FIELDS], guidance, false, {
    model: req.model ?? undefined,
    origin: "collect_post_process",
  });
}

interface AcceptRequestPayload {
  id: string;
  note_id: string;
  model?: string | null;
}

async function handleAccept(req: AcceptRequestPayload): Promise<void> {
  try {
    await acceptCollectSuggestion({ id: req.id, noteId: req.note_id, model: req.model });
  } catch {
    // acceptSuggestion()의 callSilent 가 실패하면 refresh emit 까지 못 미친다 — 여기서 한 번 더
    // 요청해 펫 배지가 다음 60초 폴링을 기다리지 않게 한다(petLinkBridge.ts 와 같은 안전망).
    void emit(PET_EVENT.suggestionsRefresh).catch(() => {});
  }
}

/** App.tsx 마운트 시(펫 활성일 때만) 1회 호출 — 반환값은 useEffect cleanup용 해제 함수. */
export function listenPetCollectBridge(): () => void {
  return listenMany([
    [
      PET_EVENT.acceptCollectSuggestion,
      (e: { payload: AcceptRequestPayload }) => void handleAccept(e.payload),
    ],
  ]);
}
