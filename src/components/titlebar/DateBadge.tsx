import React, { useState, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { t } from "../../i18n/t";
import { HintBadge } from "../settings/HintBadge";
import { formatDateBadgeLabel, type EventEnd } from "./eventDate";
import { DatesPanel } from "./DatesPanel";
import { useDismiss, useMenuPos } from "../../lib/ui";
import { useNoteDates } from "../../lib/noteMeta";
import { IconBell } from "../icons";
import { NoteDatesList } from "../../lazySurfaces";
import { preloadIntentProps } from "../../lib/lazyPreload";

// 노트의 연도가 가질 수 있는 범위 = DB 제약 그대로(notes.sql: CHECK year BETWEEN -9999 AND 9999).
// 검색 스토어의 yearBounds 를 쓰면 안 된다 — 그건 "지금 등록된 노트들이 걸쳐 있는 구간"이라
// 필터 슬라이더용이고, 그걸로 입력을 막으면 코퍼스에 없는 연도를 영영 적을 수 없게 된다.
const YEAR_MIN = -9999;
const YEAR_MAX = 9999;

/* Dashboard §2 popover redesign (docs/DASHBOARD.md, 2026-08-01 owner decision): airline-booking
 * style range calendar replaces the old start `<input type=date>` + end year/month/day number
 * spinners + due-date quickpicks. Click semantics live in dateRangePicker.ts (pure, tested there);
 * this file owns the draft (start/end/phase/view-month) that DateRangeCalendar is controlled by,
 * plus a compact YYYY[.MM[.DD]] fallback text pair for partial precision the grid can't express
 * (a grid cell is always a full day; year-only/year-month notes still need a text path — the
 * fallback subsumes the old double-click-to-edit affordance, so that mode is gone: one route to
 * partial precision, not two).
 *
 * The end triple absorbed the old due_at axis (see dueDate.ts header). This badge never showed a
 * ⏰/red deadline flag (owner: "cramped") even before Dashboard Wave 3 (2026-08-01) retired that
 * whole display model app-wide — dates are neutral record info everywhere now.
 *
 * docs/PLAN-schedule-system.md §7.5 (2026-08-09 오너 결정): 이 컴포넌트가 갖고 있던 "알려줘"
 * (remind) 체크박스는 제거됐다 — 알림 진입점이 제목줄 벨 아이콘 + ReminderModal 로 단일화되면서
 * (§7.1~§7.3), 이 배지는 순수 날짜 컴포넌트로 되돌아간다. remind 는 여전히 board 의 pin/red-dot
 * (board/status.ts::isPinned)을 몰고 있지만, 그 값을 켜고 끄는 UI는 이제 TitleBar 의 벨 버튼이다.
 *
 * 오너 요청(2026-09-07, "관련 날짜도 지역처럼 하나로 묶자"): 옛 RelatedDatesBadge(별도 칩)를
 * 흡수했다 — RegionMetaBadge가 경유지 개수를 대표 지역 칩에 얹는 것과 같은 결. 닫힌 칩은 대표
 * 날짜 요약 뒤에 관련 날짜 개수를 `+N`으로 붙이고(0개면 그대로), 팝오버는 기존 날짜 고르기
 * 아래에 구분선을 두고 NoteDatesList(라벨 편집·삭제·승격)를 그대로 이어 붙인다. noteId가
 * 없는 드래프트 페이지에서는 관련 날짜 개수 조회·섹션 모두 생략 — 기존 DateBadge 동작 그대로.
 *
 * 오너 피드백 후속(2026-09-07, "입력 달력이 두 개가 되어 버리기도 하고... 통일이 필요" →
 * 그리고 이어진 정신 모델 그릴: "달력 설정 → 아래에서 기간 확인·수정 → 등록 버튼 → 목록에
 * 등록 → 첫 항목이 대표로 상단 표시 → 행마다 알림"): 별도의 `<input type="date">`(OS 네이티브
 * 달력)를 열던 옛 NoteDatesList 폼도, 그 다음에 있던 "+ 관련 날짜"(`pickRelatedMode`, 켜고 그리드를
 * 한 번 더 클릭) 원샷 모드도 이제 둘 다 없다 — 오너 모델과 어긋났다("관련 날짜는 하루만 되는
 * 거야?"). 지금은 하나뿐이다: 이 컴포넌트가 대표 날짜 편집용으로 이미 갖고 있던
 * draftStart/draftEnd(그리드 드래그·폴백 텍스트가 채운다, 대표 날짜 실시간 편집은 그대로
 * 살아있다 — onGridChange/commitStartText/commitEndText)를 "등록" 버튼이 그대로 읽어
 * `note_date_add`로 목록에 새 행을 하나 얹는다(handleRegister). 대표 편집 경로를 손대지 않는
 * 채로 등록이 그 위에 얹히는 것 — 대체가 아니라 추가다. 목록(NoteDatesList) 자체는 이제 항상
 * 그려진다(관련 날짜가 0개여도) — 대표 행이 항상 그 목록의 맨 위이기 때문(NoteRegionsList의
 * 대표+경유지 한 목록 관용구).
 *
 * PLAN-2026-09-08-dates-rebuild.md W4 §2 — 표면 하나로: 제목줄 벨 아이콘과 ReminderModal 은
 * 없앴다(TitleBar.tsx). 날짜 칩 팝오버가 유일한 표면이다 — 달력 위 목록에서 **행을 고르면**
 * 달력이 그 행의 기간을 보여주고 끌면 그 행이 바뀐다(selectedId, 기본값은 대표 행 —
 * 옛 "그리드 드래그는 항상 대표를 바꾼다" 동작과 자연히 같다). 행의 벨을 누르면 그 행 아래에
 * 알림 설정이 인라인으로 펼쳐진다(NoteDatesList 내부).
 *
 * PLAN-2026-09-10-calendar-reminders.md D1 — 팝오버 **본체는 DatesPanel.tsx 로 나갔다**. 이
 * 파일에 남은 것은 닫힌 칩(요약 + 관련 날짜 개수 + 벨)과 팝오버 껍데기뿐이다. 아래 문단들은
 * 그 본체의 내력이므로 DatesPanel 을 읽을 때 함께 본다.
 *
 * §A/§E/§F 후속(같은 계획서, 2026-09-08 오너 결정 — "790px는 너무 길다"): 위 문단들이 설명하는
 * 두 폴백 텍스트 칸 + "등록" 버튼(handleRegister)은 이제 없다. 노트 페이지는 목록 헤더의 "+"
 * (handleAddRow)가 그 자리를 대신한다 — 지금 그려진 draftStart/draftEnd 를 그대로 새 행으로 얹고
 * (오늘이 아니라 "지금 화면 위"를 쓰는 이유는 handleAddRow 자체의 주석 참고) 그 행을 곧바로 선택
 * 상태로 만든다. 초안 페이지(noteId 없음)만 최소한의 대체 수단(date-draft-precision, 시작 정밀도
 * 텍스트 한 칸)을 남겼다 — 목록이 없어 "+"도 없고, 캘린더 드래그로는 부분 정밀도를 못 찍기
 * 때문. NoteDatesList 안의 4행 드로어(알림 켜기/시각/반복/알림 시점 + 저장/알림 끄기 버튼)도
 * 칩 한 줄 + 즉시 커밋으로 대체됐다 — NoteDatesList.tsx 자체 주석 참고.
 */
export function DateBadge({
  year,
  month,
  day,
  end_year = null,
  end_month = null,
  end_day = null,
  noteId = null,
  setYear,
  setEventPrecision,
  setEventEnd,
}: {
  year: number | null;
  month: number | null;
  day: number | null;
  end_year?: number | null;
  end_month?: number | null;
  end_day?: number | null;
  /** Present on a real note; null on the draft page — gates the related-dates fetch/section
   * exactly like RegionMetaBadge/RelatedDatesBadge did before the merge. */
  noteId?: string | null;
  setYear: (y: number) => void;
  setEventPrecision: (month: number | null, day: number | null) => void;
  setEventEnd: (end: EventEnd) => void;
}) {
  const [dateAnchor, setDateAnchor] = useState<{ x: number; y: number } | null>(null);
  const [relatedRevision, setRelatedRevision] = useState(0);
  const badgeRef = useRef<HTMLDivElement>(null);
  const { ref: popRef, x: menuX, y: menuY } = useMenuPos(dateAnchor);

  // 닫힌 칩의 +N 용 관련 날짜 — 노트 열기마다 한 번(lib/noteMeta.ts 공유 캐시, 재마운트는 재사용),
  // 팝오버 안 편집 뒤엔 relatedRevision 으로 다시 읽는다. 팝오버의 NoteDatesList 는 자기 조회를 따로 한다.
  // W4b: 목록은 대표(position 0)를 **첫 항목으로 포함**한다(§2) — "관련 날짜"만 남기려 대표를 걷어낸다.
  const allDates = useNoteDates(noteId, relatedRevision);
  const relatedDates = useMemo(() => (noteId ? allDates.filter((d) => d.position !== 0) : []), [noteId, allDates]);

  const clampYear = (y: number) => Math.max(YEAR_MIN, Math.min(YEAR_MAX, y));

  const displayYear = year ?? new Date().getFullYear();

  const openDatePicker = () => {
    const rect = badgeRef.current?.getBoundingClientRect();
    if (rect) setDateAnchor({ x: rect.left, y: rect.bottom });
  };

  const closeDatePicker = () => {
    setDateAnchor(null);
  };

  useDismiss(dateAnchor != null, [badgeRef, popRef], closeDatePicker, {
    onEscape: () => {
      closeDatePicker();
      badgeRef.current?.focus();
    },
  });

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      setYear(clampYear(displayYear - 1));
    } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      setYear(clampYear(displayYear + 1));
    } else if (e.key === "PageDown") {
      e.preventDefault();
      setYear(clampYear(displayYear - 10));
    } else if (e.key === "PageUp") {
      e.preventDefault();
      setYear(clampYear(displayYear + 10));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openDatePicker();
    }
  };

  // Region-badge style: representative summary first, related-date count tacked on as `+N` when
  // there are any (0 stays silent — a bare "+0" must never leak onto the closed chip). Owner
  // feedback (2026-09-07, closed chip redesign): unlike the old flat string, the count now renders
  // at a smaller size (var(--text-2xs), muted) so the representative date/range stays the visual
  // lead and the count reads as secondary — hierarchy by size, not weight (§10: only 400/600 exist
  // as a distinguishable pair). A filled bell shows when any related date has an active reminder.
  const dateSummary = formatDateBadgeLabel(displayYear, month, day, {
    end_year: end_year ?? null,
    end_month: end_month ?? null,
    end_day: end_day ?? null,
  });
  const relatedCount = relatedDates.length;
  const hasActiveRelatedReminder = relatedDates.some((d) => d.remind);

  return (
    <>
      <div
        ref={badgeRef}
        role="button"
        tabIndex={0}
        aria-label={t("editor.year")}
        aria-haspopup="dialog"
        aria-expanded={dateAnchor != null}
        onClick={openDatePicker}
        onKeyDown={onKeyDown}
        // 팝오버 본체(DatesPanel)의 행 목록이 지연 로드다 — 칩에서 미리 받는다.
        {...preloadIntentProps(NoteDatesList)}
        className="tag-btn tb-quiet-chip"
        data-testid="date-badge"
        style={{
          flex: "none",
          boxSizing: "border-box",
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "var(--tb-chip-pt) var(--space-4) 0",
          borderRadius: "var(--radius-sm)",
          color: "var(--text)",
          fontFamily: "var(--font-body)",
          fontSize: "var(--text-xs)",
          fontWeight: 400,
          height: "var(--tb-chip-h)",
          fontVariantNumeric: "tabular-nums",
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "baseline", minWidth: 0, overflow: "hidden" }}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dateSummary}</span>
          {relatedCount > 0 && (
            <span
              data-testid="date-related-count"
              style={{ fontSize: "var(--text-2xs)", color: "var(--muted)", flex: "none" }}
            >
              {` +${relatedCount}`}
            </span>
          )}
        </span>
        {hasActiveRelatedReminder && (
          <IconBell
            data-testid="date-related-remind-icon"
            aria-hidden="true"
            size={10}
            strokeWidth={2}
            style={{ flex: "none", fill: "var(--accent)", color: "var(--accent)" }}
          />
        )}
      </div>
      {dateAnchor &&
        createPortal(
          <div
            ref={popRef}
            className="overlay"
            role="dialog"
            aria-label={t("editor.year_date_popover_label")}
            onMouseDown={(e) => e.stopPropagation()}
            style={{
              position: "fixed",
              left: menuX,
              top: menuY,
              transform: "translateY(var(--space-2))",
              zIndex: "var(--z-dropdown)",
              display: "flex",
              flexDirection: "column",
              gap: "var(--space-3)",
              padding: "var(--space-4)",
              boxShadow: "var(--shadow-lg)",
              // 2026-09-08: 알림 옵션 셋이 한 줄을 나눠 가지므로 240 으로는 값이 잘렸다
              // (오너: "좌우가 부족하면 너비를 좀 늘려도 됨"). 달력 7열의 리듬은 그대로 넉넉해진다.
              width: 296,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ color: "var(--faint)", fontSize: "var(--text-xs)" }}>{t("editor.date_drag_caption")}</span>
              <HintBadge glyph="?" hint={t("editor.year_precision_hint")} />
            </div>
            <DatesPanel
              noteId={noteId}
              seed={{
                year,
                month,
                day,
                end_year: end_year ?? null,
                end_month: end_month ?? null,
                end_day: end_day ?? null,
              }}
              draft={noteId ? undefined : { setYear, setEventPrecision, setEventEnd }}
              onChanged={() => setRelatedRevision((n) => n + 1)}
            />
          </div>,
          document.body,
        )}
    </>
  );
}
