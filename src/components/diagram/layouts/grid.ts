/**
 * grid — 여정/스토리맵. 그룹 = 열(단계, 그룹 배열 순서 = 좌→우), 그룹 안 노드 배열 순서 = 행(위→아래).
 * 행 높이는 전체 최대 노드 높이로 통일해 열 사이 행이 맞는다. 그룹 상자는 멤버에서 파생되므로
 * (`groupBoxes`) 열 간격에 GROUP_PAD 두 배를 더해 상자끼리 닿지 않는다. 그룹 없는 노드는 마지막 열.
 */
import { DAGRE_NODESEP, GROUP_PAD, GROUP_TITLE_H, NODE_H, NODE_W, type XY } from "../flowLayout";
import { LAYOUT_MARGIN, type LayoutResult, type Sizes } from "./_types";
import type { DiagramModel } from "../diagramSchema";
import { membersByGroup } from "./_place";

export function gridLayout(model: DiagramModel, sizes: Sizes): LayoutResult {
  const positions: Record<string, XY> = {};
  const rowH = Math.max(NODE_H, ...model.nodes.map((n) => sizes[n.id]?.height ?? NODE_H)) + DAGRE_NODESEP / 2;
  let x = LAYOUT_MARGIN + GROUP_PAD;
  for (const col of membersByGroup(model)) {
    const colW = Math.max(NODE_W, ...col.nodes.map((n) => sizes[n.id]?.width ?? NODE_W));
    col.nodes.forEach((n, row) => {
      positions[n.id] = { x, y: LAYOUT_MARGIN + GROUP_TITLE_H + GROUP_PAD + row * rowH };
    });
    x += colW + GROUP_PAD * 2 + DAGRE_NODESEP;
  }
  return { positions };
}
