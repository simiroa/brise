import { t } from "../../i18n/t";
import { IconClose } from "../icons";
import type { ReachDirection } from "./diagramReach";

export interface DiagramReachBannerProps {
  nodeLabel: string;
  direction: ReachDirection;
  onChangeDirection: (dir: ReachDirection) => void;
  onClose: () => void;
}

/**
 * DiagramReachBanner
 *
 * 연결 도달(Reachability) 분석 모드 상단 배너 컴포넌트:
 * - 현재 타깃 노드 라벨 표시
 * - 상류(upstream), 하류(downstream), 양방향(both) 전환 버튼 제공
 * - 닫기 버튼으로 리더 모드 해제
 */
export function DiagramReachBanner({
  nodeLabel,
  direction,
  onChangeDirection,
  onClose,
}: DiagramReachBannerProps) {
  return (
    <div className="diagram-canvas-float diagram-reach-banner" data-testid="diagram-reach-bar">
      <span className="diagram-reach-title">
        {t("editor.diagram_reach")}: <strong>{nodeLabel}</strong>
      </span>
      <div className="diagram-reach-actions">
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          data-testid="diagram-reach-btn-upstream"
          data-active={direction === "upstream" ? "true" : undefined}
          onClick={() => onChangeDirection("upstream")}
        >
          {t("editor.diagram_reach_upstream")}
        </button>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          data-testid="diagram-reach-btn-downstream"
          data-active={direction === "downstream" ? "true" : undefined}
          onClick={() => onChangeDirection("downstream")}
        >
          {t("editor.diagram_reach_downstream")}
        </button>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          data-testid="diagram-reach-btn-both"
          data-active={direction === "both" ? "true" : undefined}
          onClick={() => onChangeDirection("both")}
        >
          {t("editor.diagram_reach_both")}
        </button>
        <button
          type="button"
          className="icon-btn icon-btn--sm diagram-reach-close"
          data-testid="diagram-reach-close"
          onClick={onClose}
          aria-label={t("common.close")}
        >
          <IconClose size={13} />
        </button>
      </div>
    </div>
  );
}
