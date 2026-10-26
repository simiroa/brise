import { useState } from "react";
import { formatEventDate, toDateInputValue, parseDateInputValue } from "../components/titlebar/eventDate";
import {
  BUILT_IN_STATUSES,
  statusColorVar,
  customStatusName,
  statusOptions,
  statusOptionLabel,
} from "../lib/status";
import type { StatusEntry } from "../lib/commands.gen";
import { t } from "../i18n/t";
import { MobileModal } from "./MobileModal";
import { IconCalendar, IconMapPin, IconBell } from "../components/icons";
import { MobileRegionSheet } from "./MobileRegionSheet";
import { MobileReminderSheet, type MobileSchedulePatch } from "./MobileReminderSheet";

export type { MobileSchedulePatch };

function StatusDotSmall({ color, size = 9 }: { color: string; size?: number }) {
  return <span aria-hidden style={{ display: "inline-block", width: size, height: size, borderRadius: "50%", background: color, flex: "none" }} />;
}

export interface MobileNoteBadgesProps {
  year: number;
  month: number | null;
  day: number | null;
  status: string | null;
  region: string | null;
  customStatuses: StatusEntry[];
  /** Geocode search language (desktop's RegionPickerFields uses the same settings-store uiLang). */
  uiLang: string;
  setYear: (y: number) => void;
  setEventPrecision: (month: number | null, day: number | null) => void;
  setStatus: (status: string | null) => void;
  setRegion: (region: string | null) => void;
  setLocation: (lat: number | null, lng: number | null) => void;
  /** §7.7 벨 배지 — docs/PLAN-schedule-system.md W5-6. */
  remind: boolean;
  startTime: string | null;
  /** Not editable here (§7.7 범위 밖) — carried through untouched on save so a mobile edit never
   *  silently clears an end time the desktop ReminderModal set. */
  endTime: string | null;
  remindOffsetMin: number | null;
  rrule: string | null;
  notificationsEnabled: boolean;
  onEnableNotifications: () => void;
  setRemind: (remind: boolean) => void;
  setSchedule: (patch: MobileSchedulePatch) => void;
}

/**
 * 지역·날짜·상태 badge row — desktop TitleBar's YearBadge/StatusControl/RegionEditor design
 * language (outlined pill, muted-dashed until set), mobile-shaped (bottom sheets instead of
 * anchored popovers/modals, no map). Presentational + self-contained pickers, no store coupling —
 * MobileNote passes activeNote fields + the same notes-store setters desktop uses.
 *
 * A-3: split from a single 556-line file into one file per sheet (mobile convention, cf.
 * MobileAiSheet) — this file now owns only the badge row + the status sheet. Region search lives
 * in MobileRegionSheet.tsx (A-1's useGeocodeSearch), the reminder sheet in
 * MobileReminderSheet.tsx (A-2's useReminderDraft).
 */
