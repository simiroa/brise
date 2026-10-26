import { IconClose } from "../icons";
import { t } from "../../i18n/t";

/**
 * OS 창 크롬(메인 창 스트립, AuxWindowChrome)이 공유하는 닫기 버튼. 아이콘·크기·hit area는
 * 여기서 고정한다 — 창마다 눈에 보이는 X가 미묘하게 달랐던 문제(오너 지적)의 원인이
 * 호출부마다 스타일을 따로 먹였던 것이었다. 다시 갈라지지 않도록 스타일 prop은 두지 않고,
 * 창마다 다른 **동작**(main: close() → invoke.ts의 onCloseRequested → flush + close_to_tray
 * 분기 / aux: hide() 직접 호출)만 onClose로 받는다.
 * 30x30 hit area·radius-sm·danger 호버는 새 CSS가 아니라 기존 icon-btn/icon-btn--danger
 * 관례를 그대로 재사용한 것(tokens.css) — 앱 전역에서 이미 검증된 클릭 표적 크기다.
 */
export function WindowCloseButton(props: { onClose: () => void; testId?: string }) {
  return (
    <button
      type="button"
      className="icon-btn icon-btn--danger"
      onClick={props.onClose}
      title={t("window.close")}
      aria-label={t("window.close")}
      data-testid={props.testId}
    >
      <IconClose size={14} strokeWidth={2} />
    </button>
  );
}
