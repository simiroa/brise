/**
 * DiagramBubbleNode — 플로팅 버블의 노드 컨텍스트. 위치 계산·바깥 클릭·조기 반환은
 * DiagramFloatingBubble 셸에 있고, 여기는 그 안에 그려질 항목만 쥔다.
 *
 * 항목은 일부러 적다(GRILL-2026-10-19 R6 "간단히"): 글자 붙은 **색 칩 한 줄** · 모양 · 노드 추가 · AI · 삭제.
 * - 색 칩 = 예전의 강조 표시(톤)·상태·강조 플래그 셋을 합친 것. 셋은 같은 두 필드(`flag`·`state`)를
 *   쓰므로 따로 둘 이유가 없었다. 칩 이름은 범례(DiagramLegend)와 같은 식(`nodeMarkOptions`)이다.
 *   칩을 고르면 그 표시 하나가 되고(다른 표시는 지운다, ONE 쓰기), 이미 켜진 칩을 다시 누르면 꺼진다.
 * - 이름 변경은 노드 더블클릭(평문 글자 편집)이 한다 — 버튼을 따로 두지 않는다.
 * - 빠진 것: 여기서 연결 시작(노드 테두리 손잡이 끌기가 연결이다) · 배지 · 아이콘 · 설명 · 구획.
 *   기존 노드의 tag·icon·desc·rows 는 계속 그려지고 저장 구조도 그대로다 — 편집은 소스 보기에서.
 */
import type { CSSProperties, MutableRefObject } from "react";
import { t } from "../../i18n/t";
import { IconPlus, IconTrash, IconMaximize, IconAi } from "../icons";
import type { DiagramActions } from "./diagramActions";
import type { DiagramCanvasApi } from "./diagramCanvasApi";
import type { DiagramModel, DiagramNode, NodeShape } from "./diagramModel";
import { nodeMarkOptions, type NodeMark } from "./diagramStyles";
import { shapeOptions } from "./verbs";
import { layoutPositions } from "./flowLayout";
import { BubbleMenu, type BubbleMenuCtl } from "./DiagramBubbleMenu";

export interface DiagramBubbleNodeProps {
  node: DiagramNode;
  model: DiagramModel;
  actions: DiagramActions;
  apiRef?: MutableRefObject<DiagramCanvasApi | null>;
  menu: BubbleMenuCtl;
  /** AskAiModal 과 그 열림 상태는 셸이 쥔다(선택이 바뀌어도 열림이 유지되던 기존 수명 그대로). */
  onAskAi: () => void;
}

/** 이 칩이 지금 켜져 있는가. 강조와 상태가 둘 다 걸린 옛 노드는 두 칩이 함께 켜진다. */
function isMarkActive(node: DiagramNode, mark: NodeMark): boolean {
  if (mark === null) return !node.flag && node.state === undefined;
  if (mark === "flag") return Boolean(node.flag);
  return node.state === mark;
}

