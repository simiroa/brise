import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAiStore } from "../../stores/ai";
import { useNotesStore } from "../../stores/notes";
import { t } from "../../i18n/t";
import {
  computeFieldDiffs,
  computeTagZones,
  computeFinalTagNames,
  tagNamesForApply,
  buildApplyPayload,
  defaultSelectedFieldKeys,
  FALLBACK_CURRENT,
  FIELD_LABEL_KEYS,
  type FieldDiff,
  type FieldDiffKey,
  type CurrentNoteFields,
} from "../../lib/aiProposalDiff";

export const STATE_BADGE_KEYS: Record<FieldDiff["state"], string> = {
  fill: "ai.diff_fill",
  overwrite: "ai.diff_overwrite",
  add: "ai.diff_add",
};

// 앱 전체 배지 한 벌 `.badge`(styles/tokens.css, GRILL-2026-10-19 R8)의 톤 — 채움=강조, 덮어씀=주의, 추가=중성.
export const STATE_BADGE_TONE: Record<FieldDiff["state"], string> = {
  fill: "accent",
  overwrite: "warn",
  add: "muted",
};

function StateBadge({ state }: { state: FieldDiff["state"] }) {
  return (
    <span className="badge" data-tone={STATE_BADGE_TONE[state]} style={{ marginLeft: "var(--space-3)" }}>
      {t(STATE_BADGE_KEYS[state])}
    </span>
  );
}

export function FieldRowValue({ diff, folderName }: { diff: FieldDiff; folderName: (id: string, proposedName?: string | null) => string }) {
  const empty = t("ai.empty_value") || "(empty)";
  switch (diff.key) {
    case "title":
    case "region":
      return <>{diff.current || empty} → {diff.proposed}</>;
    case "year":
      return <>{diff.current === 0 ? empty : diff.current} → {diff.proposed}</>;
    case "location":
      return (
        <>
          {diff.current ? `${diff.current.lat.toFixed(4)}, ${diff.current.lng.toFixed(4)}` : empty}
          {" → "}
          {diff.proposed.lat.toFixed(4)}, {diff.proposed.lng.toFixed(4)}
        </>
      );
    case "folder_id":
      return <>{folderName(diff.current)} → {folderName(diff.proposed, diff.proposedName)}</>;
    case "source_urls":
      return (
        <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
          {diff.proposed.map((url, idx) => (
            <li key={idx}>
              {/* source_urls는 AI 응답에서 온 비신뢰 문자열 — 백엔드 is_safe_link_url과 동일하게
                  http/https만 클릭 가능한 앵커로 렌더한다(javascript: 등은 텍스트로 강등). */}
              {/^https?:\/\//i.test(url) ? (
                <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>
                  {url}
                </a>
              ) : (
                <span style={{ color: "var(--muted)" }}>{url}</span>
              )}
            </li>
          ))}
        </ul>
      );
  }
}

/** 제안 창·단계의 제목 — "「노트 제목」 정리" (그 노트를 못 찾으면 일반 제목). 두 호스트가 같이 쓴다. */
export function useProposalTargetNoteTitle(): string | null {
  const lastProposalNoteId = useAiStore((s) => s.lastProposalNoteId);
  const noteIndex = useNotesStore((s) => s.noteIndex);
  const activeNoteMeta = useNotesStore(
    useShallow((s) => (s.activeNote ? { id: s.activeNote.note.id, title: s.activeNote.note.title } : null)),
  );
  const targetId = lastProposalNoteId ?? activeNoteMeta?.id ?? null;
  return (
    (targetId ? noteIndex.get(targetId)?.title : null) ||
    (targetId && activeNoteMeta?.id === targetId ? activeNoteMeta.title : null) ||
    null
  );
}

