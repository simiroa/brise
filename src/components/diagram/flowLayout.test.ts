import { describe, it, expect, vi, beforeEach } from "vitest";
import { layout as dagreRun } from "@dagrejs/dagre";
import { parseDiagram } from "./diagramModel";

// dagre stays REAL — every placement assertion below is about its actual output. It is only wrapped
// in a spy so the one thing coordinates alone cannot show can be asserted: that a fully arranged
// diagram never runs the auto-layout at all (layoutPositions' early return). A behaviour-only test
// would pass just as happily on the version that ran dagre and threw the whole result away.
vi.mock("@dagrejs/dagre", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dagrejs/dagre")>();
  return { ...actual, layout: vi.fn(actual.layout) };
});
import {
  alignPositions,
  dagreLayout,
  distributePositions,
  groupBoxes,
  groupMembers,
  layoutPositions,
  nodeSize,
  nodeSizes,
  GROUP_PAD,
  GROUP_TITLE_H,
  NODE_H,
  NODE_LINE_H,
  NODE_DESC_H,
  NODE_MAX_W,
  NODE_W,
  type LayoutBox,
} from "./flowLayout";

// The failure mode these guard against is quiet, not loud: a box lands somewhere plausible but
// wrong, and the user only notices after they have re-arranged the diagram by hand.

const SRC = JSON.stringify(
  {
    v: 1,
    nodes: [
      { id: "n1", label: "김철수" },
      { id: "n2", label: "김영수" },
      { id: "n3", label: "박씨" },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", line: "solid", arrow: "end" },
      { id: "e2", from: "n2", to: "n3", line: "solid", arrow: "end" },
    ],
  },
  null,
  2,
);

describe("dagreLayout", () => {
  it("places every node, top-left corner (not dagre's centre)", () => {
    const model = parseDiagram(SRC);
    const laid = dagreLayout(model);
    expect(Object.keys(laid).sort()).toEqual(["n1", "n2", "n3"]);
    for (const p of Object.values(laid)) {
      expect(Number.isInteger(p.x)).toBe(true);
      expect(Number.isInteger(p.y)).toBe(true);
    }
    // TD: a child ranks BELOW its parent, and by more than one box height (dagre's ranksep).
    expect(laid.n2.y - laid.n1.y).toBeGreaterThan(NODE_H);
    expect(laid.n3.y - laid.n2.y).toBeGreaterThan(NODE_H);
  });

  it("follows the diagram's own direction — LR ranks sideways, not downwards", () => {
    const m = parseDiagram(SRC);
    m.direction = "LR";
    const laid = dagreLayout(m);
    expect(laid.n2.x - laid.n1.x).toBeGreaterThan(NODE_W);
    expect(Math.abs(laid.n2.y - laid.n1.y)).toBeLessThan(NODE_H);
  });

  it("survives a graph with no edges at all (a diagram that is only boxes)", () => {
    const laid = dagreLayout(
      parseDiagram(
        JSON.stringify({
          v: 1,
          nodes: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
          edges: [],
        }),
      ),
    );
    expect(Object.keys(laid).sort()).toEqual(["a", "b"]);
  });

  it("reserves the WIDE box's real width — a long name must not land on top of its neighbour", () => {
    const long = "가".repeat(40);
    const m = parseDiagram(
      JSON.stringify({
        v: 1,
        nodes: [
          { id: "n1", label: long },
          { id: "n2", label: "짧음" },
        ],
        edges: [{ id: "e1", from: "n1", to: "n2", line: "solid", arrow: "end" }],
      }),
    );
    m.direction = "LR";
    const laid = dagreLayout(m);
    // The gap is measured from n1's own (wider) box, not from the minimum tile.
    expect(laid.n2.x - laid.n1.x).toBeGreaterThanOrEqual(nodeSize({ label: long }).width);
  });
});

