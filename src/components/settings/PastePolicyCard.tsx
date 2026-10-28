import { useSettingsStore } from "../../stores/settings";
import { t } from "../../i18n/t";
import { SettingsRow } from "./SettingsRow";
import { Toggle } from "./Toggle";
import { Select } from "../Select";
import { IconPaste } from "../icons";
import { SettingsCard } from "./SettingsCard";

/**
 * 첨부파일 > 붙여넣기·드롭 정책 카드(PLAN-2026-10-27). 에디터 페이지에서 이사했다 — 붙여넣거나 끌어다 놓은
 * 내용이 첨부·변환·제안으로 이어지는 "입력 정책"이라 첨부 저장 방식과 한 페이지에 산다.
 * 원본 처리 + 붙여넣은 내용의 모양을 보고 뒤따르는 제안·변환 토글 셋. testId·앵커 id 는 그대로.
 */
export function PastePolicyCard() {
  const sourceOriginalPolicy = useSettingsStore((s) => s.sourceOriginalPolicy);
  const setSourceOriginalPolicy = useSettingsStore((s) => s.setSourceOriginalPolicy);
  const pasteLinkNudge = useSettingsStore((s) => s.pasteLinkNudge);
  const setPasteLinkNudge = useSettingsStore((s) => s.setPasteLinkNudge);
  const pastePathInlineCode = useSettingsStore((s) => s.pastePathInlineCode);
  const setPastePathInlineCode = useSettingsStore((s) => s.setPastePathInlineCode);
  const pasteTableSheetSuggest = useSettingsStore((s) => s.pasteTableSheetSuggest);
  const setPasteTableSheetSuggest = useSettingsStore((s) => s.setPasteTableSheetSuggest);

  return (
    <SettingsCard title={t("settings.editor_paste_drop_group")} icon={<IconPaste size={14} strokeWidth={2} />} testId="settings-editor-paste-drop">

      <SettingsRow
        anchor="original_policy"
        label={t("settings.original_policy")}
        hint={t("settings.original_policy_hint")}
        data-testid="settings-original-policy"
        control={
          <Select
            value={sourceOriginalPolicy}
            onChange={(v) => void setSourceOriginalPolicy(v)}
            ariaLabel={t("settings.original_policy")}
            options={[
              { value: "ask", label: t("settings.policy_ask") },
              { value: "keep", label: t("settings.policy_keep") },
              { value: "discard", label: t("settings.policy_discard") },
            ]}
          />
        }
      />

      <SettingsRow
        anchor="paste_link_nudge"
        label={t("settings.paste_link_nudge_label")}
        hint={t("settings.paste_link_nudge_hint")}
        data-testid="settings-paste-link-nudge"
        control={
          <Toggle
            checked={pasteLinkNudge}
            onChange={(next) => void setPasteLinkNudge(next)}
            aria-label={t("settings.paste_link_nudge_label")}
            data-testid="settings-paste-link-nudge-toggle"
          />
        }
      />

      <SettingsRow
        anchor="paste_path_inline_code"
        label={t("settings.paste_path_inline_code_label")}
        hint={t("settings.paste_path_inline_code_hint")}
        data-testid="settings-paste-path-inline-code"
        control={
          <Toggle
            checked={pastePathInlineCode}
            onChange={(next) => void setPastePathInlineCode(next)}
            aria-label={t("settings.paste_path_inline_code_label")}
            data-testid="settings-paste-path-inline-code-toggle"
          />
        }
      />

      <SettingsRow
        anchor="paste_table_sheet_suggest"
        label={t("settings.paste_table_sheet_suggest_label")}
        hint={t("settings.paste_table_sheet_suggest_hint")}
        data-testid="settings-paste-table-sheet-suggest"
        control={
          <Toggle
            checked={pasteTableSheetSuggest}
            onChange={(next) => void setPasteTableSheetSuggest(next)}
            aria-label={t("settings.paste_table_sheet_suggest_label")}
            data-testid="settings-paste-table-sheet-suggest-toggle"
          />
        }
      />
    </SettingsCard>
  );
}
