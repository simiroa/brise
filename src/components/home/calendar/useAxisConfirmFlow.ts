import { useState, useRef, useEffect, useCallback } from "react";
import type { RepeatDraft } from "../../titlebar/scheduleRrule";
import { buildRrule } from "../../titlebar/scheduleRrule";
import {
  fetchDateRow,
  commitDateRow,
  removeDateRow,
  syncAfterDateWrite,
} from "./dateWrite";
import { call } from "../../../lib/invoke";
import { showUndoToast } from "../../../lib/undo";
import { t } from "../../../i18n/t";
import {
  planAllDayDrop,
  clampStoredEndMin,
  MIN_SLOT_MIN,
  parseIsoDay,
  formatHhmm,
  axisEndMinFor,
  mergeTailTimed,
  DAY_MIN,
  type TimedDayPlan,
} from "../calendarLayout";

/**
 * 그릴 2026-09-11 D2·D4·D5 — 확인 다이얼로그 셋의 공용 상태. 세 종류를 각각 state 로 두지
 * 않는다(오케스트레이터 지시) — 한 번에 하나만 뜬다. 어느 것이든 뜨는 **시점에** 축 칩의
 * 설정 메뉴(openChip, TimeAxis 안)는 이미 닫혀 있어야 한다("포포버 위 모달" 금지, GRILL §3) —
 * 그 책임은 이 상태를 세팅하는 TimeAxis 쪽 호출부가 진다(D4/D5 핸들러의 setOpenChip(null)).
 */
export type ConfirmState =
  | {
      kind: "spanDrop";
      key: string;
      noteId: string;
      dateId: string;
      /** 놓은 날(선택된 날, ISO) — ⓑ "이 날에 따로 두기"가 쓴다. */
      day: string;
      /** 행의 진짜 첫날(ISO, DB 기준) — ⓐ 라벨에 쓴다. */
      firstDay: string;
      startMin: number;
      title: string;
    }
  // `day` = 축이 보여주는 날(selectedDay) — 사후 판정(아래 pendingRepeatCheck)이 "그 날을 아직 보고 있나"를 이 값으로 가른다. 칩이 익일 구간에
  // 있어도 같은 값이다(그 칩의 실제 날이 아니다 — 쓰기는 noteId/dateId 로 행을 직접 가리킨다).
  | {
      kind: "repeatApply";
      key: string;
      noteId: string;
      dateId: string;
      day: string;
      draft: RepeatDraft;
      /** 이 칩이 익일 구간에 있다 — 사후 판정이 다음 날 plan 의 도착을 기다린다(없으면 당일 plan). */
      inTail?: boolean;
    }
  | { kind: "deleteRepeat"; key: string; noteId: string; dateId: string }
  | { kind: "deleteEvent"; key: string; noteId: string; dateId: string };

/**
 * 삭제 확인 요청 — 반복 행이면 시리즈 전체(`deleteRepeat`), 아니면 한 행(`deleteEvent`). 갈래는 `item.rrule` 로만 가른다 — 월 경계로 잘리는
 * span_start/span_end 와 달리 화면에서 클리핑되지 않는 값(그 행의 rrule 컬럼을 그대로 옮긴 것)이라 note_dates_list 왕복 없이 문구만 가를 수 있다.
 * TimeChip 의 Delete 키와 일정 수정 모달(DayAxis)의 삭제 단추가 **같은 요청**을 만든다. 실제 갈래(관련 행 지우기 vs 대표 행 정밀도 비우기)는
 * 여전히 removeDateRow 가 DB 행으로 판정한다(함정 ⓑ).
 */
export function confirmForDelete(e: {
  key: string;
  item: { note_id: string; date_id: string; rrule: string | null };
}): Extract<ConfirmState, { kind: "deleteRepeat" | "deleteEvent" }> {
  const payload = { key: e.key, noteId: e.item.note_id, dateId: e.item.date_id };
  return e.item.rrule ? { kind: "deleteRepeat", ...payload } : { kind: "deleteEvent", ...payload };
}

export type DropPreviewState = {
  key: string;
  title: string;
  startMin: number;
  saving: boolean;
};

