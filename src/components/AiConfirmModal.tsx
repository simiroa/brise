import { useState } from "react";
import { useAiStore } from "../stores/ai";
import { useProposalHostStore } from "../stores/proposalHost";
import { ModalShell } from "./ModalShell";
import { AiProposalPanel, useProposalTitle } from "./ai/AiProposalPanel";

/**
 * 독립 AI 정리(메타데이터) 확인 창. 몸통은 `ai/AiProposalPanel.tsx` 가 소유한다(2026-09-27 에 여기서 떼어
 * 냄 — AI 모달이 "메타데이터 포함" 삽입 뒤 같은 패널을 제 안에 그린다). AI 모달이 품고 있는 노트의 제안
 * (`stores/proposalHost`)은 여기서 그리지 않는다 — 다른 노트의 제안은 그대로 받는다.
 */
export function AiConfirmModal() {
  const proposal = useAiStore((s) => s.lastProposal);
  const lastProposalNoteId = useAiStore((s) => s.lastProposalNoteId);
  const clearProposal = useAiStore((s) => s.clearProposal);
  const hostNoteId = useProposalHostStore((s) => s.noteId);
  const [isApplying, setIsApplying] = useState(false);
  const title = useProposalTitle();

  if (!proposal) return null;
  if (hostNoteId && lastProposalNoteId === hostNoteId) return null;

  return (
    <ModalShell title={title} onClose={isApplying ? () => {} : clearProposal} width={440}>
      <AiProposalPanel applying={isApplying} setApplying={setIsApplying} />
    </ModalShell>
  );
}
