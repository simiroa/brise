import { useState } from "react";
import { useSettingsStore } from "../stores/settings";
import { t } from "../i18n/t";
import {
  getMobileTheme,
  getMobileFontSize,
  setMobileTheme,
  setMobileFontSize,
  getLocMode,
  setLocMode,
  type MobileTheme,
  type MobileFontSize,
  type MobileLocMode,
} from "./mobilePrefs";

/** One pick-one-of-N setting, collapsed to a single row. */
export interface ChoiceSetting {
  key: "theme" | "font" | "lang" | "photo" | "voice" | "cleanup" | "loc";
  label: string;
  /** Label of the CURRENTLY selected option — shown on the row itself, right-aligned. */
  value: string;
  options: { id: string; label: string }[];
  selected: string;
  choose: (id: string) => void;
  /** theme/font persist to mobilePrefs.ts (localStorage, per-device) — lang writes the shared
   *  uiLang DB setting instead. The difference is invisible in the row itself, so a quiet hint
   *  renders under the section (see MobileSettings). */
  deviceLocal?: boolean;
  /** One-line explanation of what the CURRENT choice does (입력 group). */
  hint?: string;
  /** Row is not tappable (voice while AI is off); `hint` then carries the reason. */
  disabled?: boolean;
}

const THEME_OPTIONS: MobileTheme[] = ["system", "light", "dark"];
const THEME_LABEL_KEY: Record<MobileTheme, string> = {
  system: "mobile.theme_system",
  light: "mobile.theme_light",
  dark: "mobile.theme_dark",
};

const FONT_OPTIONS: MobileFontSize[] = ["small", "medium", "large"];
const FONT_LABEL_KEY: Record<MobileFontSize, string> = {
  small: "mobile.font_small",
  medium: "mobile.font_medium",
  large: "mobile.font_large",
};

const LANG_OPTIONS = ["ko", "en", "fr"] as const;
const LANG_LABEL: Record<string, string> = { ko: "한국어", en: "English", fr: "Français" };

const INPUT_MODES: MobileLocMode[] = ["auto", "ask", "off"];
// Literal keys on purpose — check:i18n can't see dynamically built ones.
const modeLabel = (m: MobileLocMode) =>
  m === "auto" ? t("mobileSettingsInput.mode_auto") : m === "ask" ? t("mobileSettingsInput.mode_ask") : t("mobileSettingsInput.mode_off");
const photoHint = (m: MobileLocMode) =>
  m === "auto" ? t("mobileSettingsInput.photo_auto") : m === "ask" ? t("mobileSettingsInput.photo_ask") : t("mobileSettingsInput.photo_off");
const voiceHint = (m: MobileLocMode) =>
  m === "auto" ? t("mobileSettingsInput.voice_auto") : m === "ask" ? t("mobileSettingsInput.voice_ask") : t("mobileSettingsInput.voice_off");
const cleanupHint = (m: MobileLocMode) =>
  m === "auto" ? t("mobileSettingsInput.cleanup_auto") : m === "ask" ? t("mobileSettingsInput.cleanup_ask") : t("mobileSettingsInput.cleanup_off");
const locHint = (m: MobileLocMode) =>
  m === "auto" ? t("mobileSettingsInput.loc_auto") : m === "ask" ? t("mobileSettingsInput.loc_ask") : t("mobileSettingsInput.loc_off");

/**
 * The 설정 tab's pick-one rows, as data: `choices` = 모양 group (theme · font size · language),
 * `inputChoices` = 입력 group (photo · voice · cleanup · location). Owns the per-device state
 * (theme/font size/location mode live in mobilePrefs.ts's localStorage, so the screen needs a local
 * mirror to re-render) and wires every other row to the shared settings store's setters.
 */
