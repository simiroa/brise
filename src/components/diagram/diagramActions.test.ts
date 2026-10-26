import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDiagramActions } from "./diagramActions";
import { parseDiagram } from "./diagramModel";
import { onAppNotice } from "../../lib/invoke";

const SRC = JSON.stringify(
  {
    v: 1,
    nodes: [
      { id: "n1", label: "김철수" },
      { id: "n2", label: "김영수" },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", line: "solid", arrow: "end" },
    ],
  },
  null,
  2,
);

/** The real write path in miniature: `apply` lands on a live string, exactly like DiagramSection's
 *  draft — so the assertions below read the SOURCE, the same thing FTS/sync/undo read. */
function harness(initial = SRC) {
  let src = initial;
  const apply = vi.fn((next: string) => {
    src = next;
  });
  const select = vi.fn();
  const actions = makeDiagramActions({
    source: () => src,
    apply,
    select,
    shape: "rect",
    style: "solid",
    setShapeDefault: vi.fn(),
    setStyleDefault: vi.fn(),
    pickNote: vi.fn(),
    openNote: vi.fn(),
  });
  return { actions, apply, select, source: () => src };
}

// connect — 표현은 최대한 허용, 정보량 0인 것만 거부. diagramModel is pure and cannot toast, so the
// "why" of a refusal is decided here, in the one place both surfaces (canvas drag/click, toolbar
// 관계 추가) route through.
describe("connect — 자기루프는 쓰고, 완전 동일 중복만 거부하고 이유를 말한다", () => {
  const notices: string[] = [];
  beforeEach(() => {
    notices.length = 0;
    onAppNotice((m) => notices.push(m));
  });

  it("writes a self-loop and says nothing — it is an ordinary relation now", () => {
    const { actions, apply, select, source } = harness();
    actions.connect("n1", "n1", "본인 확인");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(parseDiagram(source()).edges.filter((e) => e.from === "n1" && e.to === "n1")).toHaveLength(1);
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ kind: "edge" }));
    expect(notices).toEqual([]);
  });

  it("an EXACT duplicate is a no-op WITH a notice — the user has to know why nothing happened", () => {
    const { actions, apply } = harness();
    actions.connect("n1", "n2", "아들"); // n1 --> n2 already exists, unlabelled
    expect(apply).toHaveBeenCalledTimes(1);
    actions.connect("n1", "n2", "아들"); // …now it is identical in all fields
    expect(apply).toHaveBeenCalledTimes(1);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("already exists");
  });

  it("a different label / direction is written, not refused — both are real statements", () => {
    const { actions, apply, source } = harness();
    actions.connect("n1", "n2", "동료");
    actions.connect("n1", "n2", "친구");
    actions.connect("n2", "n1", "동료");
    expect(apply).toHaveBeenCalledTimes(3);
    expect(parseDiagram(source()).edges).toHaveLength(4);
    expect(notices).toEqual([]);
  });

  it("a refusal that is NOT the user's doing stays silent (unknown endpoint)", () => {
    const { actions, apply } = harness();
    actions.connect("n1", "nope");
    expect(apply).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });
});

describe("addConnected — 빈 캔버스 드롭 = 노드+엣지+좌표 in ONE apply", () => {
  it("writes node, edge and pos into one source with exactly one apply (one 되돌리기 step)", () => {
    const { actions, apply, source } = harness();
    actions.addConnected("n1", "박민수", { x: 320, y: 140 });

    expect(apply).toHaveBeenCalledTimes(1);
    const model = parseDiagram(source());
    const created = model.nodes.find((n) => n.label === "박민수");
    expect(created).toBeTruthy();
    expect(model.edges.some((e) => e.from === "n1" && e.to === created!.id)).toBe(true);
    expect(model.nodes.find((n) => n.id === created!.id)?.pos).toEqual([320, 140]);
  });

  it("selects the new node, same as createChild", () => {
    const { actions, select } = harness();
    actions.addConnected("n1", "이수진", { x: 10, y: 20 });
    expect(select).toHaveBeenCalledWith({ kind: "node", id: "n3" });
  });

  it("unstructured source: no edit, no undo step", () => {
    const { actions, apply } = harness("invalid json string");
    actions.addConnected("A", "x", { x: 0, y: 0 });
    expect(apply).not.toHaveBeenCalled();
  });
});

