import { useState } from "react";
import { ModalShell } from "./ModalShell";
import { PromptDialog } from "./PromptDialog";
import { createPlanExecutionId, type AiPlan, type AiPlanAction, executeApprovedPlan } from "../lib/aiAgentBridge";
import { t } from "../i18n/t";
import { emitNotice } from "../lib/invoke";

export interface AiAgentReviewModalProps {
  plan: AiPlan;
  onClose: () => void;
  onSuccess?: (executedCount: number) => void;
}

function isDestructive(action: AiPlanAction): boolean {
  return action.type === "delete_note" || action.type === "merge_notes";
}

type PlanBadgeTone = "create" | "title" | "folder" | "body" | "delete" | "merge";

function badgesFor(action: AiPlanAction): { key: string; label: string; tone: PlanBadgeTone }[] {
  if (action.type === "create_note") {
    return [{ key: "create", label: t("note.ai_plan_badge_create"), tone: "create" }];
  }
  if (action.type === "delete_note") {
    return [{ key: "delete", label: t("note.ai_plan_badge_delete"), tone: "delete" }];
  }
  if (action.type === "merge_notes") {
    return [{ key: "merge", label: t("note.ai_plan_badge_merge"), tone: "merge" }];
  }
  const badges: { key: string; label: string; tone: PlanBadgeTone }[] = [];
  if (action.payload.title) {
    badges.push({ key: "title", label: t("note.ai_plan_badge_title"), tone: "title" });
  }
  if (action.payload.folderId) {
    badges.push({ key: "folder", label: t("note.ai_plan_badge_folder"), tone: "folder" });
  }
  if (action.payload.bodyMd) {
    badges.push({ key: "body", label: t("note.ai_plan_badge_body"), tone: "body" });
  }
  if (badges.length === 0) {
    badges.push({ key: "update", label: t("note.ai_plan_type_update"), tone: "body" });
  }
  return badges;
}

// 계획 항목 배지 → 앱 전체 배지 한 벌 `.badge`(styles/tokens.css, GRILL-2026-10-19 R8)의 톤. 예전엔 생성·제목·삭제·병합이
// 채운 알약이었다. 되돌리기 비싼 삭제·병합만 위험/주의 톤을 쓰고, 나머지는 서로 다른 비위험 톤으로 갈린다.
const BADGE_TONE: Record<PlanBadgeTone, string> = {
  create: "success",
  title: "info",
  folder: "muted",
  body: "accent",
  delete: "danger",
  merge: "warn",
};

