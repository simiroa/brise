import { useSettingsStore } from "../../stores/settings";
import { t } from "../../i18n/t";
import { isBrowser } from "../../lib/env";
import { SettingsRow } from "./SettingsRow";
import { Toggle } from "./Toggle";
import { TimeField } from "./TimeField";
import { IconBell } from "../icons";
import { SettingsCard } from "./SettingsCard";

/**
 * 일반 > 앱 동작 아래 알림 카드(PLAN-2026-10-27 §1). 예전엔 "달력 및 일정"(NotificationsSection) 맨 아래에 있었다 —
 * 알림은 한 곳(일반)에만 둔다. testId·앵커는 그대로 유지한다(검색 색인은 page 만 general 로).
 * 시각 칸은 TimeField(포커스 이탈·Enter 에서 한 번 저장).
 */
export function NotificationsCard() {
  const browser = isBrowser();
  const closeToTray = useSettingsStore((s) => s.closeToTray);
  const notificationsEnabled = useSettingsStore((s) => s.notificationsEnabled);
  const setNotificationsEnabled = useSettingsStore((s) => s.setNotificationsEnabled);
  const reminderAllDayAt = useSettingsStore((s) => s.reminderAllDayAt);
  const setReminderAllDayAt = useSettingsStore((s) => s.setReminderAllDayAt);

  return (
    <SettingsCard title={t("settings.notifications_group")} icon={<IconBell size={14} strokeWidth={2} />} testId="settings-notifications-card">
      <SettingsRow
        anchor="notifications_enabled"
        label={t("settings.notifications_enabled")}
        hint={t("settings.general_notify_hint")}
        control={
          <Toggle
            checked={notificationsEnabled}
            onChange={(next) => void setNotificationsEnabled(next)}
            aria-label={t("settings.notifications_enabled")}
            data-testid="settings-switch-notifications"
          />
        }
        data-testid="settings-switch-row-notifications"
      />
      <SettingsRow
        anchor="notifications_all_day_at"
        label={t("settings.notifications_all_day_at")}
        control={
          <TimeField
            value={reminderAllDayAt}
            onCommit={(v) => void setReminderAllDayAt(v)}
            ariaLabel={t("settings.notifications_all_day_at")}
            data-testid="settings-notifications-all-day-at"
          />
        }
      />
      {/* 브라우저(태블릿)에는 트레이도, 원인을 고칠 토글도 없다 — 할 수 있는 일이 없는 경고는
          띄우지 않는다(GeneralSection 시절의 W2-ⓓ 회귀 그대로). */}
      {!browser && !closeToTray && notificationsEnabled && (
        <div
          data-testid="settings-notifications-needs-tray"
          style={{ fontSize: "var(--text-sm)", color: "var(--danger)", padding: "0 0 var(--space-3)" }}
        >
          {t("settings.notifications_needs_tray")}
        </div>
      )}
    </SettingsCard>
  );
}
