import { describe, it, expect } from "vitest";
import {
  parseDiagramJson,
  serializeDiagram,
  validateDiagramModel,
  sanitizeDiagramAiOutput,
  isDiagramStructureEqual,
} from "./diagramSchema";

describe("diagramSchema validation and structure integrity", () => {
  it("test_diagram_validation_referential_integrity", () => {
    const rawJson = JSON.stringify({
      v: 1,
      states: ["준비", "완료"],
      nodes: [
        { id: "n1", label: "A", state: 5, group: "non_existing_group", pos: [10, 20] },
      ],
      edges: [
        { id: "e1", from: "n1", to: "missing_node" },
      ],
    });

    const model = parseDiagramJson(rawJson);
    const result = validateDiagramModel(model);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
    expect(result.errors.some((e: string) => e.includes("missing_node"))).toBe(true);
    expect(result.errors.some((e: string) => e.includes("non_existing_group"))).toBe(true);
    expect(result.errors.some((e: string) => e.includes("state"))).toBe(true);
  });

  it("test_diagram_progress_preserves_structure_and_rejects_change", () => {
    const original = parseDiagramJson(JSON.stringify({
      v: 1,
      states: ["준비", "진행중", "완료"],
      nodes: [
        { id: "n1", label: "A", state: 0 },
        { id: "n2", label: "B", state: 1 },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2" },
      ],
    }));

    // Valid state update
    const stateUpdated = parseDiagramJson(JSON.stringify({
      v: 1,
      states: ["준비", "진행중", "완료"],
      nodes: [
        { id: "n1", label: "A", state: 2 },
        { id: "n2", label: "B", state: 2 },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2" },
      ],
    }));
    expect(isDiagramStructureEqual(original, stateUpdated)).toBe(true);

    // Structural change: added node
    const nodeAdded = parseDiagramJson(JSON.stringify({
      v: 1,
      states: ["준비", "진행중", "완료"],
      nodes: [
        { id: "n1", label: "A", state: 0 },
        { id: "n2", label: "B", state: 1 },
        { id: "n3", label: "C", state: 0 },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2" },
      ],
    }));
    expect(isDiagramStructureEqual(original, nodeAdded)).toBe(false);

    // Structural change: removed edge
    const edgeRemoved = parseDiagramJson(JSON.stringify({
      v: 1,
      states: ["준비", "진행중", "완료"],
      nodes: [
        { id: "n1", label: "A", state: 0 },
        { id: "n2", label: "B", state: 1 },
      ],
      edges: [],
    }));
    expect(isDiagramStructureEqual(original, edgeRemoved)).toBe(false);
  });

  it("sanitizeDiagramAiOutput strips illegal pos coordinates when no existing diagram is given", () => {
    const raw = parseDiagramJson(JSON.stringify({
      v: 1,
      nodes: [
        { id: "n1", label: "A", pos: [100, 200] },
      ],
      edges: [],
    }));
    const sanitized = sanitizeDiagramAiOutput(raw);
    expect(sanitized.nodes[0].pos).toBeUndefined();
  });

  it("sanitizeDiagramAiOutput preserves existing node pos and strips new node pos", () => {
    const existing = parseDiagramJson(JSON.stringify({
      v: 1,
      nodes: [
        { id: "n1", label: "A", pos: [100, 200] },
      ],
      edges: [],
    }));
    const aiOutput = parseDiagramJson(JSON.stringify({
      v: 1,
      nodes: [
        { id: "n1", label: "A Updated", pos: [999, 999] }, // AI tried to give new pos
        { id: "n2", label: "New Node", pos: [500, 500] },
      ],
      edges: [],
    }));
    const sanitized = sanitizeDiagramAiOutput(aiOutput, existing);
    expect(sanitized.nodes[0].pos).toEqual([100, 200]); // preserved from original
    expect(sanitized.nodes[1].pos).toBeUndefined(); // stripped for auto-layout
  });

  it("isDiagramStructureEqual detects label, desc, states, edge label changes", () => {
    const original = parseDiagramJson(JSON.stringify({
      v: 1,
      states: ["준비", "완료"],
      nodes: [
        { id: "n1", label: "A", desc: "desc A" },
        { id: "n2", label: "B" },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2", label: "leads to" },
      ],
      groups: [{ id: "g1", title: "Group 1" }],
    }));

    // Label changed
    const labelChanged = parseDiagramJson(JSON.stringify({
      ...original,
      nodes: [{ id: "n1", label: "A New", desc: "desc A" }, { id: "n2", label: "B" }],
    }));
    expect(isDiagramStructureEqual(original, labelChanged)).toBe(false);

    // Desc changed
    const descChanged = parseDiagramJson(JSON.stringify({
      ...original,
      nodes: [{ id: "n1", label: "A", desc: "different desc" }, { id: "n2", label: "B" }],
    }));
    expect(isDiagramStructureEqual(original, descChanged)).toBe(false);

    // States list changed
    const statesChanged = parseDiagramJson(JSON.stringify({
      ...original,
      states: ["준비", "진행", "완료"],
    }));
    expect(isDiagramStructureEqual(original, statesChanged)).toBe(false);

    // Edge label changed
    const edgeLabelChanged = parseDiagramJson(JSON.stringify({
      ...original,
      edges: [{ id: "e1", from: "n1", to: "n2", label: "other label" }],
    }));
    expect(isDiagramStructureEqual(original, edgeLabelChanged)).toBe(false);

    // Group title changed
    const groupTitleChanged = parseDiagramJson(JSON.stringify({
      ...original,
      groups: [{ id: "g1", title: "Group Renamed" }],
    }));
    expect(isDiagramStructureEqual(original, groupTitleChanged)).toBe(false);
  });

  it("test_diagram_validation_cross_namespace_node_group_duplication", () => {
    const rawJson = JSON.stringify({
      v: 1,
      nodes: [
        { id: "item1", label: "Node 1" },
        { id: "item2", label: "Node 2" },
      ],
      edges: [
        { id: "e1", from: "item1", to: "item2" },
      ],
      groups: [
        { id: "item1", title: "Colliding Group" },
      ],
    });

    const model = parseDiagramJson(rawJson);
    const result = validateDiagramModel(model);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes("item1") && (e.includes("duplicate") || e.includes("collide")))).toBe(true);
  });

  it("parses and serializes group tone properly", () => {
    const rawJson = JSON.stringify({
      v: 1,
      nodes: [
        { id: "n1", label: "Step 1", group: "g1" },
      ],
      edges: [],
      groups: [
        { id: "g1", title: "Phase 1", tone: "accent" },
      ],
    });

    const model = parseDiagramJson(rawJson);
    expect(model.groups[0].tone).toBe("accent");

    const serialized = serializeDiagram(model);
    const parsedBack = parseDiagramJson(serialized);
    expect(parsedBack.groups[0].tone).toBe("accent");
  });
});


