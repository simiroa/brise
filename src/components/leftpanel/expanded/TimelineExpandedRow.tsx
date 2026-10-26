import React from "react";
import type { RowComponentProps } from "react-window";
import { t } from "../../../i18n/t";
import { displayTitle } from "../../../stores/notes";
import {
  getTimelineHeaderKey,
  timelineNoteDateBadge,
  type TimelineHeaderRow,
  type TimelineRow,
} from "./timelineRows";
import { splitByQuery, HighlightedText } from "../notetree/highlight";
import { formatEventDate } from "../../titlebar/eventDate";
import { NoteIcon, NoteIconControl } from "../NoteIconControl";
import { startNoteDrag } from "../../../lib/noteDrag";
import { useSettingsStore } from "../../../stores/settings";

/** §2.3: depth 1/2 headers show the full dotted path ("1592.07", "1592.07.13") rather than just
 * the incremental part — in a virtualized list the ancestor (year/month) header can scroll out of
 * view, and a lone "13" with no visible year/month would be unreadable. Unknown buckets get
 * translated text instead of a fabricated path. */
function headerLabel(h: TimelineHeaderRow): string {
  if (h.depth === 0) return String(h.year);
  if (h.depth === 1) {
    return h.month === null ? t("search.timeline_month_unknown") : formatEventDate(h.year, h.month, null);
  }
  return h.day === null ? t("search.timeline_day_unknown") : formatEventDate(h.year, h.month!, h.day);
}

export interface TimelineExpandedRowProps {
  rows: TimelineRow[];
  activeId: string | null;
  query?: string;
  onSelectNote: (id: string) => void;
  onOpenCtx?: (id: string, x: number, y: number) => void;
  onHeaderContextMenu?: (year: number, month: number | null, day: number | null, x: number, y: number) => void;
  onToggleCollapse?: (key: string) => void;
  loadTree?: () => Promise<void>;
  selectNote?: (id: string) => Promise<void>;
}

