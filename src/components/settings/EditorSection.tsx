import { useEffect, useRef, useState } from "react";
import {
  useSettingsStore,
  dateNudgeModeOf,
  regionNudgeModeOf,
  type DateNudgeMode,
  type RegionNudgeMode,
  type EditorWidth,
  type NewNoteDatePrecision,
} from "../../stores/settings";
import { t } from "../../i18n/t";
import { optionsOf, SETTINGS_CTRL_WIDTH } from "./shared";
import { EDITOR_WIDTHS } from "../../stores/prefs";
import { SettingsRow } from "./SettingsRow";
import { Toggle } from "./Toggle";
import { SegGroup } from "./SegGroup";
import { IconAction } from "./IconAction";
import { IconSparkles, IconEye, IconFmtText, IconNote, IconClose } from "../icons";
import { SettingsCard } from "./SettingsCard";

// "링크 열기" 세그먼트의 내부 값 — 저장은 linkOpenOnClick 불리언 하나뿐이라 이 두 문자열은
// 화면 표시용 로컬 타입이다(설정 키가 아니다).
type LinkOpenMode = "ctrlClick" | "click";

const WIDTH_LABELS: Record<EditorWidth, () => string> = {
  narrow: () => t("settings.editor_width_narrow"),
  normal: () => t("settings.editor_width_normal"),
  wide: () => t("settings.editor_width_wide"),
};

/**
 * 설정 > 에디터 — 흩어져 있던 에디터 동작 설정을 한 페이지로 모은다. 카드는 전부 페이지 최상위
 * 형제다(SettingsPanel 본문의 flex gap 이 간격을 맡는다). 순서(PLAN-2026-10-27): 표시 → 새 노트 → 자동완성·편의성.
 * 붙여넣기·드롭 정책은 "첨부파일" 페이지(PastePolicyCard)로 이사했다. 아래 번호는 옛 순서의 이름표다:
 *   1. 자동 제안 — 날짜·지역 제안 3단 세그먼트. 저장은 불리언 두 쌍이고 `dateNudgeModeOf`/
 *      `regionNudgeModeOf` 가 표시값으로 접고 `setDateNudgeMode`/`setRegionNudgeMode` 가 한 번의
 *      `settings_set` 으로 되돌린다.
 *   3. 입력 — 마크다운 자동 서식 · 링크 열기(Ctrl+클릭/클릭). 타이핑·클릭 중 일어나는 일.
 *   4. 새 노트 — 새 노트가 받는 날짜의 정밀도 · 첫 섹션 이름(빈 값 = UI 언어별 기본 이름).
 *   5. 표시 — 전체 너비 · 본문 폭(전체 너비가 켜지면 잠긴다) · 글자 수 표시 · 맞춤법 검사.
 *
 * 여기 키는 전부 `settings_schema.rs::NOTEBOOK_KEYS` 에 있는 노트북별 설정이라 "앱 전체" 칩을 달지 않는다.
 */
