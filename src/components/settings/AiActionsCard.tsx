import { anchorId } from "./settingsAnchor";
import { Suspense, useState } from "react";
import { t } from "../../i18n/t";
import { emitNotice } from "../../lib/invoke";
import { reportFallback } from "../../lib/diag";
import type { AiPlan } from "../../lib/aiAgentBridge";
import { groupCardStyle } from "./shared";
import { SectionHeader } from "./SectionHeader";
import { IconAction } from "./IconAction";
import { IconEdit, IconWrench } from "../icons";
import { AiAgentReviewModal } from "../../lazySurfaces";


/**
 * 설정 > AI > 기능 맨 아래 "AI 액션" 카드 — AI 프리셋 페이지로 가는 버튼과 "노트북 재편 (AI)".
 *
 * 재편은 계획을 만든 뒤 검토 모달(AiAgentReviewModal)을 띄운다. 계획 상태는 이 카드가 갖는다 —
 * 창 셸(SettingsPanel)이 페이지 하나의 일시 상태를 들고 있을 이유가 없다.
 */
export function AiActionsCard({ onNavigate }: { onNavigate: (pageId: string) => void }) {
  const [planning, setPlanning] = useState(false);
  const [reviewPlan, setReviewPlan] = useState<AiPlan | null>(null);

  const handleRestructure = async () => {
    setPlanning(true);
    void AiAgentReviewModal.preload(); // 검토 모달은 AI 계획이 온 뒤에 뜬다 — 기다리는 동안 받아 둔다.
    try {
      let mod: typeof import("../../stores/aiAgentActions");
      try {
        mod = await import("../../stores/aiAgentActions");
      } catch (e) {
        reportFallback("ai", "restructure_module_load_failed", e instanceof Error ? e.message : String(e));
        emitNotice(t("common.component_failed"));
        return;
      }
      try {
        const plan = await mod.generateWorkspaceRefactorPlan();
        if (plan) setReviewPlan(plan);
        // 바꿀 후보가 없거나 계획이 비었다 — 아무 말 없이 버튼만 돌아오면 고장처럼 보인다.
        else emitNotice(t("settings.ai_restructure_empty"));
      } catch (e) {
        // IPC 실패는 call() 이 이미 토스트했다 — 그 밖의 예외(파싱 등)까지 기록은 남긴다.
        reportFallback("ai", "restructure_plan_failed", e instanceof Error ? e.message : String(e));
      }
    } finally {
      setPlanning(false);
    }
  };

  return (
    <div className="card" style={groupCardStyle} id={anchorId("ai_actions")} data-testid="settings-ai-actions-card">
      <SectionHeader
        title={t("ai.actions_section")}
        hint={t("settings.ai_action_edit_hint")}
        icon={<IconWrench size={14} strokeWidth={2} />}
        actions={
          <IconAction
            icon={<IconEdit size={16} />}
            label={t("settings.ai_action_edit_button")}
            data-testid="ai-action-edit-open"
            onClick={() => onNavigate("ai_presets")}
          />
        }
      />
      {/* "노트북 재편 (AI)" 는 글자로 둔다 — 아이콘만으로는 무엇을 하는지 추측이 안 된다
          (PLAN-2026-09-19-settings-icon-actions §1). */}
      <button
        type="button"
        className="btn"
        data-testid="ai-workspace-restructure"
        onClick={() => void handleRestructure()}
        disabled={planning}
        aria-busy={planning || undefined}
      >
        {planning ? t("settings.ai_restructure_planning") : t("ai.workspace_restructure")}
      </button>
      {reviewPlan && (
        <Suspense fallback={null}>
          <AiAgentReviewModal plan={reviewPlan} onClose={() => setReviewPlan(null)} />
        </Suspense>
      )}
    </div>
  );
}
