/**
 * stack — 계층 스택. 노드 배열 순서 = 위→아래, 전부 같은 x(왼쪽 정렬). 피라미드는 같은 배치에
 * `model.type === "pyramid"` 일 때만 가운데 정렬 — 라벨 길이가 곧 폭이라 층이 좁아지면 피라미드로 읽힌다
 * (ponytail: 배치는 크기를 못 바꾸므로 "폭 사다리"는 시드의 라벨이 만든다).
 */
import { NODE_H, NODE_W, type XY } from "../flowLayout";
import { LAYOUT_MARGIN, type LayoutResult, type Sizes } from "./_types";
import type { DiagramModel } from "../diagramSchema";

const GAP = 12;

export function stackLayout(model: DiagramModel, sizes: Sizes): LayoutResult {
  const positions: Record<string, XY> = {};
  const maxW = Math.max(0, ...model.nodes.map((n) => sizes[n.id]?.width ?? NODE_W));
  let y = LAYOUT_MARGIN;
  for (const n of model.nodes) {
    const s = sizes[n.id] ?? { width: NODE_W, height: NODE_H };
    const x = model.type === "pyramid" ? LAYOUT_MARGIN + Math.round((maxW - s.width) / 2) : LAYOUT_MARGIN;
    positions[n.id] = { x, y };
    y += s.height + GAP;
  }
  return { positions };
}
