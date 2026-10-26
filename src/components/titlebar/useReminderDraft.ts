import { useState } from "react";
import {
  buildRrule,
  parseRruleForUi,
  offsetKeyFromMinutes,
  offsetMinutesFromKey,
  type RepeatDraft,
  type RepeatFreq,
} from "./scheduleRrule";

/**
 * PLAN-2026-09-08-dates-rebuild.md W4 — the row this draft edits. Was a `PrimaryScheduleTarget` /
 * `RelatedScheduleTarget` discriminated union (docs/PLAN-2026-09-07-reminder-2tier.md §5.1); §1.1
 * of the rebuild plan made every note_dates row (position 0 or not) carry the same columns —
 * precision ladder, end triple, start/end time, remind, offset, rrule — so the union collapsed to
 * one shape. `id` is always a real `note_dates.id` since PLAN-2026-09-10 D1/D2 retired the
 * synthetic "primary" sentinel — the primary is just the position 0 row.
 */
export interface RowScheduleTarget {
  year: number;
  month: number | null;
  day: number | null;
  end_year: number | null;
  end_month: number | null;
  end_day: number | null;
  remind: boolean;
  start_time: string | null;
  end_time: string | null;
  remind_offset_min: number | null;
  rrule: string | null;
}

// Back-compat aliases — mobile's MobileReminderSheet and the (still primary-only) callers used
// these names; kept so their imports don't need touching for a shape that didn't actually change.
export type ScheduleTarget = RowScheduleTarget;

export interface RowSchedulePatch {
  start_time: string | null;
  end_time: string | null;
  remind_offset_min: number | null;
  rrule: string | null;
}

export type SchedulePatch = RowSchedulePatch;

export interface ReminderDraft {
  remindOn: boolean;
  setRemindOn: (v: boolean) => void;
  startTime: string;
  setStartTime: (v: string) => void;
  endTime: string;
  setEndTime: (v: string) => void;
  repeat: RepeatDraft;
  setRepeat: (updater: (r: RepeatDraft) => RepeatDraft) => void;
  setRepeatFreq: (freq: RepeatFreq) => void;
  toggleByday: (code: string) => void;
  offsetKey: string;
  setOffsetKey: (v: string) => void;
  hasFullPrecision: boolean;
  /** True once the draft differs from `target`'s saved values (remind flag included) — drives the
   *  save button's enabled state (switching rows/closing the drawer discards silently). */
  isDirty: boolean;
  buildPatch: () => RowSchedulePatch;
}

/**
 * docs/PLAN-schedule-system.md §7.3/§7.7 — draft-until-save state shared by the inline row
 * reminder drawer (NoteDatesList) and mobile's MobileReminderSheet.
 *
 * Lazy useState init (reads `target` only on first call) — the caller remounts this hook (a
 * `key={rowId}` on the drawer) whenever the selected row changes, so "starts fresh from the
 * target's latest saved values" also covers "switching rows discards the unsaved draft" for free.
 */
export function useReminderDraft(target: RowScheduleTarget): ReminderDraft {
  const [remindOn, setRemindOn] = useState(target.remind);
  const [startTime, setStartTime] = useState(target.start_time ?? "");
  const [endTime, setEndTime] = useState(target.end_time ?? "");
  const [repeat, setRepeat] = useState(() => parseRruleForUi(target.rrule));
  const [offsetKey, setOffsetKey] = useState(() => offsetKeyFromMinutes(target.remind_offset_min));

  const hasFullPrecision = target.month != null && target.day != null;

  const toggleByday = (code: string) => {
    setRepeat((r) => ({
      ...r,
      byday: r.byday.includes(code) ? r.byday.filter((d) => d !== code) : [...r.byday, code],
    }));
  };

  const setRepeatFreq = (freq: RepeatFreq) => setRepeat((r) => ({ ...r, freq }));

  const buildPatch = (): RowSchedulePatch => {
    const start_time = hasFullPrecision && startTime ? startTime : null;
    const end_time = start_time && endTime ? endTime : null;
    const rrule = hasFullPrecision ? buildRrule(repeat) : null;
    return { start_time, end_time, remind_offset_min: offsetMinutesFromKey(offsetKey), rrule };
  };
  const patch = buildPatch();
  const isDirty =
    remindOn !== target.remind ||
    patch.start_time !== (target.start_time ?? null) ||
    patch.end_time !== (target.end_time ?? null) ||
    patch.remind_offset_min !== (target.remind_offset_min ?? null) ||
    patch.rrule !== (target.rrule ?? null);

  return {
    remindOn,
    setRemindOn,
    startTime,
    setStartTime,
    endTime,
    setEndTime,
    repeat,
    setRepeat,
    setRepeatFreq,
    toggleByday,
    offsetKey,
    setOffsetKey,
    hasFullPrecision,
    isDirty,
    buildPatch,
  };
}
