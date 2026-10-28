import { useSettingsStore, type HolidayRegion, type WeekStart } from "../../stores/settings";
import { t } from "../../i18n/t";
import { isBrowser } from "../../lib/env";
import { SettingsRow } from "./SettingsRow";
import { Select } from "../Select";
import { TimelineRoutineSection } from "./TimelineRoutineSection";
import { DayMarksSection } from "./DayMarksSection";
import { IconCalendar } from "../icons";
import { SettingsCard } from "./SettingsCard";

/**
 * 설정 > 달력 및 일정 (id 는 `notifications` 그대로 — 딥링크 호환).
 *
 * 이력: 2026-09-15 1차 R5 "알림 및 일정" 신설 → 2차 R7 "알림" 개명 + R6 달력 카드는 "지역 및 날씨"로 →
 * **2026-09-19 오너 재번복: "달력 및 일정"**(docs/PLAN-2026-09-19-calendar-schedule.md §0). 공휴일이
 * "지역 설정 한 줄"이 아니라 보고·추가·편집하는 목록이 되면서 지역의 속성이 아니라 일정의 재료가 됐다 —
 * 반복 일정(`skip_holidays`)이 이미 그 목록을 읽는다. 다섯 번째로 뒤집기 전에 그 문서를 읽을 것.
 *
 * 블록은 전부 페이지 최상위 형제다(SettingsPanel 본문의 flex gap 이 간격을 맡는다). 컨트롤 묶음은 카드,
 * 표는 카드 밖 표 블록(TableSection — 카드와 같은 SectionHeader, 제목·표 간격 고정, R1). 브리핑
 * 페이지의 습관 표도 같은 처리다(반복 일정 표는 이 페이지에만 있다). 위에서 아래로:
 *   1. 달력 카드 — 주 시작일 · 기본 공휴일(둘 다 노트북 설정).
 *   2. 공휴일·기념일 표 블록 — DayMarksSection. 브라우저에선 읽기 전용.
 *   3. 반복 일정 표 블록 — 커맨드가 전부 http:false 라 브라우저 모드에서는 통째로 숨긴다.
 * 알림 카드는 2026-10-27 일반 페이지(앱 동작 아래)로 이사했다(PLAN-2026-10-27 §1, NotificationsCard).
 */
export function NotificationsSection() {
  const browser = isBrowser();
  const weekStart = useSettingsStore((s) => s.weekStart);
  const setWeekStart = useSettingsStore((s) => s.setWeekStart);
  const holidayRegion = useSettingsStore((s) => s.holidayRegion);
  const setHolidayRegion = useSettingsStore((s) => s.setHolidayRegion);
  const tailHours = useSettingsStore((s) => s.calendarAxisTailHours);
  const setTailHours = useSettingsStore((s) => s.setCalendarAxisTailHours);

  return (
    <>

      {/* ViewSection("지역 및 날씨")에서 옮겨 왔다(2026-09-19). 카드 제목이 곧 "달력"이라 같은 이름의
          SubGroup 을 겹치지 않는다. */}
      <SettingsCard title={t("settings.view_calendar_section")} icon={<IconCalendar size={14} strokeWidth={2} />} testId="settings-calendar-card">
        <SettingsRow
          anchor="week_start"
          label={t("settings.week_start")}
          control={
            <Select
              value={weekStart}
              onChange={(v) => void setWeekStart(v as WeekStart)}
              ariaLabel={t("settings.week_start")}
              options={[
                { value: "sunday", label: t("settings.week_start_sunday") },
                { value: "monday", label: t("settings.week_start_monday") },
              ]}
            />
          }
        />
        <SettingsRow
          anchor="holiday_region"
          label={t("settings.holiday_region")}
          hint={t("settings.holiday_region_hint")}
          control={
            <Select
              value={holidayRegion}
              onChange={(v) => void setHolidayRegion(v as HolidayRegion)}
              ariaLabel={t("settings.holiday_region")}
              options={[
                { value: "none", label: t("settings.holiday_region_none") },
                { value: "kr", label: t("settings.holiday_region_kr") },
                { value: "fr", label: t("settings.holiday_region_fr") },
              ]}
            />
          }
        />
        {/* 시간축 범위는 여기 한 곳에만 둔다(2026-10-28 — 대시보드 달력 카드에서 되돌렸다). 대시보드·사이드바·브리핑 TimeAxis 가 같이 읽는다. */}
        <SettingsRow
          anchor="calendar_axis_tail_hours"
          label={t("settings.calendar_axis_tail")}
          hint={t("settings.calendar_axis_tail_hint")}
          control={
            <Select
              value={String(tailHours)}
              onChange={(v) => void setTailHours(Number(v))}
              ariaLabel={t("settings.calendar_axis_tail")}
              options={[
                { value: "0", label: t("settings.calendar_axis_tail_off") },
                ...[1, 2, 3, 4, 5, 6, 9, 12].map((h) => ({
                  value: String(h),
                  label: t("settings.calendar_axis_tail_until", { h }),
                })),
              ]}
            />
          }
        />
      </SettingsCard>

      <DayMarksSection />

      {!browser && <TimelineRoutineSection />}
    </>
  );
}
