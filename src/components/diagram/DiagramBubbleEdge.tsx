/**
 * DiagramBubbleEdge — 플로팅 버블의 엣지 컨텍스트(라벨·선 모양·화살표·선 색상·삭제).
 * 위치 계산·바깥 클릭·조기 반환은 DiagramFloatingBubble 셸에 있고, 여기는 그 안에 그려질 항목만 쥔다.
 */
import type { MutableRefObject } from "react";
import { t } from "../../i18n/t";
import { IconEdit, IconGraph, IconMinimize, IconPalette, IconTrash } from "../icons";
import type { DiagramActions } from "./diagramActions";
import type { DiagramCanvasApi } from "./diagramCanvasApi";
import type { DiagramEdge, EdgeArrow, EdgeLine } from "./diagramModel";
import { edgeLineOptions, edgeArrowOptions } from "./verbs";
import { BubbleMenu, type BubbleMenuCtl } from "./DiagramBubbleMenu";
import { ToneSwatches } from "./ToneSwatches";

export interface DiagramBubbleEdgeProps {
  edge: DiagramEdge;
  actions: DiagramActions;
  apiRef?: MutableRefObject<DiagramCanvasApi | null>;
  menu: BubbleMenuCtl;
}

export function DiagramBubbleEdge({ edge, actions, apiRef, menu }: DiagramBubbleEdgeProps) {
  return (
    <>
      {/* 엣지 라벨 편집 */}
      <button
        type="button"
        className="diagram-floating-bubble-btn"
        title={t("editor.diagram_edge_label_placeholder")}
        aria-label={t("editor.diagram_edge_label_placeholder")}
        onClick={() => apiRef?.current?.openRelabel?.(edge)}
      >
        <IconEdit size={14} strokeWidth={2} />
      </button>

      {/* 선 모양(line) */}
      <BubbleMenu
        id="line"
        menu={menu}
        label={t("editor.diagram_edge_line")}
        icon={<IconMinimize size={14} strokeWidth={2} />}
      >
        {() =>
          edgeLineOptions().map((opt) => (
            <button
              key={opt.value}
              type="button"
              className="diagram-floating-bubble-dropdown-item"
              data-selected={edge.line === opt.value || (!edge.line && opt.value === "solid")}
              onClick={() => {
                actions.setEdgeLine(edge.id, opt.value as EdgeLine);
                menu.setActive(null);
              }}
            >
              {opt.label}
            </button>
          ))
        }
      </BubbleMenu>

      {/* 화살표 모양(arrow) */}
      <BubbleMenu
        id="arrow"
        menu={menu}
        label={t("editor.diagram_edge_arrow")}
        icon={<IconGraph size={14} strokeWidth={2} />}
      >
        {() =>
          edgeArrowOptions().map((opt) => (
            <button
              key={opt.value}
              type="button"
              className="diagram-floating-bubble-dropdown-item"
              data-selected={edge.arrow === opt.value || (!edge.arrow && opt.value === "end")}
              onClick={() => {
                actions.setEdgeArrow(edge.id, opt.value as EdgeArrow);
                menu.setActive(null);
              }}
            >
              {opt.label}
            </button>
          ))
        }
      </BubbleMenu>

      {/* 선 색상(Tone) */}
      <BubbleMenu
        id="edge-tone"
        menu={menu}
        label={t("editor.diagram_tone")}
        icon={<IconPalette size={14} strokeWidth={2} />}
        highlight={Boolean(edge.tone && edge.tone !== "default")}
      >
        {() => (
          <ToneSwatches
            current={edge.tone ?? "default"}
            onPick={(tone) => {
              actions.setEdgeTone(edge.id, tone);
              menu.setActive(null);
            }}
          />
        )}
      </BubbleMenu>

      <span className="diagram-floating-bubble-divider" />

      {/* 엣지 삭제 */}
      <button
        type="button"
        className="diagram-floating-bubble-btn danger"
        title={t("editor.diagram_delete")}
        aria-label={t("editor.diagram_delete")}
        onClick={() => actions.deleteEdge(edge.id)}
      >
        <IconTrash size={14} strokeWidth={2} />
      </button>
    </>
  );
}
