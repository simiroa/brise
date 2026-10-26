import { MobileModal } from "./MobileModal";
import { t } from "../i18n/t";
import { OFFSET_PRESETS, WEEKDAY_CODES, REPEAT_OPTIONS } from "../components/titlebar/scheduleRrule";
import { useReminderDraft, type SchedulePatch } from "../components/titlebar/useReminderDraft";
import { weekdayShortLabels } from "../components/home/dateFmt";

export type MobileSchedulePatch = SchedulePatch;

interface MobileReminderSheetProps {
  month: number | null;
  day: number | null;
  remind: boolean;
  startTime: string | null;
  endTime: string | null;
  remindOffsetMin: number | null;
  rrule: string | null;
  uiLang: string;
  notificationsEnabled: boolean;
  onEnableNotifications: () => void;
  setRemind: (remind: boolean) => void;
  setSchedule: (patch: MobileSchedulePatch) => void;
  onClose: () => void;
}

/**
 * docs/PLAN-schedule-system.md §7.7 — 알림 보조 시트. desktop ReminderModal.tsx(§7.3)과 같은
 * 항목·같은 draft-until-save 철학을 그대로 따르되, 종료 시각·반복 종료일(UNTIL) 입력은 뺀다
 * (§7.7 표 "시트에서 뺀 것" — 모바일에는 노트 기간 입력 자체가 없다).
 *
 * A-2: draft 상태 조립(remindOn/startTime/repeat/offsetKey + toggleByday + 저장 시 patch 조립)은
 * useReminderDraft 공유 훅 — desktop ReminderModal과 동일 로직, 렌더만 따로(칩+MobileModal).
 *
 * end_time과 UNTIL을 "제거"가 아니라 "노출하지 않음"으로 처리한다는 점이 이 파일에서 가장 미묘한
 * 부분이다: endTime prop은 훅의 draft.endTime 초기값으로만 쓰이고 이 파일 어디서도 setEndTime을
 * 부르지 않는다 — 그래서 buildPatch()의 `start_time && endTime ? endTime : null` 규칙(데스크톱과
 * 동일, A-2로 단일화)이 그대로 "기존 end_time을 건드리지 않고 되돌려 보낸다"로 동작한다. repeat.
 * until도 마찬가지로 parseRruleForUi가 기존 RRULE에서 읽어온 값을 draft에 실어만 두고 UI를 그리지
 * 않는다 — 그래서 데스크톱에서 이미 걸어 둔 반복 종료일이 모바일에서 반복 켜짐/오프셋만 바꿔도
 * 조용히 사라지지 않는다(반대로 모바일에서 새로 켠 반복은 until이 "" 그대로라 무한 반복이 된다,
 * 설계서 그대로).
 */
