import { useEffect, useState } from "react";
import { useSettingsStore } from "../stores/settings";
import { t } from "../i18n/t";
import { IconCaret, IconCheck } from "../components/icons";
import { fetchPing, type MobilePing } from "./mobileApi";
import { MobileModal } from "./MobileModal";
import { MobileSettingsRoster } from "./MobileSettingsRoster";
import { MobileSettingsAiPresets } from "./MobileSettingsAiPresets";
import { useMobileChoiceSettings, type ChoiceSetting } from "./useMobileChoiceSettings";

/** 설정 tab — 원격 클라이언트에서 실제로 동작하는 설정만 남긴 요약 화면(D9). 노출 키의 SSOT는
 *  `lib/remoteSettingsPolicy.ts::PHONE_SETTINGS_KEYS` — 이 화면이 `settings_set`으로 쓰는 키를
 *  늘리거나 줄이면 그 목록도 같이 고친다.
 *
 *  INFORMATION ARCHITECTURE (owner verdict on an earlier pass: every element was the same
 *  one-line `mobile-settings-row`, so pick-one settings, openable editors and read-only info all
 *  looked identical and no tap outcome was predictable). Three visually distinct species, kept:
 *
 *  1. 모양 (테마/글자 크기/언어) · 입력 (사진/음성/위치) — 값 표시 + 탭으로 선택. ONE row each,
 *     current value rendered on the right with a chevron; tapping opens a MobileModal picker. The
 *     rows are data from `useMobileChoiceSettings`; the picker modal is rendered here.
 *  2. 편집형 목록 — 보기(사이드바 구성, filter_roster → MobileSettingsRoster) · 노트 작업 프리셋
 *     (→ MobileSettingsAiPresets). 알림도 같은 species — 토글 + 시각 입력이 그 자리에서 바로 값을
 *     바꾼다.
 *  3. 읽기 전용 — AI 연결(마스터 토글은 원격에서 400이라 D8로 제거, 자리에 데스크톱 안내만) ·
 *     연결 정보 · 화면 하단 "나머지는 데스크톱에서" 안내. 전부 버튼이 아니고 탭 핸들러가 없다.
 *
 *  Theme/font-size/location mode are per-device (mobilePrefs.ts, localStorage); language/roster/
 *  notifications/photo·voice modes write shared DB settings, the same ones desktop reads.
 *
 *  펫 페르소나 섹션은 제거됐다(D8) — 펫은 데스크톱 로컬 창이고 이 화면의 기준은 "이 기기에서
 *  의미 있는 설정"이다. 키(pet_persona_*)는 원격 허용이라 데스크톱에서는 계속 동작한다. */