describe("W2 (2026-09-20) — type / layout / axes / rows", () => {
  const base = { v: 1, nodes: [{ id: "n1", label: "A", rows: ["id: uuid", 3, "email: text"] }, { id: "n2", label: "B" }], edges: [{ id: "e1", from: "n1", to: "n2" }] };

  it("파싱: type 은 메타로, layout 은 enum 안이면 그대로, rows 는 문자열만 남긴다; 직렬화는 값이 있을 때만 쓴다", () => {
    const model = parseDiagramJson(JSON.stringify({ ...base, type: "er", layout: "radial" }));
    expect(model.type).toBe("er");
    expect(model.layout).toBe("radial");
    expect(model.nodes[0].rows).toEqual(["id: uuid", "email: text"]);
    expect(model.nodes[1].rows).toBeUndefined();
    const back = JSON.parse(serializeDiagram(model));
    expect(back.type).toBe("er");
    expect(back.layout).toBe("radial");
    expect(back.nodes[0].rows).toEqual(["id: uuid", "email: text"]);
    expect("rows" in back.nodes[1]).toBe(false);
    expect(validateDiagramModel(model)).toEqual({ valid: true, errors: [] });
    // 없으면 안 쓴다 — 기존 본문은 한 글자도 안 바뀐다.
    const plain = JSON.parse(serializeDiagram(parseDiagramJson(JSON.stringify(base))));
    expect("type" in plain).toBe(false);
    expect("layout" in plain).toBe(false);
    expect("axes" in plain).toBe(false);
    expect(JSON.parse(serializeDiagram(parseDiagramJson(JSON.stringify({ ...base, layout: "dagre" })))).layout).toBeUndefined();
  });

  it('모르는 layout 은 모델에선 undefined(dagre 폴백, 렌더됨)지만 validateDiagramModel 이 `Unknown layout: "banana"` 를 낸다', () => {
    const model = parseDiagramJson(JSON.stringify({ ...base, layout: "banana" }));
    expect(model.structured).toBe(true);
    expect(model.layout).toBeUndefined();
    const v = validateDiagramModel(model);
    expect(v.valid).toBe(false);
    expect(v.errors[0]).toContain('Unknown layout: "banana"');
  });

  it("axes 는 quadrant 일 때만 유효 — 다른 배치에 있으면 검증 오류, quadrant 면 왕복 보존", () => {
    const axes = { x: ["낮음", "높음"], y: ["낮음", "높음"] };
    const wrong = parseDiagramJson(JSON.stringify({ ...base, layout: "stack", axes }));
    expect(wrong.axes).toEqual(axes);
    expect(validateDiagramModel(wrong).errors).toEqual(['"axes" is only valid with layout "quadrant"']);
    const ok = parseDiagramJson(JSON.stringify({ ...base, layout: "quadrant", axes }));
    expect(validateDiagramModel(ok).valid).toBe(true);
    expect(JSON.parse(serializeDiagram(ok)).axes).toEqual(axes);
    // 모양이 틀린 axes 는 버린다(오류 대신 무시 — 라벨일 뿐이다).
    expect(parseDiagramJson(JSON.stringify({ ...base, layout: "quadrant", axes: { x: ["하나"] } })).axes).toBeUndefined();
  });

  it("sanitizeDiagramAiOutput 은 pos 만 지우고 layout/rows 는 남긴다; layout 변경은 구조 변경이 아니다", () => {
    const model = parseDiagramJson(JSON.stringify({ ...base, layout: "circle", nodes: [{ ...base.nodes[0], pos: [1, 2] }, base.nodes[1]] }));
    const clean = sanitizeDiagramAiOutput(model);
    expect(clean.nodes[0].pos).toBeUndefined();
    expect(clean.nodes[0].rows).toEqual(["id: uuid", "email: text"]);
    expect(clean.layout).toBe("circle");
    const other = parseDiagramJson(JSON.stringify({ ...base, layout: "stack" }));
    expect(isDiagramStructureEqual(model, other)).toBe(true);
  });
});