describe("nodeSize — a long name widens its box instead of being cut off", () => {
  it("gives every short label the same minimum tile", () => {
    expect(nodeSize({ label: "A" })).toEqual({ width: NODE_W, height: NODE_H });
    expect(nodeSize({ label: "김철수" })).toEqual({ width: NODE_W, height: NODE_H });
  });

  it("grows sideways for a medium label, one line still", () => {
    const size = nodeSize({ label: "가".repeat(14) });
    expect(size.width).toBeGreaterThan(NODE_W);
    expect(size.width).toBeLessThanOrEqual(NODE_MAX_W);
    expect(size.height).toBe(NODE_H);
  });

  it("stops at the maximum width and takes a second line instead", () => {
    const size = nodeSize({ label: "가".repeat(40) });
    expect(size.width).toBe(NODE_MAX_W);
    expect(size.height).toBeGreaterThan(NODE_H);
    // Past two lines the CSS ellipsis takes over — the box does not keep growing.
    expect(nodeSize({ label: "가".repeat(400) })).toEqual(size);
  });

  it("never shrinks as the label grows, and CJK counts as wider than Latin", () => {
    let last = 0;
    for (const n of [1, 5, 10, 14, 18, 25, 60]) {
      const w = nodeSize({ label: "가".repeat(n) }).width;
      expect(w).toBeGreaterThanOrEqual(last);
      last = w;
    }
    expect(nodeSize({ label: "가".repeat(16) }).width).toBeGreaterThan(nodeSize({ label: "a".repeat(16) }).width);
  });

  it("reserves room for the 링크 아이콘 when the node carries one", () => {
    const label = "가".repeat(14);
    expect(nodeSize({ label, linked: true }).width).toBeGreaterThan(nodeSize({ label }).width);
  });

  it("reserves room for the `%% brise:meta` icon and for the description's own line", () => {
    const label = "가".repeat(14);
    expect(nodeSize({ label, icon: "🗂" }).width).toBeGreaterThan(nodeSize({ label }).width);
    // The description sits UNDER the label: a taller box, not a wider one, when it is short.
    const described = nodeSize({ label: "가", desc: "짧음" });
    expect(described.height).toBeGreaterThan(NODE_H);
    expect(described.width).toBe(NODE_W);
    // …but a description longer than the label is what decides the width.
    expect(nodeSize({ label: "가", desc: "설".repeat(20) }).width).toBeGreaterThan(NODE_W);
  });

  it("nodeSizes reads the label, the link map AND the meta map straight off the model", () => {
    const raw = JSON.parse(SRC);
    raw.nodes[0].link = "note-abc";
    const model = parseDiagram(JSON.stringify(raw));
    const sizes = nodeSizes(model);
    expect(Object.keys(sizes).sort()).toEqual(["n1", "n2", "n3"]);
    expect(sizes.n2).toEqual({ width: NODE_W, height: NODE_H });
    raw.nodes[1].desc = "설명";
    const described = nodeSizes(parseDiagram(JSON.stringify(raw)));
    expect(described.n2.height).toBeGreaterThan(NODE_H);
  });
});

