/**
 * docs/PLAN-schedule-system.md §3 RRULE 서브셋 — ReminderModal 이 쓰는 순수 조립/판독 함수.
 *
 * ponytail: §3.3 설계는 백엔드가 파싱한 `NoteSummary.rrule_parts` 를 내려보내 프론트는 파서를
 * 갖지 않게 했지만, 그 필드는 아직 랜딩되지 않았다(models.rs 의 "아직 싣지 않는다" 주석 —
 * repo::schedule 모듈이 자리잡은 뒤로 미뤄짐). 이 파일의 parseRruleForUi 는 그래서 최소한의
 * "되읽기"만 한다 — 우리가 buildRrule 로 조립한 것과 같은 모양의 문자열만 이해하면 되고, 저장 시
 * 진짜 검증 관문은 여전히 repo::schedule::rrule::parse(I5) 다. rrule_parts 가 랜딩되면
 * parseRruleForUi 를 지우고 NoteSummary.rrule_parts 를 직접 쓰는 게 업그레이드 경로.
 */
import { t } from "../../i18n/t";
import { weekdayShortLabels } from "../home/dateFmt";

export type RepeatFreq = "none" | "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

/** §7.3 REPEAT_OPTIONS — was mirrored (not imported) into MobileNoteBadges.tsx to dodge dragging
 *  ReminderModal's React-component tree (ModalShell/Select/settings-shared) into the mobile
 *  bundle; this file has no such baggage, so it's the single source now (A-2). */
export const REPEAT_OPTIONS: { value: RepeatFreq; labelKey: string }[] = [
  { value: "none", labelKey: "editor.repeat_none" },
  { value: "DAILY", labelKey: "editor.repeat_daily" },
  { value: "WEEKLY", labelKey: "editor.repeat_weekly" },
  { value: "MONTHLY", labelKey: "editor.repeat_monthly" },
  { value: "YEARLY", labelKey: "editor.repeat_yearly" },
];

export interface RepeatDraft {
  freq: RepeatFreq;
  /** raw <input type=number> text — 1..999, 빈 값/1 은 조립 시 생략(INTERVAL 생략 = 1). */
  interval: string;
  /** "MO".."SU" — WEEKLY 일 때만 의미 있음. */
  byday: string[];
  /** "YYYY-MM-DD" 또는 "" — <input type=date> 값 그대로, 조립 시 YYYYMMDD 로 압축. */
  until: string;
}

export const EMPTY_REPEAT: RepeatDraft = { freq: "none", interval: "1", byday: [], until: "" };

// §7.7/§6.1 요일 토글 순서 — weekdayShortLabels(uiLang) 기본(weekStart="sunday") 순서와 1:1로
// 맞춘다(home/dateFmt.ts). ponytail: 사용자의 week_start 설정과 무관하게 항상 일요일 시작 —
// RRULE BYDAY 저장 순서엔 영향이 없는 표시 전용 값이라 실익 대비 분기 비용이 안 맞는다.
export const WEEKDAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

/** RepeatDraft → RRULE 원문(§3.1 문법). "안 함" → null. */
export function buildRrule(draft: RepeatDraft): string | null {
  if (draft.freq === "none") return null;
  const parts = [`FREQ=${draft.freq}`];
  const n = Math.round(Number(draft.interval));
  if (Number.isFinite(n) && n > 1 && n <= 999) parts.push(`INTERVAL=${n}`);
  if (draft.freq === "WEEKLY" && draft.byday.length > 0) {
    const ordered = WEEKDAY_CODES.filter((d) => draft.byday.includes(d));
    parts.push(`BYDAY=${ordered.join(",")}`);
  }
  if (draft.until) parts.push(`UNTIL=${draft.until.replace(/-/g, "")}`);
  return parts.join(";");
}

/** RRULE 원문 → RepeatDraft. 모르는 파트/형식은 조용히 무시(검증은 저장 시 서버가 한다). */
export function parseRruleForUi(raw: string | null | undefined): RepeatDraft {
  if (!raw) return EMPTY_REPEAT;
  const out: RepeatDraft = { ...EMPTY_REPEAT };
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq);
    const v = part.slice(eq + 1);
    if (k === "FREQ" && (v === "DAILY" || v === "WEEKLY" || v === "MONTHLY" || v === "YEARLY")) {
      out.freq = v;
    } else if (k === "INTERVAL" && v) {
      out.interval = v;
    } else if (k === "BYDAY" && v) {
      out.byday = v.split(",").filter((d): d is (typeof WEEKDAY_CODES)[number] =>
        (WEEKDAY_CODES as readonly string[]).includes(d),
      );
    } else if (k === "UNTIL" && /^\d{8}$/.test(v)) {
      out.until = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
    }
  }
  return out;
}

