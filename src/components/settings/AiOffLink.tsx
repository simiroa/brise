import { useSettingsStore } from "../../stores/settings";
import { t } from "../../i18n/t";
import { linkBtn } from "./shared";

/**
 * AI 가 꺼져 있을 때 AI 페이지(권한·채팅) 맨 위에 서는 한 줄 — PLAN-2026-10-24 D7. 기능 페이지는 제공자 한 줄 요약이 같은 안내를 맡는다(AiCapabilityCatalog).
 *
 * **AI 마스터 스위치(`ai_enabled`)가 그려지는 곳은 정확히 하나다: AI 제공자(`ai`) 페이지 첫 줄**
 * (`AiProviderSection` 의 `settings-ai-master-card`). 예전에는 일반 페이지의 토글과 각 AI 페이지의 켜기 버튼
 * (`AiOffBanner`) 두 곳이 같은 키를 그렸다 — 이제 그 버튼은 없고, 이 줄이 `ai` 페이지로 가는 링크만 준다.
 * 켜기·끄기·`ensureAiReachable`·`ai_master` 기능 브리핑은 전부 그 한 줄이 맡는다.
 *
 * `ai` 페이지 자신에는 이 줄을 두지 않는다 — 마스터 행이 바로 거기 있다. `onNavigate` 가 없으면(단독 렌더)
 * 링크 없이 문구만 그린다. 훅은 조기 반환 위에 둔다(CLAUDE.md 함정 ①).
 */
export function AiOffLink({ onNavigate }: { onNavigate?: (page: string) => void }) {
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  if (aiEnabled) return null;

  return (
    <p
      data-testid="ai-off-link"
      style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--muted)", lineHeight: "var(--lh-ui)" }}
    >
      {t("settings.ai_off_link")}
      {onNavigate && (
        <>
          {" "}
          <button type="button" style={linkBtn} data-testid="ai-off-link-go" onClick={() => onNavigate("ai")}>
            {t("settings.ai_off_link_action")}
          </button>
        </>
      )}
    </p>
  );
}
