import { t } from "../../../i18n/t";
import type { CollectSource } from "../../../lib/commands.gen";
import { formatRelativeTime } from "../../../lib/dateUtils";
import { useNotesStore } from "../../../stores/notes";
import { useSettingsStore } from "../../../stores/settings";
import { IconEdit, IconFlask, IconRefresh, IconTrash } from "../../icons";
import { Badge } from "../Badge";
import { IconAction } from "../IconAction";
import { SettingsTableRow } from "../SettingsTable";
import { Toggle } from "../Toggle";
import { collectIntervalOptions, sourceAddressLabel, sourceIntervalLabel, sourceKindLabel } from "./collectSourceLabels";

const LAST_ERROR_MAX = 60;

interface CollectSourceRowProps {
  source: CollectSource;
  isLast: boolean;
  /** 이 소스를 지금 실행 중(runNow) / 드라이런 중 — 둘 다 이 행의 버튼을 잠근다. */
  busy: boolean;
  dryBusy: boolean;
  onDryRun: () => void;
  onRunNow: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: (enabled: boolean) => void;
}

/**
 * 수집 소스 표의 한 행 — 유형·이름/상태·주소·행 동작. 상태를 갖지 않는다: 동작은 전부 props 콜백이고,
 * 언어·폴더 이름만 스토어에서 읽는다(상태 텍스트의 상대 시간, 저장 폴더 라벨).
 * 표에 칸이 없는 축(주기·저장 폴더·AI 후처리)은 이름 칸의 툴팁이 말한다.
 */
export function CollectSourceRow({
  source: s,
  isLast,
  busy,
  dryBusy,
  onDryRun,
  onRunNow,
  onEdit,
  onDelete,
  onToggle,
}: CollectSourceRowProps) {
  const lang = useSettingsStore((st) => st.uiLang) || "en";
  const folders = useNotesStore((st) => st.folders);
  const intervalOptions = collectIntervalOptions();

  const lastError = s.last_status === "error" && s.last_error ? s.last_error : null;
  const statusText = lastError
    ? t("settings.collect_status_error", {
        error:
          lastError.length > LAST_ERROR_MAX
            ? `${lastError.slice(0, LAST_ERROR_MAX)}…`
            : lastError,
      })
    : s.last_run_at
      ? t("settings.collect_status_ok", { when: formatRelativeTime(s.last_run_at, lang) })
      : t("settings.collect_status_never");
  const targetFolderLabel = s.target_folder_id
    ? folders.find((f) => f.id === s.target_folder_id)?.name ?? s.target_folder_id
    : t("settings.collect_target_folder_inbox");
  const aiOn = s.post_process === "suggest";
  const disabledRow = !s.enabled;
  const address = sourceAddressLabel(s);

  return (
    <SettingsTableRow
      isLast={isLast}
      data-testid={`collect-row-${s.id}`}
      disabled={disabledRow}
      title={disabledRow ? t("settings.collect_row_disabled_hint") : statusText}
    >
      {/* 유형 */}
      <div style={{ display: "flex", alignItems: "center", gap: 4, overflow: "hidden", whiteSpace: "nowrap" }}>
        <Badge tone="neutral">{sourceKindLabel(s)}</Badge>
        {s.dry_run && <Badge tone="accent">{t("settings.collect_dry_run_badge")}</Badge>}
        {s.show_in_briefing === false && <Badge tone="neutral">{t("settings.collect_briefing_hidden_badge")}</Badge>}
      </div>

      {/* 소스 이름 */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-2xs)",
          minWidth: 0,
          paddingRight: 8,
        }}
        data-testid={`collect-name-${s.id}`}
        title={[
          `${s.name} (${statusText})`,
          sourceIntervalLabel(s.interval_minutes, intervalOptions),
          targetFolderLabel,
          aiOn ? t("settings.collect_ai_post_process_badge") : t("settings.collect_ai_off_badge"),
        ].join(" · ")}
      >
        <span
          style={{
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {s.name}
        </span>
        {lastError ? (
          <span
            data-testid={`collect-status-badge-${s.id}`}
            style={{ display: "flex", overflow: "hidden", whiteSpace: "nowrap" }}
          >
            <Badge tone="danger">{statusText}</Badge>
          </span>
        ) : (
          <span
            style={{
              fontSize: "var(--text-2xs)",
              color: "var(--faint)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {statusText}
          </span>
        )}
      </div>

      {/* 링크 / 주소 */}
      <div
        style={{
          color: "var(--muted)",
          fontSize: "var(--text-xs)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          paddingRight: 8,
        }}
        title={address}
        data-testid={`collect-address-${s.id}`}
      >
        {address}
      </div>

      {/* 편집, 제거 (+ 드라이런, 실행, 토글) */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "var(--space-1)", flex: "none" }}>
        <IconAction
          icon={<IconFlask size={14} strokeWidth={1.8} />}
          label={t("settings.collect_dry_run_btn")}
          size="sm"
          data-testid={`collect-dry-run-${s.id}`}
          busy={dryBusy}
          disabled={dryBusy || busy}
          onClick={onDryRun}
        />

        <IconAction
          icon={<IconRefresh size={14} strokeWidth={1.8} />}
          label={s.dry_run ? t("settings.collect_run_now_disabled_dry_run") : t("settings.collect_run_now")}
          size="sm"
          data-testid={`collect-run-${s.id}`}
          busy={busy}
          disabled={busy || dryBusy || s.dry_run}
          onClick={onRunNow}
        />

        <IconAction
          icon={<IconEdit size={14} strokeWidth={1.8} />}
          label={t("settings.collect_edit_source")}
          size="sm"
          data-testid={`collect-edit-${s.id}`}
          onClick={onEdit}
        />

        <IconAction
          icon={<IconTrash size={14} strokeWidth={1.8} />}
          label={t("ctx.remove")}
          size="sm"
          danger
          data-testid={`collect-delete-${s.id}`}
          onClick={onDelete}
        />

        <Toggle
          checked={s.enabled}
          onChange={onToggle}
          aria-label={t("settings.collect_enabled")}
          data-testid={`collect-enabled-${s.id}`}
        />
      </div>
    </SettingsTableRow>
  );
}
