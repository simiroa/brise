/**
 * lanes — 스윔레인. 그룹 = 레인(행, 그룹 배열 순서 = 위→아래). 레인 안 x 는 그룹을 뗀 채 dagre LR 로 구한
 * rank(`layoutBoxes`) — 레인이 달라도 같은 단계면 같은 x 에 선다. 같은 레인에서 x 가 겹치는 노드는 레인
 * 안에서 아래로 쌓는다. 레인 띠(y 대역)는 그룹 상자 패딩·제목 높이만큼 띄워 서로 겹치지 않는다.
 *
 * ponytail: 레인 상자는 멤버 bbox 에서 파생된다(`groupBoxes` 원칙) — "가로 띠 전체" 가 아니라 멤버를
 * 감싼 상자. 띠 전체가 필요해지면 `LayoutResult.groupBoxes?` 를 더한다. 그룹 없는 노드는 마지막 레인.
 */
import { DAGRE_NODESEP, GROUP_PAD, GROUP_TITLE_H, NODE_H, NODE_W, layoutBoxes, type XY } from "../flowLayout";
import { LAYOUT_MARGIN, type LayoutResult, type Sizes } from "./_types";
import type { DiagramModel } from "../diagramSchema";
import { membersByGroup } from "./_place";

export function lanesLayout(model: DiagramModel, sizes: Sizes): LayoutResult {
  const laneGap = GROUP_PAD * 2 + GROUP_TITLE_H + DAGRE_NODESEP / 2;
  const ranks = layoutBoxes(
    model.nodes.map((n) => ({ id: n.id, ...(sizes[n.id] ?? { width: NODE_W, height: NODE_H }) })),
    model.edges,
    "LR",
  );
  const positions: Record<string, XY> = {};
  let y = LAYOUT_MARGIN + GROUP_TITLE_H + GROUP_PAD;
  for (const lane of membersByGroup(model)) {
    const sorted = [...lane.nodes].sort((a, b) => (ranks[a.id]?.x ?? 0) - (ranks[b.id]?.x ?? 0));
    let laneH = 0;
    let prevRight = -Infinity;
    let stackY = 0;
    for (const n of sorted) {
      const s = sizes[n.id] ?? { width: NODE_W, height: NODE_H };
      const x = ranks[n.id]?.x ?? LAYOUT_MARGIN;
      // 같은 rank(가로로 겹침)는 아래로 쌓고, 다음 rank 부터 다시 맨 위.
      stackY = x < prevRight ? stackY : 0;
      positions[n.id] = { x, y: y + stackY };
      stackY += s.height + DAGRE_NODESEP / 2;
      laneH = Math.max(laneH, stackY - DAGRE_NODESEP / 2);
      prevRight = Math.max(prevRight, x + s.width);
    }
    y += laneH + laneGap;
  }
  return { positions };
}