export type PendingRepeatCheck = {
  key: string;
  noteId: string;
  dateId: string;
  day: string;
  inTail: boolean;
  beforeRrule: string | null;
};

export type UseAxisConfirmFlowOptions = {
  selectedDay?: string | null;
  plan?: TimedDayPlan | null;
  /** 익일 구간(`calendar_axis_tail_hours`)과 다음 날 plan — 반복 적용 사후 판정이 축이 보여주는 **합친 목록**(`mergeTailTimed`)에서 칩을 찾게 한다. */
  tailHours?: number;
  tailPlan?: TimedDayPlan | null;
  setDropPreview?: (
    preview:
      | DropPreviewState
      | null
      | ((cur: DropPreviewState | null) => DropPreviewState | null),
  ) => void;
};

/** "YYYY-MM-DD" → "MM.DD" — D2 확인 다이얼로그의 두 선택지에 놓인 날을 짧게 보여준다.
 *  로케일 표기가 아니라 이 저장소의 다른 짧은 날짜 라벨(예: cal_create_range)과 같은 자릿수
 *  고정 표기다. */
export function mdLabel(iso: string): string {
  return iso.slice(5).replace("-", ".");
}

export function useAxisConfirmFlow(options: UseAxisConfirmFlowOptions = {}) {
  const { selectedDay = null, plan = null, tailHours = 0, tailPlan = null, setDropPreview } = options;
  const tailMinutes = axisEndMinFor(tailHours) - DAY_MIN;

  // ── D2·D4·D5 확인 다이얼로그 — DayDetailPanel 수준 하나. 축(TimeAxis) 안의 반복 적용·Delete
  // 도 이 state 를 통해 여기로 요청한다(같은 파일이라 prop 으로 콜백을 내려 보낸다).
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);

  /** D4 — 반복을 적용한 뒤, plan 이 다시 계산되면(재조회 도착) 그 칩이 아직 오늘에 있는지 사후
   *  판정한다(클라이언트에 rrule 전개가 없어 예측할 수 없다, GRILL §3).
   *
   * **state 가 아니라 ref 다.** 커밋 직후 이 값을 채우는 시점엔 아직 재조회가 안 왔으니 `plan`
   * 은 옛 값 그대로다 — state 로 두면 그 세팅 자체가 이 값을 deps 에 문 이펙트를 즉시 한 번 더
   * 돌려 옛 plan 으로 성급하게 판정해 버린다(실측: byday 를 누르자마자 "바뀌었다" 토스트가 뜨는
   * 오탐). ref 는 쓴다고 재렌더/이펙트를 부르지 않으므로, 이 이펙트는 **plan 이 실제로 바뀔
   * 때만**(재조회가 새 detailNotes 를 내려줄 때) 돌고, 그때 ref 를 읽어 사후 판정한다.
   * day 를 같이 들고 있는 이유는 판정 도중 사용자가 다른 날로 옮기면(무관한 plan 변화) 엉뚱한
   * 날 기준으로 "빠졌다"고 오판하지 않기 위해서다 — 날이 다르면 **판정을 버린다**(ref 를 비운다): 안 비우면 나중에 같은 날로 돌아왔을 때
   * 낡은 판정이 엉뚱한 토스트를 띄우고, 익일 칩처럼 날이 영영 안 맞는 요청은 되돌리기 토스트 없이 ref 에 남았다.
   * 칩 찾기는 당일 plan 만이 아니라 익일 구간을 합친 목록에서 한다(익일 칩의 반복 수정도 같은 판정을 받는다).
   * ponytail: "다른 원인의 같은 날 plan 변화가 이 판정보다 먼저 도착"하는 레이스는 남는다 — 당일 plan 과 익일 plan 이 서로 다른 조회에서 따로
   * 도착하므로 익일 칩은 먼저 온 쪽의 낡은 목록으로 판정될 수 있다(세대 카운터가 정공법이지만 이 폭의 확률상 지금은 미룬다). */
  const pendingRepeatCheckRef = useRef<PendingRepeatCheck | null>(null);

  const lastPlanRef = useRef(plan);
  const lastTailPlanRef = useRef(tailPlan);
  useEffect(() => {
    const planChanged = lastPlanRef.current !== plan;
    const tailPlanChanged = lastTailPlanRef.current !== tailPlan;
    lastPlanRef.current = plan;
    lastTailPlanRef.current = tailPlan;
    const pending = pendingRepeatCheckRef.current;
    if (!pending) return;
    if (pending.day !== selectedDay) {
      pendingRepeatCheckRef.current = null; // 다른 날을 보고 있다 — 판정을 버린다
      return;
    }
    // 그 칩이 속한 쪽(당일/익일) 데이터가 새로 와야 판정한다 — 반대쪽이 먼저 와도 낡은 목록으로 서둘러 판정하지 않는다.
    if (!(pending.inTail ? tailPlanChanged : planChanged)) return;
    pendingRepeatCheckRef.current = null;
    const found = plan ? mergeTailTimed(plan.timed, tailPlan, tailMinutes).some((e) => e.key === pending.key) : false;
    // D4 — 토스트는 **하나만**: "바뀌었다"와 "오늘에서 빠졌다"를 동시에 띄우면 겹친다. 어느 쪽인지
    // 이 사후 판정이 나온 뒤에야 알 수 있으므로, commitDateRow 의 즉시-토스트(undoLabel)를 여기
    // 에서는 쓰지 않고 결과를 본 뒤 이 자리에서 딱 한 번 띄운다 — 되돌리기는 두 문구가 같은 동작
    // (rrule 을 이전 값으로) 이라 공유한다.
    showUndoToast(t(found ? "home.cal_repeat_changed" : "home.cal_repeat_dropped_today"), () => {
      void commitDateRow(pending.noteId, pending.dateId, () => ({ rrule: pending.beforeRrule }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tailMinutes 는 tailHours 의 파생값(아래 설정이 바뀌어도 재판정할 이유가 없다)
  }, [plan, tailPlan, selectedDay]);

  const requestSpanDrop = useCallback(
    (payload: Omit<Extract<ConfirmState, { kind: "spanDrop" }>, "kind">) => {
      setConfirm({ kind: "spanDrop", ...payload });
    },
    [],
  );

  const requestRepeatApply = useCallback(
    (payload: Omit<Extract<ConfirmState, { kind: "repeatApply" }>, "kind">) => {
      setConfirm({ kind: "repeatApply", ...payload });
    },
    [],
  );

  const requestDeleteRepeat = useCallback(
    (payload: Omit<Extract<ConfirmState, { kind: "deleteRepeat" }>, "kind">) => {
      setConfirm({ kind: "deleteRepeat", ...payload });
    },
    [],
  );

  const cancelConfirm = useCallback(() => {
    setConfirm((cur) => {
      if (cur?.kind === "spanDrop") {
        setDropPreview?.(null);
      }
      return null;
    });
  }, [setDropPreview]);

  /** D2 확인 다이얼로그가 닫힌 뒤 실제로 쓰는 자리 — 모달의 onSubmit/onCancel 이 부른다. */
  const resolveSpanDrop = useCallback(
    async (c: Extract<ConfirmState, { kind: "spanDrop" }>, choice: string) => {
      setConfirm(null);
      if (choice === "first") {
        // ⓐ 첫날 시작 시각으로 저장 — planAllDayDrop 의 span 갈래는 애초에 행의 날짜를 그대로
        // 두고 시작 시각만 얹으므로, 놓은 날(selectedDay)을 그대로 넘겨도 결과는 같다(그 갈래가
        // dayIso 를 날짜에 쓰지 않는다 — calendarLayout.ts 참고).
        setDropPreview?.({ key: c.key, title: c.title, startMin: c.startMin, saving: true });
        const ok = await commitDateRow(
          c.noteId,
          c.dateId,
          (row) => planAllDayDrop(row, c.day, c.startMin),
          // W15 ③ — 여기엔 "이전 시각"이 없다(다이얼로그를 거치며 행을 놓쳤고, 그것만을 위해
          // note_dates_list 를 한 번 더 태우지 않는다) → 고정 문구로 폴백.
          t("home.cal_time_changed"),
        );
        if (!ok) setDropPreview?.(null);
        return;
      }
      // ⓑ 이 날에 따로 두기 — note_date_add 로 선택된 날짜의 새 관련 행을 만든다. note_date_add 는
      // 시각 필드를 직접 받으므로(specs/commands/notes.yaml) 한 번으로 끝난다 — commitDateRow 를
      // 다시 탈 필요가 없다.
      // ponytail: 이 경로엔 되돌리기 토스트를 달지 않았다 — 시각을 "바꾸는" 다섯 경로(W9 ①)와
      // 달리 여기는 행을 "새로 만드는" 것이라, 되돌리기가 있다면 "방금 만든 관련 날짜를 지우기"가
      // 된다(성격이 다르다 — 빈 곳 드래그로 노트를 만드는 createDrag 와 같은 판단, 그 주석 참고).
      setDropPreview?.({ key: c.key, title: c.title, startMin: c.startMin, saving: true });
      const dropped = parseIsoDay(c.day);
      if (!dropped) {
        setDropPreview?.(null);
        return;
      }
      try {
        await call("note_date_add", {
          note_id: c.noteId,
          year: dropped.year,
          month: dropped.month,
          day: dropped.day,
          end_year: null,
          end_month: null,
          end_day: null,
          start_time: formatHhmm(c.startMin),
          end_time: formatHhmm(clampStoredEndMin(c.startMin + MIN_SLOT_MIN)),
          remind: false,
          remind_offset_min: null,
          rrule: null,
        });
        await syncAfterDateWrite(c.noteId);
      } catch {
        // call() 이 이미 토스트했다.
      } finally {
        setDropPreview?.(null);
      }
    },
    [setDropPreview],
  );

  /** D4 확인 뒤 실제 적용. */
  const resolveRepeatApply = useCallback(
    async (c: Extract<ConfirmState, { kind: "repeatApply" }>) => {
      setConfirm(null);
      const row = await fetchDateRow(c.noteId, c.dateId);
      const beforeRrule = row?.rrule ?? null;
      // 토스트는 여기서 안 띄운다 — 위 pendingRepeatCheck 이펙트가 사후 판정 뒤 딱 한 번 띄운다.
      const ok = await commitDateRow(c.noteId, c.dateId, () => ({ rrule: buildRrule(c.draft) }));
      if (ok) {
        pendingRepeatCheckRef.current = {
          key: c.key,
          noteId: c.noteId,
          dateId: c.dateId,
          day: c.day,
          inTail: c.inTail === true,
          beforeRrule,
        };
      }
    },
    [],
  );

  /** D5 확인 뒤 실제 삭제 — removeDateRow 한 길 그대로(되돌리기 포함). */
  const resolveDeleteRepeat = useCallback(
    (c: Extract<ConfirmState, { kind: "deleteRepeat" }>) => {
      setConfirm(null);
      void removeDateRow(c.noteId, c.dateId);
    },
    [],
  );

  /** 오너 실기 2026-09-16 — 반복 없는 행의 Delete/Backspace 도 이제 확인을 거친다("삭제할거야?"
   *  한 번). 갈래(관련 행 지우기 vs 대표 행 정밀도 비우기)는 여전히 removeDateRow 가 DB 행으로
   *  판정한다(함정 ⓑ) — 여기는 확인만 얹을 뿐 같은 길이다. */
  const resolveDeleteEvent = useCallback(
    (c: Extract<ConfirmState, { kind: "deleteEvent" }>) => {
      setConfirm(null);
      void removeDateRow(c.noteId, c.dateId);
    },
    [],
  );

  return {
    confirm,
    requestSpanDrop,
    requestRepeatApply,
    requestDeleteRepeat,
    resolveSpanDrop,
    resolveRepeatApply,
    resolveDeleteRepeat,
    resolveDeleteEvent,
    cancelConfirm,
    setConfirm,
    // Aliases
    cancel: cancelConfirm,
    requestConfirm: setConfirm,
  };
}
