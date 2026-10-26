import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { call, emitNotice } from "../../lib/invoke";
import { showUndoToast } from "../../lib/undo";
import { t } from "../../i18n/t";
import { isBrowser } from "../../lib/env";
import { useSettingsStore } from "../../stores/settings";
import { listenDayMarksChanged, useDayMarksStore } from "../../stores/dayMarks";
import { pickIcsFile } from "../../lib/ical";
import { TableSection } from "./TableSection";
import { SettingsTable, SettingsTableRow } from "./SettingsTable";
import { SegGroup } from "./SegGroup";
import { Badge } from "./Badge";
import { Toggle } from "./Toggle";
import { IconAction } from "./IconAction";
import { PromptDialog } from "../PromptDialog";
import { DayMarkFormModal } from "./DayMarkFormModal";
import { DayMarksImportModal, dayMarksErrorText, fetchIcsText, saveIcsAsDayMarks } from "./DayMarksImportModal";
import { buildDayMarkRows, copyPayload, filterDayMarkRows, type DayMarkFilter, type DayMarkRow } from "./dayMarkRows";
import {
  IconCalendarDays,
  IconCaret,
  IconCopy,
  IconEdit,
  IconEye,
  IconEyeOff,
  IconFileImport,
  IconPlus,
  IconRefresh,
  IconTrash,
} from "../icons";
import type { CalendarMark, CalendarSource } from "../../lib/commands.gen";

/**
 * 설정 > 달력 및 일정 > 공휴일·기념일 표(docs/PLAN-2026-09-19-calendar-schedule.md §5.2, W3·W4).
 *
 * 한 해를 골라 그해의 기본 공휴일(노트북 설정 holiday_region 의 정적 표) · 불러온 캘린더 · 내 기념일을
 * 날짜순 한 표로 본다. 편집권은 출처마다 다르다(§2, D3):
 *   - 내 기념일 — 편집·삭제. 삭제는 묻지 않고 바로 지운 뒤 되돌리기 토스트(같은 값으로 다시 만든다).
 *   - 기본 공휴일·불러온 캘린더 — 날짜별 숨기기 + "내 기념일로 복사"(이름을 바꾸려면 복사본에서).
 * 불러온 캘린더 출처는 표 아래 줄에서 켜기/다시 불러오기/삭제(수백 개가 함께 지워지니 한 번 묻는다).
 *
 * 표 블록(TableSection, 카드 밖 — R1)은 반복 일정 표와 같은 문법. 동작 버튼은 IconAction(아이콘만,
 * aria-label 과 title 이 같은 문자열). 날짜 칸은 앱 언어의 달·일·요일 표기를 따른다.
 * 목록은 노트북마다 따로라 활성 노트북이 바뀌면 스토어가 다시 읽고, 쓰기 뒤에는 강제로 다시 읽는다.
 * 쓰기 커맨드가 전부 http:false 라 브라우저(태블릿)에선 읽기 전용 표만 그린다(list 는 http:true).
 */

/** lib/holidays.ts 정적 표의 마지막 해 — 넘으면 "불러오기로 보충" 한 줄. 표를 늘리면 같이 올린다. */
const BUILTIN_TABLE_LAST_YEAR = 2030;

