/**
 * note_date_add 페이로드 조립 — 데스크톱 날짜 넛지(components/editor/dateNudge.ts)·폰 전사 후보
 * (mobile/mobileInputFlows.ts)·폰 타이핑 감지(lib/typingNudges.ts) 세 곳이 같은 코드를 쓴다.
 * 정밀도 사다리는 DatesPanel.tsx 의 handleAddRow 와 같다: 부모 정밀도가 있을 때만 하위 필드를 보낸다
 * (day 는 month 가 있을 때만, end_* 는 end_year 가 있을 때만). 타입만 가져온다(런타임 의존 없음).
 */
import type { NoteDateAddInput } from "./commands.gen";
import type { NlDateParseResult } from "./nlDate/types";

export function buildNoteDateAddPayload(parsed: NlDateParseResult): Omit<NoteDateAddInput, "note_id"> {
  const { start, end } = parsed;
  const payload: Omit<NoteDateAddInput, "note_id"> = { year: start.year, remind: true };
  if (start.month != null) {
    payload.month = start.month;
    if (start.day != null) payload.day = start.day;
  }
  if (end.end_year != null) {
    payload.end_year = end.end_year;
    if (end.end_month != null) {
      payload.end_month = end.end_month;
      if (end.end_day != null) payload.end_day = end.end_day;
    }
  }
  if (parsed.startTime) payload.start_time = parsed.startTime;
  if (parsed.endTime) payload.end_time = parsed.endTime;
  if (parsed.rrule) payload.rrule = parsed.rrule;
  if (parsed.title) payload.label = parsed.title;
  return payload;
}