/** §7.3 오프셋 프리셋 7종(§9-10 확정) — 자유 입력 없음. */
export const OFFSET_PRESETS: { key: string; minutes: number | null }[] = [
  { key: "exact", minutes: null },
  { key: "5m", minutes: 5 },
  { key: "10m", minutes: 10 },
  { key: "15m", minutes: 15 },
  { key: "30m", minutes: 30 },
  { key: "1h", minutes: 60 },
  { key: "1d", minutes: 1440 },
];

export function offsetKeyFromMinutes(min: number | null | undefined): string {
  return OFFSET_PRESETS.find((p) => p.minutes === (min ?? null))?.key ?? "exact";
}

export function offsetMinutesFromKey(key: string): number | null {
  return OFFSET_PRESETS.find((p) => p.key === key)?.minutes ?? null;
}

/** 라벨을 만들 수 있는 최소 공통 모양 — `note_dates` 행(NoteDate/UnifiedRow)과 달력의
 *  `CalendarItem` 이 둘 다 이걸 만족한다. 날짜 트리플은 일부러 빼둔다: 날짜 표기는
 *  eventDate.ts 가 이미 갖고 있고, 여기는 "일정" 부분만 본다. */
export interface ScheduleLike {
  start_time: string | null;
  end_time: string | null;
  remind: boolean;
  remind_offset_min: number | null;
  rrule: string | null;
}

/** 시각/반복/알림시점 라벨 — NoteDatesList 의 칩 셋과 달력 카드의 요약 줄이 **같은 여기**서
 *  나온다(PLAN-2026-09-10 D5). 칩은 셋을 따로 그리고 요약은 하나로 잇는다. */
export function scheduleLabels(
  row: ScheduleLike,
  uiLang: string,
): { time: string | null; repeat: string | null; offset: string } {
  const repeat = parseRruleForUi(row.rrule);
  const weekdayLabels = weekdayShortLabels(uiLang);
  const repeatLabel =
    repeat.freq === "none"
      ? null
      : t(REPEAT_OPTIONS.find((o) => o.value === repeat.freq)!.labelKey) +
        (repeat.freq === "WEEKLY" && repeat.byday.length > 0
          ? " " +
            WEEKDAY_CODES.filter((c) => repeat.byday.includes(c))
              .map((c) => weekdayLabels[WEEKDAY_CODES.indexOf(c)])
              .join("·")
          : "");
  return {
    time: row.start_time ? `${row.start_time}${row.end_time ? `–${row.end_time}` : ""}` : null,
    repeat: repeatLabel,
    offset: t(`editor.remind_offset_${offsetKeyFromMinutes(row.remind_offset_min)}`),
  };
}

/** 한 줄 요약 `🔔 09:00–10:00 · 10분 전 · 매주 화`(PLAN-2026-09-10 D5). 알림이 꺼져 있으면 벨 없이
 *  시각·반복만 — 알림 시점은 알림이 있어야 뜻이 생기므로 꺼짐/정시(null)면 빠진다.
 *  아무 것도 없으면 **빈 문자열**이다: 호출자가 날짜 표기로 되돌아갈 수 있게(벨만 남은 줄은
 *  카드에서 날짜를 지워버린다). */
export function formatScheduleSummary(row: ScheduleLike, uiLang: string): string {
  const l = scheduleLabels(row, uiLang);
  const parts = [
    l.time,
    row.remind && row.remind_offset_min != null ? l.offset : null,
    l.repeat,
  ].filter((s): s is string => !!s);
  if (parts.length === 0) return "";
  // 벨 아이콘은 붙이지 않는다 — 이 줄을 쓰는 두 표면(달력 카드·시간축 칩)이 모두 RemindBadge 를
  // 이미 그리고 있어 이모지를 더하면 벨이 둘로 보인다. 배지가 벨을, 이 줄이 시각·알림시점·반복을
  // 맡는다. 배지 쪽이 툴팁과 색을 갖고 있고, 벨만 켜지고 시각이 없는 행(= 이 함수가 빈 문자열을
  // 주는 행)에서도 알림이 켜졌다는 사실이 사라지지 않는다.
  return parts.join(" · ");
}
