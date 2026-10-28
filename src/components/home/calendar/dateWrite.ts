import type { NoteDate } from "../../../lib/commands.gen";
import { call } from "../../../lib/invoke";
import { t } from "../../../i18n/t";
import { useNotesStore } from "../../../stores/notes";
import { bumpNoteQueryVersion } from "../../../lib/noteQuery";
import { showUndoToast } from "../../../lib/undo";
import { addDaysIso } from "../dateFmt";
import {
  rowIsSameDay,
  parseHhmm,
  keepDurationMin,
  formatHhmm,
  clampStoredEndMin,
  DAY_MIN,
  axisDayOffsetMin,
  dragTimes,
  parseIsoDay,
  type ChipDragMode,
} from "../calendarLayout";

/** 날짜 행을 쓴 뒤 두 축을 맞추는 두 줄 — NoteDatesList.syncStores 와 같은 것이다. 쓰기 경로가
 *  둘(수정·제거)이 되면서 한 자리로 모았다. */
export async function syncAfterDateWrite(noteId: string): Promise<void> {
  if (useNotesStore.getState().activeNote?.note.id === noteId) {
    await useNotesStore.getState().reloadActive();
  }
  bumpNoteQueryVersion();
}

/** `note_dates_list` 에서 이 노트의 한 행을 읽는다 — commitDateRow · removeDateRow · D2/D5 의
 *  "판정은 DB 행 기준" 왕복이 전부 공유한다(세 번째 사용처가 생겨 여기로 뽑았다). 실패/없음이면
 *  null — 호출자가 각자의 "아무것도 안 쓴다" 갈래로 처리한다. */
export async function fetchDateRow(noteId: string, dateId: string): Promise<NoteDate | null> {
  try {
    const res = await call<{ dates: NoteDate[] }>("note_dates_list", { note_id: noteId });
    return (res?.dates ?? []).find((d) => d.id === dateId) ?? null;
  } catch {
    return null;
  }
}

/**
 * 일정 행 하나를 고치는 **유일한 길** — 칩 드래그(W3/W5)와 종일 카드 드롭(W7)이 같이 쓴다.
 *
 * **함정 ⓑ: 화면 값을 페이로드에 그대로 실으면 반복의 씨앗이 옮겨간다.** `note_date_update` 는
 * 전체 행 교체인데 `CalendarItem` 의 year/month/day 는 반복 회차(`is_occurrence`)면 그 **회차**의
 * 날짜이고, span 은 월 경계로 클리핑돼 있다. 그대로 쓰면 씨앗 행의 날짜가 통째로 바뀐다.
 * 그래서 `note_dates_list` 로 진짜 행(`date_id` 가 곧 `note_dates.id`)을 읽어 **그 행의 값을 싣고**
 * `patch` 가 돌려준 필드만 갈아끼운다. 왕복 1회 추가는 감수한다. 페이로드 형태는
 * NoteDatesList.commitRelated 와 같다(id 제외 전 필드).
 *
 * 사용자 행동의 실패라 토스트가 필요해 `try { await call } catch` 형태다 — `call()` 에 점을 찍어
 * catch 를 잇는 형태는 check:surface ⓒ 가 거부한다(그 검사는 소스에서 그 문자열 모양을 찾으므로,
 * 여기 주석도 모양을 그대로 적으면 오탐된다 — 실제로 그랬다).
 *
 * false = 아무것도 저장되지 않았다 → 호출자가 낙관적 표시를 되돌린다(CLAUDE.md §9).
 *
 * **W9 ①: 되돌리기도 여기 한 지점에 있다.** 시각을 바꾸는 다섯 경로(칩 이동 · 시작 손잡이 ·
 * 끝 손잡이 · 키보드 ↑/↓ · 종일 카드 드롭)가 전부 이 함수를 지나므로, 토스트를 각 경로에
 * 붙이는 대신 여기서 한 번 띄운다. 되돌릴 값은 **저장 직전에 읽은 그 행**이 이미 갖고 있고,
 * 되돌리기는 새 쓰기 경로를 만들지 않고 이 함수를 한 번 더 지난다(함정 ⓑ 가 그대로 지켜진다).
 * 저장이 실패하면(false) 토스트는 없다 — 되돌릴 것이 없다.
 *
 * `undoLabel` 이 없으면 토스트를 띄우지 않는다. 되돌리기 자신이 그렇게 부른다 — 안 그러면
 * 되돌린 뒤에 "다시 하기" 토스트가 뜨는 무한 왕복이 된다.
 *
 * **W15 — `collectUndo` 를 주면 토스트를 띄우지 않고 "이 행을 직전 값으로 되돌리는 함수"만
 * 넘긴다.** 연동 이동(맞닿은 이웃이 같이 움직이는 것)은 여러 행이 **한 사용자 동작**이라 토스트도
 * 하나여야 한다 — 여러 개면 그중 하나만 눌러서 붙어 있던 것이 도로 떨어져 보인다. 되돌리는 방식
 * 자체는 그대로다(같은 함수를 한 번 더 지나므로 함정 ⓑ 가 유지된다).
 */
