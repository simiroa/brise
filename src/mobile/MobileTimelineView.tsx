import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchStore } from "../stores/search";
import { useSettingsStore } from "../stores/settings";
import { EXPANDED_BOARD_MAX_NOTES, noteQueryCollect, useNoteQueryVersion } from "../lib/noteQuery";
import type { NoteSummary } from "../lib/commands.gen";
import { displayTitle } from "../stores/notes";
import { noteIconComp } from "../lib/noteIcons";
import { formatEventDate } from "../components/titlebar/eventDate";
import { t } from "../i18n/t";
import { IconCaret, IconNote } from "../components/icons";
import {
  flattenTimelineRows,
  timelineNoteDateBadge,
  type TimelineRow,
} from "../components/leftpanel/expanded/timelineRows";
import { MobileYearRangeSlider } from "./MobileYearRangeSlider";
import { preloadIntentProps } from "../lib/lazyPreload";
import { MobileNote } from "../lazySurfaces";

interface MobileTimelineViewProps {
  onOpenNote: (id: string) => void;
}

function timelineHeaderLabel(row: Extract<TimelineRow, { type: "header" }>): string {
  if (row.depth === 0) return String(row.year);
  return row.month === null ? t("search.timeline_month_unknown") : formatEventDate(row.year, row.month, null);
}

/**
 * `timeline` mode — vertical year/month list, mobile mirror of
 * leftpanel/expanded/TimelineExpanded.tsx (workorder W3 §5). Reuses that file's exact query shape
 * (noteQueryCollect at EXPANDED_BOARD_MAX_NOTES, sort year_asc) and its flattenTimelineRows pure
 * module at the same fixed zoomLevel="month" desktop settled on (QA7 — no zoom UI on either side).
 *
 * ponytail: no react-window here (see MobileNoteTree.tsx's own header comment for the same
 * ceiling/upgrade-path reasoning — a resident EXPANDED_BOARD_MAX_NOTES=5000-note year could be a
 * lot of DOM on a phone; `react-window` is already a dependency if a real workload needs it).
 *
 * 상단 = MobileYearRangeSlider — 데스크톱 TimelineFilter 와 같은 연도 범위(setYearRange)를 끌어서
 * 정한다(2026-10-10 오너: "데스크톱처럼 드래그로 범위, 설정된 범위는 위에"). 예전의 연도 칩은
 * 스크롤만 했는데 필터 시트의 MobileYearChips(범위 설정)와 똑같은 알약 모양이라 뜻이 섞였다 — 칩은
 * 없앴고, 스크롤 점프는 라벨 줄 끝의 ▲/▼ 아이콘 버튼(모양부터 다르다)으로만 남겼다.
 *
 * 행 날짜 = 사건 날짜(timelineNoteDateBadge, 데스크톱과 같은 함수·같은 왼쪽 자리). 예전엔 오른쪽에
 * updated_at 을 찍어 "2026.05" 머리글 밑에 "9월 17일"(수정일)이 나왔다.
 */