export function EditorSection() {
  const dateNudgeEnabled = useSettingsStore((s) => s.dateNudgeEnabled);
  const dateNudgeAuto = useSettingsStore((s) => s.dateNudgeAuto);
  const setDateNudgeMode = useSettingsStore((s) => s.setDateNudgeMode);
  const regionNudgeEnabled = useSettingsStore((s) => s.regionNudgeEnabled);
  const regionNudgeStrict = useSettingsStore((s) => s.regionNudgeStrict);
  const setRegionNudgeMode = useSettingsStore((s) => s.setRegionNudgeMode);
  const editorMdAutoformat = useSettingsStore((s) => s.editorMdAutoformat);
  const setEditorMdAutoformat = useSettingsStore((s) => s.setEditorMdAutoformat);
  const editorFullWidth = useSettingsStore((s) => s.editorFullWidth);
  const setEditorFullWidth = useSettingsStore((s) => s.setEditorFullWidth);
  const spellcheckEnabled = useSettingsStore((s) => s.spellcheckEnabled);
  const setSpellcheckEnabled = useSettingsStore((s) => s.setSpellcheckEnabled);
  const linkOpenOnClick = useSettingsStore((s) => s.linkOpenOnClick);
  const setLinkOpenOnClick = useSettingsStore((s) => s.setLinkOpenOnClick);
  const editorWidth = useSettingsStore((s) => s.editorWidth);
  const setEditorWidth = useSettingsStore((s) => s.setEditorWidth);
  const editorWordCount = useSettingsStore((s) => s.editorWordCount);
  const setEditorWordCount = useSettingsStore((s) => s.setEditorWordCount);
  const newNoteDatePrecision = useSettingsStore((s) => s.newNoteDatePrecision);
  const setNewNoteDatePrecision = useSettingsStore((s) => s.setNewNoteDatePrecision);
  const newNoteSectionName = useSettingsStore((s) => s.newNoteSectionName);
  const setNewNoteSectionName = useSettingsStore((s) => s.setNewNoteSectionName);

  const dateNudgeMode = dateNudgeModeOf(dateNudgeEnabled, dateNudgeAuto);
  const regionNudgeMode = regionNudgeModeOf(regionNudgeEnabled, regionNudgeStrict);
  const linkOpenMode: LinkOpenMode = linkOpenOnClick ? "click" : "ctrlClick";

  // 첫 섹션 이름 — 로컬 draft, blur/Enter 에서만 커밋한다(매 키 입력마다 settings_set 을 쏘지 않는다).
  // 공백뿐인 값은 빈 값(= 기본 이름)으로 친다. Escape 는 편집을 취소하고 저장값으로 되돌린다 —
  // 이어지는 blur 가 옛 draft 를 커밋하지 않도록 ref 로 한 번 건너뛴다.
  const [sectionNameDraft, setSectionNameDraft] = useState(newNoteSectionName);
  const skipNextCommitRef = useRef(false);
  useEffect(() => {
    setSectionNameDraft(newNoteSectionName);
  }, [newNoteSectionName]);
  const commitSectionName = () => {
    if (skipNextCommitRef.current) {
      skipNextCommitRef.current = false;
      return;
    }
    const next = sectionNameDraft.trim();
    setSectionNameDraft(next);
    if (next !== newNoteSectionName) void setNewNoteSectionName(next);
  };

  return (
    <>

      {/* 5. 표시 — 전체 너비 → 본문 폭 → 글자 수 표시 → 맞춤법 검사. */}
      <SettingsCard title={t("settings.editor_display_group")} icon={<IconEye size={14} strokeWidth={2} />} testId="settings-editor-display">

        <SettingsRow
          anchor="editor_full_width"
          label={t("settings.editor_full_width_label")}
          hint={t("settings.editor_full_width_hint")}
          data-testid="settings-editor-full-width"
          control={
            <Toggle
              checked={editorFullWidth}
              onChange={(next) => void setEditorFullWidth(next)}
              aria-label={t("settings.editor_full_width_label")}
              data-testid="settings-editor-full-width-toggle"
            />
          }
        />

        <SettingsRow
          anchor="editor_width"
          label={t("settings.editor_width_label")}
          hint={t("settings.editor_width_hint")}
          disabled={editorFullWidth}
          disabledReason={editorFullWidth ? t("settings.editor_width_disabled_reason") : undefined}
          data-testid="settings-editor-width"
          control={
            <SegGroup<EditorWidth>
              value={editorWidth}
              onChange={(v) => void setEditorWidth(v)}
              ariaLabel={t("settings.editor_width_label")}
              options={optionsOf(EDITOR_WIDTHS, WIDTH_LABELS).map((o) => ({
                ...o,
                disabled: editorFullWidth,
                title: editorFullWidth ? t("settings.editor_width_disabled_reason") : undefined,
              }))}
            />
          }
        />

        <SettingsRow
          anchor="editor_word_count"
          label={t("settings.editor_word_count_label")}
          hint={t("settings.editor_word_count_hint")}
          data-testid="settings-editor-word-count"
          control={
            <Toggle
              checked={editorWordCount}
              onChange={(next) => void setEditorWordCount(next)}
              aria-label={t("settings.editor_word_count_label")}
              data-testid="settings-editor-word-count-toggle"
            />
          }
        />

        <SettingsRow
          anchor="spellcheck_enabled"
          label={t("settings.spellcheck_enabled_label")}
          hint={t("settings.spellcheck_enabled_hint")}
          data-testid="settings-spellcheck-enabled"
          control={
            <Toggle
              checked={spellcheckEnabled}
              onChange={(next) => void setSpellcheckEnabled(next)}
              aria-label={t("settings.spellcheck_enabled_label")}
              data-testid="settings-spellcheck-enabled-toggle"
            />
          }
        />
      </SettingsCard>
      {/* 4. 새 노트 — 새 노트가 뭘 들고 시작하는지. */}
      <SettingsCard title={t("settings.editor_new_note_group")} icon={<IconNote size={14} strokeWidth={2} />} testId="settings-editor-new-note">

        <SettingsRow
          anchor="new_note_date_precision"
          label={t("settings.new_note_date_precision_label")}
          hint={t("settings.new_note_date_precision_hint")}
          data-testid="settings-new-note-date-precision"
          control={
            <SegGroup<NewNoteDatePrecision>
              value={newNoteDatePrecision}
              onChange={(v) => void setNewNoteDatePrecision(v)}
              ariaLabel={t("settings.new_note_date_precision_label")}
              options={[
                { value: "day", label: t("settings.new_note_date_precision_day") },
                { value: "month", label: t("settings.new_note_date_precision_month") },
                { value: "year", label: t("settings.new_note_date_precision_year") },
              ]}
            />
          }
        />

        <SettingsRow
          anchor="new_note_section_name"
          label={t("settings.new_note_section_name_label")}
          hint={t("settings.new_note_section_name_hint")}
          data-testid="settings-new-note-section-name"
          control={
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
                width: SETTINGS_CTRL_WIDTH,
              }}
            >
              <input
                type="text"
                className="field"
                style={{ flex: 1, minWidth: 0, textAlign: "right" }}
                // 비워두면 쓰이는 이름 — Rust default_section_name_for_lang 과 같은 문자열(UI 언어별).
                placeholder={t("note.default_section_name")}
                maxLength={40}
                value={sectionNameDraft}
                onChange={(e) => setSectionNameDraft(e.target.value)}
                onBlur={commitSectionName}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    (e.target as HTMLInputElement).blur();
                  } else if (e.key === "Escape") {
                    // 설정 창 자체의 Escape(창 닫기 등)로 번지지 않게 여기서 끝낸다.
                    e.preventDefault();
                    e.stopPropagation();
                    skipNextCommitRef.current = true;
                    setSectionNameDraft(newNoteSectionName);
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                aria-label={t("settings.new_note_section_name_label")}
                data-testid="settings-new-note-section-name-input"
              />
              {sectionNameDraft.trim().length > 0 && (
                <IconAction
                  icon={<IconClose size={14} strokeWidth={2} />}
                  label={t("settings.new_note_section_name_clear")}
                  size="sm"
                  data-testid="settings-new-note-section-name-clear"
                  onClick={() => {
                    setSectionNameDraft("");
                    void setNewNoteSectionName("");
                  }}
                />
              )}
            </div>
          }
        />
      </SettingsCard>

      {/* 1. 자동 제안 — 날짜·지역 제안 3단 세그먼트(저장은 불리언 두 쌍). */}
      <SettingsCard title={t("settings.editor_auto_suggest_group")} icon={<IconSparkles size={14} strokeWidth={2} />} testId="settings-editor-auto-suggest">

        <SettingsRow
          anchor="date_nudge_mode"
          label={t("settings.date_nudge_mode_label")}
          hint={t("settings.date_nudge_mode_hint")}
          data-testid="settings-date-nudge-mode"
          control={
            <SegGroup<DateNudgeMode>
              value={dateNudgeMode}
              onChange={(v) => void setDateNudgeMode(v)}
              ariaLabel={t("settings.date_nudge_mode_label")}
              options={[
                { value: "off", label: t("settings.date_nudge_mode_off") },
                { value: "suggest", label: t("settings.date_nudge_mode_suggest") },
                { value: "auto", label: t("settings.date_nudge_mode_auto") },
              ]}
            />
          }
        />

        <SettingsRow
          anchor="region_nudge_mode"
          label={t("settings.region_nudge_mode_label")}
          hint={t("settings.region_nudge_mode_hint")}
          data-testid="settings-region-nudge-mode"
          control={
            <SegGroup<RegionNudgeMode>
              value={regionNudgeMode}
              onChange={(v) => void setRegionNudgeMode(v)}
              ariaLabel={t("settings.region_nudge_mode_label")}
              options={[
                { value: "off", label: t("settings.region_nudge_mode_off") },
                { value: "strict", label: t("settings.region_nudge_mode_strict") },
                { value: "loose", label: t("settings.region_nudge_mode_loose") },
              ]}
            />
          }
        />
      </SettingsCard>

      {/* 3. 입력 — "어떻게 보이는지"가 아니라 타이핑·클릭 중 무슨 일이 일어나는지. */}
      <SettingsCard title={t("settings.editor_input_group")} icon={<IconFmtText size={14} strokeWidth={2} />} testId="settings-editor-input">

        <SettingsRow
          anchor="editor_md_autoformat"
          label={t("settings.editor_md_autoformat_label")}
          hint={t("settings.editor_md_autoformat_hint")}
          data-testid="settings-editor-md-autoformat"
          control={
            <Toggle
              checked={editorMdAutoformat}
              onChange={(next) => void setEditorMdAutoformat(next)}
              aria-label={t("settings.editor_md_autoformat_label")}
              data-testid="settings-editor-md-autoformat-toggle"
            />
          }
        />

        <SettingsRow
          anchor="link_open_on_click"
          label={t("settings.link_open_on_click_label")}
          hint={t("settings.link_open_on_click_hint")}
          data-testid="settings-link-open-on-click"
          control={
            <SegGroup<LinkOpenMode>
              value={linkOpenMode}
              onChange={(v) => void setLinkOpenOnClick(v === "click")}
              ariaLabel={t("settings.link_open_on_click_label")}
              options={[
                { value: "ctrlClick", label: t("settings.link_open_on_click_ctrl_click") },
                { value: "click", label: t("settings.link_open_on_click_click") },
              ]}
            />
          }
        />
      </SettingsCard>

    </>
  );
}
