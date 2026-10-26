/**
 * flowElements — 모델(JSON IR) → React Flow 요소 투영의 순수 산수.
 *
 * FlowCanvas.tsx 의 `useMemo` 본문들이 여기로 나왔다(docs/PLAN-2026-09-13-separation-of-concerns.md
 * §4-j 의 후속 — W2a/W2b 로 사분면 축·시퀀스 분기가 얹히며 잔여 오케스트레이터가 다시 불어났다).
 * **메모 자체는 컴포넌트에 남아 있고**(deps 배열이 캐시 규율이라 그대로다), 본문만 이 파일의 함수
 * 호출 한 줄이 됐다. 그래서 여기 있는 것은 전부 "입력 → 배열" 순수 함수다 — 상태도 ref 도 없다.
 *
 * `flowNodes` 는 **일부러 옮기지 않았다**: 넘겨야 할 값이 10개(model·positions·sizes·boxes·
 * toRelative·selection·initialSelectedBoxIds·missingNotes·dimmedIds + `actions.nodeTone` 콜백)라
 * 함수 시그니처가 컴포넌트 상태의 재진술이 된다 — 같은 문서 §1 이 말하는 억지 분리다.
 */
import type { Edge } from "@xyflow/react";
import type { DiagramModel } from "./diagramModel";
import type { Selection } from "./diagramActions";
import type { DiagramTone } from "./diagramStyles";
import type { LayoutResult } from "./flowLayout";
import { NODE_H, NODE_W, type LayoutBox, type XY } from "./flowLayout";
import { edgeOffsets, type Rect } from "./flowEdgePath";
import { groupNodeId, type BriseGroupNode } from "./FlowGroup";
import { strokeOf } from "./FlowEdge";

type Sizes = Record<string, { width: number; height: number }>;

/** ABSOLUTE → React Flow 가 원하는 부모 상대 좌표. 그룹 경계의 단 하나뿐인 변환. */
export type ToRelative = (at: XY, group: string | undefined) => XY;

/** Our own arrowheads, in our own <defs>: React Flow's `MarkerType` machinery bakes the colour into
 *  the marker's DOM id, which cannot survive `var(--divider)`. `auto-start-reverse` makes ONE
 *  marker serve both ends, which is what bidirectional needs. */
export const ARROW_ID = "brise-flow-arrow";
export const arrowMarkerId = (tone?: DiagramTone): string => {
  if (tone && tone !== "default") return `brise-flow-arrow-${tone}`;
  return ARROW_ID;
};

/**
 * React Flow demands a parent BEFORE its children in the array, so groups come first, outermost
 * first. A frame is selectable now that it carries verbs (이름 변경 / 그룹 해제); the selection
 * itself still lives in the app's `Selection`, not in React Flow's own flag, so it survives a
 * re-projection like every other single selection here.
 * `draggable` stays on — dragging the frame is how you move a whole group, and React Flow carries
 * the children along for free because their coordinates are relative to it.
 */
export function buildFlowGroups(
  groups: DiagramModel["groups"],
  boxes: Record<string, LayoutBox>,
  toRelative: ToRelative,
  selection: Selection,
  membersOf: (id: string) => string[],
  onSelectMembers: (memberIds: string[]) => void,
): BriseGroupNode[] {
  const depth = (g: (typeof groups)[number]): number => {
    let d = 0;
    let cur = g;
    while (cur.parent && d < groups.length) {
      const up = groups.find((x) => x.id === cur.parent);
      if (!up) break;
      cur = up;
      d += 1;
    }
    return d;
  };
  return groups
    .filter((g) => boxes[g.id])
    .sort((a, b) => depth(a) - depth(b))
    .map((g, idx) => {
      const members = membersOf(g.id);
      return {
        id: groupNodeId(g.id),
        type: "briseGroup" as const,
        position: toRelative({ x: boxes[g.id].x, y: boxes[g.id].y }, g.parent && boxes[g.parent] ? g.parent : undefined),
        width: boxes[g.id].width,
        height: boxes[g.id].height,
        ...(g.parent && boxes[g.parent] ? { parentId: groupNodeId(g.parent) } : {}),
        selected: selection?.kind === "group" && selection.id === g.id,
        data: {
          title: g.title,
          tone: g.tone,
          step: groups.length >= 2 ? idx + 1 : undefined,
          members,
          onSelectMembers,
        },
      };
    });
}

/** 선이 피해 다닐 상자들 — 노드의 현재 자리(배치 결과 없으면 소스의 `pos`)와 크기. */
export function buildObstacles(
  nodes: DiagramModel["nodes"],
  positions: Record<string, XY>,
  sizes: Sizes,
): Rect[] {
  return nodes.map((n) => {
    const pos = positions[n.id] ?? { x: n.pos?.[0] ?? 0, y: n.pos?.[1] ?? 0 };
    const sz = sizes[n.id] ?? { width: NODE_W, height: NODE_H };
    return { x: pos.x, y: pos.y, width: sz.width, height: sz.height };
  });
}

export function buildFlowEdges(
  edges: DiagramModel["edges"],
  route: DiagramModel["route"],
  selection: Selection,
  dimmedIds: ReadonlySet<string> | null,
  obstacles: Rect[],
  seq: LayoutResult | null,
): Edge[] {
  // Fan parallel and round-trip relations apart; a lone edge gets 0 and stays a straight line.
  const offsets = edgeOffsets(edges.map((e) => ({ id: e.id, source: e.from, target: e.to })));
  return edges.map((e) => {
    const isEdgeDimmed = dimmedIds !== null && !dimmedIds.has(e.id);
    const line = e.line ?? (e.style === "dotted" ? "dotted" : e.style === "thick" ? "thick" : "solid");
    const arrow = e.arrow ?? (e.style === "bidirectional" ? "both" : e.style === "open" ? "none" : "end");
    const markerId = arrowMarkerId(e.tone);
    return {
      id: e.id,
      type: "brise" as const,
      source: e.from,
      target: e.to,
      sourceHandle: e.sourceHandle,
      targetHandle: e.targetHandle,
      label: e.label || undefined,
      selected: selection?.kind === "edge" && selection.id === e.id,
      markerEnd: arrow === "none" ? undefined : markerId,
      markerStart: arrow === "both" ? markerId : undefined,
      style: strokeOf(line, e.style),
      className: "diagram-flow-edge",
      data: {
        offset: offsets[e.id] ?? 0,
        dimmed: isEdgeDimmed,
        route,
        line,
        arrow,
        tone: e.tone,
        obstacles,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
        anchorY: seq?.edgeAnchors?.[e.id]?.y,
      },
    };
  });
}