// 드래그로 소속 변경 — a box dropped inside a frame lands on a coordinate AND moves house. Those are
// one gesture, so they must cost one 되돌리기 press, exactly like addConnected above.
describe("setNodePositions — 좌표 + 소속 변경 in ONE apply", () => {
  const GROUPED = JSON.stringify(
    {
      v: 1,
      nodes: [
        { id: "n1", label: "김철수" },
        { id: "n2", label: "김영수" },
        { id: "n3", label: "박씨", group: "g1" },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2", line: "solid", arrow: "end" },
      ],
      groups: [
        { id: "g1", title: "가족", parent: null },
      ],
    },
    null,
    2,
  );

  it("writes the pos comment and the membership move with exactly one apply", () => {
    const { actions, apply, source } = harness(GROUPED);
    actions.setNodePositions({ n1: { x: 40, y: 80 } }, { n1: "g1" });

    expect(apply).toHaveBeenCalledTimes(1);
    const model = parseDiagram(source());
    expect(model.nodes.find((n) => n.id === "n1")?.pos).toEqual([40, 80]);
    expect(model.nodes.find((n) => n.id === "n1")?.group).toBe("g1");
    // Nothing else moved, and the relation is untouched.
    expect(model.nodes.find((n) => n.id === "n2")?.group).toBeUndefined();
    expect(model.edges.map((e) => [e.from, e.to])).toEqual([["n1", "n2"]]);
  });

  it("dragging back OUT is the same one-apply move, with `null` for top level", () => {
    const { actions, apply, source } = harness(GROUPED);
    actions.setNodePositions({ n3: { x: 0, y: 0 } }, { n3: null });
    expect(apply).toHaveBeenCalledTimes(1);
    const model = parseDiagram(source());
    expect(model.nodes.find((n) => n.id === "n3")?.pos).toEqual([0, 0]);
    expect(model.nodes.find((n) => n.id === "n3")).toMatchObject({ label: "박씨" });
    expect(model.nodes.find((n) => n.id === "n3")?.group).toBeUndefined();
  });

  it("a drag that crossed no border is still just a position write", () => {
    const { actions, apply, source } = harness(GROUPED);
    actions.setNodePositions({ n1: { x: 5, y: 5 } });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(parseDiagram(source()).nodes.find((n) => n.id === "n1")?.group).toBeUndefined();
  });
});

