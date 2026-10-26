import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  borderPoint,
  edgeOffsets,
  floatingEdgePath,
  orthogonalEdgePath,
  selfLoopPath,
  sequenceEdgePath,
  bezierHitsObstacles,
  polylineHitsObstacles,
  PARALLEL_SPREAD,
  type XY,
} from "./flowEdgePath";
import { EDGE_LINES, EDGE_ARROWS, edgeStyleOf, styleToLineArrow } from "./diagramSchema";

// These are the three pictures React Flow's stock edge drew wrong (a self-loop through its own box,
// two overlapping round-trip arrows, every line leaving the bottom). The failures are visual, so
// the assertions below are about the NUMBERS behind them — jsdom can't see a curve.

const box = (x: number, y: number, width = 168, height = 44) => ({ x, y, width, height });

/** Endpoints of `M x,y Q …` / `M x,y C …` / `M x,y L …`, for asserting where a path starts and stops. */
function ends(path: string): { start: [number, number]; end: [number, number] } {
  const nums = path.match(/-?\d+(\.\d+)?/g)!.map(Number);
  return { start: [nums[0], nums[1]], end: [nums[nums.length - 2], nums[nums.length - 1]] };
}

/** Parses an orthogonal SVG path into points and verifies all segments are strictly horizontal or vertical. */
function parseOrthogonalSegments(pathStr: string): XY[] {
  const tokens = pathStr.trim().split(/\s+/);
  const pts: XY[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const cmd = tokens[i];
    expect(cmd === "M" || cmd === "L").toBe(true);
    const [x, y] = tokens[i + 1].split(",").map(Number);
    pts.push({ x, y });
  }
  return pts;
}

describe("borderPoint — a line stops at the box, not at a handle", () => {
  it("leaves through the side that faces the other box", () => {
    const rect = box(0, 0, 100, 40); // centre (50, 20)
    expect(borderPoint(rect, { x: 500, y: 20 })).toEqual({ x: 100, y: 20 }); // right edge
    expect(borderPoint(rect, { x: -500, y: 20 })).toEqual({ x: 0, y: 20 }); // left edge
    expect(borderPoint(rect, { x: 50, y: 500 })).toEqual({ x: 50, y: 40 }); // bottom edge
    expect(borderPoint(rect, { x: 50, y: -500 })).toEqual({ x: 50, y: 0 }); // top edge
  });

  it("always lands ON the border — never inside it and never past it", () => {
    const rect = box(20, 60, 168, 44);
    for (const toward of [
      { x: 400, y: 400 },
      { x: -300, y: 90 },
      { x: 100, y: -500 },
      { x: 21, y: 61 },
    ]) {
      const p = borderPoint(rect, toward);
      const onX = Math.abs(p.x - rect.x) < 1e-9 || Math.abs(p.x - (rect.x + rect.width)) < 1e-9;
      const onY = Math.abs(p.y - rect.y) < 1e-9 || Math.abs(p.y - (rect.y + rect.height)) < 1e-9;
      expect(onX || onY).toBe(true);
      expect(p.x).toBeGreaterThanOrEqual(rect.x);
      expect(p.x).toBeLessThanOrEqual(rect.x + rect.width);
      expect(p.y).toBeGreaterThanOrEqual(rect.y);
      expect(p.y).toBeLessThanOrEqual(rect.y + rect.height);
    }
  });

  it("degenerates to the centre rather than to NaN when the two boxes are concentric", () => {
    expect(borderPoint(box(0, 0, 100, 40), { x: 50, y: 20 })).toEqual({ x: 50, y: 20 });
  });

  it("re-aims when the target moves sideways — the whole point of a floating endpoint", () => {
    const rect = box(0, 0, 100, 40);
    const below = borderPoint(rect, { x: 50, y: 300 });
    const right = borderPoint(rect, { x: 600, y: 20 });
    expect(below).not.toEqual(right);
  });
});

