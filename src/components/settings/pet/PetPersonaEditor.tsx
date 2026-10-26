import { t } from "../../../i18n/t";
import { SETTINGS_CTRL_WIDTH } from "../shared";
import { SettingsRow } from "../SettingsRow";
import { Select } from "../../Select";
import { IconSparkles, IconTrash } from "../../icons";
import { IconAction } from "../IconAction";
import {
  PET_PERSONA_PRESETS,
  type PetPersonaPreset,
} from "../../../plugins/pet/bridge/petPersona";

export interface PetPersonaEditorProps {
  preset: PetPersonaPreset;
  prompt: string;
  onPresetChange: (preset: PetPersonaPreset) => void;
  onPromptChange: (prompt: string) => void;
  onPromptBlur?: () => void;
  /** 되돌릴 수 없는 삭제라 확인 다이얼로그는 호출부가 소유한다(PetPersonaSection). */
  onClearChat: () => void;
  onExtractInsights?: () => void;
  isExtractingInsights?: boolean;
}

export function PetPersonaEditor({
  preset,
  prompt,
  onPresetChange,
  onPromptChange,
  onPromptBlur,
  onClearChat,
  onExtractInsights,
  isExtractingInsights,
}: PetPersonaEditorProps) {
  return (
    <>
      <SettingsRow
        label={t("settings.pet_persona")}
        control={
          <Select
            value={preset}
            onChange={(v) => onPresetChange(v as PetPersonaPreset)}
            options={PET_PERSONA_PRESETS.map((p) => ({ value: p, label: t(`settings.pet_persona_${p}`) }))}
            ariaLabel={t("settings.pet_persona")}
            testid="settings-pet-persona"
            style={{ width: SETTINGS_CTRL_WIDTH }}
          />
        }
      />

      {/* 자유 편집 프롬프트는 preset=custom 일 때만 실제로 쓰인다(repo::pet::persona_prompt).
          PLAN-2026-09-12 §2(D2): 여기 있던 borderBottom 은 **옵션 행 아래 헤어라인**이었다 —
          위 페르소나 행에 딸린 입력이지 새 영역이 아니므로 선을 지운다. 행이 끝난다는 신호는
          이제 여백(--space-4 상하 패딩)이 낸다. */}
      {preset === "custom" && (
        <div style={{ padding: "var(--space-4) 0" }}>
          <textarea
            className="field"
            data-testid="settings-pet-persona-prompt"
            value={prompt}
            rows={4}
            maxLength={2000}
            placeholder={t("settings.pet_persona_prompt_placeholder")}
            onChange={(e) => onPromptChange(e.target.value)}
            onBlur={onPromptBlur}
            style={{ width: "100%", resize: "vertical" }}
          />
        </div>
      )}

      <SettingsRow
        label={t("settings.pet_chat_clear")}
        hint={t("settings.chat_history_hint")}
        control={
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            {onExtractInsights && (
              <IconAction
                icon={<IconSparkles size={16} />}
                label={t("settings.pet_chat_extract_insights_btn")}
                titleOverride={isExtractingInsights ? t("settings.pet_chat_extracting_insights") : undefined}
                busy={isExtractingInsights}
                onClick={onExtractInsights}
                disabled={isExtractingInsights}
                data-testid="settings-pet-chat-extract-insights"
              />
            )}
            <IconAction
              icon={<IconTrash size={16} />}
              label={t("settings.pet_chat_clear_btn")}
              danger
              onClick={onClearChat}
              data-testid="settings-pet-chat-clear-btn"
            />
          </div>
        }
      />
    </>
  );
}
