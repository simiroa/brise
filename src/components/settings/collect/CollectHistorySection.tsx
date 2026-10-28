import { useCallback, useEffect, useState } from "react";
import { callSilent } from "../../../lib/invoke";
import type { CollectHistoryNote, CollectHistoryOutput } from "../../../lib/commands.gen";
import { requestOpenNoteInMain } from "../../../lib/openNoteInMain";
import { formatRelativeTime } from "../../../lib/dateUtils";
import { reportFallback, safeErrorDetail } from "../../../lib/diag";
import { useSettingsStore } from "../../../stores/settings";
import { t } from "../../../i18n/t";
import { SectionHeader } from "../SectionHeader";
import { anchorId } from "../settingsAnchor";
import { SettingsTable, SettingsTableRow } from "../SettingsTable";
import { IconAction } from "../IconAction";
import { IconHistory, IconRefresh } from "../../icons";

const HISTORY_LIMIT = 30;

/**
 * 설정 > 수집 > 수집 이력 (2026-10-28, 오너: "수집이력을 새로 만들자").
 * 수집 소스가 가져와 만든 노트를 **최근 수집순**으로 보여 주고, 행을 누르면 본 창에서 그 노트를 연다.
 * 전용 `collect_history` 를 쓴다(수집 출처 = notes.origin_source_id/collected_at) — 브리핑 카드의 `briefing_recent_collected` 를 재사용하면
 * 브리핑에서 끈 소스의 노트가 이력에서 사라지고, 표가 안 쓰는 발췌·태그·개수까지 계산했다.
 * 이 창은 별도 OS 창이라 노트를 직접 열지 않고 `requestOpenNoteInMain` 으로 본 창에 부탁한다.
 * 브라우저 모드에서는 이 페이지에 소스 목록만 있고(커맨드가 http:false) 호출부가 마운트하지 않는다.
 */
export function CollectHistorySection() {
  const uiLang = useSettingsStore((s) => s.uiLang);
  const [items, setItems] = useState<CollectHistoryNote[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    setFailed(false);
    // callSilent 가 실패를 진단 로그에 남긴다.
    void callSilent<CollectHistoryOutput>("collect_history", {
      limit: HISTORY_LIMIT,
    })
      .then((r) => setItems(r?.items ?? []))
      .catch((e) => {
        reportFallback("collect", "history_load_failed", safeErrorDetail(e));
        setItems(null);
        setFailed(true);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 본 창이 닫혀 있어도 emit 은 던지지 않는다. 던지면 진단에 남기고 넘어간다(눌렀는데 무반응인 원인 추적용).
  const open = (noteId: string) => {
    void requestOpenNoteInMain(noteId).catch((e) => reportFallback("collect", "history_open_failed", safeErrorDetail(e)));
  };

  return (
    <div id={anchorId("collect_history")} data-testid="collect-history">
      <SectionHeader
        title={t("settings.collect_history")}
        hint={t("settings.collect_history_hint")}
        icon={<IconHistory size={14} strokeWidth={2} />}
        actions={
          <IconAction
            icon={<IconRefresh size={14} />}
            label={t("common.retry")}
            size="sm"
            data-testid="collect-history-refresh"
            onClick={load}
          />
        }
      />
      <SettingsTable
        columns="minmax(160px, 2.2fr) minmax(90px, 1fr) 110px"
        maxHeight={360}
        data-testid="collect-history-table"
        scrollTestId="collect-history-scroll"
        style={{ marginTop: 0 }}
        isEmpty={!items || items.length === 0}
        emptyText={failed ? t("settings.collect_history_failed") : items === null ? t("common.loading") : t("settings.collect_history_empty")}
        header={
          <>
            <div>{t("settings.collect_history_title")}</div>
            <div>{t("settings.collect_history_source")}</div>
            <div style={{ textAlign: "right" }}>{t("settings.collect_history_when")}</div>
          </>
        }
      >
        {(items ?? []).map((n, i) => (
          <SettingsTableRow
            key={n.note_id}
            isLast={i === (items ?? []).length - 1}
            data-testid="collect-history-row"
            title={t("settings.collect_history_open")}
            onClick={() => open(n.note_id)}
            style={{ cursor: "pointer" }}
          >
            {/* 행 전체가 눌리지만 키보드는 이 단추가 맡는다 — 포커스 가능한 곳이 하나여야 한다. */}
            <button
              type="button"
              data-testid="collect-history-open"
              onClick={(e) => {
                e.stopPropagation();
                open(n.note_id);
              }}
              style={{
                all: "unset",
                cursor: "pointer",
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {n.title || t("note.untitled_note")}
            </button>
            <div style={{ minWidth: 0, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {n.source_name ?? "—"}
            </div>
            <div style={{ textAlign: "right", color: "var(--muted)", fontSize: "var(--text-xs)" }}>
              {formatRelativeTime(n.collected_at, uiLang)}
            </div>
          </SettingsTableRow>
        ))}
      </SettingsTable>
    </div>
  );
}
