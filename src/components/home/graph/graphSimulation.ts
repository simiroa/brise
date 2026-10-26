import type { Node } from "@xyflow/react";
import type { GraphEdge, GraphNode, GraphResult } from "../../../lib/commands.gen";
// 라벨 폭 추정은 GraphCanvas 가 실제로 그리는 글자와 같아야 한다 — 같은 판정(센티널 "Untitled Note" 포함).
import { displayTitle } from "../../../stores/notes";

export type DashboardGraphNode = GraphNode;
export type DashboardGraphEdge = GraphEdge;
export type DashboardGraphResult = GraphResult;

export type GraphNodeData = {
  item: DashboardGraphNode;
  color: string;
  labelled: boolean;
  size: number;
  searchDim: boolean;
  searchHit: boolean;
  justConnected?: boolean;
  selectionIndex?: number;
};
export type GraphFlowNode = Node<GraphNodeData, "note">;

export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export function stringHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0) / 4294967295;
}

/** A double-clicked node becomes the ego centre; one hop is enough for the v1 relationship trail. */
export function egoGraph(result: DashboardGraphResult, centreId: string | null): DashboardGraphResult {
  if (!centreId) return result;
  const ids = new Set([centreId]);
  for (const edge of result.edges) {
    if (edge.source === centreId) ids.add(edge.target);
    if (edge.target === centreId) ids.add(edge.source);
  }
  return {
    ...result,
    nodes: result.nodes.filter((node) => ids.has(node.id)),
    edges: result.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
  };
}

export function orderFoldersByLinkDensity(
  groups: Map<string, DashboardGraphNode[]>,
  edges: DashboardGraphEdge[] = [],
): [string, DashboardGraphNode[]][] {
  const folderIds = [...groups.keys()];
  if (folderIds.length <= 2) {
    folderIds.sort((a, b) => (groups.get(b)?.length ?? 0) - (groups.get(a)?.length ?? 0) || a.localeCompare(b));
    return folderIds.map((id) => [id, groups.get(id)!]);
  }

  const nodeFolder = new Map<string, string>();
  for (const [folderId, folderNodes] of groups) {
    for (const node of folderNodes) {
      nodeFolder.set(node.id, folderId);
    }
  }

  const linkCounts = new Map<string, Map<string, number>>();
  const getLinkCount = (f1: string, f2: string): number => {
    return linkCounts.get(f1)?.get(f2) ?? 0;
  };
  const addLink = (f1: string, f2: string) => {
    if (f1 === f2) return;
    let m1 = linkCounts.get(f1);
    if (!m1) {
      m1 = new Map();
      linkCounts.set(f1, m1);
    }
    m1.set(f2, (m1.get(f2) ?? 0) + 1);

    let m2 = linkCounts.get(f2);
    if (!m2) {
      m2 = new Map();
      linkCounts.set(f2, m2);
    }
    m2.set(f1, (m2.get(f1) ?? 0) + 1);
  };

  for (const edge of edges) {
    const fA = nodeFolder.get(edge.source);
    const fB = nodeFolder.get(edge.target);
    if (fA && fB && fA !== fB) {
      addLink(fA, fB);
    }
  }

  const totalLinks = (f: string) => {
    let sum = 0;
    const m = linkCounts.get(f);
    if (m) {
      for (const count of m.values()) sum += count;
    }
    return sum;
  };

  const compareFolders = (a: string, b: string) => {
    const linkDiff = totalLinks(b) - totalLinks(a);
    if (linkDiff !== 0) return linkDiff;
    const countDiff = (groups.get(b)?.length ?? 0) - (groups.get(a)?.length ?? 0);
    if (countDiff !== 0) return countDiff;
    return a.localeCompare(b);
  };

  folderIds.sort(compareFolders);

  const topFolder = folderIds[0];
  const placed: string[] = [topFolder];
  const remaining = new Set(folderIds.slice(1));

  while (remaining.size > 0) {
    let bestCand = "";
    let bestGain = -Infinity;
    let bestAdjacentSum = -Infinity;
    let bestInsertIdx = -1;

    for (const cand of remaining) {
      for (let i = 0; i < placed.length; i += 1) {
        const left = placed[i];
        const right = placed[(i + 1) % placed.length];

        const oldD = placed.length > 1 ? getLinkCount(left, right) : 0;
        const newD = getLinkCount(left, cand) + getLinkCount(cand, right);
        const gain = newD - oldD;
        const adjSum = getLinkCount(left, cand) + getLinkCount(cand, right);

        if (gain > bestGain) {
          bestGain = gain;
          bestAdjacentSum = adjSum;
          bestCand = cand;
          bestInsertIdx = i;
        } else if (gain === bestGain) {
          if (adjSum > bestAdjacentSum) {
            bestAdjacentSum = adjSum;
            bestCand = cand;
            bestInsertIdx = i;
          } else if (adjSum === bestAdjacentSum) {
            if (!bestCand || compareFolders(cand, bestCand) < 0) {
              bestCand = cand;
              bestInsertIdx = i;
            }
          }
        }
      }
    }

    if (!bestCand) {
      const cand = [...remaining].sort(compareFolders)[0];
      for (let i = 0; i < placed.length; i += 1) {
        const left = placed[i];
        const right = placed[(i + 1) % placed.length];
        const oldD = placed.length > 1 ? getLinkCount(left, right) : 0;
        const newD = getLinkCount(left, cand) + getLinkCount(cand, right);
        const gain = newD - oldD;
        const adjSum = getLinkCount(left, cand) + getLinkCount(cand, right);
        if (gain > bestGain) {
          bestGain = gain;
          bestAdjacentSum = adjSum;
          bestInsertIdx = i;
        } else if (gain === bestGain) {
          if (adjSum > bestAdjacentSum) {
            bestAdjacentSum = adjSum;
            bestInsertIdx = i;
          }
        }
      }

      placed.splice(bestInsertIdx + 1, 0, cand);
      remaining.delete(cand);
      continue;
    }

    placed.splice(bestInsertIdx + 1, 0, bestCand);
    remaining.delete(bestCand);
  }

  const topIdx = placed.indexOf(topFolder);
  if (topIdx > 0) {
    const rotated = [...placed.slice(topIdx), ...placed.slice(0, topIdx)];
    return rotated.map((id) => [id, groups.get(id)!]);
  }

  return placed.map((id) => [id, groups.get(id)!]);
}

