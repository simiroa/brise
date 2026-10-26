import { IconPaperclip, IconArrowUp, IconFolder, IconAlignLeft, IconCheck, IconHistory } from "../icons";
import { t } from "../../i18n/t";
import { Select } from "../Select";
import type { AskAiWhere } from "../../stores/aiPrompts";
import type { WhereOption } from "./askAiDispatch";

/**
 * 동작 줄(PLAN-2026-09-15-askai-composer D9·D10):
 * `📎 │ 위치: [새 섹션 ▾] ([📁 폴더 ▾] 새 노트일 때) │ 보내기 ↵`.
 * 제안형 프리셋(메타·태그·분리)은 드롭다운 대신 점선 고정 라벨 「☑ 검토 후 적용」(`fixedLabel`).
 *
 * 드롭다운은 네이티브 `<select>` 가 아니라 인앱 `Select` 다 — W7-b 에서 네이티브 select 를 전면
 * 대체한 이유(OS 가 그리는 옵션 목록에 앱 폰트가 안 닿음)가 여기도 그대로 적용된다.
 */
export type OutputFormat = "text" | "sheet" | "diagram";

export interface AskAiActionBarProps {
  where: AskAiWhere;
  options: WhereOption[];
  onWhere: (w: AskAiWhere) => void;
  /** 제안형 프리셋: 드롭다운 대신 「☑ 검토 후 적용」 고정 라벨. 값은 툴팁(어느 제안인지). */
  fixedLabel?: string;
  format?: OutputFormat;
  onFormat?: (f: OutputFormat) => void;
  formatFixed?: boolean;
  folderId: string | null;
  folders: { id: string; name: string }[];
  onFolder: (id: string) => void;
  attachedCount: number;
  onAttach: () => void;
  onHistory?: () => void;
  canSend: boolean;
  sendLabel: string;
  onSend: () => void;
}

// 크기·색은 tokens.css `.askai-actionbar*` 가 소유한다 — 모든 컨트롤이 한 높이(--ctrl-h-sm)다. 인라인으로
// 남는 건 `Select` 가 기본으로 박는 설정 화면용 폭(--settings-ctrl-w)을 푸는 것뿐이다.
const selectFit = { width: "auto", minWidth: 0 } as const;

export function AskAiActionBar(p: AskAiActionBarProps) {
  return (
    <div className="askai-actionbar">
      <button
        type="button"
        className="btn btn--sm askai-actionbar__icon"
        data-on={p.attachedCount > 0 || undefined}
        onClick={p.onAttach}
        title={t("ai.attach_files_hint")}
        aria-label={t("ai.attach_files")}
      >
        <IconPaperclip size={12} strokeWidth={1.8} />
        {p.attachedCount > 0 && <span>{p.attachedCount}</span>}
      </button>
      {p.onHistory && (
        <button type="button" className="btn btn--sm askai-actionbar__icon" onClick={p.onHistory} title={t("ai.history_open_all")} aria-label={t("ai.history_open_all")}>
          <IconHistory size={12} strokeWidth={1.8} />
        </button>
      )}

      <span className="askai-actionbar__spacer" />

      {p.fixedLabel ? (
        <span data-testid="askai-fixed-where" title={p.fixedLabel} className="askai-actionbar__fixed">
          <IconCheck size={12} strokeWidth={2} />
          {t("ai.review_before_apply")}
        </span>
      ) : (
        <>
          <span className="askai-actionbar__label">
            <IconAlignLeft size={12} strokeWidth={1.8} />
            {t("ai.where_label")}
          </span>
          <Select
            value={p.where}
            onChange={(v) => p.onWhere(v as AskAiWhere)}
            options={p.options.map((o) => ({ value: o.value, label: o.label, disabled: o.disabled, title: o.hint }))}
            ariaLabel={t("ai.where_label")}
            testid="askai-where"
            className="btn btn--sm"
            style={selectFit}
          />
          <span className="askai-actionbar__label">
            {t("ai.format_label")}
          </span>
          {p.formatFixed ? (
            <span className="askai-actionbar__fixed" data-testid="askai-fixed-format">
              {p.format === "sheet" ? t("ai.format_sheet") : p.format === "diagram" ? t("ai.format_diagram") : t("ai.format_text")}
            </span>
          ) : (
            <Select
              value={p.format ?? "text"}
              onChange={(v) => p.onFormat?.(v as OutputFormat)}
              options={[
                { value: "text", label: t("ai.format_text") },
                { value: "sheet", label: t("ai.format_sheet") },
                { value: "diagram", label: t("ai.format_diagram") },
              ]}
              ariaLabel={t("ai.format_label")}
              testid="askai-format"
              className="btn btn--sm"
              style={selectFit}
            />
          )}
          {p.where === "note" && (
            <>
              <IconFolder size={12} strokeWidth={1.8} className="askai-actionbar__icon" />
              <Select
                value={p.folderId ?? ""}
                onChange={p.onFolder}
                options={p.folders.map((f) => ({ value: f.id, label: f.name }))}
                ariaLabel={t("ai.where_folder")}
                testid="askai-folder"
                className="btn btn--sm"
                style={{ ...selectFit, maxWidth: 160 }}
              />
            </>
          )}
        </>
      )}

      <button type="button" className="btn btn--sm btn-primary askai-actionbar__send" disabled={!p.canSend} onClick={p.onSend}>
        <IconArrowUp size={13} strokeWidth={2.2} />
        <span>{p.sendLabel}</span>
        <kbd>↵</kbd>
      </button>
    </div>
  );
}
