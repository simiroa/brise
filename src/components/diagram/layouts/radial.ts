/**
 * radial — 트리를 방사형으로. 루트 = 들어오는 엣지 없는 노드(여럿이면 첫 노드), 자식 = from→to 를 따라간
 * BFS. 깊이 d 는 반지름 d·ring 의 원 위에, 각 서브트리는 잎 수에 비례한 부채꼴을 받는다(형제끼리 겹치지
 * 않고 부모 바로 바깥에 자식이 선다).
 *
 * ponytail: 루트에서 닿지 않는 노드는 루트의 자식으로 붙인다(빈 화면보다 낫다). 부채꼴이 잎 수 비례라
 * 비대칭 트리에선 루트가 bbox 중심에서 벗어날 수 있다 — 대칭 트리(별)에서만 정확히 중심.
 */
import { DAGRE_RANKSEP, NODE_W, type XY } from "../flowLayout";
import { LAYOUT_MARGIN, type LayoutResult, type Sizes } from "./_types";
import type { DiagramModel } from "../diagramSchema";
import { shiftToMargin } from "./_place";

export function radialLayout(model: DiagramModel, sizes: Sizes): LayoutResult {
  const nodes = model.nodes;
  if (!nodes.length) return { positions: {} };
  const incoming = new Set(model.edges.filter((e) => e.from !== e.to).map((e) => e.to));
  const root = nodes.find((n) => !incoming.has(n.id)) ?? nodes[0];

  const children = new Map<string, string[]>();
  const seen = new Set([root.id]);
  const queue = [root.id];
  while (queue.length) {
    const id = queue.shift()!;
    const kids: string[] = [];
    for (const e of model.edges) {
      if (e.from === id && !seen.has(e.to)) {
        seen.add(e.to);
        kids.push(e.to);
        queue.push(e.to);
      }
    }
    children.set(id, kids);
  }
  for (const n of nodes) {
    if (!seen.has(n.id)) {
      seen.add(n.id);
      children.get(root.id)!.push(n.id);
      children.set(n.id, []);
    }
  }

  const leaves = (id: string): number => {
    const kids = children.get(id) ?? [];
    return kids.length ? kids.reduce((sum, c) => sum + leaves(c), 0) : 1;
  };
  const ring = Math.max(...nodes.map((n) => sizes[n.id]?.width ?? NODE_W)) + DAGRE_RANKSEP;
  const centers: Record<string, XY> = { [root.id]: { x: 0, y: 0 } };
  const place = (id: string, depth: number, a0: number, a1: number) => {
    const kids = children.get(id) ?? [];
    const total = leaves(id);
    let a = a0;
    for (const c of kids) {
      const span = ((a1 - a0) * leaves(c)) / total;
      const mid = a + span / 2;
      centers[c] = { x: depth * ring * Math.cos(mid), y: depth * ring * Math.sin(mid) };
      place(c, depth + 1, a, a + span);
      a += span;
    }
  };
  place(root.id, 1, -Math.PI / 2, 1.5 * Math.PI);

  const positions: Record<string, XY> = {};
  for (const n of nodes) {
    const c = centers[n.id];
    const s = sizes[n.id] ?? { width: NODE_W, height: 0 };
    positions[n.id] = { x: c.x - s.width / 2, y: c.y - s.height / 2 };
  }
  return { positions: shiftToMargin(positions, LAYOUT_MARGIN) };
}