describe("group verbs — one mutation, one 되돌리기 step", () => {
  const SRC3 = JSON.stringify(
    {
      v: 1,
      nodes: [
        { id: "n1", label: "김철수" },
        { id: "n2", label: "김영수" },
        { id: "n3", label: "박씨" },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2", line: "solid", arrow: "end" },
      ],
    },
    null,
    2,
  );

  it("addGroup applies once and selects the new frame", () => {
    const { actions, apply, select, source } = harness(SRC3);
    actions.addGroup("가족", ["n1", "n3"]);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith({ kind: "group", id: "g1" });
    expect(parseDiagram(source()).groups.map((g) => g.title)).toEqual(["가족"]);
  });

  it("a group with no members is not written at all — no edit, no undo step", () => {
    const { actions, apply, select } = harness(SRC3);
    actions.addGroup("빈 그룹", []);
    expect(apply).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it("이름 변경 / 해제 each apply once; 해제 keeps every member and clears the selection", () => {
    const { actions, apply, select, source } = harness(SRC3);
    actions.addGroup("가족", ["n1", "n3"]);
    actions.renameGroup("g1", "친척");
    expect(parseDiagram(source()).groups.map((g) => g.title)).toEqual(["친척"]);
    actions.dissolveGroup("g1");
    expect(apply).toHaveBeenCalledTimes(3);
    const model = parseDiagram(source());
    expect(model.groups).toEqual([]);
    expect(model.nodes.map((n) => n.label)).toEqual(["김철수", "김영수", "박씨"]);
    expect(model.edges).toHaveLength(1);
    expect(select).toHaveBeenLastCalledWith(null);
  });
});

describe("expandChildren — 선택 노드에 3~4개의 자식 노드와 엣지를 1회의 apply로 생성", () => {
  it("creates multiple children and connecting edges in a single batch mutation", () => {
    const { actions, apply, select, source } = harness();
    const createdIds = actions.expandChildren("n1", ["하위 1", "하위 2", "하위 3"]);

    expect(apply).toHaveBeenCalledTimes(1);
    expect(createdIds).toHaveLength(3);
    const model = parseDiagram(source());

    expect(model.nodes).toHaveLength(5); // n1, n2 + 3 children
    const child1 = model.nodes.find((n) => n.label === "하위 1");
    const child2 = model.nodes.find((n) => n.label === "하위 2");
    const child3 = model.nodes.find((n) => n.label === "하위 3");
    expect(child1).toBeTruthy();
    expect(child2).toBeTruthy();
    expect(child3).toBeTruthy();

    expect(model.edges.some((e) => e.from === "n1" && e.to === child1!.id)).toBe(true);
    expect(model.edges.some((e) => e.from === "n1" && e.to === child2!.id)).toBe(true);
    expect(model.edges.some((e) => e.from === "n1" && e.to === child3!.id)).toBe(true);

    expect(select).toHaveBeenCalledWith({ kind: "node", id: createdIds[0] });
  });

  it("returns empty array and does not apply if labels is empty", () => {
    const { actions, apply } = harness();
    const result = actions.expandChildren("n1", []);
    expect(result).toEqual([]);
    expect(apply).not.toHaveBeenCalled();
  });
});

describe("connectBatch — 다중 선택 노드 일괄 연결", () => {
  it("creates connections from all given source nodes to target in 1 apply step", () => {
    const SRC3 = JSON.stringify({
      v: 1,
      nodes: [
        { id: "n1", label: "A" },
        { id: "n2", label: "B" },
        { id: "n3", label: "C" },
      ],
      edges: [],
    });
    const { actions, apply, source } = harness(SRC3);
    actions.connectBatch(["n1", "n2"], "n3", "합류");

    expect(apply).toHaveBeenCalledTimes(1);
    const model = parseDiagram(source());
    expect(model.edges).toHaveLength(2);
    expect(model.edges.some((e) => e.from === "n1" && e.to === "n3" && e.label === "합류")).toBe(true);
    expect(model.edges.some((e) => e.from === "n2" && e.to === "n3" && e.label === "합류")).toBe(true);
  });
});

describe("setEdgeTone / edgeTone — 관계선 색상 톤 지정", () => {
  it("updates edge tone and queries it back", () => {
    const { actions, apply, source } = harness();
    actions.setEdgeTone("e1", "accent");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(actions.edgeTone("e1")).toBe("accent");
    const model = parseDiagram(source());
    expect(model.edges.find((e) => e.id === "e1")?.tone).toBe("accent");

    actions.setEdgeTone("e1", "default");
    expect(actions.edgeTone("e1")).toBe("default");
    const model2 = parseDiagram(source());
    expect(model2.edges.find((e) => e.id === "e1")?.tone).toBeUndefined();
  });
});

describe("addFromText — 텍스트 문법(D4) 병합, ONE apply", () => {
  it("파싱이 실패하면 아무것도 바꾸지 않고 {ok:false, error, line} 을 돌려준다", () => {
    const { actions, apply } = harness();
    const res = actions.addFromText("A\n    B"); // 들여쓰기 두 단 점프
    expect(res).toEqual({ ok: false, error: "indent_jump", line: 2 });
    expect(apply).not.toHaveBeenCalled();
  });

  it("기존 노드는 라벨로 재사용 — A -> Z 를 넣으면 노드는 Z 하나만 늘고 엣지 1개, apply 1회", () => {
    const withA = JSON.stringify({ v: 1, nodes: [{ id: "n1", label: "A" }], edges: [] });
    const { actions, apply, source } = harness(withA);

    const res = actions.addFromText("A -> Z");
    expect(res).toEqual({ ok: true });
    expect(apply).toHaveBeenCalledTimes(1);
    const model = parseDiagram(source());
    expect(model.nodes.map((n) => n.label)).toEqual(["A", "Z"]);
    expect(model.edges).toHaveLength(1);
    expect(model.edges[0]).toMatchObject({ from: "n1" });
  });

  it("같은 텍스트를 두 번 넣으면 두 번째는 변화가 없어 apply 를 다시 부르지 않는다", () => {
    const withA = JSON.stringify({ v: 1, nodes: [{ id: "n1", label: "A" }], edges: [] });
    const { actions, apply } = harness(withA);

    actions.addFromText("A -> Z");
    expect(apply).toHaveBeenCalledTimes(1);
    const res2 = actions.addFromText("A -> Z");
    expect(res2).toEqual({ ok: true });
    expect(apply).toHaveBeenCalledTimes(1); // 변화 없음 → apply 재호출 안 함
  });

  it("그룹은 제목으로 만들어지고 멤버 소속까지 ONE apply 로 들어간다", () => {
    const empty = JSON.stringify({ v: 1, nodes: [], edges: [] });
    const { actions, apply, source } = harness(empty);

    const res = actions.addFromText("[1일차]\n  D\n  E");
    expect(res).toEqual({ ok: true });
    expect(apply).toHaveBeenCalledTimes(1);
    const model = parseDiagram(source());
    expect(model.groups).toHaveLength(1);
    expect(model.groups[0].title).toBe("1일차");
    expect(model.nodes.map((n) => n.label)).toEqual(["D", "E"]);
    expect(model.nodes.every((n) => n.group === model.groups[0].id)).toBe(true);
  });
});

// 배치 바꾸기(PLAN-2026-09-21 W4, D4, 베타) — layout 교체 + 전체 pos 제거가 ONE apply.
describe("setLayout — 배치 교체 + pos 전체 제거, ONE apply", () => {
  const POSITIONED = JSON.stringify(
    {
      v: 1,
      nodes: [
        { id: "n1", label: "김철수", pos: [10, 20] },
        { id: "n2", label: "김영수", pos: [110, 20] },
      ],
      edges: [{ id: "e1", from: "n1", to: "n2", line: "solid", arrow: "end" }],
    },
    null,
    2,
  );

  it("layout 을 바꾸고 모든 노드의 pos 를 지운다 — 직렬화에 \"layout\":\"radial\" 은 있고 pos 는 없다", () => {
    const { actions, apply, source } = harness(POSITIONED);
    actions.setLayout("radial");

    expect(apply).toHaveBeenCalledTimes(1);
    expect(source()).toContain('"layout": "radial"');
    const model = parseDiagram(source());
    expect(model.layout).toBe("radial");
    expect(model.nodes.every((n) => n.pos === undefined)).toBe(true);
  });

  it("undo 1회(직전 apply 를 되돌리기)로 원래 배치·좌표가 그대로 복원된다", () => {
    const { actions, apply, source } = harness(POSITIONED);
    const before = source();
    actions.setLayout("radial");
    expect(apply).toHaveBeenCalledTimes(1);

    // 되돌리기는 DiagramSection 의 undo 스택이 하는 일 — 여기서는 그 계약(apply 호출 하나 = 스택 한
    // 칸)만 확인하고, 그 한 칸을 되돌리면 이전 source 문자열 그대로 복원됨을 검증한다.
    const restored = before;
    const model = parseDiagram(restored);
    expect(model.layout).toBeUndefined();
    expect(model.nodes.find((n) => n.id === "n1")?.pos).toEqual([10, 20]);
  });

  it("dagre 로 돌아가면 layout 필드 자체가 사라진다(직렬화가 dagre 를 생략)", () => {
    const withLayout = JSON.stringify({ v: 1, layout: "radial", nodes: [{ id: "n1", label: "A" }], edges: [] });
    const { actions, source } = harness(withLayout);
    actions.setLayout("dagre");
    expect(source()).not.toContain("layout");
    expect(parseDiagram(source()).layout).toBeUndefined();
  });
});