export function constellationNodes(
  nodes: DashboardGraphNode[],
  folderColor: (id: string) => string,
  edges: DashboardGraphEdge[] = [],
): GraphFlowNode[] {
  const labelled = new Set(nodes.map((node) => node.id));

  const connectedNodes = nodes.filter((node) => node.degree > 0);
  const isolatedNodes = nodes.filter((node) => node.degree === 0);

  // 1. Connected nodes: cluster by folder around center (0, 0)
  const connectedGroups = new Map<string, DashboardGraphNode[]>();
  for (const node of connectedNodes) {
    connectedGroups.set(node.folder_id, [...(connectedGroups.get(node.folder_id) ?? []), node]);
  }
  const connectedFolders = orderFoldersByLinkDensity(connectedGroups, edges);
  const spacingFor = (count: number) => (count <= 12 ? 46 : count <= 50 ? 23 : 17);
  const largestCluster = Math.max(
    0,
    ...connectedFolders.map(
      ([, items]) => spacingFor(items.length) * Math.sqrt(Math.max(0, items.length - 1)) + 18,
    ),
  );
  const clusterRadius =
    connectedFolders.length <= 1
      ? 0
      : (largestCluster * 2 + 80) / (2 * Math.sin(Math.PI / connectedFolders.length));

  const connectedFlowNodes: GraphFlowNode[] = connectedFolders.flatMap(
    ([folderId, items], folderIndex) => {
      const clusterAngle = -Math.PI / 2 + (folderIndex * Math.PI * 2) / connectedFolders.length;
      const centre = {
        x: Math.cos(clusterAngle) * clusterRadius,
        y: Math.sin(clusterAngle) * clusterRadius,
      };
      const spacing = spacingFor(items.length);
      const seed = stringHash(folderId) * Math.PI * 2;
      return [...items]
        .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id))
        .map((item, index) => {
          const radius = spacing * Math.sqrt(index);
          const angle = seed + index * GOLDEN_ANGLE;
          const size = Math.max(7, Math.min(18, 7 + Math.sqrt(item.degree) * 1.8));
          return {
            id: item.id,
            type: "note",
            position: {
              x: centre.x + Math.cos(angle) * radius - 12,
              y: centre.y + Math.sin(angle) * radius - 12,
            },
            data: {
              item,
              color: folderColor(folderId),
              labelled: labelled.has(item.id),
              size,
              searchDim: false,
              searchHit: false,
            },
          };
        });
    },
  );

  // If no isolated nodes, return connected nodes
  if (isolatedNodes.length === 0) {
    return connectedFlowNodes;
  }

  // 2. Isolated nodes: gathered in a dedicated perimeter orbit around the constellation
  if (connectedNodes.length === 0) {
    const isoGroups = new Map<string, DashboardGraphNode[]>();
    for (const node of isolatedNodes) {
      isoGroups.set(node.folder_id, [...(isoGroups.get(node.folder_id) ?? []), node]);
    }
    const isoFolders = [...isoGroups.entries()].sort((a, b) => b[1].length - a[1].length);
    const isoClusterRadius =
      isoFolders.length <= 1 ? 0 : (24 * Math.sqrt(isolatedNodes.length) + 60) / 2;

    return isoFolders.flatMap(([folderId, items], folderIndex) => {
      const clusterAngle = -Math.PI / 2 + (folderIndex * Math.PI * 2) / isoFolders.length;
      const centre = {
        x: Math.cos(clusterAngle) * isoClusterRadius,
        y: Math.sin(clusterAngle) * isoClusterRadius,
      };
      const seed = stringHash(folderId) * Math.PI * 2;
      return items.map((item, index) => {
        const radius = 22 * Math.sqrt(index);
        const angle = seed + index * GOLDEN_ANGLE;
        return {
          id: item.id,
          type: "note",
          position: {
            x: centre.x + Math.cos(angle) * radius - 12,
            y: centre.y + Math.sin(angle) * radius - 12,
          },
          data: {
            item,
            color: folderColor(folderId),
            labelled: labelled.has(item.id),
            size: 7.5,
            searchDim: false,
            searchHit: false,
          },
        };
      });
    });
  }

  const maxConnectedR = Math.max(
    0,
    ...connectedFlowNodes.map((n) => Math.hypot(n.position.x + 12, n.position.y + 12)),
  );
  const baseOrbitR = maxConnectedR + 70;

  const sortedIsoNodes = [...isolatedNodes].sort((a, b) => {
    const fc = a.folder_id.localeCompare(b.folder_id);
    return fc !== 0 ? fc : a.id.localeCompare(b.id);
  });

  const nodesPerRing = Math.max(20, Math.floor((2 * Math.PI * baseOrbitR) / 26));

  const isolatedFlowNodes: GraphFlowNode[] = sortedIsoNodes.map((item, index) => {
    const ringIndex = Math.floor(index / nodesPerRing);
    const ringPos = index % nodesPerRing;
    const ringRadius = baseOrbitR + ringIndex * 28;
    const angle = -Math.PI / 2 + (ringPos * 2 * Math.PI) / nodesPerRing;

    return {
      id: item.id,
      type: "note",
      position: {
        x: Math.cos(angle) * ringRadius - 12,
        y: Math.sin(angle) * ringRadius - 12,
      },
      data: {
        item,
        color: folderColor(item.folder_id),
        labelled: labelled.has(item.id),
        size: 7.5,
        searchDim: false,
        searchHit: false,
      },
    };
  });

  return [...connectedFlowNodes, ...isolatedFlowNodes];
}

