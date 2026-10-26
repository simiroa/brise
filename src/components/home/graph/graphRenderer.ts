import type { Edge } from "@xyflow/react";
import type { DashboardGraphEdge, DashboardGraphNode } from "./graphSimulation";

export type CustomEdgeData = {
  edge: DashboardGraphEdge;
  color: string;
  selectActive: boolean;
  selectDim: boolean;
  searchDim: boolean;
  nodeHovered?: boolean;
  justCreated?: boolean;
  hovered?: boolean;
  onCut?: (edge: DashboardGraphEdge) => void;
};

export type Pt = { x: number; y: number };

export const NODE_HALF = 12;

export function isPairJustCreated(
  source: string,
  target: string,
  justCreatedKeys?: Set<string>,
  justCreatedPair?: { source: string; target: string } | null,
): boolean {
  if (justCreatedKeys && justCreatedKeys.size > 0) {
    if (justCreatedKeys.has(`${source}:${target}`) || justCreatedKeys.has(`${target}:${source}`)) {
      return true;
    }
  }
  if (justCreatedPair != null) {
    if (
      (source === justCreatedPair.source && target === justCreatedPair.target) ||
      (source === justCreatedPair.target && target === justCreatedPair.source)
    ) {
      return true;
    }
  }
  return false;
}

export function isNodeJustConnected(
  nodeId: string,
  justCreatedKeys?: Set<string>,
  justCreatedPair?: { source: string; target: string } | null,
): boolean {
  if (justCreatedKeys && justCreatedKeys.size > 0) {
    for (const key of justCreatedKeys) {
      const parts = key.split(":");
      if (nodeId === parts[0] || nodeId === parts[1]) return true;
    }
  }
  if (justCreatedPair != null) {
    if (nodeId === justCreatedPair.source || nodeId === justCreatedPair.target) return true;
  }
  return false;
}

export function graphEdges(
  edges: DashboardGraphEdge[],
  selectedId: string | null,
  searchHits: Set<string> | null,
  colors: Map<string, string>,
  nodes: DashboardGraphNode[],
  hoveredEdgeId: string | null,
  hoveredNodeId?: string | null,
  justCreatedKeys?: Set<string>,
  justCreatedPair?: { source: string; target: string } | null,
  onCutEdge?: (edge: DashboardGraphEdge) => void,
): Edge<CustomEdgeData>[] {
  const folderByNode = new Map(nodes.map((node) => [node.id, node.folder_id]));
  return edges.map((edge) => {
    const id = `${edge.kind}:${edge.source}:${edge.target}`;
    const color = colors.get(folderByNode.get(edge.source) ?? "") ?? "var(--muted)";
    const searchDim = searchHits !== null && !searchHits.has(edge.source) && !searchHits.has(edge.target);
    const selectActive = selectedId != null && (edge.source === selectedId || edge.target === selectedId);
    const nodeHovered = hoveredNodeId != null && (edge.source === hoveredNodeId || edge.target === hoveredNodeId);
    const selectDim = selectedId != null && !selectActive;
    const isJustCreated = isPairJustCreated(edge.source, edge.target, justCreatedKeys, justCreatedPair);
    const cls = [
      "graph-edge",
      `graph-edge--${edge.kind}`,
      selectActive ? "graph-edge--active" : "",
      nodeHovered ? "graph-edge--node-hovered" : "",
      selectDim || searchDim ? "graph-edge--dimmed" : "",
      isJustCreated ? "graph-edge--just-created" : "",
    ].filter(Boolean).join(" ");
    return {
      id,
      source: edge.source,
      target: edge.target,
      type: "graphEdge",
      className: cls,
      data: {
        edge,
        color,
        selectActive,
        selectDim,
        searchDim,
        nodeHovered,
        justCreated: isJustCreated,
        hovered: hoveredEdgeId === id,
        onCut: onCutEdge,
      },
      style: {
        stroke: edge.kind === "backlink" ? color : `color-mix(in srgb, ${color} 72%, var(--muted))`,
        strokeWidth: (edge.kind === "backlink" ? 1.15 + Math.min(edge.weight, 300) / 750 : 0.9 + Math.min(edge.weight, 100) / 400)
          * (selectActive ? 1.35 : nodeHovered ? 1.2 : 1),
      },
    };
  });
}

/**
 * 두 선분이 만나는 **점**을 돌려준다(안 만나면 null).
 */
export function segmentIntersection(p1: Pt, p2: Pt, p3: Pt, p4: Pt): Pt | null {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (d === 0) return null;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
}
