import { t } from "../../i18n/t";
import { IconSettings } from "../../components/icons";
import { IconAction } from "../../components/settings/IconAction";
import { openBriefingSettings, type SettingsTargetKey } from "../openSettings";

/** 카드 머리 우측의 조용한 설정 톱니(호버 때만 또렷해진다 — briefing.css). 이름은 카드별 i18n 키(gear_*). */
export function CardGear({ target, labelKey }: { target: SettingsTargetKey; labelKey: GearKey }) {
  return (
    <IconAction
      size="sm"
      className="brf-gear"
      icon={<IconSettings size={14} />}
      label={t(labelKey)}
      data-testid={`brf-gear-${target}`}
      onClick={() => void openBriefingSettings(target)}
    />
  );
}

// 정적 키 — i18n 미사용 검사가 문자열 리터럴로 본다.
export type GearKey = "briefing.gear_habits";
