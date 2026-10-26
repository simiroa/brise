import { useSettingsStore, type BriefingNotify, type BriefingWhen } from "../../../stores/settings";
import { Toggle } from "../Toggle";
import { t } from "../../../i18n/t";
import { groupCardStyle } from "../shared";
import { SectionHeader } from "../SectionHeader";
import { SettingsRow } from "../SettingsRow";
import { TimeField } from "../TimeField";
import { anchorId } from "../settingsAnchor";
import { Select } from "../../Select";
import { IconClock } from "../../icons";

/**
 * 브리핑을 언제 띄우나 — 지정 시각 / 앱 실행 시 / 수동만(PLAN-2026-09-30 D3). 사용 토글은 페이지 헤더.
 * 브리핑이 꺼져 있으면 행은 전부 `disabled` + 이유 툴팁(SettingsRow 가 조작을 막는다).
 */
export function ScheduleWhenSection() {
  const enabled = useSettingsStore((s) => s.briefingEnabled);
  const when = useSettingsStore((s) => s.briefingWhen);
  const setWhen = useSettingsStore((s) => s.setBriefingWhen);
  const time = useSettingsStore((s) => s.briefingTime);
  const setTime = useSettingsStore((s) => s.setBriefingTime);
  const eveningEnabled = useSettingsStore((s) => s.briefingEveningEnabled);
  const setEveningEnabled = useSettingsStore((s) => s.setBriefingEveningEnabled);
  const eveningTime = useSettingsStore((s) => s.briefingEveningTime);
  const setEveningTime = useSettingsStore((s) => s.setBriefingEveningTime);
  const notify = useSettingsStore((s) => s.briefingNotify);
  const setNotify = useSettingsStore((s) => s.setBriefingNotify);

  const off = !enabled;
  const offReason = off ? t("settings.briefing_off_reason") : undefined;

  return (
    <div className="card" style={groupCardStyle} id={anchorId("schedule")} data-testid="briefing-schedule-card">
      <SectionHeader title={t("settings.briefing_schedule_section")} icon={<IconClock size={14} strokeWidth={2} />} />
      <SettingsRow
        anchor="briefing_when"
        label={t("settings.briefing_when")}
        disabled={off}
        disabledReason={offReason}
        control={
          <Select
            value={when}
            onChange={(v) => void setWhen(v as BriefingWhen)}
            ariaLabel={t("settings.briefing_when")}
            options={[
              { value: "time", label: t("settings.briefing_when_time") },
              { value: "launch", label: t("settings.briefing_when_launch") },
              { value: "manual", label: t("settings.briefing_when_manual") },
            ]}
          />
        }
        data-testid="briefing-when-row"
      />
      {when === "time" && (
        <SettingsRow
          label={t("settings.briefing_time")}
          disabled={off}
          disabledReason={offReason}
          control={
            <TimeField
              value={time}
              onCommit={(v) => void setTime(v)}
              ariaLabel={t("settings.briefing_time")}
              data-testid="briefing-time-input"
            />
          }
        />
      )}
      <SettingsRow
        anchor="briefing_evening"
        label={t("settings.briefing_evening")}
        hint={t("settings.briefing_evening_hint")}
        disabled={off}
        disabledReason={offReason}
        control={
          <Toggle
            checked={eveningEnabled}
            onChange={(v) => void setEveningEnabled(v)}
            aria-label={t("settings.briefing_evening")}
            data-testid="briefing-evening-toggle"
          />
        }
        data-testid="briefing-evening-row"
      />
      {eveningEnabled && (
        <SettingsRow
          label={t("settings.briefing_evening_time")}
          disabled={off}
          disabledReason={offReason}
          control={
            <TimeField
              value={eveningTime}
              onCommit={(v) => void setEveningTime(v)}
              ariaLabel={t("settings.briefing_evening_time")}
              data-testid="briefing-evening-time-input"
            />
          }
        />
      )}
      <SettingsRow
        anchor="briefing_notify"
        label={t("settings.briefing_notify")}
        hint={notify === "window" ? undefined : t("settings.briefing_notify_hint")}
        disabled={off}
        disabledReason={offReason}
        control={
          <Select
            value={notify}
            onChange={(v) => void setNotify(v as BriefingNotify)}
            ariaLabel={t("settings.briefing_notify")}
            options={[
              { value: "window", label: t("settings.briefing_notify_window") },
              { value: "os", label: t("settings.briefing_notify_os") },
              { value: "both", label: t("settings.briefing_notify_both") },
            ]}
          />
        }
        data-testid="briefing-notify-row"
      />
    </div>
  );
}