export function MobileSettings() {
  // aiEnabled: READ ONLY here (D8) — the master toggle is removed because the server rejects
  // ai_enabled from remote clients (400, lib/remoteSettingsPolicy.ts::isRemoteBlockedSettingKey).
  // Only used to decide whether the "AI 연결" desktop hint shows.
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  const notificationsEnabled = useSettingsStore((s) => s.notificationsEnabled);
  const setNotificationsEnabled = useSettingsStore((s) => s.setNotificationsEnabled);
  const reminderAllDayAt = useSettingsStore((s) => s.reminderAllDayAt);
  const setReminderAllDayAt = useSettingsStore((s) => s.setReminderAllDayAt);
  const { choices, inputChoices } = useMobileChoiceSettings();
  const [ping, setPing] = useState<MobilePing | null>(null);
  const [openPicker, setOpenPicker] = useState<ChoiceSetting["key"] | null>(null);

  useEffect(() => {
    void fetchPing().then(setPing);
  }, []);

  const picker = [...choices, ...inputChoices].find((c) => c.key === openPicker);

  return (
    <>
      <div className="mobile-topbar">
        <span className="mobile-topbar-title">{t("mobile.tab_settings")}</span>
      </div>

      <div className="mobile-list mobile-settings scroll">
        {/* ── 1. 모양 — 값 표시 + 탭으로 선택 ──────────────────────────────────────────────── */}
        <div className="mobile-settings-section">
          <div className="mobile-settings-section-label label-caps">{t("mobile.settings_appearance")}</div>
          {choices.map((c) => (
            <div key={c.key}>
              <button
                type="button"
                className="mobile-settings-row"
                data-testid={`mobile-settings-choice-${c.key}`}
                onClick={() => setOpenPicker(c.key)}
              >
                <span>{c.label}</span>
                <span className="mobile-settings-value">
                  <span>{c.value}</span>
                  <IconCaret dir="right" size={17} />
                </span>
              </button>
            </div>
          ))}
          {/* theme/font persist per-device (localStorage) while every other row here (lang
              included) writes the shared DB setting — that split is otherwise invisible. Said ONCE
              for the section (K7), not under each row. */}
          {choices.some((c) => c.deviceLocal) && (
            <div className="mobile-settings-section-hint" data-testid="mobile-settings-device-only">
              {t("mobile.settings_device_only_hint")}
            </div>
          )}
        </div>

        {/* ── 1b. 입력 — 사진/음성/위치가 자동으로 하는 일. 같은 3단 선택 행, 행 아래 한 줄 설명. ── */}
        <div className="mobile-settings-section">
          <div className="mobile-settings-section-label label-caps">{t("mobileSettingsInput.group")}</div>
          {inputChoices.map((c) => (
            <div key={c.key}>
              <button
                type="button"
                className="mobile-settings-row"
                data-testid={`mobile-settings-choice-${c.key}`}
                disabled={c.disabled}
                onClick={() => setOpenPicker(c.key)}
              >
                <span>{c.label}</span>
                <span className="mobile-settings-value">
                  <span>{c.value}</span>
                  <IconCaret dir="right" size={17} />
                </span>
              </button>
              <div className="mobile-settings-section-hint" data-testid={`mobile-settings-hint-${c.key}`}>
                {c.hint}
              </div>
            </div>
          ))}
          {inputChoices.some((c) => c.deviceLocal) && (
            <div className="mobile-settings-section-hint" data-testid="mobile-settings-input-device-only">
              {t("mobile.settings_device_only_hint")}
            </div>
          )}
        </div>

        {/* ── 2. 보기 — 사이드바 구성(filter_roster). on/off 체크 + 위/아래 이동. 데스크톱
                FilterRosterStrip의 세그먼트 스트립+드래그 대신(폰엔 hover/정밀 드래그가 없다). ── */}
        <MobileSettingsRoster />

        {/* ── 3. 알림 — notifications_enabled(마스터) + reminder_all_day_at(종일 노트 알림 시각).
                데스크톱 NotificationsSection과 같은 키·같은 값 규약("HH:MM"). ── */}
        <div className="mobile-settings-section">
          <div className="mobile-settings-section-label label-caps">{t("settings.notifications")}</div>
          <div className="mobile-settings-row" data-testid="mobile-settings-notifications-enabled">
            <span>{t("settings.notifications_enabled")}</span>
            <input
              type="checkbox"
              role="switch"
              className="mobile-switch"
              checked={notificationsEnabled}
              onChange={(e) => void setNotificationsEnabled(e.target.checked)}
            />
          </div>
          <div className="mobile-settings-row" data-testid="mobile-settings-reminder-time">
            <span>{t("settings.notifications_all_day_at")}</span>
            <input
              type="time"
              className="mobile-preset-ai-input mobile-settings-time"
              value={reminderAllDayAt}
              disabled={!notificationsEnabled}
              onChange={(e) => {
                if (!notificationsEnabled) return;
                void setReminderAllDayAt(e.target.value);
              }}
            />
          </div>
        </div>

        {/* ── 4. AI 연결 — 마스터 토글은 원격에서 400이라 제거(D8, 살아있던 버그: 켜졌다 롤백되고
                에러 토스트가 떴다). 그 자리엔 데스크톱 안내만 — 버튼도, 탭 핸들러도 없다. ── */}
        {!aiEnabled && (
          <div className="mobile-settings-section">
            <div className="mobile-settings-section-label label-caps">{t("settings.ai_tab_connection")}</div>
            <div className="mobile-settings-section-hint" data-testid="mobile-settings-ai-desktop-hint">
              {t("mobile.ai_disabled_hint")}
            </div>
          </div>
        )}

        {/* ── 5. 노트 작업 프리셋 — 데스크톱 AI 설정의 프리셋 탭 미러. editable items (the hint is
                what makes a tap's outcome predictable) ── */}
        <MobileSettingsAiPresets />

        {/* ── 6. 연결 정보 — read-only, not a control: no <button>, no border, muted ────────── */}
        <div className="mobile-settings-section">
          <div className="mobile-settings-section-label label-caps">{t("mobile.settings_connection")}</div>
          <div className="mobile-settings-info" data-testid="mobile-settings-info-server">
            <span>{t("mobile.settings_server")}</span>
            <span>{typeof window !== "undefined" ? window.location.host : ""}</span>
          </div>
          {ping && (
            <div className="mobile-settings-info" data-testid="mobile-settings-info-version">
              <span>{t("mobile.settings_version")}</span>
              <span>{ping.app_version}</span>
            </div>
          )}
        </div>

        {/* ── 7. "요약"임을 화면에서 드러낸다(D9) — 읽기 전용, 버튼도 탭 핸들러도 없다. 폰에서
                갈 곳이 없어서다: 데스크톱 SettingsRow/SegGroup(minWidth:200)을 375px에 그대로
                옮기면 48px 터치 타깃을 위반한다(WORKORDER-2026-09-02 D9 근거 2). ── */}
        <div className="mobile-settings-info" data-testid="mobile-settings-desktop-only-hint">
          <span>{t("mobile.settings_desktop_only_hint")}</span>
        </div>

        {/* Keeps the last row clear of the tab bar — the two hairlines used to butt straight into
            each other and the last row read as cut off. */}
        <div className="mobile-settings-bottom-space" aria-hidden="true" data-testid="mobile-settings-bottom-space" />
      </div>

      {picker && (
        <MobileModal title={picker.label} onClose={() => setOpenPicker(null)}>
          <div className="mobile-modal-options">
            {picker.options.map((o) => (
              <button
                type="button"
                key={o.id}
                className="menu-row mobile-ai-action"
                data-selected={picker.selected === o.id}
                onClick={() => {
                  picker.choose(o.id);
                  setOpenPicker(null);
                }}
              >
                <span>{o.label}</span>
                {picker.selected === o.id && <IconCheck size={19} strokeWidth={2.2} />}
              </button>
            ))}
          </div>
        </MobileModal>
      )}
    </>
  );
}
