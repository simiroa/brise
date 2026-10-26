import { describe, expect, it } from "vitest";
import { computeReach, computeReachActiveIds } from "./diagramReach";
import type { DiagramEdge } from "./diagramModel";

describe("W2: Reach probe BFS (diagramReach)", () => {
  // n1 -> n2 -> n3, and n4 -> n2
  const sampleEdges: Array<{ id: string; from: string; to: string }> = [
    { id: "e1", from: "n1", to: "n2" },
    { id: "e2", from: "n2", to: "n3" },
    { id: "e3", from: "n4", to: "n2" },
  ];

  it("computes upstream reach as {n1, n4} when selecting n2 (literal expectation)", () => {
    const upstream = computeReach(sampleEdges, "n2", "upstream");
    expect(upstream).toEqual(new Set(["n1", "n4"]));
  });

  it("computes downstream reach as {n3} when selecting n2 (literal expectation)", () => {
    const downstream = computeReach(sampleEdges, "n2", "downstream");
    expect(downstream).toEqual(new Set(["n3"]));
  });

  it("computes both directions as {n1, n4, n3} when selecting n2", () => {
    const both = computeReach(sampleEdges, "n2", "both");
    expect(both).toEqual(new Set(["n1", "n4", "n3"]));
  });

  it("returns empty set when reaching from a leaf node with no outbound edges in that direction", () => {
    expect(computeReach(sampleEdges, "n1", "upstream")).toEqual(new Set());
    expect(computeReach(sampleEdges, "n3", "downstream")).toEqual(new Set());
  });

  it("handles cycles safely without infinite loops", () => {
    const cyclicEdges = [
      { id: "e1", from: "a", to: "b" },
      { id: "e2", from: "b", to: "c" },
      { id: "e3", from: "c", to: "a" },
    ];
    expect(computeReach(cyclicEdges, "a", "downstream")).toEqual(new Set(["b", "c"]));
    expect(computeReach(cyclicEdges, "a", "upstream")).toEqual(new Set(["b", "c"]));
    expect(computeReach(cyclicEdges, "a", "both")).toEqual(new Set(["b", "c"]));
  });

  it("computes active IDs including start node and connecting edges", () => {
    const activeIds = computeReachActiveIds(sampleEdges as DiagramEdge[], "n2", "upstream");
    // Should include start node n2, reached nodes n1, n4, and edges between them e1, e3
    expect(activeIds).toEqual(new Set(["n2", "n1", "n4", "e1", "e3"]));
    expect(activeIds.has("n3")).toBe(false);
    expect(activeIds.has("e2")).toBe(false);
  });
});
