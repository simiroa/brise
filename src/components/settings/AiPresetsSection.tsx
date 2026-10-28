import { AiActionEditor } from "../presets/AiActionEditor";
import { AiInternalInstructionsSection } from "./AiSettings";
import { t } from "../../i18n/t";
import { IconBookmark } from "../icons";
import { SettingsCard } from "./SettingsCard";

/**
 * AI 프리셋(커스텀 프롬프트) — **AI 기능 페이지 맨 아래**(2026-10-28, 오너: 별도 페이지일 이유가 없다).
 * 2026-09-27 에는 "설정에 프리셋 탭이 제대로 명시되지 않아 경험이 불완전하다" 며 자기 페이지를 받았지만, 기능 목록과 같은
 * 자리에 있으면 찾기도 쉽고 한 번에 훑을 수 있다. 옛 페이지 id(ai_presets)는 SettingsPanel 이 ai_features 로 보낸다.
 *
 * AI 가 꺼져 있어도 편집할 수 있다 — 프리셋은 AI 설정이 아니라 사용자의 문장이다(꺼짐 링크는 위 카탈로그가 이미 보인다).
 * 편집기는 앱 안 프리셋 모달의 「AI 프리셋」 탭과 **같은 컴포넌트**(AiActionEditor)다. 본 창의 AI 모달
 * 타일에 닿는 것은 settings-changed → useAiPresetsStore.load()(lib/settingsChanged.ts)가 맡는다.
 *
 * ponytail: 기능 목록과 같은 "표 형식"(이름·범위·표시·편집)으로 통일하는 일은 AiActionEditor 가 모달과 공유하는 편집기라
 * 이번엔 하지 않았다 — 설정 쪽 표 뷰를 따로 만들려면 편집 진입(행 클릭 → 편집기)을 설계해야 한다.
 *
 * 하단에는 Q5 확정안 (b) "앱 내부 지침" 고급 아코디언이 접혀 있다.
 */
export function AiPresetsSection() {
  return (
    <>
      <SettingsCard title={t("settings.page_ai_presets")} icon={<IconBookmark size={14} strokeWidth={2} />} anchor="ai_presets" testId="settings-ai-presets-card">
        <AiActionEditor />
      </SettingsCard>
      <AiInternalInstructionsSection />
    </>
  );
}