export const NODE_POS_CACHE = new Map<string, { x: number; y: number; connected: boolean }>();
export const NODE_POS_CACHE_CAP = 8192;
export const SEEN_EDGE_KEYS = new Set<string>();

export function resetNodePositionCacheForTests(): void {
  NODE_POS_CACHE.clear();
  SEEN_EDGE_KEYS.clear();
}

export const pairKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);

export function stabilizePositions(
  fresh: GraphFlowNode[],
  edges: DashboardGraphEdge[],
  cache: Map<string, { x: number; y: number; connected: boolean }> = NODE_POS_CACHE,
  seenEdges: Set<string> = SEEN_EDGE_KEYS,
): GraphFlowNode[] {
  if (cache.size > NODE_POS_CACHE_CAP) {
    cache.clear();
    seenEdges.clear();
  }
  const backlinks = edges.filter((e) => e.kind === "backlink");

  if (cache.size === 0) {
    for (const n of fresh) {
      cache.set(n.id, { x: n.position.x, y: n.position.y, connected: n.data.item.degree > 0 });
    }
    for (const e of backlinks) seenEdges.add(pairKey(e.source, e.target));
    return fresh;
  }

  const joining = new Set<string>();
  for (const n of fresh) {
    if (n.data.item.degree <= 0) continue;
    const cached = cache.get(n.id);
    if (!cached || !cached.connected) joining.add(n.id);
  }

  const partnersOf = new Map<string, string[]>();
  for (const e of edges) {
    for (const [a, b] of [[e.source, e.target], [e.target, e.source]] as const) {
      const arr = partnersOf.get(a);
      if (arr) arr.push(b);
      else partnersOf.set(a, [b]);
    }
  }

  const pos = new Map<string, { x: number; y: number }>();
  for (const n of fresh) {
    const cached = cache.get(n.id);
    let p: { x: number; y: number } = n.position;
    if (cached && !joining.has(n.id)) {
      p = { x: cached.x, y: cached.y };
    } else if (joining.has(n.id)) {
      const partners = (partnersOf.get(n.id) ?? []).filter((q) => cache.has(q));
      const settled = partners.filter((q) => !joining.has(q));
      const anchorId = settled.length > 0
        ? settled.reduce((a, b) => (a < b ? a : b))
        : partners.length > 0
          ? [n.id, ...partners].reduce((a, b) => (a < b ? a : b))
          : null;
      if (anchorId === n.id && cached) {
        p = { x: cached.x, y: cached.y };
      } else if (anchorId != null && anchorId !== n.id) {
        const anchor = cache.get(anchorId)!;
        const angle = stringHash(n.id) * Math.PI * 2;
        p = { x: anchor.x + Math.cos(angle) * 34, y: anchor.y + Math.sin(angle) * 34 };
      }
    }
    pos.set(n.id, p);
  }

  const currentKeys = new Set<string>();
  for (const e of backlinks) {
    const key = pairKey(e.source, e.target);
    currentKeys.add(key);
    if (seenEdges.has(key)) continue;
    if (joining.has(e.source) || joining.has(e.target)) continue;
    const pa = pos.get(e.source);
    const pb = pos.get(e.target);
    if (!pa || !pb) continue;
    const dist = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    if (dist <= 50) continue;
    const target = Math.max(50, dist / 2);
    const pull = (dist - target) / 2 / dist;
    pos.set(e.source, { x: pa.x + (pb.x - pa.x) * pull, y: pa.y + (pb.y - pa.y) * pull });
    pos.set(e.target, { x: pb.x + (pa.x - pb.x) * pull, y: pb.y + (pa.y - pb.y) * pull });
  }

  const nodeIds = new Set(fresh.map((n) => n.id));
  for (const key of seenEdges) {
    if (currentKeys.has(key)) continue;
    const [a, b] = key.split(":");
    if (a == null || b == null || !nodeIds.has(a) || !nodeIds.has(b)) continue;
    seenEdges.delete(key);
    const pa = pos.get(a);
    const pb = pos.get(b);
    if (!pa || !pb) continue;
    const dist = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    if (dist >= 220) continue;
    if (dist < 1) {
      const angle = stringHash(key) * Math.PI * 2;
      pos.set(a, { x: pa.x - Math.cos(angle) * 30, y: pa.y - Math.sin(angle) * 30 });
      pos.set(b, { x: pb.x + Math.cos(angle) * 30, y: pb.y + Math.sin(angle) * 30 });
      continue;
    }
    const push = 60 / 2 / dist;
    pos.set(a, { x: pa.x - (pb.x - pa.x) * push, y: pa.y - (pb.y - pa.y) * push });
    pos.set(b, { x: pb.x + (pb.x - pa.x) * push, y: pb.y + (pb.y - pa.y) * push });
  }
  for (const key of currentKeys) seenEdges.add(key);

  return fresh.map((n) => {
    const p = pos.get(n.id)!;
    cache.set(n.id, { x: p.x, y: p.y, connected: n.data.item.degree > 0 });
    return p.x === n.position.x && p.y === n.position.y ? n : { ...n, position: p };
  });
}