// subgraph 상자. DERIVED, never stored — that is the whole contract, so these assert the arithmetic
// (bbox + padding + title strip) rather than any saved number, and prove that an inner box is
// contained by its outer one.
describe("groupBoxes — a subgraph's rectangle comes from what is inside it", () => {
  const boxesOf = (source: string) => {
    const model = parseDiagram(source);
    return groupBoxes(model, layoutPositions(model), nodeSizes(model));
  };

  it("wraps the members' bounding box with padding and a title strip", () => {
    const src = JSON.stringify({
      v: 1,
      nodes: [
        { id: "a", label: "가", pos: [100, 100], group: "g1" },
        { id: "b", label: "나", pos: [100, 300], group: "g1" },
      ],
      edges: [{ id: "e1", from: "a", to: "b", line: "solid", arrow: "end" }],
      groups: [{ id: "g1", title: "조정", parent: null }],
    });
    const box = boxesOf(src).g1;
    expect(box.x).toBe(100 - GROUP_PAD);
    expect(box.y).toBe(100 - GROUP_PAD - GROUP_TITLE_H);
    expect(box.width).toBe(NODE_W + GROUP_PAD * 2);
    // 100..300+NODE_H tall, plus padding both sides and the title strip on top.
    expect(box.height).toBe(200 + NODE_H + GROUP_PAD * 2 + GROUP_TITLE_H);
  });

  it("a nested block's box is fully inside its parent's", () => {
    const src = JSON.stringify({
      v: 1,
      nodes: [
        { id: "a", label: "가", pos: [0, 0], group: "out" },
        { id: "b", label: "나", pos: [400, 0], group: "in" },
        { id: "c", label: "다", pos: [400, 200], group: "in" },
      ],
      edges: [{ id: "e1", from: "b", to: "c", line: "solid", arrow: "end" }],
      groups: [
        { id: "out", title: "밖", parent: null },
        { id: "in", title: "안", parent: "out" },
      ],
    });
    const boxes = boxesOf(src);
    const outer = boxes["out"];
    const inner = boxes["in"];
    expect(inner).toBeDefined();
    expect(outer.x).toBeLessThanOrEqual(inner.x);
    expect(outer.y).toBeLessThanOrEqual(inner.y);
    expect(outer.x + outer.width).toBeGreaterThanOrEqual(inner.x + inner.width);
    expect(outer.y + outer.height).toBeGreaterThanOrEqual(inner.y + inner.height);
    // …and it still contains the member that is NOT in the nested block.
    expect(outer.x).toBeLessThanOrEqual(0 - GROUP_PAD);
  });

  it("gives an empty block no box at all — there is nothing to derive one from", () => {
    const src = JSON.stringify({
      v: 1,
      nodes: [
        { id: "a", label: "a" },
        { id: "b", label: "b" },
      ],
      edges: [{ id: "e1", from: "a", to: "b", line: "solid", arrow: "end" }],
      groups: [{ id: "empty", title: "빈칸", parent: null }],
    });
    expect(boxesOf(src)["empty"]).toBeUndefined();
  });

  it("dagre keeps a block's members together instead of scattering them by rank", () => {
    const src = JSON.stringify({
      v: 1,
      nodes: [
        { id: "a", label: "a", group: "g1" },
        { id: "b", label: "b", group: "g1" },
        { id: "c", label: "c", group: "g2" },
        { id: "d", label: "d", group: "g2" },
      ],
      edges: [
        { id: "e1", from: "a", to: "b", line: "solid", arrow: "end" },
        { id: "e2", from: "c", to: "d", line: "solid", arrow: "end" },
        { id: "e3", from: "a", to: "c", line: "solid", arrow: "end" },
      ],
      groups: [
        { id: "g1", title: "g1", parent: null },
        { id: "g2", title: "g2", parent: null },
      ],
    });
    const laid = dagreLayout(parseDiagram(src));
    expect(Object.keys(laid).sort()).toEqual(["a", "b", "c", "d"]);
    for (const p of Object.values(laid)) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    const boxes = groupBoxes(parseDiagram(src), laid, nodeSizes(parseDiagram(src)));
    // Two disjoint clusters: neither box may swallow the other's members.
    const overlap =
      boxes.g1.x < boxes.g2.x + boxes.g2.width &&
      boxes.g2.x < boxes.g1.x + boxes.g1.width &&
      boxes.g1.y < boxes.g2.y + boxes.g2.height &&
      boxes.g2.y < boxes.g1.y + boxes.g1.height;
    expect(overlap).toBe(false);
  });
});