export function MobileReminderSheet({
  month,
  day,
  remind,
  startTime,
  endTime,
  remindOffsetMin,
  rrule,
  uiLang,
  notificationsEnabled,
  onEnableNotifications,
  setRemind,
  setSchedule,
  onClose,
}: MobileReminderSheetProps) {
  const draft = useReminderDraft({
    // PLAN-2026-09-08-dates-rebuild.md W4: target is now one unified row shape (no more
    // primary/related union) — year/end_* only mattered for the old anchor-date sentence, which
    // this sheet never rendered (§7.7 keeps it minimal), so placeholders are harmless.
    year: 0,
    month,
    day,
    end_year: null,
    end_month: null,
    end_day: null,
    remind,
    start_time: startTime,
    end_time: endTime,
    remind_offset_min: remindOffsetMin,
    rrule,
  });
  const { remindOn, setRemindOn, startTime: draftStartTime, setStartTime, repeat, setRepeat, offsetKey, setOffsetKey, toggleByday, hasFullPrecision } = draft;
  const weekdayLabels = weekdayShortLabels(uiLang);

  const handleSave = () => {
    setSchedule(draft.buildPatch());
    if (remindOn !== remind) setRemind(remindOn);
    onClose();
  };

  const handleTurnOff = () => {
    setRemind(false);
    onClose();
  };

  return (
    <MobileModal
      title={t("editor.reminder")}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="mobile-text-btn mobile-modal-footer-lead"
            data-testid="mobile-reminder-turn-off"
            onClick={handleTurnOff}
          >
            {t("editor.reminder_off_action")}
          </button>
          <button type="button" className="mobile-preset-ai-submit" data-testid="mobile-reminder-save" onClick={handleSave}>
            {t("editor.reminder_save")}
          </button>
        </>
      }
    >
      {!notificationsEnabled && (
        <div className="mobile-ai-disabled-hint" data-testid="mobile-reminder-app-off-banner" style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          <span>{t("editor.reminder_app_off")}</span>
          <button
            type="button"
            className="mobile-text-btn mobile-text-btn--accent"
            style={{ minHeight: "auto", padding: 0, alignSelf: "flex-start" }}
            data-testid="mobile-reminder-enable-app"
            onClick={onEnableNotifications}
          >
            {t("editor.reminder_app_on_action")}
          </button>
        </div>
      )}

      <div className="mobile-settings-row" data-testid="mobile-reminder-on-toggle-row">
        <span>{t("editor.reminder_on")}</span>
        <input
          type="checkbox"
          data-testid="mobile-reminder-on-toggle"
          checked={remindOn}
          onChange={(e) => setRemindOn(e.target.checked)}
        />
      </div>

      <div style={{ opacity: remindOn ? 1 : 0.5, pointerEvents: remindOn ? "auto" : "none" }}>
        <div className="mobile-settings-row">
          <span>{t("editor.time_start")}</span>
          {hasFullPrecision ? (
            <input
              type="time"
              className="mobile-preset-ai-input"
              style={{ flex: "none", width: 120 }}
              data-testid="mobile-reminder-start-time"
              value={draftStartTime}
              onChange={(e) => setStartTime(e.target.value)}
            />
          ) : (
            <span className="mobile-ai-disabled-hint" data-testid="mobile-reminder-needs-date">
              {t("editor.reminder_needs_date")}
            </span>
          )}
        </div>

        <div className="mobile-schedule-row">
          <span>{t("editor.repeat")}</span>
          <div className="mobile-schedule-chips" role="group" aria-label={t("editor.repeat")}>
            {REPEAT_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                className="mobile-schedule-chip"
                data-testid={`mobile-reminder-repeat-${o.value}`}
                data-selected={repeat.freq === o.value}
                onClick={() => setRepeat((r) => ({ ...r, freq: o.value }))}
              >
                {t(o.labelKey)}
              </button>
            ))}
          </div>
        </div>

        {repeat.freq !== "none" && (
          <div className="mobile-settings-row">
            <span>{t("editor.repeat_interval")}</span>
            <input
              type="number"
              min={1}
              max={999}
              className="mobile-preset-ai-input"
              style={{ flex: "none", width: 64 }}
              data-testid="mobile-reminder-interval"
              value={repeat.interval}
              onChange={(e) => setRepeat((r) => ({ ...r, interval: e.target.value }))}
            />
          </div>
        )}

        {repeat.freq === "WEEKLY" && (
          <div className="mobile-schedule-row">
            <span>{t("editor.repeat_byday")}</span>
            <div className="mobile-schedule-chips" role="group" aria-label={t("editor.repeat_byday")}>
              {WEEKDAY_CODES.map((code, i) => (
                <button
                  key={code}
                  type="button"
                  className="mobile-schedule-chip"
                  data-testid={`mobile-reminder-byday-${code}`}
                  aria-pressed={repeat.byday.includes(code)}
                  data-selected={repeat.byday.includes(code)}
                  onClick={() => toggleByday(code)}
                >
                  {weekdayLabels[i]}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mobile-schedule-row" style={{ borderBottom: "none" }}>
          <span>{t("editor.remind_offset")}</span>
          <div className="mobile-schedule-chips" role="group" aria-label={t("editor.remind_offset")}>
            {OFFSET_PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                className="mobile-schedule-chip"
                data-testid={`mobile-reminder-offset-${p.key}`}
                data-selected={offsetKey === p.key}
                onClick={() => setOffsetKey(p.key)}
              >
                {t(`editor.remind_offset_${p.key}`)}
              </button>
            ))}
          </div>
        </div>
      </div>
    </MobileModal>
  );
}
