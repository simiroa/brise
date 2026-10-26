import { AiActionEditor } from "../presets/AiActionEditor";
import { AiOffLink } from "./AiOffLink";
import { groupCardStyle } from "./shared";
import { AiInternalInstructionsSection } from "./AiSettings";

/**
 * 설정 > AI > AI 프리셋(2026-09-27, 오너: "설정에 프리셋 탭이 제대로 명시되지 않아 경험이 불완전하다").
 *
 * 예전엔 편집기가 AI > 기능 페이지의 카드 버튼 → 모달 안 탭으로 네 단계 깊이에 있었고, 그 카드는 AI 가
 * 꺼져 있으면 통째로 숨어 들어갈 길 자체가 없었다. 이제 레일에 이름이 보이는 페이지이고, AI 가 꺼져
 * 있어도 편집할 수 있다(AI 제공자로 가는 링크 한 줄만 위에 선다) — 프리셋은 AI 설정이 아니라 사용자의 문장이다.
 *
 * 편집기는 앱 안 프리셋 모달의 「AI 프리셋」 탭과 **같은 컴포넌트**(AiActionEditor)다. 본 창의 AI 모달
 * 타일에 닿는 것은 settings-changed → useAiPresetsStore.load()(lib/settingsChanged.ts)가 맡는다.
 * 설정은 앱 전역이라(노트북 키 아님) `notebookScoped` 를 넘기지 않는다 — 히어로에 "앱 전체" 칩이 선다.
 *
 * 하단에는 Q5 확정안 (b) "앱 내부 지침" 고급 아코디언이 접혀 있다.
 */
export function AiPresetsSection({ onNavigate }: { onNavigate?: (page: string) => void } = {}) {
  return (
    <>
      <AiOffLink onNavigate={onNavigate} />
      <div className="card" style={groupCardStyle} data-testid="settings-ai-presets-card">
        <AiActionEditor />
      </div>
      <AiInternalInstructionsSection />
    </>
  );
}

