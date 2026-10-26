import { useSettingsStore, type PetDblclickAction } from "../../../stores/settings";
import { t } from "../../../i18n/t";
import { Select } from "../../Select";
import { groupCardStyle } from "../shared";
import { SectionHeader } from "../SectionHeader";
import { SettingsRow } from "../SettingsRow";
import { IconMousePointerClick } from "../../icons";

/**
 * 설정 > 펫 — "동작" 그룹. 더블클릭 동작(펫 소유)과 페르소나 **링크 행**.
 * 페르소나는 사이드바 챗 소유라 AI > 채팅에 산다(PET.md §0.2) — 여기선 그리로 가는 길만 둔다.
 */
export function PetReactionSection({ onNavigate }: { onNavigate?: (page: string) => void }) {
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  const petDblclickAction = useSettingsStore((s) => s.petDblclickAction);
  const setPetDblclickAction = useSettingsStore((s) => s.setPetDblclickAction);

  const dblclickOptions = [
    { value: "chat", label: t("settings.pet_action_chat") },
    { value: "new_note", label: t("settings.pet_action_new_note") },
    { value: "off", label: t("settings.pet_action_off") },
  ];

  return (
    <div className="card" style={groupCardStyle} data-testid="settings-pet-reaction-section">
      <SectionHeader title={t("settings.pet_group_behavior")} icon={<IconMousePointerClick size={14} strokeWidth={2} />} />
      <SettingsRow
        label={t("settings.pet_dblclick_action")}
        hint={!aiEnabled ? t("settings.pet_action_chat_disabled_hint") : undefined}
        control={
          <Select
            value={petDblclickAction}
            onChange={(v) => void setPetDblclickAction(v as PetDblclickAction)}
            options={dblclickOptions}
            ariaLabel={t("settings.pet_dblclick_action")}
            testid="settings-pet-dblclick-action"
            style={{ minWidth: 160 }}
          />
        }
      />
      {onNavigate && (
        <SettingsRow
          label={t("settings.pet_persona")}
          hint={t("settings.pet_persona_link_hint")}
          control={
            <button
              type="button"
              className="btn"
              data-testid="settings-pet-persona-link"
              onClick={() => onNavigate("ai_chat")}
            >
              {t("settings.pet_persona_open")}
            </button>
          }
        />
      )}
    </div>
  );
}
