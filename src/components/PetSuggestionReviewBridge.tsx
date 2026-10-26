import React, { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { call, emitNotice, flushAll } from "../lib/invoke";
import { acceptSuggestion } from "../plugins/pet/bridge/petSuggestionsBridge";
import { generateMergeSuggestionPlan } from "../stores/aiAgentActions";
import { t } from "../i18n/t";
import type { AiPlan } from "../lib/aiAgentBridge";
import type { NoteDetail } from "../lib/commands.gen";
import { AiAgentReviewModal } from "../lazySurfaces";



interface ReviewRequest {
  id: string;
  note_id: string;
  related_note_id: string;
}

/**
 * 펫 채팅의 "검토하기" → 메인 창의 병합 검토 모달. pet-bubble 은 note_get/모델 호출/
 * suggestion_set_status 를 직접 못 부른다(PET_ALLOWED_COMMANDS 좁은 표면, pet_window.rs) —
 * plugins/pet/bridge/petSuggestionsBridge.ts 와 같은 이유로, pet-bubble 이 emit() 한 "pet-review-suggestion"
 * 을 이 창이 받아 대신 처리한다. 노트 클릭이 pet_open_main → "pet-open-note" 로 이 창에 오는 것과
 * 같은 이벤트 버스, 반대 방향.
 *
 * 두 노트 본문은 flushAll() 후 note_get 으로 새로 읽는다(CLAUDE.md 함정 4 — activeNote.sections 는
 * 캐럿 보호로 갱신을 미룬다. 둘 중 하나가 지금 열려 편집 중이었을 수 있다).
 *
 * App.tsx 에 항상 마운트해 둔다(펫이 켜져 있을 때만, App.tsx 쪽 게이트) — plan 이 없을 때는 null 을
 * 렌더링하는 게 전부라 항상 마운트해도 비용이 없다.
 */
export function PetSuggestionReviewBridge() {
  const [plan, setPlan] = useState<AiPlan | null>(null);
  const [suggestionId, setSuggestionId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<ReviewRequest>("pet-review-suggestion", (e) => {
      void handleReviewRequest(e.payload);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const handleReviewRequest = async (req: ReviewRequest) => {
    void AiAgentReviewModal.preload(); // 검토 모달은 AI 계획이 온 뒤에 뜬다 — 기다리는 동안 받아 둔다.
    try {
      await flushAll();
      const [noteA, noteB] = await Promise.all([
        call<NoteDetail>("note_get", { id: req.note_id }),
        call<NoteDetail>("note_get", { id: req.related_note_id }),
      ]);
      const generated = await generateMergeSuggestionPlan(noteA, noteB);
      if (!generated) {
        emitNotice(t("ai.merge_suggestion_empty"));
        return;
      }
      setPlan(generated);
      setSuggestionId(req.id);
    } catch {
      // call() 이 이미 토스트를 띄웠다(노트 삭제됨, AI 미설정 등).
    }
  };

  if (!plan) return null;

  return (
    <React.Suspense fallback={null}>
      <AiAgentReviewModal
        plan={plan}
        onClose={() => {
          setPlan(null);
          setSuggestionId(null);
        }}
        onSuccess={(executed) => {
          // 최소 하나라도 적용됐을 때만 accepted — 전부 실패했으면 pending 그대로 남겨 다시 시도할
          // 수 있게 한다(Q4: mutate 는 승인 필요, 취소/실패는 pending 유지).
          if (executed > 0 && suggestionId) {
            // acceptSuggestion 이 상태 변경 + "pet-suggestions-refresh" 새로고침을 함께 처리한다
            // (plugins/pet/bridge/petSuggestionsBridge.ts 의 리스너가 같은 창에서 받는다) — petLinkBridge.ts·
            // petChatHistory.ts 가 쓰는 버스와 통일.
            void acceptSuggestion(suggestionId);
          }
        }}
      />
    </React.Suspense>
  );
}
