/**
 * DiagramBubbleMulti — 플로팅 버블의 다중 선택 컨텍스트(스마트 정렬·일괄 톤/모양·할일 추출·그룹화·삭제).
 * 위치 계산·바깥 클릭·조기 반환은 DiagramFloatingBubble 셸에 있고, 여기는 그 안에 그려질 항목만 쥔다.
 */
import type { MutableRefObject } from "react";
import { t } from "../../i18n/t";
import { IconAlignLeft, IconCheck, IconFolderPlus, IconMaximize, IconPalette, IconTrash } from "../icons";
import type { DiagramActions } from "./diagramActions";
import type { DiagramCanvasApi } from "./diagramCanvasApi";
import type { DiagramModel, NodeShape } from "./diagramModel";
import { shapeOptions } from "./verbs";
import { ARRANGE_TOOLS } from "./DiagramToolbar";
import { extractTodosFromDiagram, copyTodosToClipboard } from "./diagramAi";
import { BubbleMenu, type BubbleMenuCtl } from "./DiagramBubbleMenu";
import { nodeMarkOptions } from "./diagramStyles";

export interface DiagramBubbleMultiProps {
  model: DiagramModel;
  selectedBoxIds: string[];
  actions: DiagramActions;
  apiRef?: MutableRefObject<DiagramCanvasApi | null>;
  menu: BubbleMenuCtl;
}

export function DiagramBubbleMulti({ model, selectedBoxIds, actions, apiRef, menu }: DiagramBubbleMultiProps) {
  return (
    <>
      <span className="diagram-multi-count" data-testid="diagram-floating-multi-count">
        {t("editor.diagram_n_selected", { n: selectedBoxIds.length })}
      </span>

      <span className="diagram-floating-bubble-divider" />

      {/* 스마트 정렬 툴 */}
      <BubbleMenu
        id="multi-align"
        menu={menu}
        label={t("editor.diagram_align_tools")}
        icon={<IconAlignLeft size={14} strokeWidth={2} />}
      >
        {() =>
          ARRANGE_TOOLS.map((tool) => (
            <button
              key={tool.id}
              type="button"
              className="diagram-floating-bubble-dropdown-item"
              onClick={() => {
                apiRef?.current?.arrange?.(tool.plan, selectedBoxIds);
                menu.setActive(null);
              }}
            >
              {tool.icon}
              <span>{t(tool.labelKey)}</span>
            </button>
          ))
        }
      </BubbleMenu>

      {/* 일괄 색 표시 — 단일 노드 버블의 색 칩과 같은 이름·색(nodeMarkOptions = 범례, GRILL-2026-10-19 R6/R7),
          선택한 노드 전부에 한 번 쓰기(되돌리기 한 단계). */}
      <BubbleMenu
        id="multi-tone"
        menu={menu}
        label={t("editor.diagram_tone")}
        icon={<IconPalette size={14} strokeWidth={2} />}
      >
        {() => (
          <div className="diagram-bubble-marks" role="group" aria-label={t("editor.diagram_tone")} data-testid="diagram-multi-mark-chips">
            {nodeMarkOptions(model, { flag: model.nodes.some((n) => n.flag && selectedBoxIds.includes(n.id)) }).map((opt) => {
              const key = opt.mark === null ? "default" : String(opt.mark);
              return (
                <button
                  key={key}
                  type="button"
                  className="diagram-bubble-mark"
                  data-testid={`diagram-multi-mark-${key}`}
                  onClick={() => {
                    actions.setNodesMark(selectedBoxIds, opt.mark);
                    menu.setActive(null);
                  }}
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
        )}
      </BubbleMenu>

      {/* 일괄 모양(Shape) 변경 */}
      <BubbleMenu
        id="multi-shape"
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
              onClick={() => {
                actions.setShapeDefault(opt.value as NodeShape);
                selectedBoxIds.forEach((id) => actions.setNodeShape(id, opt.value as NodeShape));
                menu.setActive(null);
              }}
            >
              <span>{opt.label}</span>
            </button>
          ))
        }
      </BubbleMenu>

      <span className="diagram-floating-bubble-divider" />

      {/* 할일(체크리스트) 추출 버튼 */}
      <button
        type="button"
        className="diagram-floating-bubble-btn"
        data-testid="diagram-extract-todos"
        title={t("editor.diagram_extract_todos") || "할일(체크리스트) 추출"}
        aria-label={t("editor.diagram_extract_todos") || "할일(체크리스트) 추출"}
        onClick={async () => {
          const text = extractTodosFromDiagram(model, selectedBoxIds);
          if (text) {
            await copyTodosToClipboard(text);
          }
        }}
      >
        <IconCheck size={14} strokeWidth={2} />
      </button>

      {/* 일괄 그룹화 버튼 */}
      <button
        type="button"
        className="diagram-floating-bubble-btn"
        title={t("editor.diagram_group_create")}
        aria-label={t("editor.diagram_group_create")}
        onClick={() => actions.addGroup("새 그룹", selectedBoxIds)}
      >
        <IconFolderPlus size={14} strokeWidth={2} />
      </button>

      {/* 일괄 삭제 버튼 */}
      <button
        type="button"
        className="diagram-floating-bubble-btn danger"
        title={t("editor.diagram_delete")}
        aria-label={t("editor.diagram_delete")}
        onClick={() => selectedBoxIds.forEach((id) => actions.deleteNode(id))}
      >
        <IconTrash size={14} strokeWidth={2} />
      </button>
    </>
  );
}
