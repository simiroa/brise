import type { ReactNode } from "react";
import { t } from "../../i18n/t";
import type { LoadStatus } from "../hooks/useBriefingData";
import { CardGear, type GearKey } from "./CardAction";
import type { SettingsTargetKey } from "../openSettings";

/**
 * 카드 공통 틀 — 공용 `.card`(칠 없음 · --divider 헤어라인 · --radius-md, tokens.css)에 머리 한 줄.
 * PLAN-2026-10-19 §7(R1-C): 브리핑 고유 카드 표면(.brf-card 34% 채움 + 그림자)은 걷어냈다 — 메인 창 본문과
 * 같은 관계다. 안쪽 여백만 briefing.css 가 갖는다. 머리 위계는 굵기가 아니라 크기(--text-section).
 */
export function CardShell(props: {
  title: string;
  /** 머리 오른쪽 요약(예: "2/4"). */
  aside?: ReactNode;
  /** 머리 오른쪽 톱니의 설정 목적지 + 툴팁 키. 생략 = 톱니 없음. */
  gear?: { target: SettingsTargetKey; labelKey: GearKey };
  testId: string;
  className?: string;
  /** 머리 줄 자체를 다른 요소로(접기 버튼 등) 바꿀 때. */
  head?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className={`card brf-card ${props.className ?? ""}`} data-testid={props.testId} aria-label={props.title}>
      {props.head ?? (
        <div className="brf-card-head">
          <h2 className="brf-card-title">{props.title}</h2>
          {(props.aside || props.gear) && (
            <span className="brf-card-aside">
              {props.aside}
              {props.gear && <CardGear {...props.gear} />}
            </span>
          )}
        </div>
      )}
      {props.children}
    </section>
  );
}

/** 로딩·오류 한 줄 — 카드가 조용히 비지 않게 한다(빈 상태는 카드가 자기 문구로). */
export function CardStatus({ status, onRetry }: { status: LoadStatus; onRetry?: () => void }) {
  if (status === "loading") return <div className="brf-state" role="status">{t("briefing.loading")}</div>;
  if (status === "error")
    return (
      <div className="brf-state" role="alert">
        {t("briefing.load_failed")}
        {onRetry && (
          <button type="button" className="brf-link-btn" onClick={onRetry}>
            {t("briefing.retry")}
          </button>
        )}
      </div>
    );
  return null;
}
