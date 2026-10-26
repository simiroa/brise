import { useMemo, type CSSProperties } from "react";
import { t } from "../../i18n/t";
import { IconClose, IconFlag, IconFolder, IconLink, IconShapes } from "../icons";
import type { DiagramModel } from "./diagramSchema";
import { flagLabelOf, stateSlotDef } from "./diagramStyles";

export interface DiagramLegendProps {
  model: DiagramModel;
  selectedStates?: Set<number> | null;
  onToggleState?: (idx: number, isShift: boolean) => void;
  flagFilter?: boolean;
  onToggleFlag?: () => void;
  hoveredTarget?: number | "flag" | null;
  onHoverTarget?: (target: number | "flag" | null) => void;
  hoveredState?: number | null;
  onHoverState?: (idx: number | null) => void;
  onClearFilter?: () => void;
}

/**
 * DiagramLegend — 캔버스 상단 중앙에 떠 있는 통계 + 상태 필터 칩.
 *
 * - 통계(상자/관계/그룹)는 **항상** 보인다. 예전에는 states 도 flag 도 없으면 이 줄 전체가
 *   사라져서, 상태를 쓰지 않는 관계도에서는 개수조차 볼 수 없었다. 칩만 조건부다.
 * - 문구는 `editor.diagram_count_*` 를 상태바·미리보기와 함께 쓴다 — 예전엔 이 파일만
 *   "3개 노드 / 2개 연결" 이라는 자기만의 한국어 문자열을 하드코딩했다(번역도 없었다).
 * - 이름은 노드 버블의 색 칩(DiagramBubbleNode · diagramStyles.nodeMarkOptions)과 같다 — 상태는
 *   `model.states[i]`, 강조는 `flagLabelOf(model)`, 색은 `stateSlotDef(i).colorVar` (GRILL-2026-10-19 R7).
 * - 켜진 칩은 그 색의 배지 틴트로 칠한다(인라인 `--badge-c`, tokens.css `.badge` 블록 — R8). 노드 버블의
 *   켜진 색 칩과 같은 규칙이다.
 * - 아이콘은 앱 아이콘 세트다. 📦/🔗/🚩/✕ 이모지를 쓰던 자리인데, 컬러 이모지가 이 칩만
 *   OS 폰트로 튀어 앱 분위기를 깼다. 상태 스와치도 같은 이유로 `■` 글자 대신 CSS 사각형이다.
 */
export function DiagramLegend({
  model,
  selectedStates,
  onToggleState,
  flagFilter,
  onToggleFlag,
  hoveredTarget: propHoveredTarget,
  onHoverTarget: propOnHoverTarget,
  hoveredState,
  onHoverState,
  onClearFilter,
}: DiagramLegendProps) {
  const effectiveHoveredTarget = propHoveredTarget !== undefined ? propHoveredTarget : (hoveredState ?? null);
  const handleHover = (target: number | "flag" | null) => {
    propOnHoverTarget?.(target);
    onHoverState?.(typeof target === "number" ? target : null);
  };
  const { counts, flagCount } = useMemo(() => {
    const res: Record<number, number> = {};
    let flags = 0;
    for (const n of model.nodes) {
      if (n.state !== undefined) {
        res[n.state] = (res[n.state] ?? 0) + 1;
      }
      if (n.flag) {
        flags++;
      }
    }
    return { counts: res, flagCount: flags };
  }, [model.nodes]);

  const hasStates = Boolean(model.states && model.states.length > 0);
  const hasFlags = flagCount > 0;
  const hasItems = hasStates || hasFlags;

  const hasActiveFilter = Boolean(
    (selectedStates && selectedStates.size > 0) || flagFilter
  );

  if (model.nodes.length === 0 && model.edges.length === 0) return null;

  return (
    <div className="diagram-canvas-float diagram-flow-legend" data-testid="diagram-legend">
      <span className="diagram-legend-summary" data-testid="diagram-legend-summary">
        <IconShapes size={12} />
        {t("editor.diagram_count_nodes", { n: model.nodes.length })}
        <span className="diagram-legend-sep">·</span>
        <IconLink size={12} />
        {t("editor.diagram_count_edges", { n: model.edges.length })}
        {model.groups.length > 0 && (
          <>
            <span className="diagram-legend-sep">·</span>
            <IconFolder size={12} />
            {t("editor.diagram_count_groups", { n: model.groups.length })}
          </>
        )}
      </span>
      {hasItems && <span className="diagram-legend-sep">|</span>}
      {hasStates &&
        model.states!.map((name, idx) => {
          const slot = stateSlotDef(idx);
          const count = counts[idx] ?? 0;
          const isSelected = selectedStates ? selectedStates.has(idx) : false;
          const isHovered = effectiveHoveredTarget === idx;
          return (
            <button
              key={idx}
              type="button"
              className="diagram-legend-item"
              data-testid={`diagram-legend-chip-${idx}`}
              data-active={isSelected ? "true" : undefined}
              data-hovered={isHovered ? "true" : undefined}
              aria-pressed={isSelected}
              style={{ "--badge-c": slot.colorVar } as CSSProperties}
              onMouseEnter={() => handleHover(idx)}
              onMouseLeave={() => handleHover(null)}
              onClick={(e) => onToggleState?.(idx, e.shiftKey)}
            >
              {idx > 0 && <span className="diagram-legend-sep"> · </span>}
              <span className="diagram-legend-marker" style={{ color: slot.colorVar }} aria-hidden="true" />{" "}
              {name} {count}
            </button>
          );
        })}
      {hasFlags && (
        <button
          type="button"
          className="diagram-legend-item"
          data-testid="diagram-legend-chip-flag"
          data-active={flagFilter ? "true" : undefined}
          data-hovered={effectiveHoveredTarget === "flag" ? "true" : undefined}
          aria-pressed={flagFilter}
          style={{ "--badge-c": "var(--accent)" } as CSSProperties}
          onMouseEnter={() => handleHover("flag")}
          onMouseLeave={() => handleHover(null)}
          onClick={() => onToggleFlag?.()}
        >
          {hasStates && <span className="diagram-legend-sep"> · </span>}
          <IconFlag size={12} />{" "}
          {flagLabelOf(model)} {flagCount}
        </button>
      )}
      {hasActiveFilter && onClearFilter && (
        <button
          type="button"
          className="diagram-legend-clear"
          data-testid="diagram-legend-clear"
          onClick={onClearFilter}
        >
          <IconClose size={11} />
          {t("editor.diagram_legend_clear")}
        </button>
      )}
    </div>
  );
}
