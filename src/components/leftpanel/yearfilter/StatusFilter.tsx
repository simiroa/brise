import { useState } from "react";
import { useSearchStore } from "../../../stores/search";
import { useTaxonomyStore } from "../../../stores/taxonomy";
import { useSettingsStore } from "../../../stores/settings";
import { BUILT_IN_STATUSES } from "../../../lib/status";
import { t } from "../../../i18n/t";
import { IconClose, IconPlus } from "../../icons";
import { FilterHeaderRow, RemovableChip, chipStyle, addChipStyle, draftInputStyle } from "./shared";

/* ── Year filter: Statut ──
   Wave 15: 진행 상태(작성중/내보냄/완료 + 사용자 추가분)로 필터링. 태그와 동일하게 다중
   선택 + OR 매칭(선택된 상태 중 하나라도 일치하면 통과) — "matches any (OR)" 힌트를 태그와
   동일한 문구로 노출한다(owner 요구사항: 규칙이 UI에 보여야 한다). 내장 3종은 코드 상수라
   제거 버튼이 없고, 사용자 추가분(workspace_statuses)만 지울 수 있다 — "검색필터쪽에서
   추가할수있게 하자"는 요구사항에 따라 이 모드 안에 추가 입력이 있다(era/region add와 동일
   패턴). 색상 점은 note.status 배지(TitleBar)와 동일한 statusColorVar를 사용해 두 곳의
   색이 항상 일치한다. */
export function StatusFilter() {
  const statusFilter = useSearchStore((s) => s.statusFilter);
  const toggleStatusFilter = useSearchStore((s) => s.toggleStatusFilter);
  const clearStatusFilter = useSearchStore((s) => s.clearStatusFilter);
  const customStatuses = useTaxonomyStore((s) => s.statuses);
  const addStatus = useTaxonomyStore((s) => s.addStatus);
  const renameStatus = useTaxonomyStore((s) => s.renameStatus);
  const removeStatus = useTaxonomyStore((s) => s.removeStatus);
  const statusAddLocked = useSettingsStore((s) => s.statusAddLocked);

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  // 커스텀 칩 더블클릭 → 인라인 개명(NoteRegionsList 의 인라인 rename 패턴 — Enter 확정 /
  // Escape 취소 / blur 확정). 내장 3종은 코드 상수라 개명 진입점 자체가 없다.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  // Wave A-4: no resident corpus for chip counts — labels alone (expanded board has totals).

  const cancelAdd = () => {
    setAdding(false);
    setDraft("");
  };
  const commitAdd = () => {
    const name = draft.trim();
    cancelAdd();
    if (name) void addStatus(name);
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameDraft("");
  };
  const commitRename = () => {
    const id = renamingId;
    const name = renameDraft.trim();
    cancelRename();
    if (id && name) void renameStatus(id, name);
  };

  return (
    <div style={{ marginTop: "var(--space-2)", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {/* idle 안내 제거 — 활성일 때만 초슬림 상태 표시(선택 개수 · OR + 지우기). */}
      {statusFilter.length > 0 && (
        <FilterHeaderRow>
          <span style={{ fontSize: "var(--text-label)", color: "var(--accent)", fontWeight: 600 }}>
            {statusFilter.length} · OR
          </span>
          <button
            type="button"
            onClick={clearStatusFilter}
            className="icon-btn icon-btn--sm"
            title={t("search.status_clear")}
            aria-label={t("search.status_clear")}
          >
            <IconClose size={12} strokeWidth={2.2} />
          </button>
        </FilterHeaderRow>
      )}
      <div
        className="scroll"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "var(--space-1)",
          marginTop: "var(--space-3)",
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          alignContent: "flex-start",
        }}
      >
        {BUILT_IN_STATUSES.map((def) => {
          const active = statusFilter.includes(def.key);
          return (
            <button type="button" key={def.key} onClick={() => toggleStatusFilter(def.key)} style={chipStyle(active)}>
              <span
                aria-hidden
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: def.colorVar,
                  marginRight: 5,
                  flex: "none",
                }}
              />
              {t(def.labelKey)}
            </button>
          );
        })}
        {customStatuses.map((s) => {
          if (renamingId === s.id) {
            return (
              <input
                key={s.id}
                data-testid="status-rename-input"
                autoFocus
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitRename();
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    cancelRename();
                  }
                }}
                placeholder={t("search.status_add_placeholder")}
                style={{ ...draftInputStyle, width: 110 }}
              />
            );
          }
          const active = statusFilter.includes(s.id);
          return (
            <RemovableChip
              key={s.id}
              label={s.name}
              active={active}
              onSelect={() => toggleStatusFilter(s.id)}
              onRename={() => {
                setRenamingId(s.id);
                setRenameDraft(s.name);
              }}
              onRemove={() => void removeStatus(s.id)}
              removeLabel={t("search.status_remove_custom", { name: s.name })}
            />
          );
        })}
        {!statusAddLocked &&
          (adding ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitAdd}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitAdd();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  cancelAdd();
                }
              }}
              placeholder={t("search.status_add_placeholder")}
              style={{ ...draftInputStyle, width: 110 }}
            />
          ) : (
            <button
              type="button"
              onClick={() => setAdding(true)}
              title={t("search.status_add")}
              aria-label={t("search.status_add")}
              style={addChipStyle}
            >
              <IconPlus size={11} strokeWidth={2.2} />
            </button>
          ))}
      </div>
    </div>
  );
}
