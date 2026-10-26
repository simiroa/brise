import { describe, it, expect } from "vitest";
import {
  addEdge,
  addGroup,
  addNode,
  canConnect,
  deleteEdge,
  deleteNode,
  dissolveGroup,
  moveNodeToGroup,
  nextNodeId,
  nextEdgeId,
  nextGroupId,
  renameGroup,
  setGroupTone,
  groupTone,
  parseDiagram,
  renameNode,
  setEdgeLabel,
  setEdgeStyle,
  setNodeLink,
  setNodeMeta,
  setNodeRows,
  setNodePos,
  setNodePositions,
  setNodeShape,
  setEdgeSource,
  setEdgeTarget,
  soleIncomingEdge,
} from "./diagramModel";

const SRC = JSON.stringify(
  {
    v: 1,
    nodes: [
      { id: "n1", label: "김철수", shape: "rect", link: "note-abc" },
      { id: "n2", label: "김영수", shape: "rect" },
      { id: "n3", label: "박씨", shape: "stadium" },
      { id: "n4", label: "이씨", shape: "diamond" },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", label: "아들", line: "solid", arrow: "end" },
      { id: "e2", from: "n2", to: "n3", label: "사돈", line: "dotted", arrow: "end" },
      { id: "e3", from: "n1", to: "n4", label: "부부", line: "solid", arrow: "both" },
    ],
  },
  null,
  2,
);

describe("parseDiagram (JSON IR v1)", () => {
  it("reads direction, nodes, edges, links, and positions", () => {
    const m = parseDiagram(SRC);
    expect(m.structured).toBe(true);
    expect(m.direction).toBe("TD");
    expect(m.nodes.map((n) => [n.id, n.label, n.shape])).toEqual([
      ["n1", "김철수", "rect"],
      ["n2", "김영수", "rect"],
      ["n3", "박씨", "stadium"],
      ["n4", "이씨", "diamond"],
    ]);
    expect(m.edges.map((e) => [e.id, e.from, e.to, e.label, e.style])).toEqual([
      ["e1", "n1", "n2", "아들", "solid"],
      ["e2", "n2", "n3", "사돈", "dotted"],
      ["e3", "n1", "n4", "부부", "bidirectional"],
    ]);
    expect(m.nodes.find((n) => n.id === "n1")?.link).toBe("note-abc");
  });

  it("handles empty or whitespace string by returning an empty model", () => {
    const m = parseDiagram("   ");
    expect(m.empty).toBe(true);
    expect(m.structured).toBe(true);
    expect(m.nodes).toEqual([]);
    expect(m.edges).toEqual([]);
  });

  it("handles non-json string gracefully without throwing", () => {
    const bad = "sequenceDiagram\n  A->>B: 인사";
    const m = parseDiagram(bad);
    expect(m.structured).toBe(false);
    expect(m.raw).toBe(bad);
    expect(m.nodes).toEqual([]);
    expect(m.edges).toEqual([]);
  });
});

describe("id generators", () => {
  it("generates sequential next ids", () => {
    expect(nextNodeId([{ id: "n1", label: "" }, { id: "n3", label: "" }])).toBe("n4");
    expect(nextEdgeId([{ id: "e1", from: "a", to: "b" }, { id: "e5", from: "b", to: "c" }])).toBe("e6");
    expect(nextGroupId([{ id: "g2", title: "", parent: null }])).toBe("g3");
  });
});