export function useMobileChoiceSettings(): { choices: ChoiceSetting[]; inputChoices: ChoiceSetting[] } {
  const uiLang = useSettingsStore((s) => s.uiLang);
  const setUiLang = useSettingsStore((s) => s.setUiLang);
  // aiEnabled: READ ONLY here (D8) — the master toggle is removed because the server rejects
  // ai_enabled from remote clients (400, lib/remoteSettingsPolicy.ts::isRemoteBlockedSettingKey).
  // It only locks the voice row below.
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  const photoMetaMode = useSettingsStore((s) => s.photoMetaMode);
  const setPhotoMetaMode = useSettingsStore((s) => s.setPhotoMetaMode);
  const voiceTranscribeMode = useSettingsStore((s) => s.voiceTranscribeMode);
  const setVoiceTranscribeMode = useSettingsStore((s) => s.setVoiceTranscribeMode);
  const voiceCleanupMode = useSettingsStore((s) => s.voiceCleanupMode);
  const setVoiceCleanupMode = useSettingsStore((s) => s.setVoiceCleanupMode);
  const [locMode, setLocModeState] = useState<MobileLocMode>(getLocMode);
  const [theme, setTheme] = useState<MobileTheme>(getMobileTheme);
  const [fontSize, setFontSize] = useState<MobileFontSize>(getMobileFontSize);

  const choices: ChoiceSetting[] = [
    {
      key: "theme",
      label: t("mobile.settings_theme"),
      value: t(THEME_LABEL_KEY[theme]),
      options: THEME_OPTIONS.map((v) => ({ id: v, label: t(THEME_LABEL_KEY[v]) })),
      selected: theme,
      choose: (v) => {
        setMobileTheme(v as MobileTheme);
        setTheme(v as MobileTheme);
      },
      deviceLocal: true,
    },
    {
      key: "font",
      label: t("mobile.settings_font_size"),
      value: t(FONT_LABEL_KEY[fontSize]),
      options: FONT_OPTIONS.map((v) => ({ id: v, label: t(FONT_LABEL_KEY[v]) })),
      selected: fontSize,
      choose: (v) => {
        setMobileFontSize(v as MobileFontSize);
        setFontSize(v as MobileFontSize);
      },
      deviceLocal: true,
    },
    {
      key: "lang",
      label: t("mobile.settings_language"),
      value: LANG_LABEL[uiLang] ?? uiLang,
      options: LANG_OPTIONS.map((v) => ({ id: v, label: LANG_LABEL[v] })),
      selected: uiLang,
      choose: (v) => void setUiLang(v as (typeof LANG_OPTIONS)[number]),
    },
  ];
  // 입력 group. DB 키 3개는 settings 스토어 setter(낙관적 저장 + 실패 롤백은 setSimplePref 몫),
  // 위치는 기기별 localStorage. 음성 받아쓰기는 오디오가 AI 로 나가므로 ai_enabled 가 꺼져 있으면 잠근다.
  // ponytail: aiReachable(PC 도달성)까지는 보지 않는다 — 설정은 선호값이라 PC 가 잠깐 안 보여도
  // 바꿀 수 있어야 한다. 실제 전사 시점의 도달 실패는 녹음 쪽이 처리한다.
  const inputOptions = INPUT_MODES.map((v) => ({ id: v, label: modeLabel(v) }));
  const inputChoices: ChoiceSetting[] = [
    {
      key: "photo",
      label: t("mobileSettingsInput.photo_label"),
      value: modeLabel(photoMetaMode),
      options: inputOptions,
      selected: photoMetaMode,
      choose: (v) => void setPhotoMetaMode(v as MobileLocMode), // 실패 롤백은 setSimplePref
      hint: photoHint(photoMetaMode),
    },
    {
      key: "voice",
      label: t("mobileSettingsInput.voice_label"),
      value: modeLabel(voiceTranscribeMode),
      options: inputOptions,
      selected: voiceTranscribeMode,
      choose: (v) => void setVoiceTranscribeMode(v as MobileLocMode), // 실패 롤백은 setSimplePref
      hint: aiEnabled ? voiceHint(voiceTranscribeMode) : t("mobileSettingsInput.voice_needs_ai"),
      disabled: !aiEnabled,
    },
    {
      key: "cleanup",
      label: t("mobileSettingsInput.cleanup_label"),
      value: modeLabel(voiceCleanupMode),
      options: inputOptions,
      selected: voiceCleanupMode,
      choose: (v) => void setVoiceCleanupMode(v as MobileLocMode), // 실패 롤백은 setSimplePref
      hint: cleanupHint(voiceCleanupMode),
    },
    {
      key: "loc",
      label: t("mobileSettingsInput.loc_label"),
      value: modeLabel(locMode),
      options: inputOptions,
      selected: locMode,
      choose: (v) => {
        setLocMode(v as MobileLocMode);
        setLocModeState(v as MobileLocMode);
      },
      deviceLocal: true,
      hint: locHint(locMode),
    },
  ];

  return { choices, inputChoices };
}
