/**
 * 월간 일정 탭의 목록 조립 — CalendarExpanded 의 useMemo 본체를 그대로 옮긴 순수 함수
 * (PLAN-2026-09-13-separation-of-concerns 트랙 D1 ③, 동작 변경 0).
 *
 * 입력은 그 달의 `dashboard_calendar` 항목과 트리 캐시(noteIndex), 그리고 검색 스토어의 필터.
 * 출력은 화면이 그대로 그리는 NoteSummary 목록이다 — 컴포넌트 상태를 하나도 안 보므로
 * React 마운트 없이 입력→출력으로 검증된다.
 */
import type { CalendarItem, NoteSummary } from "../../../lib/commands.gen";

export type MonthReminderFilter = {
  selectedTags: string[];
  tagMode: "or" | "and";
  statusFilter: string[];
};

export function buildMonthReminders(
  items: CalendarItem[],
  noteIndex: ReadonlyMap<string, NoteSummary>,
  filter: MonthReminderFilter,
): NoteSummary[] {
  const reminderItems = items.filter((it) => it.remind);
  // Sort by day ascending, then by start_time
  reminderItems.sort((a, b) => {
    const dayA = a.day ?? 99;
    const dayB = b.day ?? 99;
    if (dayA !== dayB) return dayA - dayB;
    const timeA = a.start_time ?? "";
    const timeB = b.start_time ?? "";
    return timeA.localeCompare(timeB);
  });

  const seenIds = new Set<string>();
  let reminders: NoteSummary[] = [];

  for (const item of reminderItems) {
    if (seenIds.has(item.note_id)) continue;
    seenIds.add(item.note_id);
    const cached = noteIndex.get(item.note_id);
    if (cached) {
      reminders.push({
        ...cached,
        day: item.day ?? cached.day,
        month: item.month ?? cached.month,
        start_time: item.start_time ?? cached.start_time,
        remind: true,
      });
    } else {
      reminders.push({
        id: item.note_id,
        folder_id: item.folder_id,
        title: item.title,
        year: item.year,
        month: item.month,
        day: item.day,
        start_time: item.start_time,
        end_time: item.end_time,
        end_year: item.end_year,
        end_month: item.end_month,
        end_day: item.end_day,
        remind: true,
        is_favorite: false,
        exported_at: null,
        has_image: false,
        tag_names: [],
        region: null,
        status: null,
        icon: null,
        lat: null,
        lng: null,
        created_at: "",
        updated_at: "",
      });
    }
  }

  const { selectedTags, tagMode, statusFilter } = filter;
  if (selectedTags.length > 0) {
    reminders = reminders.filter((n) => {
      if (tagMode === "and") {
        return selectedTags.every((t) => n.tag_names.includes(t));
      }
      return selectedTags.some((t) => n.tag_names.includes(t));
    });
  }
  if (statusFilter.length > 0) {
    reminders = reminders.filter((n) => n.status && statusFilter.includes(n.status));
  }
  return reminders;
}