describe("groupMembers — every node inside a group, however deeply nested", () => {
  it("collects direct members plus every nested sub-group's members", () => {
    const src = JSON.stringify({
      v: 1,
      nodes: [
        { id: "a", label: "가", group: "out" },
        { id: "b", label: "나", group: "in" },
        { id: "c", label: "다", group: "deepest" },
        { id: "d", label: "라" }, // no group at all
      ],
      edges: [],
      groups: [
        { id: "out", title: "밖", parent: null },
        { id: "in", title: "안", parent: "out" },
        { id: "deepest", title: "더안", parent: "in" },
      ],
    });
    const model = parseDiagram(src);
    // Outermost group pulls in every descendant's members, three levels deep.
    expect(groupMembers(model, "out").sort()).toEqual(["a", "b", "c"]);
    expect(groupMembers(model, "in").sort()).toEqual(["b", "c"]);
    expect(groupMembers(model, "deepest")).toEqual(["c"]);
  });

  it("returns an empty array for a group with no members", () => {
    const src = JSON.stringify({
      v: 1,
      nodes: [{ id: "a", label: "a" }],
      edges: [],
      groups: [{ id: "empty", title: "빈칸", parent: null }],
    });
    expect(groupMembers(parseDiagram(src), "empty")).toEqual([]);
  });

  it("returns an empty array for a groupId that does not exist in the model", () => {
    const src = JSON.stringify({
      v: 1,
      nodes: [{ id: "a", label: "a", group: "g1" }],
      edges: [],
      groups: [{ id: "g1", title: "g1", parent: null }],
    });
    expect(groupMembers(parseDiagram(src), "nope")).toEqual([]);
  });
});

describe("layoutPositions — saved coordinates beat the auto-layout, per node", () => {
  it("uses pos where it exists and dagre for every node that has none", () => {
    const raw = JSON.parse(SRC);
    raw.nodes[1].pos = [400, -25];
    const model = parseDiagram(JSON.stringify(raw));
    const placed = layoutPositions(model);
    expect(placed.n2).toEqual({ x: 400, y: -25 });
    // n1/n3 were never dragged: they get dagre's slot, not (0,0) and not n2's.
    const auto = dagreLayout(model);
    expect(placed.n1).toEqual(auto.n1);
    expect(placed.n3).toEqual(auto.n3);
  });

  it("adding one box to a hand-arranged diagram leaves the arranged boxes exactly where they were", () => {
    const raw = JSON.parse(SRC);
    raw.nodes[0].pos = [0, 0];
    raw.nodes[1].pos = [0, 120];
    raw.nodes[2].pos = [0, 240];
    const arranged = JSON.stringify(raw);
    const before = layoutPositions(parseDiagram(arranged));
    raw.nodes.push({ id: "n4", label: "새 사람" });
    const after = layoutPositions(parseDiagram(JSON.stringify(raw)));
    expect(after.n1).toEqual(before.n1);
    expect(after.n2).toEqual(before.n2);
    expect(after.n3).toEqual(before.n3);
    expect(after.n4).toBeDefined();
  });

  // 조기 반환 — 세 케이스. dagre 는 저장 좌표에 덮여 버려질 뿐인데도 매번 돌고 있었다.
  describe("dagre only runs when something is actually missing", () => {
    // Block body, not a concise one: `mockClear()` returns the mock, and a beforeEach that RETURNS
    // a function hands vitest that function as the teardown hook — it would then call dagre's
    // layout() with no graph after every case.
    beforeEach(() => {
      vi.mocked(dagreRun).mockClear();
    });

    it("전부 저장: dagre 를 아예 부르지 않고 저장 좌표를 그대로 돌려준다", () => {
      const raw = JSON.parse(SRC);
      raw.nodes[0].pos = [13, 7];
      raw.nodes[1].pos = [13, 127];
      raw.nodes[2].pos = [13, 247];
      const placed = layoutPositions(parseDiagram(JSON.stringify(raw)));
      expect(placed).toEqual({ n1: { x: 13, y: 7 }, n2: { x: 13, y: 127 }, n3: { x: 13, y: 247 } });
      expect(dagreRun).not.toHaveBeenCalled();
    });

    it("일부만 저장: 예전 그대로 — dagre 가 돌고 저장된 것만 덮인다", () => {
      const raw = JSON.parse(SRC);
      raw.nodes[1].pos = [400, -25];
      const model = parseDiagram(JSON.stringify(raw));
      const placed = layoutPositions(model);
      expect(dagreRun).toHaveBeenCalled();
      expect(placed.n2).toEqual({ x: 400, y: -25 });
      expect(Object.keys(placed).sort()).toEqual(["n1", "n2", "n3"]);
    });

    it("노드 0개: 빈 기록, dagre 없이", () => {
      const placed = layoutPositions(parseDiagram(JSON.stringify({ v: 1, nodes: [], edges: [] })));
      expect(placed).toEqual({});
      expect(dagreRun).not.toHaveBeenCalled();
    });

    // 그룹이 있어도 안전한지 — groupBoxes 는 좌표에서 파생되므로 dagre 를 건너뛴 것과 무관해야
    // 한다. dagre 의 cluster 노드는 원래도 반환값에 들어간 적이 없다(model.nodes 만 순회한다).
    it("subgraph 가 있어도 전부 저장이면 dagre 없이 같은 상자가 나온다", () => {
      const src = JSON.stringify({
        v: 1,
        nodes: [
          { id: "a", label: "가", pos: [100, 100], group: "g1" },
          { id: "b", label: "나", pos: [100, 300], group: "g1" },
        ],
        edges: [{ id: "e1", from: "a", to: "b", line: "solid", arrow: "end" }],
        groups: [{ id: "g1", title: "조정", parent: null }],
      });
      const model = parseDiagram(src);
      const positions = layoutPositions(model);
      expect(dagreRun).not.toHaveBeenCalled();
      const box = groupBoxes(model, positions, nodeSizes(model)).g1;
      expect(box.x).toBe(100 - GROUP_PAD);
      expect(box.y).toBe(100 - GROUP_PAD - GROUP_TITLE_H);
      expect(box.height).toBe(200 + NODE_H + GROUP_PAD * 2 + GROUP_TITLE_H);
    });
  });
});

