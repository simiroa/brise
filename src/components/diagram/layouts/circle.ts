/**
 * circle — 원형 루프/플라이휠. 첫 노드에서 시작해 엣지(from→to)를 따라간 순서로 원주 위에 시계 방향
 * (12시부터). 막히면 배열 순서상 다음 미방문 노드로 이어 붙인다. 반지름은 노드들이 원주에서 겹치지
 * 않는 최소값(둘레 = n·(최대 폭 + NODESEP)).
 */
import { DAGRE_NODESEP, NODE_H, NODE_W, type XY } from "../flowLayout";
import { LAYOUT_MARGIN, type LayoutResult, type Sizes } from "./_types";
import type { DiagramModel } from "../diagramSchema";
import { shiftToMargin } from "./_place";

/** 엣지를 따라간 방문 순서 — circle 이 쓰고, 같은 규약이 필요한 배치가 생기면 재사용. */
export function edgeWalkOrder(model: DiagramModel): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    seen.add(id);
    order.push(id);
    const next = model.edges.find((e) => e.from === id && !seen.has(e.to));
    if (next) visit(next.to);
  };
  for (const n of model.nodes) if (!seen.has(n.id)) visit(n.id);
  return order;
}

export function circleLayout(model: DiagramModel, sizes: Sizes): LayoutResult {
  const order = edgeWalkOrder(model);
  const n = order.length;
  if (!n) return { positions: {} };
  const maxW = Math.max(...order.map((id) => sizes[id]?.width ?? NODE_W));
  const r = Math.max((n * (maxW + DAGRE_NODESEP)) / (2 * Math.PI), NODE_W);
  const positions: Record<string, XY> = {};
  order.forEach((id, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const s = sizes[id] ?? { width: NODE_W, height: NODE_H };
    positions[id] = { x: r * Math.cos(a) - s.width / 2, y: r * Math.sin(a) - s.height / 2 };
  });
  return { positions: shiftToMargin(positions, LAYOUT_MARGIN) };
}
