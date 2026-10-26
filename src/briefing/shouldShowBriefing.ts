/**
 * 브리핑 자동 표시 판정 (PLAN-2026-09-30-briefing D3/W5).
 * 이 함수가 "브리핑이 표시될 때"의 유일한 자리다 — 나중에 표시 시 트리거 액션(PLAN §7)을 얹는다면 여기 결과에만 건다.
 * 날짜·시각은 전부 **로컬** 기준(UTC 집계 함정 회피).
 */

import { toIsoDateLocal } from "../components/home/dateFmt";
import type { BriefingWhen } from "../stores/settings";

export type BriefingTrigger = "launch" | "tick";

export interface BriefingAutoSettings {
  enabled: boolean;
  when: BriefingWhen;
  /** "HH:MM" */
  time: string;
  /** 마지막으로 자동 표시한 로컬일 "YYYY-MM-DD" ("" = 없음) */
  lastShown: string;
  /** 저녁 회고(W10). 생략 = 꺼짐. */
  eveningEnabled?: boolean;
  /** "HH:MM" */
  eveningTime?: string;
  lastShownEvening?: string;
}

export type BriefingKind = "morning" | "evening";

/** 저녁 회고는 지정 시각 + 이 시간 안에 켰을 때만 — 밤늦게 켜서 "오늘 회고"가 뜨는 건 무의미하다. */
export const EVENING_GRACE_MIN = 180;

export const localDayOf = toIsoDateLocal;

/** "HH:MM" → 자정부터의 분. 깨졌으면 null. */
function minutesOf(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
}

/**
 * 저녁 회고 — `when`(아침 정책)과 무관하게 eveningEnabled 가 곧 옵트인이다. 지정 시각 ≤ 지금 < 시각+3h,
 * 하루 1회. 자정은 넘기지 않는다(판정은 로컬일 단위라 23:00 + 3h 는 23:59 까지만 유효 — 다음 날 0시엔 lastShown 이 새 날이라 시각 전).
 */
function shouldShowEvening(now: Date, s: BriefingAutoSettings): boolean {
  if (!s.enabled || !s.eveningEnabled) return false;
  if (s.lastShownEvening === localDayOf(now)) return false;
  const target = minutesOf(s.eveningTime ?? "");
  if (target === null) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return cur >= target && cur < target + EVENING_GRACE_MIN;
}

export function shouldShowBriefing(
  now: Date,
  s: BriefingAutoSettings,
  trigger: BriefingTrigger,
  kind: BriefingKind = "morning",
): boolean {
  if (kind === "evening") return shouldShowEvening(now, s);
  if (!s.enabled || s.when === "manual") return false;
  if (s.lastShown === localDayOf(now)) return false;
  if (s.when === "launch") return trigger === "launch";
  // when === "time": 지정 시각 이후면 tick 이든 launch 든(놓치고 늦게 켠 경우) 하루 1회.
  const target = minutesOf(s.time);
  if (target === null) return false;
  return now.getHours() * 60 + now.getMinutes() >= target;
}
