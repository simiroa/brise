import React from "react";
import type { OnboardingScreen } from "../../stores/onboardingSession";
import { t } from "../../i18n/t";
import { IconArrowLeft } from "../icons";

const backLinkStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  background: "none",
  border: "none",
  padding: 0,
  color: "var(--muted)",
  fontSize: "var(--text-sm)",
  fontWeight: 400,
  cursor: "pointer",
};

/**
 * 모달 꼬리 — 화면/설정 쪽마다 뒤로·건너뛰기·주 버튼. 첫 화면은 꼬리가 없으므로 wizard 가 이걸 아예 안 그린다.
 * 동작은 전부 콜백으로 받는다(상태·저장은 wizard/onboardingFlow 몫).
 */
export function OnboardingFooter({
  screen,
  setupPage,
  starting,
  adopting,
  regionSelected,
  aiAdoptReady,
  onScreen,
  onSetupPage,
  onSkip,
  onRegionConfirm,
  onAiNext,
  onFinish,
}: {
  screen: OnboardingScreen;
  setupPage: number;
  starting: boolean;
  adopting: boolean;
  /** 3쪽(지역) 주 버튼 활성 조건 — 지역을 골랐는가 */
  regionSelected: boolean;
  /** 4쪽(AI) 주 버튼 라벨 — 연결 테스트가 성공해 채택 함수가 준비됐는가 */
  aiAdoptReady: boolean;
  onScreen: (s: OnboardingScreen) => void;
  onSetupPage: (n: number) => void;
  onSkip: () => void;
  onRegionConfirm: () => void;
  onAiNext: () => void;
  onFinish: () => void;
}) {
  const content =
    screen === "setup" ? (
      <>
        <button
          type="button"
          style={backLinkStyle}
          onClick={() => (setupPage === 1 ? onScreen("first") : onSetupPage(setupPage - 1))}
        >
          <IconArrowLeft size={14} />
          {setupPage === 1 ? t("onboarding.to_first") : t("onboarding.back")}
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          {/* 건너뛰기는 쪽마다 주 행동 바로 옆 같은 자리 — 저장 없이 다음 쪽으로(4쪽은 요약 화면으로). */}
          <button type="button" className="btn" onClick={onSkip} data-testid="onboarding-setup-skip">
            {t("onboarding.setup_skip")}
          </button>
          {setupPage === 1 && (
            <button type="button" className="btn btn-primary" onClick={() => onSetupPage(2)}>
              {t("onboarding.next")}
            </button>
          )}
          {setupPage === 2 && (
            <button type="button" className="btn btn-primary" onClick={() => onSetupPage(3)} data-testid="onboarding-setup-page2-next">
              {t("onboarding.next")}
            </button>
          )}
          {setupPage === 3 && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!regionSelected}
              onClick={onRegionConfirm}
              data-testid="onboarding-setup-page3-confirm"
            >
              {t("onboarding.setup_region_confirm")}
            </button>
          )}
          {setupPage === 4 && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={adopting}
              onClick={onAiNext}
              data-testid="onboarding-setup-page4-next"
            >
              {aiAdoptReady ? t("onboarding.aistep_adopt_next") : t("onboarding.next")}
            </button>
          )}
          {setupPage === 5 && (
            <button type="button" className="btn btn-primary" onClick={() => onScreen("done")} data-testid="onboarding-setup-page5-next">
              {t("onboarding.next")}
            </button>
          )}
        </div>
      </>
    ) : screen === "import" ? (
      <button type="button" style={backLinkStyle} onClick={() => onScreen("first")} data-testid="onboarding-import-back">
        <IconArrowLeft size={14} />
        {t("onboarding.to_first")}
      </button>
    ) : screen === "done" ? (
      <>
        <button type="button" style={backLinkStyle} onClick={() => onScreen("setup")}>
          <IconArrowLeft size={14} />
          {t("onboarding.back")}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={starting}
          onClick={onFinish}
          data-testid="onboarding-done-start"
        >
          {t("onboarding.setup_connect_finish")}
        </button>
      </>
    ) : null;

  return content ? <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>{content}</div> : null;
}