/* ── Timeline expanded view: 개별 행 렌더링 (React.memo 적용) ── */
function TimelineExpandedRowImpl({
  index,
  style,
  rows,
  activeId,
  query,
  onSelectNote,
  onOpenCtx,
  onHeaderContextMenu,
  onToggleCollapse,
  loadTree,
  selectNote,
}: RowComponentProps<TimelineExpandedRowProps>): React.ReactElement | null {
  // 훅은 조기 반환 위에(CLAUDE.md 함정 1).
  const uiLang = useSettingsStore((s) => s.uiLang);
  const row = rows[index];
  if (!row) return null;

  if (row.type === "empty") {
    return (
      <div
        style={{
          ...style,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "var(--space-8) var(--space-6)",
          color: "var(--faint)",
          fontSize: "var(--text-sm)",
          textAlign: "center",
        }}
      >
        {t("search.timeline_empty")}
      </div>
    );
  }

  if (row.type === "header") {
    const key = getTimelineHeaderKey(row.depth, row.year, row.month, row.day);
    const isYear = row.depth === 0;
    const isMonth = row.depth === 1;
    const isOpen = !row.collapsed;

    return (
      <div style={{ ...style, display: "flex", alignItems: "stretch" }}>
        <button
          type="button"
          className="treerow menu-row menu-item"
          onClick={() => onToggleCollapse?.(key)}
          onContextMenu={(e) => {
            e.preventDefault();
            onHeaderContextMenu?.(row.year, row.month, row.day, e.clientX, e.clientY);
          }}
          style={{
            display: "flex",
            alignItems: "center",
            width: "100%",
            height: "100%",
            position: "relative",
            // type-scale-exempt: 연/월/일 계층 트리 인덴트 오프셋
            padding: `0 var(--sidebar-pad) 0 ${isYear ? 26 : isMonth ? 40 : 54}px`,
            border: "none",
            background: "transparent",
            cursor: "pointer",
            textAlign: "left",
            borderRadius: "var(--radius-sm)",
            animation: "fade var(--dur-med) ease-out",
          }}
        >
          {/* 연도 헤더 (depth 0): 메인 spine(중심 16px) 위의 앵커 dot (열림=채운 액센트, 닫힘=테두리) */}
          {isYear && (
            <div
              aria-hidden
              style={{
                position: "absolute",
                left: 11,
                top: "50%",
                transform: "translateY(-50%)",
                width: 10,
                height: 10,
                boxSizing: "border-box",
                borderRadius: "50%",
                background: isOpen ? "var(--accent)" : "var(--surface-base)",
                border: isOpen ? "none" : "2px solid var(--muted)",
                boxShadow: isOpen ? "0 0 0 2px var(--surface-base)" : "none",
                transition: "background var(--dur-med) ease, border var(--dur-med) ease",
                zIndex: 2,
              }}
            />
          )}

          {/* 월 헤더 (depth 1): 메인 spine 에서 뻗어나오는 브랜치 가로선 & 월 dot */}
          {isMonth && (
            <>
              <div
                aria-hidden
                style={{
                  position: "absolute",
                  left: 16,
                  width: 11,
                  top: "50%",
                  height: 2,
                  transform: "translateY(-50%)",
                  background: "var(--line)",
                  opacity: 0.7,
                  zIndex: 1,
                }}
              />
              <div
                aria-hidden
                style={{
                  position: "absolute",
                  left: 26,
                  top: "50%",
                  transform: "translateY(-50%)",
                  width: 8,
                  height: 8,
                  boxSizing: "border-box",
                  borderRadius: "50%",
                  background: isOpen ? "var(--muted)" : "var(--surface-base)",
                  border: isOpen ? "none" : "2px solid var(--faint)",
                  boxShadow: isOpen ? "0 0 0 2px var(--surface-base)" : "none",
                  transition: "background var(--dur-med) ease, border var(--dur-med) ease",
                  zIndex: 2,
                }}
              />
              {isOpen && (
                <div
                  aria-hidden
                  style={{
                    position: "absolute",
                    left: 29,
                    top: "50%",
                    bottom: -1,
                    width: 2,
                    background: "var(--line)",
                    opacity: 0.5,
                    zIndex: 1,
                  }}
                />
              )}
            </>
          )}

          {/* 헤더 라벨 */}
          <span
            style={{
              fontFamily: isYear ? "var(--font-heading)" : "inherit",
              fontWeight: 600,
              fontSize: isYear ? "var(--text-md)" : "var(--text-sm)",
              color: isYear
                ? isOpen
                  ? "var(--accent)"
                  : "var(--muted)"
                : isOpen
                  ? "var(--text)"
                  : "var(--muted)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              transition: "color var(--dur-med) ease",
            }}
          >
            {headerLabel(row)}
          </span>

          {/* 노트 개수 배지 (우측) */}
          <span
            style={{
              marginLeft: "auto",
              flexShrink: 0,
              fontSize: isYear ? "var(--text-xs)" : "var(--text-2xs)",
              fontWeight: 600,
              color: isOpen ? "var(--faint)" : "var(--muted)",
              background: "var(--surface-raised-strong)",
              padding: isYear ? "0 var(--space-2)" : "0 var(--space-1)",
              borderRadius: "var(--radius-pill)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {row.count}
          </span>
        </button>
      </div>
    );
  }

  // row.type === "note"
  const n = row.note;
  const isSelected = n.id === activeId;
  const titleText = displayTitle(n.title);
  const titleSegments = splitByQuery(titleText, query ?? "");

  const isDepth1 = row.depth === 1;
  const isDepth0 = row.depth === 0;
  const notePaddingLeft = isDepth0 ? 24 : 40;

  // 일자 라벨 (타임라인 고유의 시간 정보 복원) — 폰과 같은 순수 함수(timelineRows.ts).
  const dateBadgeText = timelineNoteDateBadge(n, row.depth, uiLang);

  return (
    <div style={{ ...style, display: "flex", alignItems: "stretch" }}>
      <button
        type="button"
        className="treerow menu-row menu-item"
        data-selected={isSelected}
        data-note-id={n.id}
        onPointerDown={(e) => startNoteDrag(e, n.id, titleText)}
        onClick={() => onSelectNote(n.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          if (onOpenCtx) onOpenCtx(n.id, e.clientX, e.clientY);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          width: "100%",
          height: "100%",
          position: "relative",
          padding: `0 var(--sidebar-pad) 0 ${notePaddingLeft}px`,
          boxShadow: isSelected ? "inset 2px 0 0 var(--accent)" : undefined,
          background: isSelected ? "var(--sel)" : undefined,
          border: "none",
          cursor: "pointer",
          textAlign: "left",
          borderRadius: "var(--radius-sm)",
        }}
      >
        {/* 월 그룹 하위 노트: 월 서브라인(수직) 및 가로 브랜치 tick */}
        {isDepth1 && (
          <>
            <div
              aria-hidden
              style={{
                position: "absolute",
                left: 29,
                top: -1,
                bottom: -1,
                width: 2,
                background: "var(--line)",
                opacity: 0.5,
                zIndex: 1,
              }}
            />
            <div
              aria-hidden
              style={{
                position: "absolute",
                left: 29,
                width: 8,
                top: "50%",
                height: 2,
                transform: "translateY(-50%)",
                background: "var(--line)",
                opacity: 0.5,
                zIndex: 1,
              }}
            />
          </>
        )}

        {/* 연도 직속 노트: 메인 spine 에서 나오는 가로 tick */}
        {isDepth0 && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              left: 16,
              width: 8,
              top: "50%",
              height: 2,
              transform: "translateY(-50%)",
              background: "var(--line)",
              opacity: 0.5,
              zIndex: 1,
            }}
          />
        )}

        {/* 일자(Day) 배지: [15일] 📄 김민준 형태 */}
        {dateBadgeText && (
          <span
            style={{
              fontSize: "var(--text-2xs)",
              fontWeight: 600,
              color: "var(--muted)",
              background: "var(--surface-raised-strong)",
              padding: "0 var(--space-1)",
              borderRadius: "var(--radius-xs)",
              fontVariantNumeric: "tabular-nums",
              whiteSpace: "nowrap",
              flexShrink: 0,
              marginRight: "var(--space-2)",
            }}
          >
            {dateBadgeText}
          </span>
        )}

        {/* 인터랙티브 노트 아이콘 (노트 트리와 동일하게 클릭/롱프레스로 수정 가능) */}
        {loadTree && selectNote ? (
          <NoteIconControl
            noteId={n.id}
            icon={n.icon}
            size={15}
            loadTree={loadTree}
            selectNote={selectNote}
            activeNoteId={activeId}
          />
        ) : (
          <NoteIcon icon={n.icon} size={15} />
        )}

        {/* 노트 제목: 트리뷰와 동일한 fontSize: var(--text-md) (13px), marginLeft: 0px */}
        <span
          style={{
            fontSize: "var(--text-md)",
            fontWeight: 400,
            flex: 1,
            minWidth: 0,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            color: isSelected ? "var(--accent)" : "var(--text)",
            marginLeft: 0,
          }}
        >
          <HighlightedText segments={titleSegments} />
        </span>
      </button>
    </div>
  );
}

export const TimelineExpandedRow = React.memo(
  TimelineExpandedRowImpl
) as unknown as (props: RowComponentProps<TimelineExpandedRowProps>) => React.ReactElement | null;

