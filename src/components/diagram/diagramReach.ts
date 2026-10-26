/**
 * diagramReach.ts — Pure BFS Reach probe over declared edges (W2).
 *
 * Follows the archify Route Probe principle:
 * Follows ONLY declared edge relations, not geometric coordinates.
 */
import type { DiagramEdge } from "./diagramModel";

export type ReachDirection = "upstream" | "downstream" | "both";

/**
 * Pure BFS reach traversal over edges starting from `startNodeId`.
 *
 * - "upstream": Traverses incoming edges (edges where to === current, following to `edge.from`).
 * - "downstream": Traverses outgoing edges (edges where from === current, following to `edge.to`).
 * - "both": Traverses both directions.
 *
 * Returns the set of reached node IDs, excluding `startNodeId` itself.
 */
export function computeReach(
  edges: ReadonlyArray<{ from: string; to: string }>,
  startNodeId: string,
  direction: ReachDirection = "both",
): Set<string> {
  const reached = new Set<string>();
  const queue: string[] = [startNodeId];
  const visitedForQueue = new Set<string>([startNodeId]);

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (direction === "upstream" || direction === "both") {
      for (const edge of edges) {
        if (edge.to === current) {
          const neighbor = edge.from;
          if (!visitedForQueue.has(neighbor)) {
            visitedForQueue.add(neighbor);
            reached.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
    }

    if (direction === "downstream" || direction === "both") {
      for (const edge of edges) {
        if (edge.from === current) {
          const neighbor = edge.to;
          if (!visitedForQueue.has(neighbor)) {
            visitedForQueue.add(neighbor);
            reached.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
    }
  }

  return reached;
}

/**
 * Computes all active IDs (start node + reached nodes + edges between them)
 * to be kept un-dimmed during a Reach interaction.
 */
export function computeReachActiveIds(
  edges: ReadonlyArray<DiagramEdge>,
  startNodeId: string,
  direction: ReachDirection = "both",
): Set<string> {
  const reachedNodes = computeReach(edges, startNodeId, direction);
  const allNodes = new Set<string>([startNodeId, ...reachedNodes]);

  const activeEdges = new Set<string>();
  for (const edge of edges) {
    if (allNodes.has(edge.from) && allNodes.has(edge.to)) {
      activeEdges.add(edge.id);
    }
  }

  return new Set([...allNodes, ...activeEdges]);
}
