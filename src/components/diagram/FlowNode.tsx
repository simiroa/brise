import { useContext } from "react";
import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { IconLink } from "../icons";
import type { NodeShape } from "./diagramModel";
import type { DiagramTone } from "./diagramStyles";
import { InlineEditCtx } from "./useFlowInlineEdit";
import { DiagramInlineInput } from "./DiagramInlineInput";
import { hexagonPoints } from "./diagramStaticSvg";

export type BriseNodeData = {
  label: string;
  shape: NodeShape;
  tone: DiagramTone;
  tag?: string;
  state?: number;
  flag?: boolean;
  linked: boolean;
  /** The linked note is gone (deleted / trashed). Shown BEFORE the click, not after. */
  linkBroken: boolean;
  source: Position;
  target: Position;
  /** %% brise:meta — an emoji left of the label, one line of small print under it. */
  icon?: string;
  desc?: string;
  /** 구획 — 라벨 아래 구획선 밑에 한 줄씩(ER 컬럼, 클래스 멤버). */
  rows?: string[];
  dimmed?: boolean;
  /** `model.layout` — CSS 훅(`data-layout`). sequence 라이프라인 자체는 FlowCanvas 의 배경 레이어가 긋는다. */
  layout?: string;
};

export type BriseNode = Node<BriseNodeData, "brise">;

/**
 * BriseFlowNode
 *
 * 노드 렌더링 컴포넌트:
 * - 연결 핸들, 태그, 메타 아이콘, 라벨, 메타 설명, 구획, 링크 표시
 * - DiagramInlineInput 을 활용한 인라인 편집은 **라벨(이름)뿐** — 노드 더블클릭이 연다.
 *   배지·아이콘·설명·구획은 그리기만 한다(2026-10-19 버블 간소화, GRILL R6 — 편집은 소스 보기).
 */
export function BriseFlowNode({ id, data, selected, width, height }: NodeProps<BriseNode>) {
  const inlineCtx = useContext(InlineEditCtx);
  const edit = inlineCtx?.edit;
  const commit = inlineCtx?.commit;
  const cancel = inlineCtx?.cancel;

  const isEditingRename = edit?.kind === "rename" && edit.id === id;

  const hasTag = Boolean(data.tag);
  const hasIcon = Boolean(data.icon);
  const hasHeader = hasTag || hasIcon || data.linked;

  return (
    <div
      className="diagram-flow-node"
      data-shape={data.shape}
      data-tone={data.tone === "default" ? undefined : data.tone}
      data-state={data.state !== undefined ? data.state : undefined}
      data-flag={data.flag ? "true" : undefined}
      data-selected={selected || undefined}
      data-dimmed={data.dimmed ? "true" : undefined}
      data-desc={data.desc ? "" : undefined}
      data-has-header={hasHeader ? "true" : undefined}
      data-layout={data.layout}
    >
      {/* 육각형 테두리 — CSS border 는 clip-path 에 잘리므로 클립 경계 위에 polygon 을 긋는다(tokens.css 주석).
          크기는 FlowCanvas 가 노드에 박은 width/height(flowLayout::nodeSize) 그대로. */}
      {data.shape === "diamond" && width && height ? (
        <svg className="diagram-flow-node-shape" aria-hidden="true" data-testid="diagram-node-hexagon">
          <polygon points={hexagonPoints(0, 0, width, height)} />
        </svg>
      ) : null}
      {/* 4-way connection handles */}
      <Handle type="source" position={Position.Top} id="top" />
      <Handle type="source" position={Position.Right} id="right" />
      <Handle type="source" position={Position.Bottom} id="bottom" />
      <Handle type="source" position={Position.Left} id="left" />

      {/* Top Header: Tag chip, Icon, Link */}
      {hasHeader && (
        <div className="diagram-flow-node-header">
          <div className="diagram-flow-node-header-left">
            {data.icon ? <span className="diagram-flow-node-icon">{data.icon}</span> : null}
          </div>

          <div className="diagram-flow-node-header-right">
            {data.tag ? (
              <span className="diagram-flow-node-tag badge" data-tone="accent" data-testid="diagram-node-tag">
                {data.tag}
              </span>
            ) : null}

            {data.linked && (
              <IconLink
                size={11}
                strokeWidth={2.4}
                className="diagram-flow-node-link"
                data-broken={data.linkBroken || undefined}
              />
            )}
          </div>
        </div>
      )}

      {/* Center Body: Bold Label + Refined Sub Description */}
      <div className="diagram-flow-node-text">
        {isEditingRename ? (
          <DiagramInlineInput
            className="diagram-flow-node-label diagram-flow-node-label-input"
            testId="diagram-inline-rename"
            defaultValue={edit.value}
            selectOnFocus
            onCommit={(val) => commit?.(val)}
            onCancel={() => cancel?.()}
          />
        ) : (
          <span className="diagram-flow-node-label">{data.label}</span>
        )}

        {data.desc ? <span className="diagram-flow-node-desc">{data.desc}</span> : null}
      </div>

      {/* 구획(rows): 구획선 아래 한 줄 = 한 구획. 편집은 소스 보기에서. */}
      {data.rows?.length ? (
        <div className="diagram-flow-node-rows" data-testid="diagram-node-rows-list">
          {data.rows.map((row, i) => (
            <div key={i} className="diagram-flow-node-row">
              {row}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