export interface LabelBoundingBox {
  l: number;
  t: number;
  r: number;
  b: number;
}

export function estimateLabelWidth(title: string): number {
  let charWidth = 0;
  for (let i = 0; i < title.length; i++) {
    charWidth += title.charCodeAt(i) > 255 ? 11 : 7;
  }
  return Math.min(150, Math.max(16, charWidth + 4));
}

export function getLabelBoundingBox(node: GraphFlowNode, zoom: number = 1): LabelBoundingBox {
  const z = typeof zoom === "number" && zoom > 0 ? zoom : 1;
  const title = displayTitle(node.data.item.title);
  const w = estimateLabelWidth(title);
  const l = (node.position.x + 27) * z;
  const t = (node.position.y + 12) * z - 7;
  const r = l + w;
  const b = t + 14;
  return { l, t, r, b };
}

export function boxesIntersect(a: LabelBoundingBox, b: LabelBoundingBox): boolean {
  return a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
}

export function declutterLabels(nodes: GraphFlowNode[], zoom: number = 1): GraphFlowNode[] {
  const z = typeof zoom === "number" && zoom > 0 ? zoom : 1;
  const kept: LabelBoundingBox[] = [];
  const hide = new Set<string>();
  const byPriority = [...nodes].sort(
    (a, b) => b.data.item.degree - a.data.item.degree || a.id.localeCompare(b.id),
  );
  for (const n of byPriority) {
    if (!n.data.labelled) continue;
    const box = getLabelBoundingBox(n, z);
    if (kept.some((k) => boxesIntersect(box, k))) hide.add(n.id);
    else kept.push(box);
  }
  if (hide.size === 0) return nodes;
  return nodes.map((n) => (hide.has(n.id) ? { ...n, data: { ...n.data, labelled: false } } : n));
}