export async function commitDateRow(
  noteId: string,
  dateId: string,
  patch: (row: NoteDate) => Partial<NoteDate> | null,
  undoLabel?: string,
  collectUndo?: (revert: () => void) => void,
): Promise<boolean> {
  try {
    const row = await fetchDateRow(noteId, dateId);
    // 행을 못 찾으면 아무것도 쓰지 않는다.
    if (!row) return false;
    const fields = patch(row);
    if (!fields) return false;
    await call<NoteDate>("note_date_update", {
      id: row.id,
      year: row.year,
      month: row.month,
      day: row.day,
      end_year: row.end_year,
      end_month: row.end_month,
      end_day: row.end_day,
      remind: row.remind,
      start_time: row.start_time,
      end_time: row.end_time,
      remind_offset_min: row.remind_offset_min,
      rrule: row.rrule,
      // PLAN-2026-09-18-nl-dates.md D1(V85) — note_date_update 는 전량 교체 계약이라, `patch` 에
      // 없는 필드도 이 행의 현재 값을 그대로 실어야 한다(위 11개 필드와 같은 이유). label 을 빼면
      // 이 행에 달린 라벨이 달력 드래그 한 번에 조용히 NULL 로 지워진다(lib/primaryDate.ts 와
      // 동일 규율).
      label: row.label,
      ...fields,
    });
    await syncAfterDateWrite(noteId);
    if (undoLabel || collectUndo) {
      // 되돌릴 값 = **이번에 쓴 필드들만** 원래 행의 값으로. 전체 행을 되감지 않는 이유는
      // 그 사이 다른 화면이 고친 필드까지 덮어쓰기 때문이다 — 되돌리기는 자기가 한 일만 무른다.
      const before = Object.fromEntries(
        Object.keys(fields).map((k) => [k, (row as unknown as Record<string, unknown>)[k]]),
      ) as Partial<NoteDate>;
      const revert = () => {
        void commitDateRow(noteId, dateId, () => before);
      };
      // **연속 드래그**: 토스트는 쌓이고, 각각은 **자기 직전 상태**로 돌아간다(세 번 옮기면 세
      // 개). 하나만 남기는 쪽은 고르지 않았다 — undo.ts 에 특정 토스트를 지우는 공개 수단이
      // 없고(dismiss 는 지연 커밋 항목 전용), 무엇보다 "마지막 하나만"이면 두 번째 드래그가
      // 첫 번째의 되돌릴 자리를 조용히 삼킨다. 쌓아 두면 위에서부터 차례로 눌러 원래 자리까지
      // 걸어 나올 수 있고, 어느 토스트도 자기가 안 만든 상태로 데려가지 않는다.
      if (collectUndo) collectUndo(revert);
      else if (undoLabel) showUndoToast(undoLabel, revert);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * W15 — 연동 이동으로 딸려 온 **이웃 행** 하나를 델타만큼 민다(길이 유지). 판정은 화면이 아니라
 * 이 행이 한다(함정 ⓑ):
 *  · 하루짜리가 아니면 아무것도 쓰지 않는다 — 여러 날 span 의 `end_time` 은 마지막 날의 시각이라
 *    같이 밀면 남의 날짜를 조용히 바꾼다(끝 손잡이를 안 주는 것과 같은 이유). 화면에서 하루처럼
 *    보여도(월 경계 클리핑) 행이 아니라고 하면 아니다.
 *  · 델타를 얹어 하루를 벗어나면 쓰지 않는다.
 *  · 끝이 없는 행에 끝을 만들어 주지 않는다(`durationMin` 0 이면 end_time 은 그대로).
 * 저장할 끝의 자정 처리는 다른 경로와 같은 clampStoredEndMin 한 규칙이다(I3).
 */
export function shiftRowTimes(row: NoteDate, deltaMin: number): Partial<NoteDate> | null {
  if (!rowIsSameDay(row)) return null;
  const start = parseHhmm(row.start_time);
  if (start === null) return null;
  const durationMin = keepDurationMin(row.start_time, row.end_time, true);
  const next = start + deltaMin;
  if (next < 0 || next > DAY_MIN - 1 || next + durationMin > DAY_MIN) return null;
  return {
    start_time: formatHhmm(next),
    end_time: durationMin > 0 ? formatHhmm(clampStoredEndMin(next + durationMin)) : row.end_time,
  };
}

/**
 * 오너 요청(2026-09-16) — 맞닿은 이음새 리사이즈로 딸려 온 이웃 행의 **한쪽 경계만** 민다(길이가
 * 아니라 그 한쪽 끝을 옮긴다 — shiftRowTimes 는 길이를 유지한 채 통째로 미는 "이동"이라 여기
 * 안 맞는다). 판정은 화면이 아니라 이 행이 한다(함정 ⓑ):
 *  · `side` 가 "end" 인데 끝이 없던 행(`row.end_time === null`)이면 아무것도 쓰지 않는다 —
 *    없던 끝을 지어내지 않는다(shiftRowTimes 의 같은 규칙, 그리고 planLinkedResize 가 이미
 *    hasEnd 로 이 경우를 후보에서 빼지만, 이 함수는 그 가드에만 기대지 않는 마지막 방어선이다).
 *  · `side` 가 "end" 인데 하루짜리가 아니면 아무것도 쓰지 않는다 — 여러 날 span 의 `end_time` 은
 *    마지막 날의 시각이라(§1.3 I3) 그대로 쓰면 남의 날짜를 조용히 바꾼다.
 *  · `side` 가 "start" 는 항상 안전하다 — 축에 그려진 시각 있는 항목은 전부 `start_time` 이
 *    있다(planTimedDay).
 */
export function resizeRowBoundary(
  row: NoteDate,
  side: "start" | "end",
  min: number,
): Partial<NoteDate> | null {
  if (side === "start") return { start_time: formatHhmm(min) };
  if (row.end_time === null || !rowIsSameDay(row)) return null;
  return { end_time: formatHhmm(clampStoredEndMin(min)) };
}

/**
 * 끌거나(mode "move") 손잡이로 늘린(mode "start"/"end") **주 칩 자신**의 새 시각 — 위 두
 * 이웃 함수(shiftRowTimes · resizeRowBoundary)와 같은 자리의 셋째다. 셋 다 "DB 행 + 얼마"를
 * 받아 쓸 필드만 돌려주는 순수 함수이고, 판정은 화면 항목이 아니라 **행**이 한다(함정 ⓑ).
 *
 * 무엇이 고정인지는 `mode` 가 정한다. move 는 **길이를 행에게 묻는다** — 화면 항목의 `end_time`
 * 은 월 클리핑/회차를 거친 값이다. 손잡이 둘은 반대쪽 끝을 행 값 그대로 남긴다.
 *
 * `startMin` 은 move 에서만 값이 있다: 행에서 얻은 길이로 하루 안에 다시 죈 **실제 시작 분**
 * 이라 `next.startMin` 과 다를 수 있고, 그때 호출자가 미리보기를 그 값으로 고쳐 그린다
 * (그 setState 는 여기 들어올 수 없는 비순수라 호출자에 남는다). 손잡이 둘은 null.
 *
 * ponytail: mode "start" 는 `end_time` 이 없는 항목에 끝을 만들어 주지 않는다(없는 끝을
 * 지어내지 않는다). 그래서 저장 직후 한 번, 미리보기가 실제보다 길게 보였다가 재조회로
 * 30분 칩으로 돌아온다. 거슬리면 그때 "끝 없는 항목엔 위 손잡이도 주지 않기"로 올린다.
 */
export function planRowTimes(
  row: NoteDate,
  mode: ChipDragMode,
  next: { startMin: number; endMin: number },
  hourRowH: number,
): { start_time: string | null; end_time: string | null; startMin: number | null } {
  if (mode === "start") {
    return { start_time: formatHhmm(next.startMin), end_time: row.end_time, startMin: null };
  }
  if (mode === "end") {
    // 24:00 은 "00:00" 이 되어 I3 에 걸린다 — 다른 경로와 같은 clampStoredEndMin 한 규칙.
    return { start_time: row.start_time, end_time: formatHhmm(clampStoredEndMin(next.endMin)), startMin: null };
  }
  const durationMin = keepDurationMin(row.start_time, row.end_time, rowIsSameDay(row));
  const start = dragTimes("move", { ...next, durationMin }, 0, hourRowH).startMin;
  return {
    start_time: formatHhmm(start),
    end_time: durationMin > 0 ? formatHhmm(clampStoredEndMin(start + durationMin)) : row.end_time,
    startMin: start,
  };
}

/**
 * 하루짜리 행을 다른 날로 옮기는 날짜 필드 — 익일 구간으로 자정을 넘겨 옮길 때(또는 되돌아올 때) 시각과 함께 쓴다.
 * 종료 날짜 트리플이 시작과 같게 채워져 있던 행은 같이 옮기고, 비어 있던 행은 비운 채 둔다(rowIsSameDay 의 두 모양).
 * **옮길 수 없는 행은 null**(= 아무것도 쓰지 않는다): 여러 날 span 은 시작만 옮기면 기간이 변하고, 반복 행은 날짜가
 * 씨앗이라 옮기면 시리즈 전체가 밀린다. 날짜 정밀도가 day 가 아니어도 null(시각을 가진 행은 항상 day 정밀도지만 방어한다).
 */
export function moveRowToDay(row: NoteDate, iso: string): Partial<NoteDate> | null {
  const to = parseIsoDay(iso);
  if (!to || !rowIsSameDay(row) || row.rrule || row.month === null || row.day === null) return null;
  const hasEnd = row.end_year !== null;
  return {
    year: to.year,
    month: to.month,
    day: to.day,
    end_year: hasEnd ? to.year : null,
    end_month: hasEnd ? to.month : null,
    end_day: hasEnd ? to.day : null,
  };
}

/**
 * W10 ② — 축의 칩이 가리키는 **행**을 없앤다(Delete/Backspace). 지우는 것은 노트가 아니라
 * `note_dates` 한 줄이고, **두 갈래는 NoteDatesList 가 이미 정해 둔 것 그대로**다(그 파일이 SSOT):
 *  · 관련 행(position ≠ 0) → `note_date_remove`
 *  · 대표 행(position === 0) → 지우지 않고 **정밀도만 비운다**(month/day + 종료 트리플).
 *    연도는 DB CHECK 상 비울 수 없다 — NoteDatesList 의 clear-primary 버튼과 같은 페이로드다.
 * 어느 갈래인지는 화면 항목이 아니라 **DB 행**이 말한다(함정 ⓑ) — 반복 회차의 `position` 은
 * 씨앗 행의 것이고, 회차 칩에서 지우면 씨앗 행이 사라진다(NoteDatesList 의 제거와 같은 뜻).
 *
 * 파괴적이므로 되돌리기가 짝이다. commitDateRow 와 같은 Tier 2(showUndoToast) — 이 저장소의
 * 다른 삭제(휴지통)처럼 **이미 커밋된 것을 되돌리는** 모양이다. 지연 커밋(scheduleUndoableDelete)
 * 은 여기 안 맞는다: 이 패널은 행 목록을 자기 상태로 갖지 않아 낙관적으로 감출 수가 없고,
 * 그러면 칩이 5초 동안 그대로 남아 있게 된다.
 */
export async function removeDateRow(noteId: string, dateId: string): Promise<boolean> {
  const label = t("home.cal_date_removed");
  const row = await fetchDateRow(noteId, dateId);
  if (!row) return false;
  try {
    if (row.position === 0) {
      // 대표 비우기는 그냥 이 행의 편집이라 commitDateRow 한 길로 보낸다 — 되돌리기·동기화·
      // 전량 교체 페이로드가 전부 거기 있다. 목록을 한 번 더 읽는 왕복은 감수한다(키보드 한 번).
      return await commitDateRow(
        noteId,
        dateId,
        () => ({ month: null, day: null, end_year: null, end_month: null, end_day: null }),
        label,
      );
    }
    await call("note_date_remove", { id: row.id });
    await syncAfterDateWrite(noteId);
    showUndoToast(label, () => {
      void (async () => {
        try {
          // 되돌리기 = 같은 값으로 행을 다시 만든다(note_date_add 는 정밀도 사다리 전체를 받는다).
          // ponytail: position 은 서버가 맨 뒤로 다시 매긴다 — 관련 날짜의 순서를 되살리려면
          // note_date_reorder 까지 태워야 하는데, 이 화면은 순서를 쓰지 않는다.
          await call("note_date_add", {
            note_id: noteId,
            year: row.year,
            month: row.month,
            day: row.day,
            end_year: row.end_year,
            end_month: row.end_month,
            end_day: row.end_day,
            start_time: row.start_time,
            end_time: row.end_time,
            remind: row.remind,
            remind_offset_min: row.remind_offset_min,
            rrule: row.rrule,
            // 위 commitDateRow 와 같은 이유 — 지운 행의 라벨이 되돌리기로 되살아나지 않으면
            // 사용자가 지운 적 없는 값을 잃는다.
            label: row.label,
          });
          await syncAfterDateWrite(noteId);
        } catch {
          // call() 이 이미 토스트했다 — 되살리기 실패는 여기서 더 할 일이 없다.
        }
      })();
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * W15 ③ — 되돌리기 토스트 문구. 연속 드래그는 토스트가 **쌓이도록** 이미 정책이 돼 있는데(그릴 D4) 문구가 고정 한 줄이라 서로 구분되지
 * 않았다 — 어느 토스트가 어느 변경인지 알 수 없으면 쌓아 둔 의미가 없다. 이제 실제 이전 → 이후 시각이 들어간다.
 * 한쪽이라도 없으면(시각을 처음 얹거나 해제하는 경우) 예전 고정 문구로 폴백한다 — "→ 10:00" 처럼 반쪽만 든 문구는 무엇에서 바뀐 것인지
 * 더 헷갈린다. 축(DayAxis)·종일 스트립(AllDayStrip)·일정 수정 모달(ChipEventModal)이 같은 문구를 쓴다.
 */
export function timeChangeLabel(from: string | null, to: string | null): string {
  return from && to ? t("home.cal_time_changed_at", { from, to }) : t("home.cal_time_changed");
}

/** 한 제스처가 쓸 행 하나의 계산 결과 — `fields` 가 쓸 필드, 나머지는 주 칩만 채운다. */
export type GesturePatch = {
  fields: Partial<NoteDate>;
  /** move 가 행에서 얻은 길이로 하루 안에 다시 죈 **실제 시작 분**(축 분 — 익일 오프셋 포함)이 미리보기와 다르면 그 값. 호출자가 미리보기를 고친다. */
  settledStartMin?: number | null;
  /** 되돌리기 토스트 문구(이전 → 이후). */
  label?: string;
};

/** 한 제스처가 쓸 행 하나. `patch` 는 **DB 행**을 받아 쓸 필드를 돌려주는 순수 함수다(null = 아무것도 쓰지 않는다) — 판정은 화면 항목이 아니라
 *  행이 한다(함정 ⓑ). 순서가 곧 쓰기 순서이고 첫 항목이 주 칩이다(첫 쓰기가 실패하면 이웃은 쓰지 않는다). */
export type GestureWrite = {
  noteId: string;
  dateId: string;
  patch: (row: NoteDate) => GesturePatch | null;
};

/**
 * 시각을 옮기거나(mode "move") 시작·끝을 따로 늘리는(mode "start"/"end") 제스처 하나가 **어느 행에 무엇을 쓰는가**의 순수 계산 —
 * 예전엔 DayAxis.commitTimes 한 함수 안에 상태 갱신과 뒤섞여 있었다. 훅은 이 목록대로 쓰고 롤백만 맡는다.
 *
 * - 주 칩: `planRowTimes`(무엇이 고정인지는 mode). 이동이 자정을 넘으면(익일 구간 ↔ 당일) 시각과 함께 날짜도 `moveRowToDay` 로 옮긴다 —
 *   옮길 수 없는 행(여러 날 span · 반복)은 null 이라 아무것도 쓰지 않는다.
 * - 이웃(`linked`): move 는 각자의 원래 시작과 새 시작의 차이만큼 통째로(`shiftRowTimes`), 리사이즈는 맞닿은 한쪽 경계만(`resizeRowBoundary` —
 *   mode 가 가리키는 손잡이의 **반대편**이 이웃의 닿은 면). 이웃의 자리·행 id 는 `neighbors`(키 → 현재 자리)에서 찾고, 없는 이웃은 건너뛴다.
 * 좌표는 당일 00:00 기준이고 익일 구간은 +24:00 이므로 행에는 **그 날의 분**으로 쓴다.
 */
export function planGestureWrites(args: {
  chip: { noteId: string; dateId: string; startMin: number };
  mode: ChipDragMode;
  next: { startMin: number; endMin: number };
  linked: ReadonlyArray<{ key: string; startMin: number; endMin: number }>;
  neighbors: ReadonlyMap<string, { noteId: string; dateId: string; startMin: number }>;
  day: string | null;
  hourRowH: number;
}): GestureWrite[] {
  const { chip, mode, next, linked, neighbors, day, hourRowH } = args;
  const newOff = axisDayOffsetMin(next.startMin);
  const local = { startMin: next.startMin - newOff, endMin: next.endMin - newOff };
  const targetDay = day && mode === "move" && newOff !== axisDayOffsetMin(chip.startMin) ? addDaysIso(day, newOff ? 1 : 0) : null;
  const writes: GestureWrite[] = [
    {
      noteId: chip.noteId,
      dateId: chip.dateId,
      patch: (row) => {
        const { start_time, end_time, startMin } = planRowTimes(row, mode, local, hourRowH);
        // 날짜가 바뀌는 쓰기는 옮길 수 있는 행만(하루짜리·반복 아님) — 아니면 아무것도 쓰지 않고 되돌린다.
        const datePatch = targetDay ? moveRowToDay(row, targetDay) : {};
        if (!datePatch) return null;
        return {
          fields: { ...datePatch, start_time, end_time },
          settledStartMin: startMin !== null && startMin !== local.startMin ? startMin + newOff : null,
          // 토스트 문구의 이전→이후는 **이 행이 실제로 바꾼 쪽**이다: 끝 손잡이는 끝 시각, 나머지(이동·시작 손잡이)는 시작 시각.
          label: mode === "end" ? timeChangeLabel(row.end_time, end_time) : timeChangeLabel(row.start_time, start_time),
        };
      },
    },
  ];
  for (const l of linked) {
    const target = neighbors.get(l.key);
    if (!target) continue;
    if (mode === "move") {
      const shift = l.startMin - target.startMin; // 밀린 양은 이웃마다 다르다(겹친 만큼만 밀린다)
      writes.push({
        noteId: target.noteId,
        dateId: target.dateId,
        patch: (row) => {
          const fields = shiftRowTimes(row, shift);
          return fields ? { fields } : null;
        },
      });
      continue;
    }
    const side = mode === "end" ? "start" : "end";
    const boundaryMin = (side === "start" ? l.startMin : l.endMin) - axisDayOffsetMin(target.startMin);
    writes.push({
      noteId: target.noteId,
      dateId: target.dateId,
      patch: (row) => {
        const fields = resizeRowBoundary(row, side, boundaryMin);
        return fields ? { fields } : null;
      },
    });
  }
  return writes;
}