export function AiAgentReviewModal({ plan, onClose, onSuccess }: AiAgentReviewModalProps) {
  // 기본값은 "아무것도 선택 안 됨"이다. 전체 선택을 기본으로 두면 승인 게이트가 형식이 되고,
  // 그 목록에는 삭제·병합처럼 되돌리기 비싼 액션이 섞여 있다 — 사용자가 한 줄씩 고르게 한다.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [completedIds, setCompletedIds] = useState<Set<string>>(() => new Set());
  const [executionId] = useState(createPlanExecutionId);
  const [executing, setExecuting] = useState(false);
  const [lastExecution, setLastExecution] = useState<{ executed: number; failed: number } | null>(null);
  // delete/merge stay unselectable until the user explicitly enables this gate (injection
  // defense in depth: even a model that proposes trash cannot be applied in one click).
  const [allowDestructive, setAllowDestructive] = useState(false);
  // Second confirm when applying any selected delete/merge.
  const [pendingDestructiveConfirm, setPendingDestructiveConfirm] = useState(false);

  const toggleSelect = (id: string, destructive: boolean) => {
    if ((destructive && !allowDestructive) || completedIds.has(id)) return;
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const setDestructiveEnabled = (enabled: boolean) => {
    setAllowDestructive(enabled);
    if (!enabled) {
      // Drop any already-checked delete/merge when the gate is closed again.
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const a of plan.actions) {
          if (isDestructive(a)) next.delete(a.id);
        }
        return next;
      });
    }
  };

  const runApply = async (approvedActions: AiPlanAction[]) => {
    setExecuting(true);
    try {
      const { executed, completedActionIds = [], failed } = await executeApprovedPlan(
        approvedActions,
        executionId,
        plan.applyScope,
      );
      setLastExecution({ executed, failed: failed.length });
      // Older callers/mocks may not include the new receipt field; a no-failure result means all
      // submitted rows completed. Production always receives explicit receipts from the backend.
      const completed = completedActionIds.length > 0 || failed.length > 0
        ? completedActionIds
        : approvedActions.map((action) => action.id);
      if (completed.length > 0) {
        setCompletedIds((previous) => new Set([...previous, ...completed]));
        setSelectedIds((previous) => {
          const next = new Set(previous);
          for (const id of completed) next.delete(id);
          return next;
        });
      }
      // 부분 실패를 성공으로 보고하지 않는다 — 실패가 하나라도 있으면 개수를 그대로 알리고
      // 모달을 열어 둔다(무엇이 남았는지 볼 수 있어야 다시 시도할 수 있다).
      if (failed.length > 0) {
        emitNotice(t("note.ai_plan_result", { ok: executed, failed: failed.length }));
        onSuccess?.(executed);
        return;
      }
      emitNotice(t("note.ai_organized"));
      onSuccess?.(executed);
      onClose();
    } catch {
      emitNotice(t("note.save_failed"));
    } finally {
      setExecuting(false);
    }
  };

  const handleApply = () => {
    const approvedActions = plan.actions.filter((a) => selectedIds.has(a.id) && !completedIds.has(a.id));
    if (approvedActions.length === 0) return;
    // Hard gate: never execute delete/merge without the explicit toggle (defense if state is stale).
    if (approvedActions.some(isDestructive) && !allowDestructive) return;
    if (approvedActions.some(isDestructive)) {
      setPendingDestructiveConfirm(true);
      return;
    }
    void runApply(approvedActions);
  };

  const confirmDestructiveApply = () => {
    setPendingDestructiveConfirm(false);
    const approvedActions = plan.actions.filter((a) => selectedIds.has(a.id) && !completedIds.has(a.id));
    if (approvedActions.length === 0) return;
    void runApply(approvedActions);
  };

  const selectedCount = [...selectedIds].filter((id) => !completedIds.has(id)).length;
  const hasDestructiveInPlan = plan.actions.some(isDestructive);
  const selectedDestructiveCount = plan.actions.filter(
    (a) => selectedIds.has(a.id) && isDestructive(a),
  ).length;
  const requestClose = () => {
    if (!executing) onClose();
  };

  return (
    <>
      <ModalShell title={plan.title} onClose={requestClose} width={620}>
        <div style={{ padding: "var(--space-4)", display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
          <div style={{ fontSize: "var(--text-sm)", color: "var(--text)", lineHeight: 1.5 }}>
            {plan.summary}
          </div>

          <div
            data-testid="ai-plan-execution-id"
            style={{ fontSize: "var(--text-xs)", color: "var(--muted)", fontFamily: "var(--font-mono)" }}
          >
            Execution: {executionId}
            {lastExecution ? ` · Applied ${lastExecution.executed}, failed ${lastExecution.failed}` : ""}
          </div>

          {plan.truncatedCount && plan.truncatedCount > 0 ? (
            <div
              style={{
                padding: "var(--space-2) var(--space-3)",
                background: "var(--hover)",
                borderRadius: "var(--radius-sm)",
                fontSize: "var(--text-xs)",
                color: "var(--info)",
                fontWeight: 600,
              }}
            >
              ⚠️ {t("note.ai_plan_truncated", { n: plan.truncatedCount, shown: plan.actions.length })}
            </div>
          ) : null}

          {plan.filteredOutOfScopeCount && plan.filteredOutOfScopeCount > 0 ? (
            <div
              style={{
                padding: "var(--space-2) var(--space-3)",
                background: "var(--hover)",
                borderRadius: "var(--radius-sm)",
                fontSize: "var(--text-xs)",
                color: "var(--info)",
                fontWeight: 600,
              }}
            >
              ⚠️ {t("note.ai_plan_filtered_scope", { n: plan.filteredOutOfScopeCount })}
            </div>
          ) : null}

          <div className="label-caps" style={{ color: "var(--muted)" }}>
            {t("note.ai_plan_actions", { sel: selectedCount, total: plan.actions.length })}
          </div>

          {hasDestructiveInPlan ? (
            <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "var(--space-2)",
                fontSize: "var(--text-xs)",
                color: "var(--muted)",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={allowDestructive}
                onChange={(e) => setDestructiveEnabled(e.target.checked)}
                data-testid="ai-plan-allow-destructive"
                style={{ marginTop: "var(--space-2xs)" }}
              />
              <span>{t("note.ai_plan_enable_destructive")}</span>
            </label>
          ) : null}

          <div
            className="scroll"
            style={{
              maxHeight: 320,
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-2)",
              paddingRight: 4,
            }}
          >
            {plan.actions.map((action) => {
              const checked = selectedIds.has(action.id);
              // Destructive actions (delete/merge) use danger chrome so the review table makes
              // original disposition (trash vs keep) and merge-trash-sources obvious.
              const destructive = isDestructive(action);
              const completed = completedIds.has(action.id);
              const locked = completed || (destructive && !allowDestructive);
              const badges = badgesFor(action);
              const targetLabel =
                action.type === "merge_notes"
                  ? (action.payload.title ||
                      (action.payload.sourceNoteIds ?? []).join(" + ") ||
                      t("note.untitled_note"))
                  : action.payload.title || action.payload.noteId || t("note.untitled_note");
              return (
                <label
                  key={action.id}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: "var(--space-3)",
                    padding: "var(--space-3)",
                    border: "1px solid var(--divider)",
                    borderRadius: "var(--radius-sm)",
                    background: checked ? "var(--sel)" : "transparent",
                    cursor: locked ? "not-allowed" : "pointer",
                    opacity: locked ? 0.55 : 1,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={locked}
                    onChange={() => toggleSelect(action.id, destructive)}
                    data-testid={`ai-plan-action-${action.id}`}
                    style={{ marginTop: "var(--space-2xs)" }}
                  />
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "var(--space-2xs)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      {badges.map((badge) => (
                        <span
                          key={badge.key}
                          className="badge"
                          data-tone={BADGE_TONE[badge.tone]}
                          data-testid={`ai-plan-badge-${action.id}-${badge.key}`}
                        >
                          {badge.label}
                        </span>
                      ))}
                      <span style={{ fontSize: "var(--text-md)", fontWeight: 600, color: "var(--text)" }}>
                        {targetLabel}
                      </span>
                    </div>
                    <div style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>
                      {action.description}
                    </div>
                    {completed ? (
                      <div style={{ fontSize: "var(--text-xs)", color: "var(--ok)", fontWeight: 600 }}>
                        Applied
                      </div>
                    ) : null}
                    {action.payload.sourceNotes && action.payload.sourceNotes.length > 0 ? (
                      <details data-testid={`ai-plan-sources-${action.id}`}>
                        <summary style={{ fontSize: "var(--text-xs)", color: "var(--muted)", cursor: "pointer" }}>
                          Sources ({action.payload.sourceNotes.length})
                        </summary>
                        {action.payload.sourceNotes.map((source) => (
                          <div key={source.id} style={{ marginTop: 6 }}>
                            <div style={{ fontSize: "var(--text-xs)", fontWeight: 600 }}>{source.title || source.id}</div>
                            <pre style={{ margin: "3px 0 0", whiteSpace: "pre-wrap", fontSize: "var(--text-xs)", color: "var(--muted)" }}>{source.bodyMd}</pre>
                          </div>
                        ))}
                      </details>
                    ) : null}
                    {action.payload.bodyMd !== undefined ? (
                      <details data-testid={`ai-plan-body-${action.id}`}>
                        <summary style={{ fontSize: "var(--text-xs)", color: "var(--muted)", cursor: "pointer" }}>
                          {action.type === "update_note" ? "Proposed body (after)" : "Proposed body"}
                        </summary>
                        <pre style={{ margin: "6px 0 0", whiteSpace: "pre-wrap", fontSize: "var(--text-xs)", color: "var(--text)" }}>{action.payload.bodyMd}</pre>
                      </details>
                    ) : null}
                  </div>
                </label>
              );
            })}
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-3)", marginTop: "var(--space-2)" }}>
            <button type="button" className="btn" onClick={requestClose} disabled={executing}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => handleApply()}
              disabled={selectedCount === 0 || executing}
              data-testid="ai-plan-apply"
            >
              {executing ? t("note.saving") : t("note.ai_plan_apply", { n: selectedCount })}
            </button>
          </div>
        </div>
      </ModalShell>

      {pendingDestructiveConfirm ? (
        <PromptDialog
          title={t("note.ai_plan_destructive_confirm_title")}
          description={t("note.ai_plan_destructive_confirm_desc", { n: selectedDestructiveCount })}
          mode="confirm"
          danger
          confirmLabel={t("note.ai_plan_destructive_confirm_apply")}
          onSubmit={() => confirmDestructiveApply()}
          onCancel={() => setPendingDestructiveConfirm(false)}
        />
      ) : null}
    </>
  );
}
