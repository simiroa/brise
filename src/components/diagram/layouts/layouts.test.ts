import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDiagramJson, type DiagramModel } from "../diagramSchema";
import { groupBoxes, layoutFor, layoutPositions, nodeSizes, NODE_W, NODE_H, quadrantAxes, dagreLayout } from "../flowLayout";
import { diagramTemplateSource } from "../diagramStarter";
import { radialLayout } from "./radial";
import { stackLayout } from "./stack";
import { circleLayout } from "./circle";
import { LAYOUT_MARGIN } from "./_types";
import { sequenceLayout, SEQUENCE_STEP } from "./sequence";

const model = (json: object): DiagramModel => parseDiagramJson(JSON.stringify(json));
const run = (m: DiagramModel) => {
  const sizes = nodeSizes(m);
  const { positions } = layoutFor(m, sizes);
  return { sizes, positions, boxes: groupBoxes(m, positions, sizes) };
};
const center = (p: { x: number; y: number }, s: { width: number; height: number }) => ({ x: p.x + s.width / 2, y: p.y + s.height / 2 });

describe("layouts/ — 순수 함수 규율", () => {
  it("소스에 react·xyflow 문자열이 없다(캔버스 청크를 끌고 오지 않는다)", () => {
    const dir = resolve(__dirname);
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      const src = readFileSync(resolve(dir, f), "utf8");
      expect(src.includes("react"), f).toBe(false);
      expect(src.includes("xyflow"), f).toBe(false);
    }
  });

  it("layoutFor: layout 이 없거나 모르는 값이면 dagre 와 같은 좌표; sequence 는 dagre 와 다르다(W2b)", () => {
    const base = { v: 1, nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ id: "e", from: "a", to: "b" }] };
    const plain = model(base);
    expect(layoutFor(plain, nodeSizes(plain)).positions).toEqual(dagreLayout(plain));
    const seq = model({ ...base, layout: "sequence" });
    expect(seq.layout).toBe("sequence");
    expect(layoutFor(seq, nodeSizes(seq)).positions).not.toEqual(dagreLayout(seq));
    expect(layoutFor(seq, nodeSizes(seq)).edgeAnchors).toEqual({ e: { y: LAYOUT_MARGIN + NODE_H + SEQUENCE_STEP } });
    const banana = model({ ...base, layout: "banana" });
    expect(banana.layout).toBeUndefined();
    expect(layoutFor(banana, nodeSizes(banana)).positions).toEqual(dagreLayout(banana));
  });
});

describe("radial", () => {
  it("별(루트 + 자식 4)에서 루트 중심 = 나머지 bbox 중심(±1px), 자식은 모두 같은 반지름", () => {
    const m = model({
      v: 1,
      layout: "radial",
      nodes: [{ id: "r", label: "R" }, { id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }, { id: "d", label: "D" }],
      edges: ["a", "b", "c", "d"].map((id) => ({ id: `e${id}`, from: "r", to: id })),
    });
    const { sizes, positions } = run(m);
    const rc = center(positions.r, sizes.r);
    const kids = ["a", "b", "c", "d"].map((id) => ({ ...positions[id], ...sizes[id] }));
    const bx = (Math.min(...kids.map((k) => k.x)) + Math.max(...kids.map((k) => k.x + k.width))) / 2;
    const by = (Math.min(...kids.map((k) => k.y)) + Math.max(...kids.map((k) => k.y + k.height))) / 2;
    expect(Math.abs(rc.x - bx)).toBeLessThanOrEqual(1);
    expect(Math.abs(rc.y - by)).toBeLessThanOrEqual(1);
    const radii = kids.map((k) => Math.hypot(k.x + k.width / 2 - rc.x, k.y + k.height / 2 - rc.y));
    for (const r of radii) expect(Math.abs(r - radii[0])).toBeLessThanOrEqual(1);
    // 첫 자식은 12시 방향 부채꼴(−90°..0°)의 가운데 = 우상단.
    expect(kids[0].x + kids[0].width / 2).toBeGreaterThan(rc.x);
    expect(kids[0].y + kids[0].height / 2).toBeLessThan(rc.y);
  });

  it("루트 = 들어오는 엣지 없는 노드; 닿지 않는 노드도 배치된다; 좌상단 여백 = LAYOUT_MARGIN", () => {
    const m = model({
      v: 1,
      layout: "radial",
      nodes: [{ id: "x", label: "X" }, { id: "root", label: "Root" }, { id: "lone", label: "Lone" }],
      edges: [{ id: "e1", from: "root", to: "x" }],
    });
    const { positions } = radialLayout(m, nodeSizes(m));
    expect(Object.keys(positions).sort()).toEqual(["lone", "root", "x"]);
    expect(Math.min(...Object.values(positions).map((p) => p.x))).toBe(LAYOUT_MARGIN);
    expect(Math.min(...Object.values(positions).map((p) => p.y))).toBe(LAYOUT_MARGIN);
  });

  it("mindmap 시드가 radial 로 열린다 — 중심 주제가 깊이 1 노드들 사이에 있다", () => {
    const m = parseDiagramJson(diagramTemplateSource("mindmap"));
    expect(m.layout).toBe("radial");
    const { sizes, positions } = run(m);
    const c = center(positions.n1, sizes.n1);
    const a = center(positions.n2, sizes.n2);
    const b = center(positions.n5, sizes.n5);
    // 두 가지가 서로 반대편 반원에 선다(부채꼴 2/3 + 1/3 이라 정반대는 아니다).
    expect((a.x - c.x) * (b.x - c.x) + (a.y - c.y) * (b.y - c.y)).toBeLessThan(0);
  });
});