describe("floatingEdgePath", () => {
  it("runs border to border, so neither end is hidden under a box", () => {
    const a = box(0, 0);
    const b = box(0, 200);
    const { start, end } = ends(floatingEdgePath(a, b).path);
    expect(start[1]).toBe(44); // a's bottom
    expect(end[1]).toBe(200); // b's top
    expect(start[0]).toBe(84);
    expect(end[0]).toBe(84);
  });

  it("a lone edge (offset 0) is a straight line — its label sits on the midpoint", () => {
    const geo = floatingEdgePath(box(0, 0), box(0, 200), 0);
    expect(geo.labelX).toBe(84);
    expect(geo.labelY).toBe(122); // halfway between y=44 and y=200
  });

  it("offset pushes the curve — and its label — perpendicular to the centre line", () => {
    const straight = floatingEdgePath(box(0, 0), box(0, 200), 0);
    const bent = floatingEdgePath(box(0, 0), box(0, 200), PARALLEL_SPREAD);
    // A vertical relation is bent horizontally, by at least the spread and not along its own axis.
    expect(straight.labelX - bent.labelX).toBeGreaterThanOrEqual(PARALLEL_SPREAD);
    expect(bent.labelY).toBeCloseTo(straight.labelY, 5);
    // …and the endpoints move with it: a fanned edge LEAVES the box somewhere else, not just bulges.
    expect(ends(bent.path).start[0]).not.toBe(ends(straight.path).start[0]);
  });

  it("A→B and B→A end up on OPPOSITE sides, which is what stopped them overlapping", () => {
    const a = box(0, 0);
    const b = box(0, 200);
    const off = edgeOffsets([
      { id: "ab", source: "a", target: "b" },
      { id: "ba", source: "b", target: "a" },
    ]);
    const ab = floatingEdgePath(a, b, off.ab);
    const ba = floatingEdgePath(b, a, off.ba);
    const mid = floatingEdgePath(a, b, 0).labelX;
    expect(Math.sign(ab.labelX - mid)).toBe(-Math.sign(ba.labelX - mid));
    expect(Math.abs(ab.labelX - mid)).toBeCloseTo(Math.abs(ba.labelX - mid), 5);
  });

  it("avoids obstacle between source and target: A(0,0)-B(400,0) with C(200,0)", () => {
    const a = box(0, 0, 100, 40);
    const b = box(400, 0, 100, 40);
    const c = box(200, 0, 100, 40);

    const geoWithoutObs = floatingEdgePath(a, b, 0, []);
    // Straight line goes straight through C
    expect(geoWithoutObs.path.includes("Q")).toBe(true);

    const geoWithObs = floatingEdgePath(a, b, 0, [c]);
    // The curve with obstacle avoidance must not intersect C
    const ctrlMatch = geoWithObs.path.match(/M\s+([^,]+),(\S+)\s+Q\s+([^,]+),(\S+)\s+([^,]+),(\S+)/);
    expect(ctrlMatch).not.toBeNull();
    const p0 = { x: Number(ctrlMatch![1]), y: Number(ctrlMatch![2]) };
    const p1 = { x: Number(ctrlMatch![3]), y: Number(ctrlMatch![4]) };
    const p2 = { x: Number(ctrlMatch![5]), y: Number(ctrlMatch![6]) };

    const hits = bezierHitsObstacles(p0, p1, p2, [c]);
    expect(hits).toBe(false);
  });

  it("routes accurately from and to specific ports (port-aware floating Bézier)", () => {
    const a = box(0, 0, 100, 50);
    const b = box(200, 100, 100, 50);

    // a.bottom -> b.top
    const geo = floatingEdgePath(a, b, 0, [], "bottom", "top");
    const { start, end } = ends(geo.path);
    // a.bottom = { x: 50, y: 50 }
    expect(start[0]).toBe(50);
    expect(start[1]).toBe(50);
    // b.top = { x: 250, y: 100 }
    expect(end[0]).toBe(250);
    expect(end[1]).toBe(100);
    // Path uses cubic bezier (C) when ports are specified
    expect(geo.path.includes("C")).toBe(true);

    // a.right -> b.left
    const geo2 = floatingEdgePath(a, b, 0, [], "right", "left");
    const { start: start2, end: end2 } = ends(geo2.path);
    // a.right = { x: 100, y: 25 }
    expect(start2[0]).toBe(100);
    expect(start2[1]).toBe(25);
    // b.left = { x: 200, y: 125 }
    expect(end2[0]).toBe(200);
    expect(end2[1]).toBe(125);
  });
});