// 정렬/분배. Sizes DIFFER on purpose in every fixture below: aligning by top-left corner looks
// right on equal boxes and visibly wrong the moment one label is longer than the others, which is
// the normal case in a real diagram.
const box = (id: string, x: number, y: number, width = NODE_W, height = NODE_H): LayoutBox => ({
  id,
  x,
  y,
  width,
  height,
});

describe("alignPositions", () => {
  const boxes = [box("a", 0, 0, 100, 40), box("b", 30, 100, 200, 60), box("c", 10, 200, 60, 40)];

  it("left / right pin the matching EDGE of the selection's own bounding box", () => {
    expect(alignPositions(boxes, "left")).toEqual({
      a: { x: 0, y: 0 },
      b: { x: 0, y: 100 },
      c: { x: 0, y: 200 },
    });
    // right edge of the group = max(x + width) = 30 + 200 = 230.
    expect(alignPositions(boxes, "right")).toEqual({
      a: { x: 130, y: 0 },
      b: { x: 30, y: 100 },
      c: { x: 170, y: 200 },
    });
  });

  it("centres by the box's own middle, not by its corner", () => {
    // group spans x 0..230, centre 115.
    expect(alignPositions(boxes, "center-x")).toEqual({
      a: { x: 65, y: 0 },
      b: { x: 15, y: 100 },
      c: { x: 85, y: 200 },
    });
  });

  it("does the same on the other axis, leaving x untouched", () => {
    const row = [box("a", 0, 0, 100, 40), box("b", 200, 30, 100, 80)];
    expect(alignPositions(row, "top")).toEqual({ a: { x: 0, y: 0 }, b: { x: 200, y: 0 } });
    // bottom edge = max(y + height) = 110.
    expect(alignPositions(row, "bottom")).toEqual({ a: { x: 0, y: 70 }, b: { x: 200, y: 30 } });
    expect(alignPositions(row, "center-y")).toEqual({ a: { x: 0, y: 35 }, b: { x: 200, y: 15 } });
  });

  it("moves nothing when there is nothing to align against", () => {
    expect(alignPositions([box("a", 5, 5)], "left")).toEqual({});
    expect(alignPositions([], "top")).toEqual({});
  });

  it("writes integers only — a coordinate goes into the source as `%% brise:pos x,y`", () => {
    const odd = [box("a", 0, 0, 101, 41), box("b", 7, 55, 60, 33)];
    for (const p of Object.values(alignPositions(odd, "center-x"))) expect(Number.isInteger(p.x)).toBe(true);
    for (const p of Object.values(alignPositions(odd, "center-y"))) expect(Number.isInteger(p.y)).toBe(true);
  });
});

