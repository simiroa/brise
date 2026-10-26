import React, { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { emitNotice } from "../lib/invoke";
import { generatePetChatPlan, PET_REVIEW_CHAT_PLAN_EVENT, type PetChatPlanRequest } from "../plugins/pet/bridge/petChatPlan";
import {
  applyChatSection,
  generateAndInsertFillSection,
  PET_APPLY_CHAT_SECTION_EVENT,
  type PetChatSectionRequest,
} from "../plugins/pet/bridge/petChatSection";
import { t } from "../i18n/t";
import type { AiPlan } from "../lib/aiAgentBridge";
import { AiAgentReviewModal } from "../lazySurfaces";



/**
 * Sidebar / pet tool chip → main-window review modal, or a new-section write.
 * Pet cannot run aiAgentActions / insertAiSection (narrow PET_ALLOWED_COMMANDS) so it emits
 * after pet_open_main. Sidebar uses the same events so there is one host.
 */
export function PetChatPlanReviewBridge() {
  const [plan, setPlan] = useState<AiPlan | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let unPlan: (() => void) | undefined;
    let unSection: (() => void) | undefined;
    void listen<PetChatPlanRequest>(PET_REVIEW_CHAT_PLAN_EVENT, (e) => {
      void openPlan(e.payload);
    }).then((fn) => {
      if (cancelled) fn();
      else unPlan = fn;
    });
    void listen<PetChatSectionRequest>(PET_APPLY_CHAT_SECTION_EVENT, (e) => {
      void applyChatSection(e.payload);
    }).then((fn) => {
      if (cancelled) fn();
      else unSection = fn;
    });
    return () => {
      cancelled = true;
      unPlan?.();
      unSection?.();
    };
  }, []);

  const openPlan = async (req: PetChatPlanRequest) => {
    if (busy) return;
    setBusy(true);
    try {
      if (req.plan_kind === "fill_note") {
        await generateAndInsertFillSection(req.note_id, req.instruction);
        return;
      }
      void AiAgentReviewModal.preload(); // 검토 모달은 AI 계획이 온 뒤에 뜬다 — 기다리는 동안 받아 둔다.
      const generated = await generatePetChatPlan(req);
      if (!generated) {
        emitNotice(t("search.chat_plan_empty"));
        return;
      }
      setPlan(generated);
    } catch {
      // call() already toasted provider/DB failures.
    } finally {
      setBusy(false);
    }
  };

  if (!plan) return null;
  return (
    <React.Suspense fallback={null}>
      <AiAgentReviewModal plan={plan} onClose={() => setPlan(null)} />
    </React.Suspense>
  );
}
