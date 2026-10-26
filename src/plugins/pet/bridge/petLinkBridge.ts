/**
 * P2 3단계 후행 제안(docs/PLAN-2026-08-07-second-brain.md Q5) — 펫 채팅의 링크 제안 카드
 * "추가하기" → 메인 창의 실제 append. pet-bubble 은 section_create_with_body/pet_note_create를
 * 직접 못 부른다(PET_ALLOWED_COMMANDS 좁은 allowlist, pet_window.rs) — petSuggestionsBridge.ts,
 * PetSuggestionReviewBridge.tsx 와 같은 이유로, pet-bubble 이 emit() 한
 * "pet-accept-link-suggestion" 을 이 창이 받아 대신 처리한다.
 *
 * Q4("append는 자유, mutate는 승인") 그대로: 확인 모달 없이 바로 실행한다 — 대상 노트가 있으면
 * section_create_with_body로 새 섹션을 append하고, 없으면(target_note_id null) pet_note_create로
 * 인박스에 새 노트를 만든다. 둘 다 기존 노트를 고치지 않는 순수 추가라 Q4의 "무확인" 축에 든다.
 *
 * App.tsx 는 마운트 시(펫이 켜져 있을 때만) listenPetLinkBridge() 를 한 번 등록한다 — UI가 없어
 * (수락하면 바로 실행, 보여줄 것이 없다) 컴포넌트일 이유가 없다. plugins/pet/bridge/petSuggestionsBridge.ts 와
 * 같은 패턴으로, App.tsx 를 렌더링하지 않고도 테스트할 수 있다.
 */
import { emit } from "@tauri-apps/api/event";
import { appendSectionWithBody, createInboxMemo } from "../../../lib/noteActions";
import { acceptSuggestion } from "./petSuggestionsBridge";
import { listenMany } from "../../../lib/tauriListen";
import { PET_EVENT } from "./petEvents";

interface AcceptRequest {
  id: string;
  target_note_id: string | null;
  title: string;
  summary: string;
  url: string;
}

async function handleAccept(req: AcceptRequest): Promise<void> {
  const body_md = `${req.summary}\n\n${req.url}`;
  try {
    if (req.target_note_id) {
      await appendSectionWithBody(req.target_note_id, req.title || undefined, body_md);
    } else {
      await createInboxMemo(body_md, req.title || undefined);
    }
    await acceptSuggestion(req.id);
  } catch {
    // callSilent() 이 이미 토스트를 띄웠다(노트 삭제됨 등) — append 자체가 실패해 acceptSuggestion 까지
    // 못 미친 경우에도 펫 배지는 그래도 새로고침해 다음 60초를 기다리지 않게 한다.
    void emit(PET_EVENT.suggestionsRefresh).catch(() => {});
  }
}

/** App.tsx 마운트 시(펫 활성일 때만) 1회 호출 — 반환값은 useEffect cleanup용 해제 함수. */
export function listenPetLinkBridge(): () => void {
  return listenMany([
    [
      PET_EVENT.acceptLinkSuggestion,
      (e: { payload: AcceptRequest }) => void handleAccept(e.payload),
    ],
  ]);
}