describe("distributePositions", () => {
  it("evens out the GAPS and never moves the two outermost boxes", () => {
    // Widths 100/200/100 across x 0..600 → 600 - 400 = 200 of gap, 100 each.
    const boxes = [box("a", 0, 0, 100, 40), box("b", 120, 0, 200, 40), box("c", 500, 0, 100, 40)];
    expect(distributePositions(boxes, "x")).toEqual({
      a: { x: 0, y: 0 },
      b: { x: 200, y: 0 },
      c: { x: 500, y: 0 },
    });
  });

  it("orders by centre, so a scrambled selection comes out in the order it LOOKS", () => {
    const boxes = [box("c", 400, 0, 100, 40), box("a", 0, 0, 100, 40), box("b", 111, 0, 100, 40)];
    const out = distributePositions(boxes, "x");
    expect(out.a.x).toBeLessThan(out.b.x);
    expect(out.b.x).toBeLessThan(out.c.x);
    expect(out.a.x).toBe(0);
    expect(out.c.x).toBe(400);
  });

  it("does the vertical axis the same way, x untouched", () => {
    const boxes = [box("a", 10, 0, 100, 40), box("b", 60, 55, 100, 40), box("c", 30, 240, 100, 40)];
    const out = distributePositions(boxes, "y");
    expect(out.a).toEqual({ x: 10, y: 0 });
    expect(out.c).toEqual({ x: 30, y: 240 });
    // 280 of span - 120 of boxes = 160 of gap, 80 each → b starts at 40 + 80.
    expect(out.b).toEqual({ x: 60, y: 120 });
  });

  it("refuses two boxes — there is no interior gap to even out, so it must not nudge them", () => {
    expect(distributePositions([box("a", 0, 0), box("b", 300, 0)], "x")).toEqual({});
  });
});

describe("nodeSize rows (W2) — 구획 한 줄에 NODE_LINE_H", () => {
  it("rows 3줄 노드 높이 = 기본 높이 + 3×NODE_LINE_H, 설명이 있으면 그 위에 더해진다", () => {
    expect(nodeSize({ label: "users", rows: ["id", "email", "created_at"] })).toEqual({ width: NODE_W, height: NODE_H + 3 * NODE_LINE_H });
    expect(nodeSize({ label: "users", desc: "표", rows: ["id", "email", "created_at"] }).height).toBe(NODE_H + NODE_DESC_H + 3 * NODE_LINE_H);
    expect(nodeSize({ label: "u", rows: [] })).toEqual(nodeSize({ label: "u" }));
  });

  it("긴 구획은 라벨처럼 상자를 옆으로 넓힌다", () => {
    expect(nodeSize({ label: "u", rows: ["created_at: timestamp with time zone"] }).width).toBeGreaterThan(NODE_W);
  });

  it("nodeSizes 가 노드의 rows 를 읽는다", () => {
    const model = parseDiagram(JSON.stringify({ v: 1, nodes: [{ id: "a", label: "A", rows: ["x", "y"] }], edges: [] }));
    expect(nodeSizes(model).a.height).toBe(NODE_H + 2 * NODE_LINE_H);
  });
});