export function DayMarksSection() {
  const browser = isBrowser();
  const uiLang = useSettingsStore((s) => s.uiLang) || "en";
  const region = useSettingsStore((s) => s.holidayRegion);
  const workspaceId = useSettingsStore((s) => s.activeWorkspaceId);
  const marks = useDayMarksStore((s) => s.marks);
  const sources = useDayMarksStore((s) => s.sources);
  const hides = useDayMarksStore((s) => s.hides);
  const load = useDayMarksStore((s) => s.load);

  const [year, setYear] = useState(() => new Date().getFullYear());
  const [filter, setFilter] = useState<DayMarkFilter>("all");
  /** undefined = 닫힘, null = 새로 추가, 행 = 편집. */
  const [editing, setEditing] = useState<CalendarMark | null | undefined>(undefined);
  const [importOpen, setImportOpen] = useState(false);
  const [pendingSourceDelete, setPendingSourceDelete] = useState<CalendarSource | null>(null);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);

  // 활성 노트북이 바뀌면 그 노트북 목록으로(설정 창이 열린 채 노트북을 바꿔도 옛 목록이 남지 않게, §2.1).
  useEffect(() => {
    listenDayMarksChanged();
    if (workspaceId) void load(workspaceId);
  }, [workspaceId, load]);

  /** 쓰기 뒤 재조회 — 쓰기 전에 출발한 조회를 재사용하지 않는다. */
  const reload = () => {
    if (workspaceId) void load(workspaceId, { force: true });
  };
  const wsArg = workspaceId ? { workspace_id: workspaceId } : {};

  const rows = useMemo(
    () => filterDayMarkRows(buildDayMarkRows(year, region, marks, sources, hides), filter),
    [year, region, marks, sources, hides, filter],
  );
  const countBySource = useMemo(() => {
    const m = new Map<string, number>();
    for (const mk of marks) if (mk.source_id) m.set(mk.source_id, (m.get(mk.source_id) ?? 0) + 1);
    return m;
  }, [marks]);

  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat(uiLang, { month: "short", day: "numeric", weekday: "short", timeZone: "UTC" }),
    [uiLang],
  );
  const dateLabel = (iso: string) => {
    const [y, mo, d] = iso.split("-").map(Number);
    return dateFmt.format(new Date(Date.UTC(y, mo - 1, d)));
  };
  const fetchedLabel = (at: string | null) => {
    if (!at) return null;
    const d = new Date(at);
    return Number.isNaN(d.getTime()) ? at : d.toLocaleDateString(uiLang);
  };

  // 되돌리기 = 같은 값으로 다시 만들기(새 id). 이 표는 날짜순이라 자리가 바뀌지 않는다. 토스트가 떠 있는
  // 사이 노트북을 바꿨어도 지운 노트북에 되살리고, 지금 보고 있는 노트북일 때만 다시 읽는다.
  const restoreMark = async (m: CalendarMark) => {
    try {
      await call("calendar_mark_create", {
        workspace_id: m.workspace_id,
        title: m.title,
        ...(m.year != null ? { year: m.year } : {}),
        month: m.month,
        day: m.day,
        repeat: m.repeat,
        lunar: m.lunar,
        day_off: m.day_off,
        ...(m.color_hue != null ? { color_hue: m.color_hue } : {}),
      });
      if (useSettingsStore.getState().activeWorkspaceId === m.workspace_id) {
        void useDayMarksStore.getState().load(m.workspace_id, { force: true });
      }
    } catch {
      /* call() 이 토스트를 띄웠다 */
    }
  };

  const deleteMark = async (m: CalendarMark) => {
    try {
      await call("calendar_mark_delete", { id: m.id });
      reload();
      showUndoToast(t("undo.deleted_named", { name: m.title }), () => void restoreMark(m));
    } catch {
      /* call() 이 토스트를 띄웠다 */
    }
  };

  const setHidden = async (row: DayMarkRow, hidden: boolean) => {
    if (!row.hideSource) return;
    try {
      await call("calendar_mark_set_hidden", {
        ...wsArg,
        source: row.hideSource,
        iso_day: row.iso,
        hidden,
      });
      reload();
    } catch {
      /* call() 이 토스트를 띄웠다 */
    }
  };

  const copyToMine = async (row: DayMarkRow) => {
    try {
      await call("calendar_mark_create", { ...wsArg, ...copyPayload(row) });
      emitNotice(t("dayMarks.copied", { title: row.title }));
      reload();
    } catch {
      /* call() 이 토스트를 띄웠다 */
    }
  };

  const setSourceEnabled = async (s: CalendarSource, enabled: boolean) => {
    try {
      await call("calendar_source_update", { id: s.id, enabled });
      reload();
    } catch {
      /* call() 이 토스트를 띄웠다 */
    }
  };

  // 다시 불러오기 — URL 출처는 같은 주소를 다시 받고, 파일 출처는 파일을 다시 고른다. 빨간 날 여부는
  // 출처에 따로 없으니 지금 행들의 값을 이어받는다(불러오기 대화상자에서 한 값으로 칠했다).
  const refreshSource = async (s: CalendarSource) => {
    setRefreshingId(s.id);
    try {
      let text: string;
      if (s.url) {
        text = await fetchIcsText(s.url);
      } else {
        const f = await pickIcsFile();
        if (!f) return;
        text = f.text;
      }
      const existing = marks.filter((m) => m.source_id === s.id);
      await saveIcsAsDayMarks({
        text,
        name: s.name,
        url: s.url,
        sourceId: s.id,
        dayOff: existing.length === 0 ? true : existing.some((m) => m.day_off),
        workspaceId,
      });
      reload();
    } catch (e: unknown) {
      // 받기 실패·빈 캘린더는 사용자 말로 알린다. 저장(call()) 실패는 토스트가 이미 떴다.
      const msg = dayMarksErrorText(e);
      if (msg) emitNotice(msg);
    } finally {
      setRefreshingId(null);
    }
  };

  const deleteSource = async (s: CalendarSource) => {
    try {
      await call("calendar_source_delete", { id: s.id });
      reload();
    } catch {
      /* call() 이 토스트를 띄웠다 */
    }
  };

  const sourceLabel = (r: DayMarkRow) =>
    r.kind === "builtin" ? t("dayMarks.source_builtin") : r.kind === "own" ? t("dayMarks.source_own") : r.sourceName;

  const columns = browser
    ? "minmax(96px, 0.9fr) minmax(140px, 1.8fr) minmax(72px, 0.7fr) minmax(80px, 1fr)"
    : "minmax(96px, 0.9fr) minmax(140px, 1.8fr) minmax(72px, 0.7fr) minmax(80px, 1fr) 72px";

  return (
    <TableSection
      anchor="day_marks"
      data-testid="settings-day-marks-section"
      title={t("dayMarks.section")}
      hint={t("dayMarks.section_hint")}
      icon={<IconCalendarDays size={14} strokeWidth={2} />}
      actions={
        browser ? undefined : (
          <div style={{ display: "flex", gap: "var(--space-1)" }}>
            <IconAction
              icon={<IconPlus size={16} strokeWidth={1.8} />}
              label={t("dayMarks.add")}
              data-testid="day-marks-add-btn"
              onClick={() => setEditing(null)}
            />
            <IconAction
              icon={<IconFileImport size={16} strokeWidth={1.8} />}
              label={t("dayMarks.import")}
              data-testid="day-marks-import-btn"
              onClick={() => setImportOpen(true)}
            />
          </div>
        )
      }
    >
      <div style={toolbar}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
          <IconAction
            icon={<IconCaret dir="left" size={14} />}
            label={t("dayMarks.year_prev")}
            size="sm"
            data-testid="day-marks-year-prev"
            onClick={() => setYear((y) => y - 1)}
          />
          <span style={yearText} data-testid="day-marks-year" aria-live="polite">
            {t("dayMarks.year_label", { year })}
          </span>
          <IconAction
            icon={<IconCaret dir="right" size={14} />}
            label={t("dayMarks.year_next")}
            size="sm"
            data-testid="day-marks-year-next"
            onClick={() => setYear((y) => y + 1)}
          />
        </div>
        <SegGroup
          value={filter}
          onChange={setFilter}
          ariaLabel={t("dayMarks.filter_label")}
          options={[
            { value: "all", label: t("dayMarks.filter_all") },
            { value: "own", label: t("dayMarks.filter_own") },
            { value: "holidays", label: t("dayMarks.filter_holidays") },
          ]}
        />
      </div>

      {region !== "none" && year > BUILTIN_TABLE_LAST_YEAR && filter !== "own" && (
        <p style={note} data-testid="day-marks-table-ends">
          {t("dayMarks.table_ends", { year: BUILTIN_TABLE_LAST_YEAR })}
        </p>
      )}

      <SettingsTable
        columns={columns}
        isEmpty={rows.length === 0}
        emptyText={t("dayMarks.empty")}
        bodyTestId="day-marks-list"
        header={
          <>
            <div>{t("dayMarks.col_date")}</div>
            <div>{t("dayMarks.col_title")}</div>
            <div>{t("dayMarks.col_kind")}</div>
            <div>{t("dayMarks.col_source")}</div>
            {!browser && <div style={{ textAlign: "right" }}>{t("dayMarks.col_actions")}</div>}
          </>
        }
      >
        {rows.map((r, idx) => {
          const dim = r.hidden || r.sourceDisabled;
          const cell: CSSProperties = dim ? { opacity: "var(--dim-disabled)" } : {};
          return (
            <SettingsTableRow key={r.key} isLast={idx === rows.length - 1} data-testid={`day-mark-row-${r.key}`}>
              <div style={{ ...cell, display: "flex", flexDirection: "column", minWidth: 0 }}>
                <span style={{ fontVariantNumeric: "tabular-nums" }}>{dateLabel(r.iso)}</span>
                {r.mark?.lunar && (
                  <span style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>
                    {t("dayMarks.lunar_date", { m: r.mark.month, d: r.mark.day })}
                  </span>
                )}
              </div>
              <div style={{ ...cell, display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0 }}>
                <span style={titleText}>
                  {r.ordinal ? t("dayMarks.ordinal", { title: r.title, n: r.ordinal }) : r.title}
                </span>
                {r.hidden && <Badge tone="neutral">{t("dayMarks.badge_hidden")}</Badge>}
                {!r.hidden && r.sourceDisabled && <Badge tone="neutral">{t("dayMarks.badge_disabled")}</Badge>}
              </div>
              <div style={cell}>
                <Badge tone={r.dayOff ? "danger" : "neutral"}>
                  {r.dayOff ? t("dayMarks.kind_day_off") : t("dayMarks.kind_label")}
                </Badge>
              </div>
              <div style={{ ...cell, ...mutedText }}>{sourceLabel(r)}</div>
              {!browser && (
                <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--space-1)" }}>
                  {r.kind === "own" && r.mark ? (
                    <>
                      <IconAction
                        icon={<IconEdit size={14} strokeWidth={1.8} />}
                        label={t("dayMarks.edit")}
                        size="sm"
                        data-testid={`day-mark-edit-${r.key}`}
                        onClick={() => setEditing(r.mark)}
                      />
                      <IconAction
                        icon={<IconTrash size={14} strokeWidth={1.8} />}
                        label={t("common.delete")}
                        size="sm"
                        danger
                        data-testid={`day-mark-delete-${r.key}`}
                        onClick={() => void deleteMark(r.mark!)}
                      />
                    </>
                  ) : (
                    <>
                      <IconAction
                        icon={r.hidden ? <IconEye size={14} strokeWidth={1.8} /> : <IconEyeOff size={14} strokeWidth={1.8} />}
                        label={r.hidden ? t("dayMarks.unhide") : t("dayMarks.hide")}
                        size="sm"
                        aria-pressed={r.hidden}
                        data-testid={`day-mark-hide-${r.key}`}
                        onClick={() => void setHidden(r, !r.hidden)}
                      />
                      <IconAction
                        icon={<IconCopy size={14} strokeWidth={1.8} />}
                        label={t("dayMarks.copy")}
                        size="sm"
                        data-testid={`day-mark-copy-${r.key}`}
                        onClick={() => void copyToMine(r)}
                      />
                    </>
                  )}
                </div>
              )}
            </SettingsTableRow>
          );
        })}
      </SettingsTable>

      {sources.length > 0 && (
        <div style={sourcesBlock} data-testid="day-marks-sources">
          <div style={{ ...mutedText, fontWeight: 600 }}>{t("dayMarks.sources_title")}</div>
          {sources.map((s) => {
            const fetched = fetchedLabel(s.fetched_at);
            return (
              <div key={s.id} style={sourceLine} data-testid={`day-marks-source-${s.id}`}>
                <span style={titleText}>{s.name}</span>
                <span style={mutedText}>
                  {t("dayMarks.source_count", { n: countBySource.get(s.id) ?? 0 })}
                  {fetched ? ` · ${t("dayMarks.source_fetched", { date: fetched })}` : ""}
                </span>
                <span style={{ flex: 1 }} />
                <Toggle
                  checked={s.enabled}
                  disabled={browser}
                  onChange={(next) => void setSourceEnabled(s, next)}
                  aria-label={t("dayMarks.source_enable", { name: s.name })}
                  data-testid={`day-marks-source-enable-${s.id}`}
                />
                {!browser && (
                  <>
                    <IconAction
                      icon={<IconRefresh size={14} strokeWidth={1.8} />}
                      label={t("dayMarks.source_refresh")}
                      size="sm"
                      busy={refreshingId === s.id}
                      disabled={refreshingId === s.id}
                      data-testid={`day-marks-source-refresh-${s.id}`}
                      onClick={() => void refreshSource(s)}
                    />
                    <IconAction
                      icon={<IconTrash size={14} strokeWidth={1.8} />}
                      label={t("dayMarks.source_delete")}
                      size="sm"
                      danger
                      data-testid={`day-marks-source-delete-${s.id}`}
                      onClick={() => setPendingSourceDelete(s)}
                    />
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}

      {editing !== undefined && (
        <DayMarkFormModal
          mark={editing}
          workspaceId={workspaceId}
          defaultYear={year}
          onClose={() => setEditing(undefined)}
          onSaved={reload}
        />
      )}

      {importOpen && (
        <DayMarksImportModal workspaceId={workspaceId} onClose={() => setImportOpen(false)} onSaved={reload} />
      )}

      {pendingSourceDelete && (
        <PromptDialog
          title={t("dayMarks.source_delete_title")}
          description={t("dayMarks.source_delete_confirm", {
            name: pendingSourceDelete.name,
            n: countBySource.get(pendingSourceDelete.id) ?? 0,
          })}
          mode="confirm"
          danger
          confirmLabel={t("common.delete")}
          onCancel={() => setPendingSourceDelete(null)}
          onSubmit={() => {
            const target = pendingSourceDelete;
            setPendingSourceDelete(null);
            void deleteSource(target);
          }}
        />
      )}
    </TableSection>
  );
}

/** 제목 → 도구 줄 → 표: 제목 아래 --space-4, 도구 줄 아래는 표가 제 위쪽 --space-4 를 가진다(TableSection). */
const toolbar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: "var(--space-3)",
  margin: 0,
};

const yearText: CSSProperties = {
  fontSize: "var(--text-sm)",
  fontWeight: 600,
  fontVariantNumeric: "tabular-nums",
  minWidth: "4.5em",
  textAlign: "center",
};

const titleText: CSSProperties = {
  fontWeight: 600,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

const mutedText: CSSProperties = { fontSize: "var(--text-xs)", color: "var(--muted)" };

const note: CSSProperties = { margin: "var(--space-4) 0 0", fontSize: "var(--text-sm)", color: "var(--muted)" };

const sourcesBlock: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  marginTop: "var(--space-5)",
};

const sourceLine: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
  minWidth: 0,
  fontSize: "var(--text-sm)",
};