export function MobileNoteBadges({
  year,
  month,
  day,
  status,
  region,
  customStatuses,
  uiLang,
  setYear,
  setEventPrecision,
  setStatus,
  setRegion,
  setLocation,
  remind,
  startTime,
  endTime,
  remindOffsetMin,
  rrule,
  notificationsEnabled,
  onEnableNotifications,
  setRemind,
  setSchedule,
}: MobileNoteBadgesProps) {
  const [statusSheetOpen, setStatusSheetOpen] = useState(false);
  const [regionSheetOpen, setRegionSheetOpen] = useState(false);
  const [reminderSheetOpen, setReminderSheetOpen] = useState(false);

  const builtIn = BUILT_IN_STATUSES.find((s) => s.key === status);
  const customName = status ? customStatusName(status, customStatuses) : undefined;
  const statusLabel = builtIn ? t(builtIn.labelKey) : (customName ?? t("note.no_status"));

  return (
    <div className="mobile-note-badges">
      {/* Date — invisible native <input type="date"> overlaid on the pill (opacity 0, inset 0);
          tapping the pill taps the input and opens the OS date picker. More portable than
          showPicker() (not universally available, and throws outside a user gesture in some
          WebViews). */}
      {/* .mobile-badge-hit (mobile.css) owns the ≥48px touch height so the pill itself can stay a
          compact round pill (owner feedback 2026-07-30 item 3) — the invisible input stretched
          across this wrapper is what the finger actually hits. */}
      <div className="mobile-badge-hit">
        <div className="mobile-badge" aria-hidden>
          <IconCalendar size={13} strokeWidth={2} />
          {formatEventDate(year, month, day)}
        </div>
        <input
          type="date"
          aria-label={t("editor.year")}
          value={toDateInputValue(year, month, day)}
          onChange={(e) => {
            const parsed = parseDateInputValue(e.target.value);
            if (!parsed) return;
            setYear(parsed.year);
            setEventPrecision(parsed.month, parsed.day);
          }}
          style={{ position: "absolute", inset: 0, opacity: 0, border: 0, padding: 0, cursor: "pointer" }}
        />
      </div>

      <button
        type="button"
        className={status ? "mobile-badge" : "mobile-badge mobile-badge--unset"}
        onClick={() => setStatusSheetOpen(true)}
        aria-haspopup="dialog"
      >
        {/* Muted-vs-set parity with desktop's StatusControl (src/components/titlebar/
            StatusControl.tsx): a set status gets its color dot, unset gets a hollow ring rather
            than nothing, same as the trigger button there. */}
        {status ? (
          <StatusDotSmall color={statusColorVar(status)} />
        ) : (
          <span aria-hidden style={{ width: 9, height: 9, borderRadius: "50%", border: "1.5px solid var(--faint)", flex: "none" }} />
        )}
        {statusLabel}
      </button>

      <button
        type="button"
        className={region ? "mobile-badge" : "mobile-badge mobile-badge--unset"}
        onClick={() => setRegionSheetOpen(true)}
        aria-haspopup="dialog"
      >
        <IconMapPin size={13} strokeWidth={2} />
        {region ?? t("note.add_region")}
      </button>

      {/* 벨 배지 — docs/PLAN-schedule-system.md §7.7/W5-6. Same on/off language as desktop's
          TitleBar bell (§7.2: fill accent when remind is on, none when off), same
          set/unset pill parity as the status/region badges above. Set state shows the start time
          text when there is one; unset (or on but no time yet) falls back to the label. */}
      <button
        type="button"
        className={remind ? "mobile-badge" : "mobile-badge mobile-badge--unset"}
        onClick={() => setReminderSheetOpen(true)}
        aria-haspopup="dialog"
        data-testid="mobile-reminder-badge"
      >
        <IconBell size={13} strokeWidth={2} style={{ fill: remind ? "var(--accent)" : "none" }} />
        {remind && startTime ? startTime : t("editor.reminder")}
      </button>

      {/* Both pickers ride the shared MobileModal primitive (owner feedback 2026-07-30 item 5) —
          centered + keyboard-aware. The 지역 one is the exact case that motivated it: a text field
          plus a result list, previously pinned to the bottom edge under the keyboard. */}
      {statusSheetOpen && (
        <MobileModal
          title={t("note.status_label")}
          onClose={() => setStatusSheetOpen(false)}
          footer={
            <button type="button" className="mobile-text-btn" onClick={() => setStatusSheetOpen(false)}>
              {t("common.cancel")}
            </button>
          }
        >
          <div className="mobile-ai-actions mobile-modal-options">
            {statusOptions(customStatuses).map((opt) => (
              <button
                key={opt.key ?? "__none__"}
                type="button"
                className="menu-row mobile-ai-action"
                data-selected={status === opt.key}
                onClick={() => {
                  setStatus(opt.key);
                  setStatusSheetOpen(false);
                }}
                style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}
              >
                {opt.colorVar ? <StatusDotSmall color={opt.colorVar} /> : null}
                {statusOptionLabel(opt, t)}
              </button>
            ))}
          </div>
        </MobileModal>
      )}

      {regionSheetOpen && (
        <MobileRegionSheet
          region={region}
          uiLang={uiLang}
          setRegion={setRegion}
          setLocation={setLocation}
          onClose={() => setRegionSheetOpen(false)}
        />
      )}

      {/* §7.7 — 보조 시트로 격리. 마운트될 때만 존재하므로(조건부 렌더) MobileReminderSheet 내부의
          draft 훅은 시트를 열 때마다 note의 최신 값으로 새로 초기화된다(desktop ReminderModal이
          open 시에만 마운트되는 것과 같은 트릭 — TitleBar.tsx의 {reminderOpen && note &&
          <ReminderModal/>}). */}
      {reminderSheetOpen && (
        <MobileReminderSheet
          month={month}
          day={day}
          remind={remind}
          startTime={startTime}
          endTime={endTime}
          remindOffsetMin={remindOffsetMin}
          rrule={rrule}
          uiLang={uiLang}
          notificationsEnabled={notificationsEnabled}
          onEnableNotifications={onEnableNotifications}
          setRemind={setRemind}
          setSchedule={setSchedule}
          onClose={() => setReminderSheetOpen(false)}
        />
      )}
    </div>
  );
}
