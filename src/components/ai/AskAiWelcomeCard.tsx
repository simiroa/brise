import { t } from "../../i18n/t";
import { call } from "../../lib/invoke";
import type { AiDataDest } from "./askAiTypes";

/**
 * AI 모달 첫 실행 시 오른쪽 요청문 상자 자리에 띄우는 환영·활용·데이터 안내 카드 (PLAN-2026-09-27 §3.6).
 * 처음 한 번만 보이며, 헤더의 `?` 버튼으로 언제든 다시 열 수 있다.
 */
export function AskAiWelcomeCard({
  dest,
  onStart,
}: {
  /** null = 아직 모름 → 외부 문장(askAiTypes AiDataDest). */
  dest?: AiDataDest | null;
  onStart: () => void;
}) {
  const isExternal = dest?.external ?? true;
  const dataNotice = isExternal
    ? t("ai.welcome_data_external", { provider: dest?.name || t("ai.welcome_provider_unknown") })
    : t("ai.welcome_data_local");

  const openSettings = async () => {
    try {
      await call("settings_window_open", { page: "ai" });
    } catch {
      // call() 이 실패 시 토스트를 띄움
    }
  };

  return (
    <div className="askai-welcome-card" data-testid="askai-welcome-card">
      <div className="askai-welcome-card__head">
        {t("ai.welcome_title")}
      </div>
      <div className="askai-welcome-card__body">
        <p className="askai-welcome-card__step">{t("ai.welcome_step_1")}</p>
        <p className="askai-welcome-card__step">{t("ai.welcome_step_2")}</p>
        <p className="askai-welcome-card__step">{t("ai.welcome_step_3")}</p>
        <p className="askai-welcome-card__step">{t("ai.welcome_step_4")}</p>
      </div>
      <div className="askai-welcome-card__divider" />
      <div className="askai-welcome-card__footer">
        <div className="askai-welcome-card__data">
          <span>{dataNotice}</span>
          <button
            type="button"
            className="btn btn--sm askai-welcome-card__settings-btn"
            onClick={() => void openSettings()}
            data-testid="askai-welcome-settings"
          >
            {t("aiResult.first_brief_open_settings")}
          </button>
        </div>
        <button
          type="button"
          className="btn btn--sm btn-primary askai-welcome-card__start-btn"
          onClick={onStart}
          data-testid="askai-welcome-start"
        >
          {t("ai.welcome_start_button")}
        </button>
      </div>
    </div>
  );
}