describe("orthogonalEdgePath", () => {
  it("consists only of M and L horizontal/vertical segments", () => {
    const a = box(0, 0, 100, 40);
    const b = box(200, 150, 100, 40);
    const geo = orthogonalEdgePath(a, b, 0);

    // Path must not contain curve commands Q, C, A
    expect(geo.path).not.toMatch(/[QCA]/);

    const pts = parseOrthogonalSegments(geo.path);
    expect(pts.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < pts.length - 1; i++) {
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const isH = Math.abs(p1.y - p2.y) < 1e-4;
      const isV = Math.abs(p1.x - p2.x) < 1e-4;
      expect(isH || isV).toBe(true);
    }
  });

  it("avoids obstacle between source and target: A(0,0)-B(400,0) with C(200,0)", () => {
    const a = box(0, 0, 100, 40);
    const b = box(400, 0, 100, 40);
    const c = box(200, 0, 100, 40);

    const geo = orthogonalEdgePath(a, b, 0, [c]);
    const pts = parseOrthogonalSegments(geo.path);
    const hits = polylineHitsObstacles(pts, [c]);
    expect(hits).toBe(false);
  });

  it("offset fans out parallel orthogonal edges", () => {
    const a = box(0, 0, 100, 40);
    const b = box(200, 200, 100, 40);
    const e1 = orthogonalEdgePath(a, b, -PARALLEL_SPREAD / 2);
    const e2 = orthogonalEdgePath(a, b, PARALLEL_SPREAD / 2);
    expect(e1.path).not.toBe(e2.path);
  });

  it("routes accurately from and to specific ports (port-aware orthogonal path)", () => {
    const a = box(0, 0, 100, 50);
    const b = box(200, 100, 100, 50);

    // a.bottom -> b.top
    const geo = orthogonalEdgePath(a, b, 0, [], "bottom", "top");
    const pts = parseOrthogonalSegments(geo.path);
    const start = pts[0];
    const end = pts[pts.length - 1];

    expect(start.x).toBe(50);
    expect(start.y).toBe(50);
    expect(end.x).toBe(250);
    expect(end.y).toBe(100);

    // All segments must be strictly orthogonal
    for (let i = 0; i < pts.length - 1; i++) {
      const isH = Math.abs(pts[i].y - pts[i + 1].y) < 1e-4;
      const isV = Math.abs(pts[i].x - pts[i + 1].x) < 1e-4;
      expect(isH || isV).toBe(true);
    }
  });
});

describe("selfLoopPath — `A --> A` must not run through A", () => {
  it("starts and ends on the box's right edge and bulges away from it", () => {
    const rect = box(100, 50);
    const geo = selfLoopPath(rect);
    const { start, end } = ends(geo.path);
    expect(start[0]).toBe(268); // right edge = 100 + 168
    expect(end[0]).toBe(268);
    expect(start[1]).not.toBe(end[1]); // two distinct points, so the arrowhead has a direction
    // Both control points sit OUTSIDE the box, so no part of the curve can cross it.
    const nums = geo.path.match(/-?\d+(\.\d+)?/g)!.map(Number);
    expect(nums[2]).toBeGreaterThan(rect.x + rect.width);
    expect(nums[4]).toBeGreaterThan(rect.x + rect.width);
    expect(geo.labelX).toBeGreaterThan(rect.x + rect.width);
    expect(geo.labelY).toBe(rect.y + rect.height / 2);
  });

  it("a second loop on the same node sits outside the first", () => {
    const rect = box(0, 0);
    expect(selfLoopPath(rect, 1).labelX).toBeGreaterThan(selfLoopPath(rect, 0).labelX);
  });
});