/** 제안 창·단계의 제목 — "「노트 제목」 정리" (그 노트를 못 찾으면 일반 제목). 두 호스트가 같이 쓴다. */
export function useProposalTitle(): string {
  const targetTitle = useProposalTargetNoteTitle();
  return targetTitle ? t("ai.organize_for", { title: targetTitle }) : t("ai.organize_title") || "AI Organize";
}

/**
 * 제안 검토의 선택 상태와 적용 — 필드 체크, 태그 칸(유지·추가·제거), 적용 페이로드. 두 호스트의 몸통이 같이
 * 쓴다: 독립 확인 창의 AiProposalPanel, AI 모달 안의 AskAiMetaPanel(2026-09-27). 적용 중 표시는 호스트가
 * 들고 있다(창은 적용 중에 닫히면 안 된다).
 */
export function useProposalReview(isApplying: boolean, setIsApplying: (v: boolean) => void) {
  const proposal = useAiStore((s) => s.lastProposal);
  const lastProposalNoteId = useAiStore((s) => s.lastProposalNoteId);
  const clearProposal = useAiStore((s) => s.clearProposal);
  const applyProposal = useAiStore((s) => s.applyProposal);
  // Title lookup for the note this proposal targets (may differ from the open editor —
  // tree/tab Ask-AI). noteIndex covers resident tree rows; activeNote covers the open tab.
  const noteIndex = useNotesStore((s) => s.noteIndex);
  const folders = useNotesStore((s) => s.folders);
  const inboxId = useNotesStore((s) => s.inboxId);
  const activeNoteMeta = useNotesStore(
    useShallow((s) =>
      s.activeNote
        ? { id: s.activeNote.note.id, title: s.activeNote.note.title }
        : null
    )
  );

  const targetId = lastProposalNoteId ?? activeNoteMeta?.id ?? null;
  const current: CurrentNoteFields = (targetId && noteIndex.get(targetId)) || FALLBACK_CURRENT;
  const currentTags = current.tag_names;

  // §1 A-2: computeFieldDiffs already drops "동일"(same) rows — nothing else needs to filter them.
  const diffs = useMemo(
    () => (proposal ? computeFieldDiffs(current, proposal) : []),
    // current is a NoteSummary reference from noteIndex — stable until loadTree() replaces it,
    // proposal identity changes on every new proposal (store always sets a fresh object).
    [proposal, current],
  );
  const tagZones = useMemo(
    () => computeTagZones(currentTags, proposal?.tag_names),
    [currentTags, proposal],
  );
  const hasTagSection = tagZones.kept.length > 0 || tagZones.added.length > 0 || tagZones.removed.length > 0;

  // Stable key so selection resets only when a genuinely new proposal arrives (same modal
  // instance is reused across proposals — background/manual queueing in stores/ai.ts).
  const resetKey = `${lastProposalNoteId ?? ""}|${JSON.stringify(proposal)}`;
  const [selectedKeys, setSelectedKeys] = useState<Set<FieldDiffKey>>(() => defaultSelectedFieldKeys(diffs));
  const [selectedAddedTags, setSelectedAddedTags] = useState<Set<string>>(() => new Set(tagZones.defaultSelectedAdded));
  const [selectedRemovedTags, setSelectedRemovedTags] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setSelectedKeys(defaultSelectedFieldKeys(diffs));
    setSelectedAddedTags(new Set(tagZones.defaultSelectedAdded));
    setSelectedRemovedTags(new Set());
    // resetKey encodes note id + full proposal; diffs/tagZones are derived from the render that
    // produced that key.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-init only when resetKey changes
  }, [resetKey]);

  const lowConfidence = !!proposal && proposal.confidence < 0.5;

  const folderName = (id: string, proposedName?: string | null): string => {
    if (!id) return t("tree.inbox");
    if (inboxId && id === inboxId) return t("tree.inbox");
    return proposedName || folders.find((f) => f.id === id)?.name || id;
  };

  const flip = <T,>(set: (fn: (prev: Set<T>) => Set<T>) => void) => (key: T) =>
    set((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const toggleField = flip<FieldDiffKey>(setSelectedKeys);
  const toggleAddedTag = flip<string>(setSelectedAddedTags);
  const toggleRemovedTag = flip<string>(setSelectedRemovedTags);

  const finalTags = computeFinalTagNames(currentTags, selectedAddedTags, selectedRemovedTags);
  const tagNamesToSend = hasTagSection ? tagNamesForApply(currentTags, finalTags) : undefined;
  // Label count = boxes the user actually ticked (matches §1 A-1's "선택 항목 적용 (5)" example,
  // which counts each added/removed tag individually, not the tag section as one unit).
  const selectedCount = selectedKeys.size + selectedAddedTags.size + selectedRemovedTags.size;
  const applyPayload = buildApplyPayload(diffs, selectedKeys, tagNamesToSend);
  // Disabled when the call would be a true no-op (e.g. a note whose only tag activity is
  // "kept" tags with nothing added/removed selected, and no other field checked) — distinct from
  // selectedCount, since "kept" tags need zero checkboxes to survive by design (A-0).
  const payloadEmpty = Object.keys(applyPayload).length === 0;
  const nothingToApply = diffs.length === 0 && !hasTagSection;

  const apply = async () => {
    if (isApplying) return;
    setIsApplying(true);
    try {
      await applyProposal(applyPayload);
    } finally {
      setIsApplying(false);
    }
  };

  return {
    proposal, clearProposal, apply, diffs, tagZones, hasTagSection, lowConfidence, folderName,
    selectedKeys, selectedAddedTags, selectedRemovedTags, toggleField, toggleAddedTag, toggleRemovedTag,
    finalTags, selectedCount, payloadEmpty, nothingToApply,
  };
}

/**
 * 독립 확인 창(AiConfirmModal)의 AI 정리(메타데이터) 제안 몸통 — 필드별 이전→제안 비교와 체크박스, 태그 칸
 * (유지·추가·제거), [취소] [선택 항목 적용]. AI 모달 안에서는 같은 훅으로 AskAiMetaPanel 이 그린다.
 */
export function AiProposalPanel({ applying: isApplying, setApplying: setIsApplying }: { applying: boolean; setApplying: (v: boolean) => void }) {
  const {
    proposal, clearProposal, apply: handleApply, diffs, tagZones, hasTagSection, lowConfidence, folderName,
    selectedKeys, selectedAddedTags, selectedRemovedTags, toggleField, toggleAddedTag, toggleRemovedTag,
    finalTags, selectedCount, payloadEmpty, nothingToApply,
  } = useProposalReview(isApplying, setIsApplying);

  if (!proposal) return null;

  return (
      <div data-testid="ai-proposal-panel">
        {lowConfidence && (
          <p style={{ margin: "0 0 10px", fontSize: "var(--text-md)", color: "var(--muted)" }}>
            {t("ai.low_confidence") || "Low confidence — review before applying."}
          </p>
        )}

        {nothingToApply ? (
          <p style={{ margin: "0 0 14px", fontSize: "var(--text-md)", color: "var(--muted)" }}>
            {t("ai.no_changes")}
          </p>
        ) : (
          <>
            <p style={{ margin: "0 0 14px", fontSize: "var(--text-md)", color: "var(--text)" }}>
              {t("ai.preview_changes") || "Suggested changes:"}
            </p>

            {diffs.map((diff) => (
              <label
                key={diff.key}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  marginBottom: "var(--space-3)",
                  wordBreak: "break-word",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={selectedKeys.has(diff.key)}
                  onChange={() => toggleField(diff.key)}
                  style={{ marginTop: "var(--space-1)" }}
                  aria-label={t(FIELD_LABEL_KEYS[diff.key])}
                />
                <span>
                  <strong>{t(FIELD_LABEL_KEYS[diff.key])}</strong>
                  <StateBadge state={diff.state} />
                  <div style={{ marginTop: "var(--space-2xs)" }}>
                    <FieldRowValue diff={diff} folderName={folderName} />
                  </div>
                </span>
              </label>
            ))}

            {hasTagSection && (
              <div className="field" style={{ marginBottom: "var(--space-3)", borderTop: "1px solid var(--divider)", paddingTop: 10 }}>
                <strong>{t("ai.field_tags")}</strong>

                {tagZones.added.length > tagZones.defaultSelectedAdded.length && (
                  <p
                    role="status"
                    data-testid="ai-over-tag-warning"
                    style={{ margin: "6px 0 0", fontSize: "var(--text-md)", color: "var(--warn)" }}
                  >
                    {t("ai.tags_too_many")}
                  </p>
                )}

                {tagZones.kept.length > 0 && (
                  <div style={{ margin: "6px 0" }}>
                    <span style={{ fontSize: "var(--text-sm)", color: "var(--muted)", marginRight: 6 }}>
                      {t("ai.tag_zone_kept")}
                    </span>
                    {tagZones.kept.map((tg) => (
                      <span key={tg} style={{ fontSize: "var(--text-md)", marginRight: 8, color: "var(--text)" }}>
                        #{tg}
                      </span>
                    ))}
                  </div>
                )}

                {tagZones.added.length > 0 && (
                  <div style={{ margin: "6px 0" }}>
                    <span style={{ fontSize: "var(--text-sm)", color: "var(--muted)", marginRight: 6 }}>
                      {t("ai.tag_zone_added")}
                    </span>
                    {tagZones.added.map((tg) => (
                      <label key={tg} style={{ display: "inline-flex", alignItems: "center", gap: 4, marginRight: 10, cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={selectedAddedTags.has(tg)}
                          onChange={() => toggleAddedTag(tg)}
                          aria-label={`#${tg}`}
                        />
                        <span style={{ fontSize: "var(--text-md)" }}>#{tg}</span>
                      </label>
                    ))}
                  </div>
                )}

                {tagZones.removed.length > 0 && (
                  <div style={{ margin: "6px 0" }}>
                    <span style={{ fontSize: "var(--text-sm)", color: "var(--muted)", marginRight: 6 }}>
                      {t("ai.tag_zone_removed")}
                    </span>
                    {tagZones.removed.map((tg) => (
                      <label key={tg} style={{ display: "inline-flex", alignItems: "center", gap: 4, marginRight: 10, cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={selectedRemovedTags.has(tg)}
                          onChange={() => toggleRemovedTag(tg)}
                          aria-label={`#${tg}`}
                        />
                        <span style={{ fontSize: "var(--text-md)" }}>#{tg}</span>
                      </label>
                    ))}
                    <p style={{ margin: "4px 0 0", fontSize: "var(--text-sm)", color: "var(--muted)" }}>
                      {t("ai.tag_zone_removed_hint")}
                    </p>
                  </div>
                )}

                <p style={{ margin: "6px 0 0", fontSize: "var(--text-sm)", color: "var(--muted)" }}>
                  {t("ai.tags_after_apply", { count: finalTags.length, tags: finalTags.map((tg) => `#${tg}`).join(" · ") })}
                </p>
              </div>
            )}
          </>
        )}

        <div style={{ display: "flex", gap: "var(--space-4)", justifyContent: "flex-end", marginTop: "var(--space-8)" }}>
          <button type="button" onClick={clearProposal} className="btn" disabled={isApplying}>
            {t("common.cancel") || "Cancel"}
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={isApplying || payloadEmpty}
            aria-busy={isApplying || undefined}
            className="btn"
            style={{ color: "var(--accent)", borderColor: "var(--accent)" }}
          >
            {isApplying ? t("ai.applying") : t("ai.apply_selected", { count: selectedCount })}
          </button>
        </div>
      </div>
  );
}
