/**
 * fishbone — 피시본. 머리 = 그룹 없는 첫 노드(없으면 첫 노드), 가장 오른쪽 척추 끝. 그룹 = 가시(원인 범주),
 * 그룹 배열 순서대로 척추 위/아래 교대, 왼쪽에서 오른쪽으로. 가시 안 노드는 척추에서 바깥으로 쌓이며 행마다
 * 머리 쪽으로 살짝 밀려(SLANT) 사선 가시로 읽힌다. 척추 y = 머리 중심 y. 머리 외 그룹 없는 노드는 마지막 가시.
 *
 * ponytail: 척추·가시 선은 그리지 않는다 — 시드의 엣지(원인 → 머리)가 그 선이다.
 */
import { DAGRE_NODESEP, DAGRE_RANKSEP, GROUP_PAD, GROUP_TITLE_H, NODE_H, NODE_W, type XY } from "../flowLayout";
import { LAYOUT_MARGIN, type LayoutResult, type Sizes } from "./_types";
import type { DiagramModel } from "../diagramSchema";
import { membersByGroup } from "./_place";

const SLANT = 24;

export function fishboneLayout(model: DiagramModel, sizes: Sizes): LayoutResult {
  if (!model.nodes.length) return { positions: {} };
  /** 척추와 가시 상자 사이 여백 — 파생 상자(GROUP_PAD, 위쪽은 +GROUP_TITLE_H)가 척추를 넘지 않게. */
  const spineClear = GROUP_TITLE_H + GROUP_PAD + 8;
  const size = (id: string) => sizes[id] ?? { width: NODE_W, height: NODE_H };
  const head = model.nodes.find((n) => !n.group) ?? model.nodes[0];
  const bones = membersByGroup(model)
    .map((g) => ({ ...g, nodes: g.nodes.filter((n) => n.id !== head.id) }))
    .filter((g) => g.nodes.length);

  const boneW = Math.max(NODE_W, ...bones.flatMap((b) => b.nodes.map((n) => size(n.id).width)));
  const rowH = Math.max(NODE_H, ...bones.flatMap((b) => b.nodes.map((n) => size(n.id).height))) + DAGRE_NODESEP / 2;
  const maxRows = Math.max(1, ...bones.map((b) => b.nodes.length));
  const spineY = LAYOUT_MARGIN + maxRows * rowH + spineClear;
  const pitch = boneW + maxRows * SLANT + GROUP_PAD * 2 + DAGRE_NODESEP;

  const positions: Record<string, XY> = {};
  bones.forEach((bone, i) => {
    const above = i % 2 === 0;
    const bx = LAYOUT_MARGIN + GROUP_PAD + Math.floor(i / 2) * pitch;
    bone.nodes.forEach((n, row) => {
      const x = bx + row * SLANT;
      const y = above ? spineY - spineClear - (row + 1) * rowH + DAGRE_NODESEP / 2 : spineY + spineClear + row * rowH;
      positions[n.id] = { x: Math.round(x), y: Math.round(y) };
    });
  });
  const pairs = Math.ceil(bones.length / 2);
  positions[head.id] = {
    x: LAYOUT_MARGIN + GROUP_PAD + Math.max(0, pairs - 1) * pitch + boneW + maxRows * SLANT + GROUP_PAD + DAGRE_RANKSEP,
    y: Math.round(spineY - size(head.id).height / 2),
  };
  return { positions };
}
