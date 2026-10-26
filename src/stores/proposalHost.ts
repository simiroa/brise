import { create } from "zustand";

/**
 * 메타데이터 제안을 AI 모달이 제 안에 품고 있는가(2026-09-27, 한 모달에서 작성→생성→검토 2단계).
 *
 * AI 모달이 "메타데이터 포함"으로 내용을 삽입한 뒤 이어지는 제안 단계에서만 `noteId` 가 선다 — 그 노트의
 * 제안은 독립 확인 창(AiConfirmModal)이 그리지 않는다. 다른 노트의 제안(배경·수동 대기열)은 이 표시와
 * 무관하게 늘 독립 창이 받는다. AI 모달이 단계를 벗어나거나 닫힐 때 반드시 되돌린다 — 새면 그 노트의
 * 제안이 영영 안 보인다.
 */
export const useProposalHostStore = create<{ noteId: string | null }>(() => ({ noteId: null }));
