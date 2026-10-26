/**
 * flowElements — 모델 → React Flow 요소 투영의 리터럴 단위 테스트.
 *
 * FlowCanvas.test.tsx 는 캔버스를 마운트해 화면으로 확인한다. 여기서는 그 화면이 되기 전의 배열을
 * 직접 본다 — 그룹 부모 상대 좌표 변환, 중첩 순서(React Flow 는 부모가 배열에서 먼저여야 한다),
 * 평행 관계의 오프셋, 시퀀스 앵커 y 처럼 눈으로는 "그려졌다"까지만 보이는 산수들.
 */
import { describe, it, expect } from "vitest";
import type { DiagramGroup, DiagramNode, DiagramEdge } from "./diagramSchema";
import type { LayoutBox, XY } from "./flowLayout";
import { NODE_H, NODE_W } from "./flowLayout";
import { buildFlowEdges, buildFlowGroups, buildObstacles, type ToRelative } from "./flowElements";

const box = (id: string, x: number, y: number, width = 200, height = 120): LayoutBox => ({ id, x, y, width, height });

/** FlowCanvas 의 `toRelative` 와 같은 산수 — 부모 상자가 있으면 그 원점을 뺀다. */
const toRelativeFor =
  (boxes: Record<string, LayoutBox>): ToRelative =>
  (at: XY, group: string | undefined) => {
    const parent = group ? boxes[group] : undefined;
    return parent ? { x: at.x - parent.x, y: at.y - parent.y } : at;
  };

describe("buildObstacles", () => {
  const nodes: DiagramNode[] = [
    { id: "a", label: "A" },
    { id: "b", label: "B", pos: [50, 60] },
  ];

  it("배치 결과가 있으면 그 좌표와 크기를 쓴다", () => {
    const out = buildObstacles(nodes, { a: { x: 10, y: 20 } }, { a: { width: 111, height: 22 } });
    expect(out[0]).toEqual({ x: 10, y: 20, width: 111, height: 22 });
  });

  it("배치 결과가 없으면 소스의 pos 로, 크기가 없으면 기본 상자로 떨어진다", () => {
    const out = buildObstacles(nodes, {}, {});
    expect(out[0]).toEqual({ x: 0, y: 0, width: NODE_W, height: NODE_H });
    expect(out[1]).toEqual({ x: 50, y: 60, width: NODE_W, height: NODE_H });
  });
});

describe("buildFlowGroups", () => {
  const groups: DiagramGroup[] = [
    { id: "inner", title: "안쪽", parent: "outer" },
    { id: "outer", title: "바깥", tone: "accent" },
  ];
  const boxes = { outer: box("outer", 100, 100, 400, 300), inner: box("inner", 150, 160) };
  const build = (selection: Parameters<typeof buildFlowGroups>[3] = null) =>
    buildFlowGroups(groups, boxes, toRelativeFor(boxes), selection, () => ["n1"], () => {});

  it("부모가 자식보다 먼저 오고, 자식 좌표는 부모 상대다", () => {
    const out = build();
    expect(out.map((g) => g.id)).toEqual(["group:outer", "group:inner"]);
    expect(out[0].position).toEqual({ x: 100, y: 100 });
    expect(out[1].position).toEqual({ x: 50, y: 60 });
    expect(out[1].parentId).toBe("group:outer");
    expect(out[0].parentId).toBeUndefined();
  });

  it("상자 크기와 톤·제목·멤버를 그대로 싣는다", () => {
    const [outer] = build();
    expect(outer.width).toBe(400);
    expect(outer.height).toBe(300);
    expect(outer.data.title).toBe("바깥");
    expect(outer.data.tone).toBe("accent");
    expect(outer.data.members).toEqual(["n1"]);
  });

  it("그룹이 둘 이상일 때만 스텝 번호가 붙는다", () => {
    expect(build().map((g) => g.data.step)).toEqual([1, 2]);
    const lone = buildFlowGroups(
      [groups[1]],
      boxes,
      toRelativeFor(boxes),
      null,
      () => [],
      () => {},
    );
    expect(lone[0].data.step).toBeUndefined();
  });

  it("상자가 없는 그룹(빈 그룹)은 아예 빠진다", () => {
    const out = buildFlowGroups(
      groups,
      { outer: boxes.outer },
      toRelativeFor({ outer: boxes.outer }),
      null,
      () => [],
      () => {},
    );
    expect(out.map((g) => g.id)).toEqual(["group:outer"]);
  });

  it("선택은 앱의 Selection 이 정한다", () => {
    const out = build({ kind: "group", id: "inner" });
    expect(out.map((g) => g.selected)).toEqual([false, true]);
  });
});

