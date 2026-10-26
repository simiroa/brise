/**
 * P2 후행 제안(docs/PLAN-2026-08-07-second-brain.md Q5) — 펫(pet/pet-bubble 창)이 겹침 제안
 * (kind='overlap')과 링크 붙여넣기 제안(kind='link', P2 3단계)을 표출·무시할 수 있게 하는 메인
 * 창 쪽 다리. pet 창은 PET_ALLOWED_COMMANDS(좁은 allowlist, src-tauri/src/pet_window.rs)에
 * suggestions_list/suggestion_set_status 가 없어 직접 못 부른다 — 이 파일이 메인 창에서 대신
 * 폴링·상태변경을 하고, 결과를 Tauri 이벤트로 pet 창에 넘긴다. 새 Tauri 커맨드를 만들지 않는다:
 * pet-open-note(커맨드 pet_open_main 이 이미 이 채널로 노트 클릭을 메인 창에 전달한다)와 같은
 * 종류의 이벤트 버스를 반대 방향으로도 재사용할 뿐이다.
 *
 * App.tsx 는 마운트 시(펫이 켜져 있을 때만) listenPetSuggestionsBridge() 를 한 번 등록한다 —
 * 실제 로직은 여기 있어 App.tsx 를 렌더링하지 않고도 테스트할 수 있다(lib/remoteNoteWrite.ts 와
 * 같은 패턴).
 *
 * 이벤트 계약:
 *   main → pet(broadcast) "pet-suggestions-pending" { suggestions: Suggestion[] }  (오래된 것 먼저)
 *   pet-bubble → main      "pet-suggestions-refresh"  (payload 없음, 채팅 패널이 열릴 때 즉시 요청)
 *   pet-bubble → main      "pet-suggestion-dismiss"   { id: string }
 */
import { emit } from "@tauri-apps/api/event";
import { call, callSilent } from "../../../lib/invoke";
import { listenMany } from "../../../lib/tauriListen";
import type { SuggestionsListOutput } from "../../../lib/commands.gen";
import { PET_EVENT } from "./petEvents";

const POLL_MS = 60 * 1000;

interface DismissPayload {
  id: string;
}

async function refreshAndBroadcast(): Promise<void> {
  try {
    const res = await call<SuggestionsListOutput>("suggestions_list", { status: "pending" });
    // suggestions_list 는 created_at DESC(최신 먼저)로 온다 — 펫 카드는 한 번에 하나만 보여주므로
    // (PetBubbleApp.tsx, suggestions[0]) 오래된 것부터 처리되도록 뒤집어 보낸다("우선순위: 오래된
    // 것 먼저면 충분", P2 3단계 태스크 브리프). overlap/link 둘 다 같은 배열에 섞여 나간다 —
    // kind별 필터는 더 이상 하지 않는다(펫 카드가 kind로 분기해 렌더한다, PetChat.tsx).
    const suggestions = [...res.suggestions].reverse();
    await emit(PET_EVENT.suggestionsPending, { suggestions });
  } catch {
    // call() 이 이미 토스트를 띄웠다 — 배지 갱신 실패는 조용히 다음 60초 주기를 기다린다.
  }
}

async function handleDismiss(id: string): Promise<void> {
  try {
    await call("suggestion_set_status", { id, status: "dismissed" });
  } catch {
    // call() 이 이미 토스트를 띄웠다.
  }
  await refreshAndBroadcast();
}

/**
 * 제안 하나를 accepted 로 표시하고 펫 배지/카드가 다음 60초 폴링을 기다리지 않도록 새로고침을
 * 요청한다 — PetSuggestionReviewBridge.tsx·petLinkBridge.ts·petThemeBridge.ts 세 다리가 마무리에
 * 똑같이 반복하던 "suggestion_set_status + pet-suggestions-refresh emit" 짝(주석까지 복제돼
 * 있었다)을 여기 한 곳으로 모은다.
 */
export async function acceptSuggestion(id: string): Promise<void> {
  await callSilent("suggestion_set_status", { id, status: "accepted" });
  await emit(PET_EVENT.suggestionsRefresh).catch(() => {});
}

/** Sibling of acceptSuggestion() — same "set status + refresh" pair, dismissed instead. */
export async function dismissSuggestion(id: string): Promise<void> {
  await callSilent("suggestion_set_status", { id, status: "dismissed" });
  await emit(PET_EVENT.suggestionsRefresh).catch(() => {});
}

/** App.tsx 마운트 시(펫 활성일 때만) 1회 호출 — 반환값은 useEffect cleanup용 해제 함수. */
export function listenPetSuggestionsBridge(): () => void {
  void refreshAndBroadcast();
  const interval = setInterval(() => void refreshAndBroadcast(), POLL_MS);

  const unlisten = listenMany([
    [PET_EVENT.suggestionsRefresh, () => void refreshAndBroadcast()],
    [
      PET_EVENT.suggestionDismiss,
      (e: { payload: DismissPayload }) => void handleDismiss(e.payload.id),
    ],
  ]);

  return () => {
    clearInterval(interval);
    unlisten();
  };
}