describe("mutations (JSON IR v1)", () => {
  it("addNode appends a new node and returns serialized json and id", () => {
    const { source, id } = addNode(SRC, "정약용");
    expect(id).toBe("n5");
    const m = parseDiagram(source);
    expect(m.nodes.find((n) => n.id === "n5")?.label).toBe("정약용");
  });

  it("addNode with pos saves position on the node", () => {
    const { source, id } = addNode(SRC, "홍길동", "round", { x: 100, y: 200 });
    const m = parseDiagram(source);
    const n = m.nodes.find((node) => node.id === id);
    expect(n?.pos).toEqual([100, 200]);
  });

  it("addEdge only accepts endpoints that exist", () => {
    expect(addEdge(SRC, "n1", "nope")).toBe(SRC);
    const next = addEdge(SRC, "n3", "n4", "혼인", "dotted");
    const m = parseDiagram(next);
    expect(m.edges.some((e) => e.from === "n3" && e.to === "n4" && e.label === "혼인" && e.style === "dotted")).toBe(true);
  });

  it("addEdge writes a self-loop", () => {
    const next = addEdge(SRC, "n1", "n1", "본인 확인");
    const m = parseDiagram(next);
    expect(m.edges.some((e) => e.from === "n1" && e.to === "n1" && e.label === "본인 확인")).toBe(true);
  });

  it("addEdge refuses exact duplicates", () => {
    const first = addEdge(SRC, "n1", "n2", "아들", "solid");
    expect(first).toBe(SRC);
  });

  it("deleteNode cascades connected edges", () => {
    const raw = JSON.parse(SRC);
    raw.nodes[0].pos = [10, 20];
    raw.nodes[0].icon = "🚀";
    const srcWithMeta = JSON.stringify(raw);
    const next = deleteNode(srcWithMeta, "n1");
    const m = parseDiagram(next);
    expect(m.nodes.some((n) => n.id === "n1")).toBe(false);
    expect(m.edges.some((e) => e.from === "n1" || e.to === "n1")).toBe(false);
  });

  it("deleteEdge removes only the specified edge", () => {
    const next = deleteEdge(SRC, "e1");
    const m = parseDiagram(next);
    expect(m.edges.some((e) => e.id === "e1")).toBe(false);
    expect(m.edges.some((e) => e.id === "e2")).toBe(true);
    expect(m.nodes).toHaveLength(4);
  });

  it("renameNode updates node label", () => {
    const next = renameNode(SRC, "n1", "김철수(개명)");
    const m = parseDiagram(next);
    expect(m.nodes.find((n) => n.id === "n1")?.label).toBe("김철수(개명)");
  });

  it("setNodeShape updates node shape", () => {
    const next = setNodeShape(SRC, "n1", "circle");
    const m = parseDiagram(next);
    expect(m.nodes.find((n) => n.id === "n1")?.shape).toBe("circle");
  });

  it("setEdgeStyle updates edge style, line, and arrow", () => {
    const next = setEdgeStyle(SRC, "e1", "dotted");
    const m = parseDiagram(next);
    const e = m.edges.find((edge) => edge.id === "e1");
    expect(e?.style).toBe("dotted");
    expect(e?.line).toBe("dotted");
    expect(e?.arrow).toBe("end");
  });

  it("setEdgeLabel updates edge label", () => {
    const next = setEdgeLabel(SRC, "e1", "장남");
    const m = parseDiagram(next);
    expect(m.edges.find((e) => e.id === "e1")?.label).toBe("장남");
  });

  it("setEdgeSource and setEdgeTarget reparent edge endpoints", () => {
    const reparented = setEdgeSource(SRC, "e1", "n3");
    expect(parseDiagram(reparented).edges.find((e) => e.id === "e1")?.from).toBe("n3");

    const retargeted = setEdgeTarget(reparented, "e1", "n4");
    expect(parseDiagram(retargeted).edges.find((e) => e.id === "e1")?.to).toBe("n4");
  });

  it("setNodeLink adds, modifies, and deletes note link", () => {
    const added = setNodeLink(SRC, "n2", "note-xyz");
    expect(parseDiagram(added).nodes.find((n) => n.id === "n2")?.link).toBe("note-xyz");
    const cleared = setNodeLink(added, "n2", null);
    expect(parseDiagram(cleared).nodes.find((n) => n.id === "n2")?.link).toBeUndefined();
  });

  it("setNodeMeta sets icon and desc, or removes them when null", () => {
    const withMeta = setNodeMeta(SRC, "n1", { icon: "⭐️", desc: "주요 인물" });
    const m = parseDiagram(withMeta);
    expect(m.nodes.find((n) => n.id === "n1")).toMatchObject({ icon: "⭐️", desc: "주요 인물" });
    const cleared = parseDiagram(setNodeMeta(withMeta, "n1", null)).nodes.find((n) => n.id === "n1");
    expect(cleared?.icon).toBeUndefined();
    expect(cleared?.desc).toBeUndefined();
  });

  it("setNodePos sets and deletes node coordinates", () => {
    const withPos = setNodePos(SRC, "n1", { x: 50, y: 75 });
    const m = parseDiagram(withPos);
    expect(m.nodes.find((n) => n.id === "n1")?.pos).toEqual([50, 75]);
    const cleared = setNodePos(withPos, "n1", null);
    expect(parseDiagram(cleared).nodes.find((n) => n.id === "n1")?.pos).toBeUndefined();
  });

  it("setNodePositions updates multiple node coordinates and group assignments in one mutation", () => {
    const next = setNodePositions(
      SRC,
      { n1: { x: 10, y: 20 }, n2: { x: 30, y: 40 } },
      { n1: "g1" },
    );
    const m = parseDiagram(next);
    expect(m.nodes.find((n) => n.id === "n1")?.pos).toEqual([10, 20]);
    expect(m.nodes.find((n) => n.id === "n2")?.pos).toEqual([30, 40]);
    expect(m.nodes.find((n) => n.id === "n1")?.group).toBe("g1");
  });

  it("group verbs: addGroup, renameGroup, dissolveGroup, moveNodeToGroup", () => {
    const { source: grouped, id: gid } = addGroup(SRC, "우리 가족", ["n1", "n2"]);
    expect(gid).toBe("g1");
    let m = parseDiagram(grouped);
    expect(m.groups.find((g) => g.id === "g1")?.title).toBe("우리 가족");
    expect(m.nodes.find((n) => n.id === "n1")?.group).toBe("g1");
    expect(m.nodes.find((n) => n.id === "n2")?.group).toBe("g1");

    const renamed = renameGroup(grouped, "g1", "확장 가족");
    m = parseDiagram(renamed);
    expect(m.groups.find((g) => g.id === "g1")?.title).toBe("확장 가족");

    const toned = setGroupTone(renamed, "g1", "accent");
    m = parseDiagram(toned);
    expect(m.groups.find((g) => g.id === "g1")?.tone).toBe("accent");
    expect(groupTone(m, "g1")).toBe("accent");

    const moved = moveNodeToGroup(toned, "n3", "g1");
    m = parseDiagram(moved);
    expect(m.nodes.find((n) => n.id === "n3")?.group).toBe("g1");

    const dissolved = dissolveGroup(moved, "g1");
    m = parseDiagram(dissolved);
    expect(m.groups.find((g) => g.id === "g1")).toBeUndefined();
    expect(m.nodes.find((n) => n.id === "n1")?.group).toBeUndefined();
    expect(m.nodes.find((n) => n.id === "n3")?.group).toBeUndefined();
  });

  it("soleIncomingEdge returns single incoming parent or null", () => {
    const m = parseDiagram(SRC);
    expect(soleIncomingEdge(m, "n2")?.from).toBe("n1");
    expect(soleIncomingEdge(m, "n1")).toBeNull();
  });

  it("canConnect correctly guards connection validity", () => {
    expect(canConnect(SRC, "n1", "n2", "아들", "solid")).toBe(false); // duplicate
    expect(canConnect(SRC, "n1", "n2", "다른 관계", "solid")).toBe(true);
    expect(canConnect(SRC, "n1", "unknown")).toBe(false);
  });
});

