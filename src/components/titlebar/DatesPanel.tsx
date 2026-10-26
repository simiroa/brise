import React, { useEffect, useState, Suspense } from "react";
import { t } from "../../i18n/t";
import {
  parseEventDateInput,
  isStartAfterEnd,
  type EventDate,
  type EventEnd,
} from "./eventDate";
import { formatFallbackValue, type RangePhase, type PickResult } from "./dateRangePicker";
import { DateRangeCalendar } from "./DateRangeCalendar";
import { shiftMonth } from "../leftpanel/expanded/calendarGrid";
import { call } from "../../lib/invoke";
import { patchDateRow } from "../../lib/primaryDate";
import { bumpNoteQueryVersion } from "../../lib/noteQuery";
import { useNotesStore } from "../../stores/notes";
import type { NoteDate } from "../../lib/commands.gen";
import { IconEraser, IconPlus } from "../icons";
import { useWeatherLocation } from "../home/useWeatherLocation";
import { fetchDailyForecast, type DailyForecast } from "../../lib/weather";
import { NoteDatesList } from "../../lazySurfaces";


// 노트의 연도가 가질 수 있는 범위 = DB 제약 그대로(notes.sql: CHECK year BETWEEN -9999 AND 9999).
const YEAR_MIN = -9999;
const YEAR_MAX = 9999;

const EMPTY_END: EventEnd = { end_year: null, end_month: null, end_day: null };

// 오너 피드백(2026-09-07): 입력 테두리를 걷어내고 값(정렬·색·크기)만 보이게 — .field--seamless.
const fallbackFieldStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: "var(--ctrl-h-sm)",
  fontSize: "var(--text-sm)",
  fontVariantNumeric: "tabular-nums",
  textAlign: "center",
  color: "var(--accent)",
  padding: "var(--space-2) var(--space-3)",
};

