import { call } from "../lib/invoke";
import { t } from "../i18n/t";
import { IconNewspaper } from "../components/icons";

/** 프레임의 브리핑 버튼 — 알림 벨(ReminderBell)과 별개로 브리핑 창만 연다(오너 2026-10-01). 데스크톱 전용(호출처가 거른다). */
export function BriefingButton() {
  const open = async () => {
    try {
      await call("briefing_window_open", {});
    } catch {
      // silent-ok: call() 이 이미 토스트+진단 로그를 남겼다(사용자 행동이라 토스트가 맞다).
    }
  };
  return (
    <button
      type="button"
      className="icon-btn"
      data-testid="frame-briefing-btn"
      title={t("home.briefing_open")}
      aria-label={t("home.briefing_open")}
      onClick={() => void open()}
    >
      <IconNewspaper size={16} strokeWidth={1.8} />
    </button>
  );
}