describe("setNodeRows (W2) — 구획은 노드 필드 하나, 저장→재로드 보존", () => {
  const src = JSON.stringify({ v: 1, nodes: [{ id: "n1", label: "users" }, { id: "n2", label: "orders" }], edges: [] });

  it("빈 줄은 버리고 trim 해서 저장하고, 재파싱하면 그대로 나온다", () => {
    const next = setNodeRows(src, "n1", [" id: uuid ", "", "email: text"]);
    const model = parseDiagram(next);
    expect(model.nodes[0].rows).toEqual(["id: uuid", "email: text"]);
    expect(model.nodes[1].rows).toBeUndefined();
    expect(parseDiagram(setNodeRows(next, "n1", ["id: uuid", "email: text"]))).toEqual(model); // 같은 값이면 무변화
    expect(JSON.parse(next).nodes[0].rows).toEqual(["id: uuid", "email: text"]);
  });

  it("null 이나 빈 배열이면 필드가 사라지고, 없는 노드·깨진 소스는 그대로", () => {
    const withRows = setNodeRows(src, "n1", ["a"]);
    expect("rows" in JSON.parse(setNodeRows(withRows, "n1", null)).nodes[0]).toBe(false);
    expect("rows" in JSON.parse(setNodeRows(withRows, "n1", ["  "])).nodes[0]).toBe(false);
    expect(setNodeRows(src, "nope", ["a"])).toBe(src);
    expect(setNodeRows("{ broken", "n1", ["a"])).toBe("{ broken");
  });
});