/** "YYYY-MM-DD" — DateRangeCalendar 의 관련 날짜 점 표시용 키일 뿐, 커맨드 페이로드가 아니다. */
function isoFromParts(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export type DatesPanelSeed = EventEnd & {
  year: number | null;
  month: number | null;
  day: number | null;
};

/** 초안 페이지(아직 `notes` 행이 없다)의 유일한 쓰기 경로 — 대표 행이 없으니 스토어가 대신 든다. */
export type DatesPanelDraftBridge = {
  setYear: (y: number) => void;
  setEventPrecision: (month: number | null, day: number | null) => void;
  setEventEnd: (end: EventEnd) => void;
};

/**
 * PLAN-2026-09-10-calendar-reminders.md D1 — 날짜 칩 팝오버의 **본체**. 달력 + 행 목록
 * (`NoteDatesList`) + 선택/지우개 배선이 여기 산다. `DateBadge` 는 칩과 팝오버 껍데기만 남고,
 * 달력 생성 팝오버(`CalendarEventDialog`)는 이 패널을 **인라인**으로 품는다(팝오버 안에 또 포털
 * 팝오버를 띄우면 `lib/ui.ts::useDismiss` 가 ref `contains` 판정뿐이라 바깥 클릭으로 오인한다).
 *
 * **입력은 노트 id 하나다.** 대표 행도 W2(D2) 이후 그냥 목록의 position 0 행이므로, 달력 드래그가
 * 어느 행을 고치든 길은 `patchDateRow(noteId, selectedId, …)` **하나**다 — 옛 `"primary"` 별칭도,
 * 활성 노트냐 아니냐를 가르던 스토어 세터 분기도 없다. `seed`/`draft` 는 노트가 **아직 없는**
 * 초안 페이지와 목록이 도착하기 전 첫 프레임을 위한 것뿐이다.
 */
/** `onRowAdded` 콜백이 넘기는 요약 — 방금 "+" 가 만든 행의 날짜·라벨(DateEntryPopover 가 본문에
 *  삽입할 평문 한 줄을 여기서 조립한다). `note_date_add` 응답은 `{id}` 뿐이라 서버 왕복 없이,
 *  이미 화면에 그려진 draftStart/draftEnd/label 그대로를 돌려준다 — handleAddRow 가 성공을 확인한
 *  바로 그 값들이다. */
export interface DatesPanelAddedRow {
  id: string;
  year: number;
  month: number | null;
  day: number | null;
  end_year: number | null;
  end_month: number | null;
  end_day: number | null;
  label: string | null;
  // 2026-09-19 후속 — 처음 §W2 구현이 "+" 폼에 시각을 안 실었던 공백을 메운다(오너의 원 예시
  // "내일 2시부터 10시까지 경복궁방문"가 날짜만 등록되고 시각이 사라지는 문제였다).
  start_time: string | null;
  end_time: string | null;
}

export function DatesPanel({
  noteId,
  seed,
  draft,
  onChanged,
  initialLabel,
  initialStartTime,
  initialEndTime,
  initialSelectedId,
  onRowAdded,
}: {
  noteId: string | null;
  /** 목록이 도착하기 전 달력이 보여줄 날짜(첫 프레임의 깜빡임 방지). 도착하면 행 값이 이긴다. */
  seed?: DatesPanelSeed;
  /** noteId 가 null 일 때만 쓰인다. */
  draft?: DatesPanelDraftBridge;
  /** 이 패널이 행을 바꾼 뒤 — 호출자의 요약(닫힌 칩의 개수·벨)을 갱신하라는 신호. */
  onChanged?: () => void;
  /** PLAN-2026-09-18-nl-dates.md §W2 — "+" 라벨 입력의 초기값(DateEntryPopover 가 파싱된 제목을
   *  미리 채울 때만 쓴다). 생략하면 기존과 같이 빈 문자열. */
  initialLabel?: string;
  /** PLAN-2026-09-18-nl-dates.md §W3a — 본문의 DateMark 를 클릭해 열렸을 때, 그 행을 처음부터
   *  선택된 상태로 보여준다(`selectedId` 의 초기 useState 값). 그 행이 이미 지워졌으면(댕글링)
   *  `onDatesChange` 의 "아직 아무 행도 안 골랐으면 대표를 고른다" 경로를 못 타 대표로 자동
   *  폴백하진 않지만(이미 non-null), 존재하지 않는 id 는 목록의 어느 행과도 매칭되지 않을 뿐이라
   *  화면이 깨지지는 않는다 — 이번 웨이브는 "크래시 안 남"까지만 보장한다(방어 코드 추가 없음). */
  initialSelectedId?: string;
  /** 2026-09-19 후속 — "+" 시각 입력 두 칸의 초기값(nlDate 가 파싱한 시각). 생략하면 빈 문자열
   *  (시각 없는 종일 행). label 과 같은 자리·같은 이유. */
  initialStartTime?: string | null;
  initialEndTime?: string | null;
  /** §W2 — "+" 가 새 행을 성공적으로 만들 때마다 호출(DateEntryPopover 전용, 다른 호출자는 생략).
   *  이 패널은 이미 "완결된 폼"이라 새 UI를 더하지 않는다 — 팝오버가 본문에 넣을 평문 한 줄을
   *  조립하는 데 필요한 값만 이 훅으로 내보낸다. */
  onRowAdded?: (row: DatesPanelAddedRow) => void;
}) {
  const seedYear = seed?.year ?? new Date().getFullYear();
  const [dates, setDates] = useState<NoteDate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? null);
  const [draftStart, setDraftStart] = useState<EventDate>({
    year: seedYear,
    month: seed?.month ?? null,
    day: seed?.day ?? null,
  });
  const [draftEnd, setDraftEnd] = useState<EventEnd>({
    end_year: seed?.end_year ?? null,
    end_month: seed?.end_month ?? null,
    end_day: seed?.end_day ?? null,
  });
  const [phase, setPhase] = useState<RangePhase>("idle");
  const [viewYear, setViewYear] = useState(seedYear);
  const [viewMonth, setViewMonth] = useState(seed?.month ?? new Date().getMonth() + 1);
  // 초안 페이지의 유일한 정밀도 입력(연도만/연·월). 그리드는 언제나 온전한 하루만 찍는다.
  const [startText, setStartText] = useState(
    formatFallbackValue(seedYear, seed?.month ?? null, seed?.day ?? null),
  );
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [registering, setRegistering] = useState(false);
  // PLAN-2026-09-18-nl-dates.md D1(V85) — "+" 로 새 관련 날짜 행을 만들 때 같이 실을 라벨.
  // 대표(position 0)는 이 입력이 만드는 대상이 아니므로(handleAddRow 는 항상 새 관련 행을
  // 만든다, D2) 여기 값은 그대로 note_date_add 의 label 로 간다 — 대표 특례가 필요 없다.
  //
  // PLAN-2026-09-19-date-region-ui.md §P1 — 이 값을 담던 **보이는** 상단 입력 칸(시각 두 칸 +
  // 라벨 한 칸)은 사라졌다(아래 JSX). 하지만 이 state 자체는 그대로 남는다 — nlDate 파서가
  // "/날짜"·"일정으로 등록" 플로우에서 `initialLabel`/`initialStartTime`/`initialEndTime` props
  // 로 채워 넣는 값이고, handleAddRow 의 payload 조립이 여전히 이 세 값을 그대로 싣는다. 입력
  // 칸이 없어졌으니 마운트 이후로는 다시 바뀌지 않는 "한 번 seed된 초기값"일 뿐이다(이름은
  // 과거 그대로 `newRow*` — 재작명은 재량 사항이라 남겨둔다, PLAN §P1 구현 범위 참고).
  const [newRowLabel, setNewRowLabel] = useState(initialLabel ?? "");
  const [newRowStartTime, setNewRowStartTime] = useState(initialStartTime ?? "");
  const [newRowEndTime, setNewRowEndTime] = useState(initialEndTime ?? "");
  // §P1 — "+" 가 방금 만든 행의 id. NoteDatesList 에 그대로 내려가 그 행을 펼친 채로 시작하게
  // 한다(justAddedId prop) — 옛 상단 입력 폼이 하던 "만들자마자 눈으로 확인/수정" 역할을 이제
  // 아코디언이 대신한다.
  const [justAddedId, setJustAddedId] = useState<string | null>(null);
  const [forecast, setForecast] = useState<DailyForecast | null>(null);
  const weatherLoc = useWeatherLocation();

  // Part C: 홈 달력과 **같은** 훅/캐시(useWeatherLocation + lib/weather.ts 1h 캐시). 이 패널은
  // 팝오버가 열려 있는 동안만 마운트되므로 별도의 "열렸나" 게이트가 필요 없다.
  // 표시 토글은 없다(D11, 2026-09-12) — 위치만 있으면 항상 그린다.
  useEffect(() => {
    if (!weatherLoc) {
      setForecast(null);
      return;
    }
    let cancelled = false;
    void fetchDailyForecast(weatherLoc).then((f) => {
      if (!cancelled) setForecast(f);
    });
    return () => {
      cancelled = true;
    };
  }, [weatherLoc]);

  const clampYear = (y: number) => Math.max(YEAR_MIN, Math.min(YEAR_MAX, y));

  /** 행 하나를 달력 초안으로 옮긴다(선택 = 달력이 무엇을 보여주고 무엇을 고치는지). */
  // 구조적 최소형 — 목록의 UnifiedRow 와 DB 의 NoteDate 가 둘 다 만족한다. 둘 중 하나로
  // 좁히면 호출자가 변환하거나 사본을 뒤지게 되고, 그 사본이 바로 이 버그의 원인이었다.
  const seedFromRow = (d: {
    id: string;
    year: number;
    month: number | null;
    day: number | null;
    end_year: number | null;
    end_month: number | null;
    end_day: number | null;
  }) => {
    setSelectedId(d.id);
    setDraftStart({ year: d.year, month: d.month, day: d.day });
    setDraftEnd({ end_year: d.end_year, end_month: d.end_month, end_day: d.end_day });
    setStartText(formatFallbackValue(d.year, d.month, d.day));
    setViewYear(d.year);
    if (d.month != null) setViewMonth(d.month);
    setPhase("idle");
    setRangeError(null);
  };

  /** 목록이 도착할 때마다 불린다. 아직 아무 행도 고르지 않았으면 대표(position 0)를 고른다 —
   *  옛 `"primary"` 센티널이 하던 일을 진짜 id 가 그대로 한다. */
  const onDatesChange = (ds: NoteDate[]) => {
    setDates(ds);
    if (selectedId != null) return;
    const primary = ds.find((d) => d.position === 0);
    if (primary) seedFromRow(primary);
  };

  /** 변경 뒤 두 축(활성 노트 투영 · 달력 note_query)을 맞춘다 — NoteDatesList 가 자기 변경 뒤
   *  하는 것과 같은 두 줄. 달력 드래그는 이 패널이 직접 쓰므로 여기서도 맞춰야 한다. */
  const syncStores = async () => {
    if (noteId && useNotesStore.getState().activeNote?.note.id === noteId) {
      await useNotesStore.getState().reloadActive();
    }
    bumpNoteQueryVersion();
  };

  const afterWrite = async () => {
    setRevision((n) => n + 1);
    onChanged?.();
    await syncStores();
  };

  /** 선택된 행에 날짜 트리플을 얹는다. 대표든 관련이든 `note_date_update` 한 길
   *  (patchDateRow 가 현재 행 위에 얹어 전량 교체한다 — 알림/시각/반복은 그대로 탄다). */
  const commitSelectedRow = (next: { start: EventDate; end: EventEnd }) => {
    if (!noteId) {
      // 초안 페이지: 아직 행이 없으니 스토어가 유일한 쓰기다.
      draft?.setYear(clampYear(next.start.year));
      draft?.setEventPrecision(next.start.month, next.start.day);
      draft?.setEventEnd(next.end);
      return;
    }
    if (!selectedId) return;
    void (async () => {
      try {
        await patchDateRow(noteId, selectedId, {
          year: clampYear(next.start.year),
          month: next.start.month,
          day: next.start.day,
          end_year: next.end.end_year,
          end_month: next.end.end_month,
          end_day: next.end.end_day,
        });
        await afterWrite();
      } catch {
        // call() 이 이미 토스트를 띄웠다(lib/invoke.ts). 화면 위 초안은 다음 성공에 다시 맞춰진다.
      }
    })();
  };

  // 그리드 클릭/드래그: dateRangePicker.ts 가 end >= start 를 이미 보장하므로 바로 커밋한다.
  const onGridChange = (next: PickResult) => {
    setDraftStart(next.start);
    setDraftEnd(next.end);
    setPhase(next.phase);
    setStartText(formatFallbackValue(next.start.year, next.start.month, next.start.day));
    setRangeError(null);
    commitSelectedRow(next);
  };

  // 2026-09-19 후속 — I1(시각 ⇒ 시작일 풀 정밀도)/I2(종료시각 ⇒ 시작시각) 를 서버가 어차피
  // 거부하므로, 여기서도 같은 모양으로 미리 접어 둔다: 월/일이 없으면 시각은 아예 안 보내고,
  // 시작시각이 없으면 종료시각도 안 보낸다. TimeInlineEditor 와 달리 이 폼은 "만들기 전" 초안이라
  // 실패해도 되돌릴 저장값이 없다 — 커밋된 newRowStartTime/EndTime 을 그대로 페이로드에 싣는다.
  const timePayload = (): { start_time?: string; end_time?: string } => {
    if (draftStart.month == null || draftStart.day == null) return {};
    if (!newRowStartTime) return {};
    return newRowEndTime ? { start_time: newRowStartTime, end_time: newRowEndTime } : { start_time: newRowStartTime };
  };

  // "+" — 지금 달력 위에 그려진 것을 그대로 새 행으로 얹고 그 행을 선택한다(§E). D1(V85): 헤더의
  // 라벨 입력에 뭔가 적혀 있으면 같이 싣는다 — 비어 있으면 키 자체를 안 보낸다(note_date_add 의
  // label 은 선택 필드라 생략하면 서버가 그냥 null 로 받는다, notes.yaml).
  const handleAddRow = () => {
    if (!noteId) return;
    setRegistering(true);
    const label = newRowLabel.trim();
    const times = timePayload();
    void (async () => {
      try {
        const res = await call<{ id: string }>("note_date_add", {
          note_id: noteId,
          year: draftStart.year,
          month: draftStart.month,
          day: draftStart.day,
          end_year: draftEnd.end_year,
          end_month: draftEnd.end_month,
          end_day: draftEnd.end_day,
          ...(label ? { label } : {}),
          ...times,
        });
        setSelectedId(res.id);
        setJustAddedId(res.id);
        setNewRowLabel("");
        setNewRowStartTime("");
        setNewRowEndTime("");
        onRowAdded?.({
          id: res.id,
          year: draftStart.year,
          month: draftStart.month,
          day: draftStart.day,
          end_year: draftEnd.end_year,
          end_month: draftEnd.end_month,
          end_day: draftEnd.end_day,
          label: label || null,
          start_time: times.start_time ?? null,
          end_time: times.end_time ?? null,
        });
        await afterWrite();
      } catch {
        // call() 이 이미 토스트 — 낙관적으로 그린 것이 없으니 되돌릴 것도 없다. 타이핑한 라벨은
        // 남겨 둔다(다시 누르면 그대로 재시도할 수 있게).
      } finally {
        setRegistering(false);
      }
    })();
  };

  const onNavMonth = (delta: number) => {
    const { year: ny, month: nm0 } = shiftMonth(viewYear, viewMonth - 1, delta);
    setViewYear(ny);
    setViewMonth(nm0 + 1);
  };

  // 폴백 텍스트(YYYY[.MM[.DD]]) — blur/Enter 에 커밋, 못 읽으면 마지막 값으로 되돌린다.
  const commitStartText = () => {
    const parsed = parseEventDateInput(startText);
    if (!parsed) {
      setStartText(formatFallbackValue(draftStart.year, draftStart.month, draftStart.day));
      return;
    }
    const nextStart: EventDate = { year: clampYear(parsed.year), month: parsed.month, day: parsed.day };
    if (isStartAfterEnd(nextStart, draftEnd)) {
      setRangeError(t("editor.year_range_reversed"));
      return;
    }
    setRangeError(null);
    setDraftStart(nextStart);
    setPhase("picking-end");
    setStartText(formatFallbackValue(nextStart.year, nextStart.month, nextStart.day));
    commitSelectedRow({ start: nextStart, end: draftEnd });
  };

  // 화면 위 초안만 연도만 남기고 되돌린다 — 쓰기는 하지 않는다. 목록의 대표 행 지우개가 DB
  // 쪽을 note_date_update 로 직접 지운다(D2).
  const resetDraftToYear = () => {
    setDraftStart({ year: draftStart.year, month: null, day: null });
    setDraftEnd(EMPTY_END);
    setPhase("idle");
    setStartText(formatFallbackValue(draftStart.year, null, null));
    setRangeError(null);
  };

  // 초안 페이지의 지우개 — 거기엔 목록이 없어 스토어 경로가 유일한 쓰기다.
  // (year 자체는 비울 수 없다: DB CHECK 상 notes.year NOT NULL.)
  const clearAll = () => {
    resetDraftToYear();
    draft?.setEventPrecision(null, null);
    draft?.setEventEnd(EMPTY_END);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      <DateRangeCalendar
        viewYear={viewYear}
        viewMonth={viewMonth}
        onNavMonth={onNavMonth}
        start={draftStart}
        end={draftEnd}
        phase={phase}
        onChange={onGridChange}
        relatedDates={dates
          .filter((d) => d.position !== 0 && d.month != null && d.day != null)
          .map((d) => isoFromParts(d.year, d.month!, d.day!))}
        forecast={forecast}
      />
      {/* 초안 페이지(noteId 없음)만: 목록이 없어 "+"도 없고, 달력만으로는 부분 정밀도를 못 찍는다. */}
      {!noteId && (
        <div
          data-testid="date-draft-precision-fields"
          style={{
            display: "flex",
            gap: "var(--space-2)",
            alignItems: "center",
            borderTop: "1px solid var(--divider)",
            paddingTop: "var(--space-3)",
          }}
        >
          <input
            type="text"
            inputMode="numeric"
            autoFocus
            data-testid="date-draft-precision"
            aria-label={t("editor.year_start_label")}
            placeholder={t("editor.year_start_label")}
            value={startText}
            onChange={(e) => setStartText(e.target.value)}
            onBlur={commitStartText}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitStartText();
              }
            }}
            className="field field--seamless"
            style={fallbackFieldStyle}
          />
          <button
            type="button"
            className="icon-btn icon-btn--sm icon-btn--danger"
            data-testid="date-clear-all-draft"
            title={t("editor.year_clear_date")}
            aria-label={t("editor.year_clear_date")}
            onClick={clearAll}
            style={{ flex: "none" }}
          >
            <IconEraser size={13} strokeWidth={1.8} />
          </button>
        </div>
      )}
      {rangeError && (
        <div data-testid="date-range-error" style={{ fontSize: "var(--text-xs)", color: "var(--danger)" }}>
          {rangeError}
        </div>
      )}
      {noteId && (
        <div
          data-testid="date-related-dates-section"
          style={{ borderTop: "1px solid var(--divider)", paddingTop: "var(--space-3)" }}
        >
          {/* PLAN-2026-09-19-date-region-ui.md §P1 — 상단의 **보이는** 시각 두 칸 + 라벨 입력
              칸은 사라졌다(그 값을 담던 newRowLabel/newRowStartTime/newRowEndTime state 와
              handleAddRow 의 payload 조립은 그대로다 — nlDate 프리필이 여전히 그 값들을 통해
              첫 note_date_add 호출에 실린다). "+"는 지금 달력 위에 그려진 것을 그대로 새 행으로
              얹고, 성공하면 justAddedId 로 그 행을 펼친 아코디언 안에서 이름/시각을 직접
              확인·수정한다(NoteDatesList.tsx RowBody). */}
          <Suspense fallback={<div style={{ minHeight: 22 }} />}>
            <NoteDatesList
              noteId={noteId}
              refreshKey={revision}
              onChanged={onChanged}
              onDatesChange={onDatesChange}
              onClearPrimary={resetDraftToYear}
              selectedId={selectedId}
              // 행을 그대로 받는다 — 예전에는 id 로 `dates`(이 패널의 사본)를 뒤졌는데, 그
              // 사본은 목록이 먼저 렌더된 뒤 onDatesChange 로 채워져서 그 틈에 누른 클릭이
              // 조용히 무시됐다(달력이 안 움직임).
              onSelect={seedFromRow}
              justAddedId={justAddedId}
            />
          </Suspense>
          <div style={{ display: "flex", marginTop: "var(--space-2xs)" }}>
            <button
              type="button"
              className="tag-btn"
              data-testid="date-add-row"
              title={t("note.register_date")}
              aria-label={t("note.register_date")}
              disabled={registering}
              onClick={handleAddRow}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "var(--space-1)",
                height: "var(--ctrl-h-sm)",
                fontSize: "var(--text-xs)",
                color: "var(--muted)",
              }}
            >
              <IconPlus size={12} strokeWidth={2} />
              {t("note.register_date")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