describe("stack", () => {
  it("모든 노드 x 동일(= LAYOUT_MARGIN), y 는 배열 순서대로 증가", () => {
    const m = parseDiagramJson(diagramTemplateSource("stack"));
    const { positions } = run(m);
    const xs = m.nodes.map((n) => positions[n.id].x);
    expect(new Set(xs).size).toBe(1);
    expect(xs[0]).toBe(LAYOUT_MARGIN);
    const ys = m.nodes.map((n) => positions[n.id].y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(ys[0]).toBe(LAYOUT_MARGIN);
    expect(ys[1]).toBe(LAYOUT_MARGIN + NODE_H + 12);
  });

  it("type:\"pyramid\" 일 때만 가운데 정렬 — 짧은 라벨 층의 x 가 커진다", () => {
    const nodes = [{ id: "a", label: "짧음" }, { id: "b", label: "이 층은 라벨이 훨씬 길어서 폭이 넓어진다" }];
    const plain = model({ v: 1, layout: "stack", nodes, edges: [] });
    const pyr = model({ v: 1, layout: "stack", type: "pyramid", nodes, edges: [] });
    expect(stackLayout(plain, nodeSizes(plain)).positions.a.x).toBe(LAYOUT_MARGIN);
    const p = stackLayout(pyr, nodeSizes(pyr)).positions;
    expect(p.b.x).toBe(LAYOUT_MARGIN);
    expect(p.a.x).toBeGreaterThan(LAYOUT_MARGIN);
  });
});

describe("circle", () => {
  it("노드 중심이 한 원 위(반지름 오차 1px), 엣지를 따라간 순서로 시계 방향", () => {
    const m = parseDiagramJson(diagramTemplateSource("lifecycle"));
    const { sizes, positions } = run(m);
    const cs = m.nodes.map((n) => center(positions[n.id], sizes[n.id]));
    const cx = cs.reduce((s, c) => s + c.x, 0) / cs.length;
    const cy = cs.reduce((s, c) => s + c.y, 0) / cs.length;
    const rs = cs.map((c) => Math.hypot(c.x - cx, c.y - cy));
    for (const r of rs) expect(Math.abs(r - rs[0])).toBeLessThanOrEqual(1);
    // n1 이 12시(가장 위), n2 는 그 시계 방향 다음(오른쪽 위).
    expect(cs[0].y).toBeLessThanOrEqual(Math.min(...cs.map((c) => c.y)) + 1);
    expect(cs[1].x).toBeGreaterThan(cs[0].x);
  });

  it("엣지가 배열 순서와 다르면 엣지 순서가 이긴다", () => {
    const m = model({
      v: 1,
      layout: "circle",
      nodes: [{ id: "a", label: "A" }, { id: "c", label: "C" }, { id: "b", label: "B" }],
      edges: [{ id: "e1", from: "a", to: "b" }, { id: "e2", from: "b", to: "c" }],
    });
    const sizes = nodeSizes(m);
    const p = circleLayout(m, sizes).positions;
    const [a, b, c] = ["a", "b", "c"].map((id) => center(p[id], sizes[id]));
    // a 12시, b 4시(오른쪽 아래), c 8시(왼쪽 아래)
    expect(b.x).toBeGreaterThan(a.x);
    expect(c.x).toBeLessThan(a.x);
    expect(Math.abs(b.y - c.y)).toBeLessThanOrEqual(1);
  });
});

describe("quadrant", () => {
  it("그룹 4개가 2×2 — 0·1 같은 y, 2·3 같은 y, 0·2 같은 x, 1·3 같은 x; 축 십자는 그 틈 한가운데", () => {
    const m = parseDiagramJson(diagramTemplateSource("quadrant"));
    const { boxes } = run(m);
    const [g1, g2, g3, g4] = ["g1", "g2", "g3", "g4"].map((id) => boxes[id]);
    expect(g1.y).toBe(g2.y);
    expect(g3.y).toBe(g4.y);
    expect(g1.x).toBe(g3.x);
    expect(g2.x).toBe(g4.x);
    expect(g2.x).toBeGreaterThan(g1.x + g1.width);
    expect(g3.y).toBeGreaterThan(g1.y + g1.height);
    const axes = quadrantAxes(m, boxes)!;
    expect(axes.x).toBeGreaterThan(g1.x + g1.width);
    expect(axes.x).toBeLessThan(g2.x);
    expect(axes.y).toBeGreaterThan(g1.y + g1.height);
    expect(axes.y).toBeLessThan(g3.y);
    expect(axes.left).toBe(g1.x);
    expect(axes.bottom).toBe(g3.y + g3.height);
  });

  it("quadrantAxes 는 quadrant 가 아니거나 그룹이 4개 미만이면 null", () => {
    const m = parseDiagramJson(diagramTemplateSource("journey"));
    const { boxes } = run(m);
    expect(quadrantAxes(m, boxes)).toBeNull();
    const three = model({
      v: 1,
      layout: "quadrant",
      nodes: [{ id: "a", label: "A", group: "g1" }, { id: "b", label: "B", group: "g2" }, { id: "c", label: "C", group: "g3" }],
      edges: [],
      groups: [{ id: "g1", title: "1" }, { id: "g2", title: "2" }, { id: "g3", title: "3" }],
    });
    const r = run(three);
    expect(quadrantAxes(three, r.boxes)).toBeNull();
    expect(Object.keys(r.positions).length).toBe(3);
  });
});

describe("lanes", () => {
  it("그룹별 y 대역(파생 상자)이 겹치지 않고 그룹 순서대로 내려간다; 단계가 뒤인 노드는 x 가 크다", () => {
    const m = parseDiagramJson(diagramTemplateSource("lanes"));
    const { positions, boxes } = run(m);
    const lanes = m.groups.map((g) => boxes[g.id]);
    for (let i = 1; i < lanes.length; i++) expect(lanes[i].y).toBeGreaterThan(lanes[i - 1].y + lanes[i - 1].height);
    // n1(고객) → n2(영업) → … → n6(고객): 단계 순으로 x 증가.
    const xs = m.nodes.map((n) => positions[n.id].x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    // 같은 레인의 n1 과 n6 은 같은 y(둘 다 레인 맨 위 — rank 가 다르니 쌓이지 않는다).
    expect(positions.n1.y).toBe(positions.n6.y);
  });

  it("같은 레인·같은 rank 는 아래로 쌓인다", () => {
    const m = model({
      v: 1,
      layout: "lanes",
      nodes: [{ id: "a", label: "A", group: "g" }, { id: "b", label: "B", group: "g" }, { id: "c", label: "C", group: "g" }],
      edges: [{ id: "e1", from: "a", to: "b" }, { id: "e2", from: "a", to: "c" }],
      groups: [{ id: "g", title: "lane" }],
    });
    const { positions } = run(m);
    expect(positions.b.x).toBe(positions.c.x);
    expect(positions.c.y).toBeGreaterThan(positions.b.y);
    expect(positions.a.x).toBeLessThan(positions.b.x);
  });
});

describe("grid", () => {
  it("그룹 = 열(x 증가), 열 안 노드는 배열 순서대로 y 증가, 열 상자끼리 겹치지 않음", () => {
    const m = parseDiagramJson(diagramTemplateSource("journey"));
    const { positions, boxes } = run(m);
    const cols = m.groups.map((g) => boxes[g.id]);
    for (let i = 1; i < cols.length; i++) expect(cols[i].x).toBeGreaterThan(cols[i - 1].x + cols[i - 1].width);
    for (const g of m.groups) {
      const members = m.nodes.filter((n) => n.group === g.id);
      expect(new Set(members.map((n) => positions[n.id].x)).size).toBe(1);
      const ys = members.map((n) => positions[n.id].y);
      expect(ys).toEqual([...ys].sort((a, b) => a - b));
    }
    // 열이 달라도 같은 행은 같은 y.
    expect(positions.n1.y).toBe(positions.n3.y);
    expect(positions.n2.y).toBe(positions.n4.y);
  });
});

describe("fishbone", () => {
  it("머리가 가장 오른쪽, 가시 그룹은 척추 위/아래 교대, 척추 y = 머리 중심 y", () => {
    const m = parseDiagramJson(diagramTemplateSource("fishbone"));
    const { sizes, positions, boxes } = run(m);
    const head = center(positions.n1, sizes.n1);
    for (const n of m.nodes) if (n.id !== "n1") expect(positions[n.id].x + sizes[n.id].width).toBeLessThan(positions.n1.x);
    m.groups.forEach((g, i) => {
      const b = boxes[g.id];
      if (i % 2 === 0) expect(b.y + b.height).toBeLessThan(head.y);
      else expect(b.y).toBeGreaterThan(head.y);
    });
    // 같은 쪽(0·2) 가시는 왼쪽에서 오른쪽으로.
    expect(boxes.g3.x).toBeGreaterThan(boxes.g1.x + boxes.g1.width);
    expect(boxes.g4.x).toBeGreaterThan(boxes.g2.x + boxes.g2.width);
    expect(Math.min(...Object.values(positions).map((p) => p.y))).toBeGreaterThanOrEqual(LAYOUT_MARGIN);
  });
});

describe("sequence", () => {
  it("시드(노드 3·엣지 4): 노드 y 전부 동일, x 는 배열 순서로 증가, 앵커 y 는 엣지 순서로 STEP 씩 증가, lifelineH > max(anchor y)", () => {
    const m = parseDiagramJson(diagramTemplateSource("sequence"));
    expect(m.nodes.length).toBe(3);
    expect(m.edges.length).toBe(4);
    const sizes = nodeSizes(m);
    const { positions, edgeAnchors, lifelineH } = sequenceLayout(m, sizes);
    const ids = m.nodes.map((n) => n.id);
    expect(new Set(ids.map((id) => positions[id].y)).size).toBe(1);
    expect(positions[ids[0]]).toEqual({ x: LAYOUT_MARGIN, y: LAYOUT_MARGIN });
    for (let i = 1; i < ids.length; i++) expect(positions[ids[i]].x).toBeGreaterThan(positions[ids[i - 1]].x + sizes[ids[i - 1]].width);
    const ys = m.edges.map((e) => edgeAnchors![e.id].y);
    expect(ys).toEqual([1, 2, 3, 4].map((i) => LAYOUT_MARGIN + NODE_H + i * SEQUENCE_STEP));
    expect(lifelineH).toBeGreaterThan(Math.max(...ys));
    // layoutFor 가 앵커·lifelineH 를 그대로 흘린다.
    expect(layoutFor(m, sizes)).toEqual(sequenceLayout(m, sizes));
  });
});

describe("layoutPositions 통합 — 드래그된 pos 가 이긴다", () => {
  it("한 노드에 pos 가 있으면 그 노드만 그대로, 나머지는 배치 함수 결과", () => {
    const src = JSON.parse(diagramTemplateSource("stack"));
    src.nodes[0].pos = [500, 500];
    const m = parseDiagramJson(JSON.stringify(src));
    const sizes = nodeSizes(m);
    const laid = layoutFor(m, sizes).positions;
    const p = layoutPositions(m);
    expect(p.n1).toEqual({ x: 500, y: 500 });
    expect(p.n2).toEqual(laid.n2);
    expect(sizes.n1.width).toBe(NODE_W);
  });
});
