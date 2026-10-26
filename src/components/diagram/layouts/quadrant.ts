/**
 * quadrant — 사분면. 그룹 4개 = 사분면(배열 순서 좌상·우상·좌하·우하). 각 사분면 안은 ceil(sqrt n) 열의
 * 작은 격자. 사분면 칸 크기는 넷 중 가장 큰 것으로 통일해 2×2 가 반듯하다. 축 십자와 `axes` 라벨은
 * 렌더러가 그룹 상자에서 파생한다(`flowLayout.ts::quadrantAxes`). 그룹 없는 노드는 다섯 번째 칸(아래).
 *
 * ponytail: 그룹이 4개를 넘으면 5번째부터는 3행 이후로 흘러내린다 — 사분면은 4개가 규약이다.
 */
import { DAGRE_NODESEP, GROUP_PAD, GROUP_TITLE_H, NODE_H, NODE_W, type XY } from "../flowLayout";
import { LAYOUT_MARGIN, type LayoutResult, type Sizes } from "./_types";
import type { DiagramModel } from "../diagramSchema";
import { membersByGroup } from "./_place";

export function quadrantLayout(model: DiagramModel, sizes: Sizes): LayoutResult {
  const cellGap = GROUP_PAD * 2 + DAGRE_NODESEP;
  const cells = membersByGroup(model);
  if (!cells.length) return { positions: {} };
  const size = (id: string) => sizes[id] ?? { width: NODE_W, height: NODE_H };
  const inner = DAGRE_NODESEP / 2;
  const plans = cells.map((c) => {
    const cols = Math.max(1, Math.ceil(Math.sqrt(c.nodes.length)));
    const w = Math.max(NODE_W, ...c.nodes.map((n) => size(n.id).width));
    const h = Math.max(NODE_H, ...c.nodes.map((n) => size(n.id).height));
    const rows = Math.max(1, Math.ceil(c.nodes.length / cols));
    return { cols, w, h, rows };
  });
  const cellW = Math.max(...plans.map((p) => p.cols * (p.w + inner) - inner));
  const cellH = Math.max(...plans.map((p) => p.rows * (p.h + inner) - inner));
  const positions: Record<string, XY> = {};
  cells.forEach((c, i) => {
    const p = plans[i];
    const ox = LAYOUT_MARGIN + GROUP_PAD + (i % 2) * (cellW + cellGap);
    const oy = LAYOUT_MARGIN + GROUP_TITLE_H + GROUP_PAD + Math.floor(i / 2) * (cellH + cellGap + GROUP_TITLE_H);
    c.nodes.forEach((n, k) => {
      positions[n.id] = { x: ox + (k % p.cols) * (p.w + inner), y: oy + Math.floor(k / p.cols) * (p.h + inner) };
    });
  });
  return { positions };
}
