import { IconCheck } from "../icons";
import { t } from "../../i18n/t";
import { useAiStore } from "../../stores/ai";
import { FIELD_LABEL_KEYS } from "../../lib/aiProposalDiff";
import { FieldRowValue, STATE_BADGE_KEYS, STATE_BADGE_TONE, useProposalReview, useProposalTargetNoteTitle } from "./AiProposalPanel";

/**
 * AI 모달 안의 메타데이터 제안 (PLAN-2026-09-27 §3.1, §3.2, §3.3) — 결과 패널과 같은 틀·같은 상자 규칙.
 * 위의 컨텍스트 줄·요청문 상자는 그대로 남는다.
 * "삽입했습니다" 안내는 상자 위가 아니라 행동 줄 왼쪽 슬롯(§3.2)으로 옮겨진다.
 */
export function AskAiMetaPanel({
  pending,
  inserted,
  applying,
  setApplying,
  cancelLabel,
  onCancel,
  onApplied,
}: {
  pending: boolean;
  inserted?: boolean;
  applying: boolean;
  setApplying: (v: boolean) => void;
  cancelLabel: string;
  onCancel: (() => void) | null;
  /** 적용이 실제로 반영돼 제안이 사라졌을 때(잠긴 노트 등으로 적용이 거절되면 부르지 않는다). */
  onApplied: () => void;
}) {
  const r = useProposalReview(applying, setApplying);
  const targetNoteTitle = useProposalTargetNoteTitle();
  const headTitle = targetNoteTitle
    ? `${t("ai.proposal_head")} · ${targetNoteTitle}`
    : t("ai.proposal_head");
  const ready = !pending && !!r.proposal;

  const apply = async () => {
    const noteId = useAiStore.getState().lastProposalNoteId;
    await r.apply();
    const s = useAiStore.getState();
    if (!(s.lastProposal && s.lastProposalNoteId === noteId)) onApplied();
  };

  return (
    <div className="ai-result-panel ai-result-panel--inline askai-metapanel" data-testid="askai-meta-step">
      <div className="ai-result-box askai-metapanel__box" data-status="proposal" data-testid="ai-result-box">
        <div className="ai-result-box__head askai-metapanel__head">
          <span className="ai-result-box__title">{headTitle}</span>
        </div>
        {!ready ? (
          <div className="ai-result-box__body askai-metapanel__pending" role="status" data-testid="askai-meta-pending">
            {t("ai.meta_follow_pending")}
          </div>
        ) : (
          <div className="ai-result-box__body askai-metapanel__body" data-testid="askai-meta-review">
            <div className="askai-metapanel__rows">
              {r.lowConfidence && <p className="askai-metapanel__note">{t("ai.low_confidence")}</p>}
              {r.nothingToApply && <p className="askai-metapanel__note">{t("ai.no_changes")}</p>}
              {r.diffs.map((diff) => (
                <label key={diff.key} className="askai-metapanel__row">
                  <input
                    type="checkbox"
                    checked={r.selectedKeys.has(diff.key)}
                    onChange={() => r.toggleField(diff.key)}
                    aria-label={t(FIELD_LABEL_KEYS[diff.key])}
                  />
                <span className="askai-metapanel__label">{t(FIELD_LABEL_KEYS[diff.key])}</span>
                <span className="askai-metapanel__value">
                  <FieldRowValue diff={diff} folderName={r.folderName} />
                </span>
                <span className="badge askai-metapanel__badge" data-tone={STATE_BADGE_TONE[diff.state]} data-state={diff.state}>
                  {t(STATE_BADGE_KEYS[diff.state])}
                </span>
              </label>
            ))}
            {r.hasTagSection && (
              <div className="askai-metapanel__row">
                <span />
                <span className="askai-metapanel__label">{t("ai.field_tags")}</span>
                <span className="askai-metapanel__tags">
                  {r.tagZones.kept.map((tg) => (
                    <span key={tg} className="askai-metapanel__tag" data-kind="kept">
                      #{tg}
                    </span>
                  ))}
                  {r.tagZones.added.map((tg) => (
                    <button
                      key={tg}
                      type="button"
                      className="askai-metapanel__tag"
                      data-kind="add"
                      aria-pressed={r.selectedAddedTags.has(tg)}
                      title={t("ai.tag_zone_added")}
                      onClick={() => r.toggleAddedTag(tg)}
                    >
                      +#{tg}
                    </button>
                  ))}
                  {r.tagZones.removed.map((tg) => (
                    <button
                      key={tg}
                      type="button"
                      className="askai-metapanel__tag"
                      data-kind="remove"
                      aria-pressed={r.selectedRemovedTags.has(tg)}
                      title={t("ai.tag_zone_removed_hint")}
                      onClick={() => r.toggleRemovedTag(tg)}
                    >
                      −#{tg}
                    </button>
                  ))}
                </span>
                <span />
              </div>
            )}
            {r.hasTagSection && r.tagZones.added.length > r.tagZones.defaultSelectedAdded.length && (
              <p className="askai-metapanel__note" role="status" data-warn="">
                {t("ai.tags_too_many")}
              </p>
            )}
              </div>
            </div>
          )}
          {ready && r.hasTagSection && (
            <div className="ai-result-box__foot askai-metapanel__foot">
              <span className="ai-result-panel__meta-caption">
                {t("ai.tags_after_apply", { count: r.finalTags.length, tags: r.finalTags.map((tg) => `#${tg}`).join(" · ") })}
              </span>
            </div>
          )}
        </div>
      <div className="ai-result-panel__actions">
        <span className="ai-result-panel__target">
          {inserted ? (
            <span className="askai-metapanel__done" data-testid="askai-meta-inserted">
              <IconCheck size={12} strokeWidth={2} />
              {t("ai.meta_inserted")}
            </span>
          ) : (
            t("ai.review_before_apply")
          )}
        </span>
        {onCancel && (
          <button type="button" className="btn" data-testid="askai-meta-cancel" onClick={onCancel ?? undefined} disabled={!onCancel || applying}>
            {cancelLabel}
          </button>
        )}
        <button
          type="button"
          className="btn btn-primary"
          data-testid="askai-meta-apply"
          onClick={() => void apply()}
          disabled={!ready || applying || r.payloadEmpty}
          aria-busy={applying || undefined}
        >
          {applying ? t("ai.applying") : t("ai.apply_selected", { count: r.selectedCount })}
        </button>
      </div>
    </div>
  );
}