describe("edgeOffsets", () => {
  it("leaves a lone relation alone", () => {
    expect(edgeOffsets([{ id: "e", source: "a", target: "b" }])).toEqual({ e: 0 });
  });

  it("spreads two edges between the same pair symmetrically", () => {
    const off = edgeOffsets([
      { id: "1", source: "a", target: "b" },
      { id: "2", source: "a", target: "b" },
    ]);
    expect(off["1"]).toBe(-PARALLEL_SPREAD / 2);
    expect(off["2"]).toBe(PARALLEL_SPREAD / 2);
  });

  it("groups a round trip as ONE pair — direction doesn't start a second group", () => {
    const off = edgeOffsets([
      { id: "ab", source: "a", target: "b" },
      { id: "ba", source: "b", target: "a" },
    ]);
    expect(Math.abs(off.ab)).toBe(PARALLEL_SPREAD / 2);
    expect(Math.abs(off.ba)).toBe(PARALLEL_SPREAD / 2);
  });

  it("keeps unrelated pairs at 0 and counts self-loops by rank, not by pixels", () => {
    const off = edgeOffsets([
      { id: "ab", source: "a", target: "b" },
      { id: "cd", source: "c", target: "d" },
      { id: "aa1", source: "a", target: "a" },
      { id: "aa2", source: "a", target: "a" },
    ]);
    expect(off.ab).toBe(0);
    expect(off.cd).toBe(0);
    expect(off.aa1).toBe(0);
    expect(off.aa2).toBe(1);
  });
});

describe("Edge vocabulary: line x arrow", () => {
  it("defines all 5 line variants and 3 arrow variants", () => {
    expect(EDGE_LINES).toEqual(["solid", "dotted", "dashed", "thick", "double"]);
    expect(EDGE_ARROWS).toEqual(["end", "both", "none"]);
  });

  it("maps legacy styles to line x arrow and back", () => {
    expect(styleToLineArrow("solid")).toEqual({ line: "solid", arrow: "end" });
    expect(styleToLineArrow("dotted")).toEqual({ line: "dotted", arrow: "end" });
    expect(styleToLineArrow("thick")).toEqual({ line: "thick", arrow: "end" });
    expect(styleToLineArrow("bidirectional")).toEqual({ line: "solid", arrow: "both" });
    expect(styleToLineArrow("open")).toEqual({ line: "solid", arrow: "none" });

    expect(edgeStyleOf("solid", "end")).toBe("solid");
    expect(edgeStyleOf("dotted", "end")).toBe("dotted");
    expect(edgeStyleOf("thick", "end")).toBe("thick");
    expect(edgeStyleOf("solid", "both")).toBe("bidirectional");
    expect(edgeStyleOf("solid", "none")).toBe("open");
  });
});

describe("sequenceEdgePath (W2b) — 라이프라인 사이의 수평선", () => {
  const box = (x: number): { x: number; y: number; width: number; height: number } => ({ x, y: 24, width: 144, height: 36 });
  const points = (d: string) => d.match(/-?\d+(\.\d+)?,-?\d+(\.\d+)?/g)!.map((p) => p.split(",").map(Number));

  it("두 라이프라인 사이: M x1 y L x2 y — y 두 개가 같고 x 는 상자 중심; 라벨은 선 위 가운데", () => {
    const geo = sequenceEdgePath(box(24), box(216), 120);
    expect(geo.path).toBe("M 96,120 L 288,120");
    const pts = points(geo.path);
    expect(pts.length).toBe(2);
    expect(pts[0][1]).toBe(pts[1][1]);
    expect(geo.labelX).toBe(192);
    expect(geo.labelY).toBe(110);
    // 반대 방향도 같은 선, 시작점만 바뀐다.
    expect(sequenceEdgePath(box(216), box(24), 120).path).toBe("M 288,120 L 96,120");
  });

  it("같은 라이프라인(자기루프)이면 오른쪽으로 나갔다 돌아오는 4점 ㄷ자", () => {
    const geo = sequenceEdgePath(box(24), box(24), 120);
    const pts = points(geo.path);
    expect(pts.length).toBe(4);
    expect(pts[0]).toEqual([96, 120]);
    expect(pts[1][0]).toBe(pts[2][0]);
    expect(pts[1][0]).toBeGreaterThan(96);
    expect(pts[2][1]).toBeGreaterThan(120);
    expect(pts[3][0]).toBe(96);
    expect(pts[3][1]).toBe(pts[2][1]);
  });
});

describe("flowEdgePath modularity: no React, no @xyflow imports", () => {
  it("does not import React or @xyflow in flowEdgePath.ts", () => {
    const filePath = path.resolve(__dirname, "flowEdgePath.ts");
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).not.toMatch(/from\s+["']@xyflow/);
    expect(content).not.toMatch(/from\s+["']react/);
  });
});