export function MobileTimelineView({ onOpenNote }: MobileTimelineViewProps) {
  const uiLang = useSettingsStore((s) => s.uiLang);
  const yearFrom = useSearchStore((s) => s.yearFrom);
  const yearTo = useSearchStore((s) => s.yearTo);
  const selectedTags = useSearchStore((s) => s.selectedTags);
  const tagMode = useSearchStore((s) => s.tagMode);
  const regionFilter = useSearchStore((s) => s.regionFilter);
  const statusFilter = useSearchStore((s) => s.statusFilter);
  const dateRange = useSearchStore((s) => s.dateRange);
  const noteQueryVersion = useNoteQueryVersion();

  const [notes, setNotes] = useState<NoteSummary[]>([]);
  // M-6: 조회 중·실패를 "노트 없음"과 구분한다. 조회 중엔 옛 목록을 그대로 두되 흐리게 보인다.
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    noteQueryCollect(
      { yearFrom, yearTo, selectedTags, tagMode, regionFilter, statusFilter, dateRange, sort: "year_asc" as const },
      { maxNotes: EXPANDED_BOARD_MAX_NOTES },
    )
      .then((r) => { if (!cancelled) { setNotes(r.notes); setStatus("ok"); } })
      .catch(() => { if (!cancelled) { setNotes([]); setStatus("error"); } });
    return () => { cancelled = true; };
  }, [yearFrom, yearTo, selectedTags, tagMode, regionFilter, statusFilter, dateRange, noteQueryVersion]);

  const rows: TimelineRow[] = useMemo(() => {
    if (notes.length === 0) return status === "ok" ? [{ type: "empty" }] : [];
    return flattenTimelineRows({ sortedNotes: notes, yearFrom, yearTo, zoomLevel: "month" });
  }, [notes, yearFrom, yearTo, status]);

  const years = useMemo(() => {
    const ys: number[] = [];
    for (const r of rows) {
      if (r.type === "header" && r.depth === 0 && !ys.includes(r.year)) ys.push(r.year);
    }
    return ys;
  }, [rows]);

  // M-23: 기준은 화면에 보이는 연도 머리글이다 — 누를 때 목록 맨 위와 머리글들의 위치를 읽는다.
  const stepYear = useCallback((dir: -1 | 1) => {
    const list = document.querySelector<HTMLElement>('[data-testid="mobile-timeline-view"]');
    if (!list) return;
    const top = list.getBoundingClientRect().top;
    const hdrs = Array.from(list.querySelectorAll<HTMLElement>(".mobile-timeline-year-hdr"));
    const EPS = 4;
    const target =
      dir === 1
        ? hdrs.find((h) => h.getBoundingClientRect().top > top + EPS)
        : [...hdrs].reverse().find((h) => h.getBoundingClientRect().top < top - EPS);
    target?.scrollIntoView({ block: "start" });
  }, []);

  const jump =
    years.length > 1 ? (
      <>
        <button
          type="button"
          className="mobile-icon-btn"
          onClick={() => stepYear(-1)}
          aria-label={t("mobile.timeline_prev_year")}
          title={t("mobile.timeline_prev_year")}
          data-testid="mobile-timeline-jump-prev"
        >
          <IconCaret dir="up" size={16} />
        </button>
        <button
          type="button"
          className="mobile-icon-btn"
          onClick={() => stepYear(1)}
          aria-label={t("mobile.timeline_next_year")}
          title={t("mobile.timeline_next_year")}
          data-testid="mobile-timeline-jump-next"
        >
          <IconCaret dir="down" size={16} />
        </button>
      </>
    ) : null;

  return (
    <>
      <div className="mobile-timeline-nav">
        <MobileYearRangeSlider trailing={jump} />
      </div>

      <div
        className="mobile-list mobile-timeline scroll"
        data-testid="mobile-timeline-view"
        aria-busy={status === "loading"}
        data-loading={status === "loading" ? "true" : undefined}
      >
        {status === "error" && (
          <div className="mobile-empty" role="alert" data-testid="mobile-timeline-error">
            {t("mobile.timeline_load_failed")}
          </div>
        )}
        {status === "loading" && notes.length === 0 && (
          <div className="mobile-empty mobile-empty--hint" role="status" data-testid="mobile-timeline-loading">
            {t("mobile.timeline_loading")}
          </div>
        )}
        {rows.map((row, i) => (
          <TimelineRowView key={i} row={row} uiLang={uiLang} onOpenNote={onOpenNote} />
        ))}
      </div>
    </>
  );
}

function TimelineRowView({
  row,
  uiLang,
  onOpenNote,
}: {
  row: TimelineRow;
  uiLang: string;
  onOpenNote: (id: string) => void;
}) {
  if (row.type === "empty") {
    return <div className="mobile-empty mobile-empty--hint">{t("search.timeline_empty")}</div>;
  }
  if (row.type === "header") {
    if (row.depth === 0) {
      return (
        <div id={`mobile-tl-y-${row.year}`} className="mobile-timeline-year-hdr">
          <span>{timelineHeaderLabel(row)}</span>
          <span className="mobile-tree-row-count">{row.count}</span>
        </div>
      );
    }
    return <div className="mobile-timeline-month-hdr">{timelineHeaderLabel(row)}</div>;
  }
  const n = row.note;
  const badge = timelineNoteDateBadge(n, row.depth, uiLang);
  const Glyph = noteIconComp(n.icon, IconNote);
  return (
    <button type="button" className="mobile-timeline-note" {...preloadIntentProps(MobileNote)} onClick={() => onOpenNote(n.id)}>
      {badge && <span className="mobile-timeline-day">{badge}</span>}
      <Glyph size={15} strokeWidth={1.8} />
      <span className="mobile-tree-row-name">{displayTitle(n.title)}</span>
    </button>
  );
}