export function DiagramBubbleNode({ node, model, actions, apiRef, menu, onAskAi }: DiagramBubbleNodeProps) {
  // 노드 빠른 하류 분기 생성
  const handleBranchOut = () => {
    const positions = layoutPositions(model);
    const curPos = positions[node.id] ?? { x: 0, y: 0 };
    const isHorizontal = model.direction === "LR" || model.direction === "RL";
    const delta = model.direction === "RL" ? -220 : 220;
    const newPos = isHorizontal
      ? { x: curPos.x + delta, y: curPos.y }
      : { x: curPos.x, y: curPos.y + (model.direction === "BT" ? -100 : 100) };

    const defaultLabel = "새 노드";
    const newNodeId = actions.addConnected(node.id, defaultLabel, newPos);
    if (newNodeId) {
      apiRef?.current?.openRename?.(newNodeId);
    }
  };

  // 켜진 칩을 다시 누르면 그 표시 하나만 끈다(강조·상태가 둘 다 걸린 옛 노드에서 다른 하나는 남는다).
  const pickMark = (mark: NodeMark, active: boolean) => {
    if (!active) {
      actions.setNodeMark(node.id, mark);
    } else if (mark === "flag") {
      actions.setNodeFlag(node.id, false);
    } else if (typeof mark === "number") {
      actions.setNodeState(node.id, undefined);
    }
    // 켜진 '기본'은 지울 것이 없다 — 아무것도 쓰지 않는다.
  };

  return (
    <>
      {/* 색 칩 한 줄 — 기본 · 강조 · 상태 이름들. 이름·색은 범례와 같은 출처. */}
      <div className="diagram-bubble-marks" role="group" aria-label={t("editor.diagram_tone")} data-testid="diagram-mark-chips">
        {nodeMarkOptions(model, node).map((opt) => {
          const active = isMarkActive(node, opt.mark);
          const key = opt.mark === null ? "default" : String(opt.mark);
          return (
            <button
              key={key}
              type="button"
              className="diagram-bubble-mark"
              data-testid={`diagram-mark-${key}`}
              data-selected={active ? "true" : undefined}
              aria-pressed={active}
              // 켜진 칩의 배지 틴트 색(tokens.css `.badge` 블록, R8) — 범례 켜진 칩과 같은 규칙. 기본은 색이 없어 --muted.
              style={{ "--badge-c": opt.colorVar ?? "var(--muted)" } as CSSProperties}
              onClick={() => pickMark(opt.mark, active)}
            >
              <span
                className="diagram-legend-marker diagram-bubble-mark-dot"
                data-empty={opt.colorVar ? undefined : "true"}
                style={opt.colorVar ? { color: opt.colorVar } : undefined}
                aria-hidden="true"
              />
              <span>{opt.label}</span>
            </button>
          );
        })}
      </div>

      <span className="diagram-floating-bubble-divider" />

      {/* 모양 변경 */}
      <BubbleMenu
        id="shape"
        menu={menu}
        label={t("editor.diagram_shape")}
        icon={<IconMaximize size={14} strokeWidth={2} />}
      >
        {() =>
          shapeOptions().map((opt) => (
            <button
              key={opt.value}
              type="button"
              className="diagram-floating-bubble-dropdown-item"
              data-selected={node.shape === opt.value || (!node.shape && opt.value === "rect")}
              onClick={() => {
                actions.setShapeDefault(opt.value as NodeShape);
                actions.setNodeShape(node.id, opt.value as NodeShape);
                menu.setActive(null);
              }}
            >
              {opt.label}
            </button>
          ))
        }
      </BubbleMenu>

      {/* 새 노드 분기 생성 */}
      <button
        type="button"
        className="diagram-floating-bubble-btn"
        title={t("editor.diagram_add_node_tooltip")}
        aria-label={t("editor.diagram_branch_downstream")}
        onClick={handleBranchOut}
      >
        <IconPlus size={14} strokeWidth={2} />
      </button>

      {/* 스마트 AI 액션 버튼 — 클릭 시 AskAiModal 즉시 오픈. 라벨은 앱 AI 아이콘이다:
          ✨ 이모지는 OS 컬러 폰트로 그려져 이 줄의 단색 아이콘들 사이에서 혼자 튀었다. */}
      <button
        type="button"
        className="diagram-floating-bubble-btn diagram-floating-bubble-ai-btn"
        data-testid="diagram-ai-btn"
        title={t("editor.diagram_ai_assistant")}
        aria-label={t("editor.diagram_ai_assistant")}
        onClick={onAskAi}
      >
        <IconAi size={14} />
        <span>AI</span>
      </button>

      <span className="diagram-floating-bubble-divider" />

      {/* 삭제 */}
      <button
        type="button"
        className="diagram-floating-bubble-btn danger"
        title={t("editor.diagram_delete")}
        aria-label={t("editor.diagram_delete")}
        onClick={() => actions.deleteNode(node.id)}
      >
        <IconTrash size={14} strokeWidth={2} />
      </button>
    </>
  );
}
