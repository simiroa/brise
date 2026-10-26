import { describe, expect, it } from "vitest";
import {
  boxesIntersect,
  constellationNodes,
  declutterLabels,
  egoGraph,
  getLabelBoundingBox,
  orderFoldersByLinkDensity,
  segmentIntersection,
  type DashboardGraphResult,
} from "./GraphCanvas";
import { snippetText } from "../../../lib/ui";

describe("egoGraph", () => {
  it("keeps only the centre, its direct neighbours, and their connecting edges", () => {
    const node = (id: string) => ({ id, folder_id: "f", title: id, year: 2026, snippet: "", degree: 1 });
    const graph: DashboardGraphResult = {
      nodes: [node("a"), node("b"), node("c"), node("d")],
      edges: [
        { source: "a", target: "b", kind: "backlink", weight: 100 },
        { source: "b", target: "c", kind: "related", weight: 30 },
        { source: "c", target: "d", kind: "related", weight: 25 },
      ],
      total: 4,
      cap: 500,
      capped: false,
      edge_total: 3,
      edge_cap: 2500,
      edges_capped: false,
    };

    const ego = egoGraph(graph, "b");
    expect(ego.nodes.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(ego.edges).toHaveLength(2);
  });

  it("turns the stored Tiptap HTML snippet into panel text", () => {
    expect(snippetText("<p>첫 문단</p><p><strong>둘째</strong>&nbsp;문단</p>")).toBe("첫 문단 둘째 문단");
  });

  it("places notes as a deterministic folder constellation", () => {
    const nodes = [
      { id: "a", folder_id: "f", title: "a", year: 2026, snippet: "", degree: 3 },
      { id: "b", folder_id: "f", title: "b", year: 2026, snippet: "", degree: 1 },
      { id: "c", folder_id: "g", title: "c", year: 2026, snippet: "", degree: 1 },
    ];
    const first = constellationNodes(nodes, (id) => id).map(({ id, position }) => ({ id, position }));
    const second = constellationNodes(nodes, (id) => id).map(({ id, position }) => ({ id, position }));

    expect(first).toEqual(second);
    expect(new Set(first.map(({ position }) => `${position.x}:${position.y}`))).toHaveLength(3);
  });

  it("places folders with more links between them in adjacent angular order", () => {
    const nodes = [
      { id: "a1", folder_id: "fa", title: "a1", year: 2026, snippet: "", degree: 4 },
      { id: "a2", folder_id: "fa", title: "a2", year: 2026, snippet: "", degree: 4 },
      { id: "b1", folder_id: "fb", title: "b1", year: 2026, snippet: "", degree: 4 },
      { id: "b2", folder_id: "fb", title: "b2", year: 2026, snippet: "", degree: 4 },
      { id: "c1", folder_id: "fc", title: "c1", year: 2026, snippet: "", degree: 2 },
      { id: "d1", folder_id: "fd", title: "d1", year: 2026, snippet: "", degree: 1 },
    ];
    const edges = [
      // 4 edges between fa and fb (dense connection)
      { source: "a1", target: "b1", kind: "related" as const, weight: 1 },
      { source: "a1", target: "b2", kind: "related" as const, weight: 1 },
      { source: "a2", target: "b1", kind: "related" as const, weight: 1 },
      { source: "a2", target: "b2", kind: "related" as const, weight: 1 },
      // 1 edge between fb and fc
      { source: "b1", target: "c1", kind: "related" as const, weight: 1 },
    ];
    const groups = new Map<string, typeof nodes>();
    for (const n of nodes) groups.set(n.folder_id, [...(groups.get(n.folder_id) ?? []), n]);

    const ordered = orderFoldersByLinkDensity(groups, edges);
    const orderedIds = ordered.map(([id]) => id);

    // fb must be placed immediately adjacent to fa around the circle
    const faIdx = orderedIds.indexOf("fa");
    const fbIdx = orderedIds.indexOf("fb");
    const diff = Math.abs(faIdx - fbIdx);
    const isAdjacent = diff === 1 || diff === orderedIds.length - 1;
    expect(isAdjacent).toBe(true);
  });
});


describe("declutterLabels", () => {
  const flowNode = (id: string, x: number, y: number, degree: number, labelled = true) => ({
    id,
    type: "note",
    position: { x, y },
    data: {
      item: { id, folder_id: "f", title: `노트 ${id}`, year: 2026, snippet: "", degree },
      color: "var(--muted)",
      labelled,
      size: 10,
      searchDim: false,
      searchHit: false,
    },
  }) as any;

  it("hides the lower-degree label when two labels overlap; keeps far-apart labels", () => {
    // a(우선)와 b는 같은 높이 30px 간격 — 라벨 폭(≈70px+)이 겹친다. c 는 멀리.
    const out = declutterLabels([
      flowNode("a", 0, 0, 5),
      flowNode("b", 30, 0, 1),
      flowNode("c", 400, 400, 1),
    ]);
    const byId = new Map(out.map((n: any) => [n.id, n.data.labelled]));
    expect(byId.get("a")).toBe(true);
    expect(byId.get("b")).toBe(false);
    expect(byId.get("c")).toBe(true);
  });

  it("returns nodes untouched when nothing overlaps or labels are off", () => {
    const input = [flowNode("a", 0, 0, 2), flowNode("b", 0, 300, 1), flowNode("c", 300, 0, 1, false)];
    const out = declutterLabels(input);
    expect(out).toBe(input); // 숨길 게 없으면 같은 배열 그대로 (재렌더 최소화)
  });

  it("in a crowded cluster: no two visible label boxes intersect, highest-degree stays visible, and zooming in reveals more labels", () => {
    // 8개의 노드가 (0, 0) 근처 좁은 영역(반경 25px)에 밀집되어 있는 fixture
    // degree는 8, 7, 6, ..., 1 로 차등 부여
    const crowded = [
      flowNode("n1", 0, 0, 8),
      flowNode("n2", 15, 5, 7),
      flowNode("n3", -10, 10, 6),
      flowNode("n4", 25, -10, 5),
      flowNode("n5", -20, -15, 4),
      flowNode("n6", 10, 20, 3),
      flowNode("n7", -15, 25, 2),
      flowNode("n8", 20, 25, 1),
    ];

    // 1) zoom = 0.5 (줌아웃/기본 원거리 뷰)
    const outZoomOut = declutterLabels(crowded, 0.5);
    const visibleZoomOut = outZoomOut.filter((n: any) => n.data.labelled);

    // 최고 degree인 n1은 반드시 표시되어야 함
    expect(visibleZoomOut.some((n: any) => n.id === "n1")).toBe(true);

    // 보이는 라벨들 사이에 어떤 두 박스도 교차하지 않아야 함
    for (let i = 0; i < visibleZoomOut.length; i++) {
      const boxA = getLabelBoundingBox(visibleZoomOut[i], 0.5);
      for (let j = i + 1; j < visibleZoomOut.length; j++) {
        const boxB = getLabelBoundingBox(visibleZoomOut[j], 0.5);
        expect(boxesIntersect(boxA, boxB)).toBe(false);
      }
    }

    // 2) zoom = 1.0 (중간 뷰)
    const outZoom1 = declutterLabels(crowded, 1.0);
    const visibleZoom1 = outZoom1.filter((n: any) => n.data.labelled);
    expect(visibleZoom1.some((n: any) => n.id === "n1")).toBe(true);

    for (let i = 0; i < visibleZoom1.length; i++) {
      const boxA = getLabelBoundingBox(visibleZoom1[i], 1.0);
      for (let j = i + 1; j < visibleZoom1.length; j++) {
        const boxB = getLabelBoundingBox(visibleZoom1[j], 1.0);
        expect(boxesIntersect(boxA, boxB)).toBe(false);
      }
    }

    // 3) zoom = 5.0 (확대/줌인)
    const outZoomIn = declutterLabels(crowded, 5.0);
    const visibleZoomIn = outZoomIn.filter((n: any) => n.data.labelled);
    expect(visibleZoomIn.some((n: any) => n.id === "n1")).toBe(true);

    for (let i = 0; i < visibleZoomIn.length; i++) {
      const boxA = getLabelBoundingBox(visibleZoomIn[i], 5.0);
      for (let j = i + 1; j < visibleZoomIn.length; j++) {
        const boxB = getLabelBoundingBox(visibleZoomIn[j], 5.0);
        expect(boxesIntersect(boxA, boxB)).toBe(false);
      }
    }

    // 핵심 단언: 줌인할수록 화면에서 더 많은 라벨이 드러난다!
    expect(visibleZoomIn.length).toBeGreaterThan(visibleZoom1.length);
    expect(visibleZoom1.length).toBeGreaterThanOrEqual(visibleZoomOut.length);
  });
});

describe("segmentIntersection", () => {
  it("returns the crossing point for two crossing segments", () => {
    // 수평선 y=10 (x 0..20) 과 수직선 x=5 (y 0..20) → (5, 10)
    const hit = segmentIntersection({ x: 0, y: 10 }, { x: 20, y: 10 }, { x: 5, y: 0 }, { x: 5, y: 20 });
    expect(hit).not.toBeNull();
    expect(hit!.x).toBeCloseTo(5, 6);
    expect(hit!.y).toBeCloseTo(10, 6);
  });

  it("returns null when segments only cross beyond their endpoints", () => {
    // 같은 두 직선이지만 수직선이 y=0..5 에서 끝나 y=10 까지 닿지 않는다
    expect(segmentIntersection({ x: 0, y: 10 }, { x: 20, y: 10 }, { x: 5, y: 0 }, { x: 5, y: 5 })).toBeNull();
  });

  it("returns null for parallel segments", () => {
    expect(segmentIntersection({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 4 }, { x: 10, y: 4 })).toBeNull();
  });
});