describe("buildFlowEdges", () => {
  const edges: DiagramEdge[] = [{ id: "e1", from: "a", to: "b", label: "" }];

  it("혼자인 선은 오프셋 0, 평행한 두 선은 좌우로 갈린다", () => {
    const [lone] = buildFlowEdges(edges, "curve", null, null, [], null);
    expect(lone.data?.offset).toBe(0);
    const parallel = buildFlowEdges(
      [
        { id: "e1", from: "a", to: "b" },
        { id: "e2", from: "a", to: "b" },
      ],
      "curve",
      null,
      null,
      [],
      null,
    );
    expect(parallel.map((e) => e.data?.offset)).toEqual([-17, 17]);
  });

  it("빈 라벨은 undefined 로, route 와 장애물은 데이터로 실린다", () => {
    const obstacles = [{ x: 0, y: 0, width: 10, height: 10 }];
    const [e] = buildFlowEdges(edges, "orthogonal", null, null, obstacles, null);
    expect(e.label).toBeUndefined();
    expect(e.data?.route).toBe("orthogonal");
    expect(e.data?.obstacles).toBe(obstacles);
  });

  it("화살표는 line/arrow 우선, 없으면 옛 style 에서 나온다", () => {
    const [none] = buildFlowEdges([{ id: "e1", from: "a", to: "b", arrow: "none" }], "curve", null, null, [], null);
    expect(none.markerEnd).toBeUndefined();
    expect(none.markerStart).toBeUndefined();
    const [both] = buildFlowEdges(
      [{ id: "e1", from: "a", to: "b", style: "bidirectional" }],
      "curve",
      null,
      null,
      [],
      null,
    );
    expect(both.markerEnd).toBe("brise-flow-arrow");
    expect(both.markerStart).toBe("brise-flow-arrow");
    const [dotted] = buildFlowEdges([{ id: "e1", from: "a", to: "b", style: "dotted" }], "curve", null, null, [], null);
    expect(dotted.data?.line).toBe("dotted");
    expect(dotted.style).toEqual({ strokeDasharray: "2 3" });
  });

  it("톤이 있으면 그 톤의 마커를 쓴다", () => {
    const [warn] = buildFlowEdges([{ id: "e1", from: "a", to: "b", tone: "warn" }], "curve", null, null, [], null);
    expect(warn.markerEnd).toBe("brise-flow-arrow-warn");
    const [plain] = buildFlowEdges([{ id: "e1", from: "a", to: "b", tone: "default" }], "curve", null, null, [], null);
    expect(plain.markerEnd).toBe("brise-flow-arrow");
  });

  it("흐림 집합 밖의 선만 흐려지고, 집합이 없으면 아무도 흐려지지 않는다", () => {
    const lit = buildFlowEdges(edges, "curve", null, new Set(["e1"]), [], null);
    expect(lit[0].data?.dimmed).toBe(false);
    const dim = buildFlowEdges(edges, "curve", null, new Set(["other"]), [], null);
    expect(dim[0].data?.dimmed).toBe(true);
    const off = buildFlowEdges(edges, "curve", null, null, [], null);
    expect(off[0].data?.dimmed).toBe(false);
  });

  it("sequence 배치의 메시지 선 y 를 앵커로 넘긴다", () => {
    const [e] = buildFlowEdges(edges, "curve", null, null, [], { positions: {}, edgeAnchors: { e1: { y: 240 } } });
    expect(e.data?.anchorY).toBe(240);
    const [noSeq] = buildFlowEdges(edges, "curve", null, null, [], null);
    expect(noSeq.data?.anchorY).toBeUndefined();
  });

  it("선택은 앱의 Selection 이 정한다", () => {
    const [e] = buildFlowEdges(edges, "curve", { kind: "edge", id: "e1" }, null, [], null);
    expect(e.selected).toBe(true);
  });
});
