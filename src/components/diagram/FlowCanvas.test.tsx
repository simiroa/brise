import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// React Flow measures real DOM. jsdom has no ResizeObserver at all (the component throws on mount
// without this) and reports every box as 0×0 — so the assertions below are deliberately about
// STRUCTURE and WRITES, never geometry. Anything geometric belongs in flowLayout.test.ts, which is
// pure arithmetic on purpose for exactly this reason.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

// The broken-link check is one batched IPC (`note_summaries_map`). Mocked here so the canvas can be
// told which notes are gone without a backend — the batching itself is asserted on the call count.
const summariesMock = vi.fn(async (_ids: string[]) => ({}) as Record<string, unknown>);
vi.mock("../../lib/noteSummaries", () => ({
  fetchNoteSummariesMap: (ids: string[]) => summariesMock(ids),
}));

import { useEffect, useRef, useState } from "react";
import { ReactFlowProvider, useStoreApi, getViewportForBounds } from "@xyflow/react";
import {
  FlowCanvas,
  canFlowRender,
  edgeId,
  BriseFlowEdge,
  InlineEditCtx,
  wholeGraphFitPadding,
  LEGEND_FIT_TOP_PX,
} from "./FlowCanvas";
import { DiagramToolbar } from "./DiagramToolbar";
import type { DiagramCanvasApi } from "./diagramCanvasApi";
import { parseDiagram } from "./diagramModel";
import { diagramTemplateSource } from "./diagramStarter";
import type { DiagramActions, Selection } from "./diagramActions";

const SRC = JSON.stringify({
  v: 1,
  nodes: [
    { id: "n1", label: "김철수" },
    { id: "n2", label: "김영수" },
    { id: "n3", label: "박씨" },
  ],
  edges: [
    { id: "e1", from: "n1", to: "n2" },
    { id: "e2", from: "n2", to: "n3" },
  ],
});

function actionsStub(): DiagramActions {
  return new Proxy({} as DiagramActions, {
    get: (target, prop) => {
      // nodeTone is READ, not a command — every other member is a spy the test can assert on.
      if (prop === "nodeTone") return () => "default";
      if (prop === "shape") return "rect";
      if (prop === "style") return "solid";
      const store = target as unknown as Record<string | symbol, unknown>;
      if (!store[prop]) store[prop] = vi.fn();
      return store[prop];
    },
  });
}

function TestFlowSection({
  source,
  actions,
  initialSelection = null,
  bubbles = false,
  initialSelectedBoxIds = [],
}: {
  source: string;
  actions: DiagramActions;
  initialSelection?: Selection;
  bubbles?: boolean;
  initialSelectedBoxIds?: string[];
}) {
  const model = parseDiagram(source);
  const [selection, setSelection] = useState<Selection>(initialSelection);
  const [selectedBoxIds, setSelectedBoxIds] = useState<string[]>(initialSelectedBoxIds);
  const apiRef = useRef<DiagramCanvasApi | null>(null);

  return (
    <div>
      <DiagramToolbar
        model={model}
        useFlow={true}
        selection={selection}
        selectedBoxIds={selectedBoxIds}
        actions={actions}
        apiRef={apiRef}
        canUndo={false}
        onUndo={vi.fn()}
        canRedo={false}
        onRedo={vi.fn()}
        onEditSource={vi.fn()}
        zoom={null}
        onZoom={vi.fn()}
        pngBusy={false}
      />
      <FlowCanvas
        model={model}
        selection={selection}
        onSelect={setSelection}
        actions={actions}
        onEditSource={vi.fn()}
        canUndo={false}
        onUndo={vi.fn()}
        canRedo={false}
        onRedo={vi.fn()}
        error={null}
        bubbles={bubbles}
        onSelectedBoxes={setSelectedBoxIds}
        initialSelectedBoxIds={selectedBoxIds}
        apiRef={apiRef}
      />
    </div>
  );
}

const canvas = (
  source: string,
  actions: DiagramActions,
  selection: Selection = null,
  bubbles = false,
  selectedBoxIds: string[] = [],
) => (
  <TestFlowSection
    source={source}
    actions={actions}
    initialSelection={selection}
    bubbles={bubbles}
    initialSelectedBoxIds={selectedBoxIds}
  />
);

const mount = (
  source: string,
  actions: DiagramActions,
  selection: Selection = null,
  bubbles = false,
  selectedBoxIds: string[] = [],
) =>
  render(canvas(source, actions, selection, bubbles, selectedBoxIds));

describe("canFlowRender — which renderer a note gets", () => {
  it("takes a structured flowchart whose every connector we can address", () => {
    expect(canFlowRender(parseDiagram(SRC))).toBe(true);
  });

  it("refuses unparseable or empty bodies", () => {
    expect(canFlowRender(parseDiagram("{ broken json"))).toBe(false);
    expect(canFlowRender(parseDiagram("sequenceDiagram\n  A->>B: 안녕"))).toBe(false);
    expect(canFlowRender(parseDiagram(""))).toBe(false);
  });

  it("TAKES a subgraph now (it used to be the commonest reason for the SVG fallback)", () => {
    const grouped = JSON.stringify({
      v: 1,
      nodes: [
        { id: "a", label: "A", group: "g1" },
        { id: "b", label: "B", group: "g1" },
      ],
      edges: [{ id: "e1", from: "a", to: "b" }],
      groups: [{ id: "g1", title: "Group 1" }],
    });
    expect(canFlowRender(parseDiagram(grouped))).toBe(true);
  });
});

describe("FlowCanvas", () => {
  it("draws one box per node, carrying the label from the source", () => {
    mount(SRC, actionsStub());
    for (const label of ["김철수", "김영수", "박씨"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("자동 정렬 writes EVERY node's coordinate in one mutation (one 되돌리기 step)", () => {
    const actions = actionsStub();
    mount(SRC, actions);
    fireEvent.click(screen.getByTestId("diagram-auto-layout"));
    expect(actions.setNodePositions).toHaveBeenCalledTimes(1);
    const written = vi.mocked(actions.setNodePositions).mock.calls[0][0];
    expect(Object.keys(written).sort()).toEqual(["n1", "n2", "n3"]);
  });

  it("W2: 자동 정렬 follows model.layout (stack → every x identical), not dagre", () => {
    const actions = actionsStub();
    mount(diagramTemplateSource("stack"), actions);
    fireEvent.click(screen.getByTestId("diagram-auto-layout"));
    const written = vi.mocked(actions.setNodePositions).mock.calls[0][0] as Record<string, { x: number }>;
    expect(new Set(Object.values(written).map((p) => p.x)).size).toBe(1);
  });

  it("W2: quadrant draws the axis cross + 4 axes labels in the viewport layer (not a Panel); other layouts draw none", () => {
    mount(diagramTemplateSource("quadrant"), actionsStub());
    const axes = screen.getByTestId("diagram-quadrant-axes");
    expect(axes.querySelectorAll("line").length).toBe(2);
    expect(Array.from(axes.querySelectorAll("text")).map((t) => t.textContent)).toEqual(["노력 적음", "노력 많음", "효과 낮음", "효과 높음"]);
    expect(axes.closest(".react-flow__panel")).toBeNull();
    cleanup();
    mount(SRC, actionsStub());
    expect(screen.queryByTestId("diagram-quadrant-axes")).toBeNull();
  });

  it("W2: rows render as 구획 lines under the label — and the node bubble no longer offers 구획 편집 (소스 보기에서)", () => {
    const actions = actionsStub();
    const { container } = mount(diagramTemplateSource("er"), actions, { kind: "node", id: "n1" }, true);
    const rows = container.querySelector('[data-id="n1"] [data-testid="diagram-node-rows-list"]')!;
    expect(Array.from(rows.children).map((c) => c.textContent)).toEqual(["id: uuid", "email: text", "created_at: timestamp"]);
    expect(screen.queryByTestId("diagram-node-rows")).toBeNull();
  });

  it("offers PNG 내보내기 next to 자동 정렬 — one canvas, one tool cluster", () => {
    mount(SRC, actionsStub());
    expect(screen.getByTestId("diagram-export-png")).toBeTruthy();
  });

  it("shows no 정렬 toolbar until 2+ boxes are picked", () => {
    mount(SRC, actionsStub(), { kind: "node", id: "n1" });
    expect(screen.queryByTestId("diagram-align-tools")).toBeNull();
  });

  it("정렬 on a multi-selection writes every moved box in ONE mutation (one 되돌리기 step)", () => {
    const actions = actionsStub();
    const view = mount(SRC, actions, null, false, ["n1", "n2"]);

    expect(screen.getByTestId("diagram-align-tools")).toBeTruthy();
    fireEvent.click(screen.getByTestId("diagram-align-left"));
    expect(actions.setNodePositions).toHaveBeenCalledTimes(1);
    const written = vi.mocked(actions.setNodePositions).mock.calls[0][0];
    expect(Object.keys(written).sort()).toEqual(["n1", "n2"]);
    // Left-aligned: both corners share the leftmost x, and nobody else was touched.
    expect(written.n1?.x).toBe(written.n2?.x);
    // The set survives the model coming back changed (which is what a real apply does) — otherwise
    // "정렬 후 분배" would mean picking the same boxes twice.
    const moved = JSON.stringify({
      v: 1,
      nodes: [
        { id: "n1", label: "김철수", pos: [0, 0] },
        { id: "n2", label: "김영수", pos: [0, 120] },
        { id: "n3", label: "박씨" },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2" },
        { id: "e2", from: "n2", to: "n3" },
      ],
    });
    view.rerender(canvas(moved, actions, null, false, ["n1", "n2"]));
    expect(screen.getByTestId("diagram-align-tools")).toBeTruthy();
  });

  // FRAMING DISCOVERABILITY (2026-08-12): the multi-selection bar's job is to say "you picked
  // several — now name them". So it states the count and gives 그룹 만들기 a word, ahead of the
  // 정렬/분배 icons.
  it("names the count and leads with a LABELLED 그룹 만들기, ahead of the 정렬 icons", () => {
    mount(SRC, actionsStub(), null, false, ["n1", "n2"]);

    expect(screen.getByTestId("diagram-multi-count").textContent).toContain("2");
    const group = screen.getByTestId("diagram-group-create");
    expect(group.textContent).toContain("Group these");
    // …and it comes FIRST in the bar, with a divider between it and the icon cluster.
    const bar = screen.getByTestId("diagram-align-tools");
    const order = Array.from(bar.children).map((c) => c.getAttribute("data-testid") ?? c.className);
    expect(order.slice(0, 3)).toEqual(["diagram-multi-count", "diagram-group-create", "diagram-toolbar-divider"]);
    expect(order[3]).toBe("diagram-align-left");
  });

  it("stays away entirely with one box picked — the node bubble is that selection's toolbar", () => {
    mount(SRC, actionsStub(), { kind: "node", id: "n1" });
    expect(screen.queryByTestId("diagram-multi-count")).toBeNull();
    expect(screen.queryByTestId("diagram-group-create")).toBeNull();
    expect(screen.queryByTestId("diagram-align-tools")).toBeNull();
  });

  it("renders multi-selection tools in the toolbar and carries align/distribute actions", () => {
    mount(SRC, actionsStub(), null, false, ["n1", "n2"]);

    const bar = screen.getByTestId("diagram-align-tools");
    expect(bar).toBeTruthy();
    expect(screen.getByTestId("diagram-align-left")).toBeTruthy();
    expect(screen.getByTestId("diagram-align-center-x")).toBeTruthy();
    expect(screen.getByTestId("diagram-align-right")).toBeTruthy();
    expect(screen.getByTestId("diagram-align-top")).toBeTruthy();
    expect(screen.getByTestId("diagram-align-center-y")).toBeTruthy();
    expect(screen.getByTestId("diagram-align-bottom")).toBeTruthy();
    expect(screen.getByTestId("diagram-distribute-x")).toBeTruthy();
    expect(screen.getByTestId("diagram-distribute-y")).toBeTruthy();
  });

  it("never shares the screen with a single selection's verbs", () => {
    mount(SRC, actionsStub(), { kind: "node", id: "n1" }, false, ["n2", "n3"]);
    expect(screen.getByTestId("diagram-align-tools")).toBeTruthy();
    expect(screen.queryByTestId("diagram-subject-chip")).toBeNull();
  });

  // MINIMAP (owner screenshot 2026-08-12): on a five-node diagram it was a shrunk copy of what was
  // already fully on screen, eating the bottom-right corner. See MINIMAP_MIN_NODES.
  it("hides the minimap on a small diagram and brings it back once the graph outgrows the view", () => {
    const view = mount(SRC, actionsStub()); // 3 nodes
    expect(view.container.querySelector(".react-flow__minimap")).toBeNull();

    const manyNodes = Array.from({ length: 15 }, (_, i) => ({ id: `n${i}`, label: `Node ${i}` }));
    const manyEdges = Array.from({ length: 14 }, (_, i) => ({ id: `e${i}`, from: `n${i}`, to: `n${i + 1}` }));
    const many = JSON.stringify({ v: 1, nodes: manyNodes, edges: manyEdges });
    view.rerender(canvas(many, actionsStub()));
    expect(view.container.querySelector(".react-flow__minimap")).toBeTruthy();
  });

  it("the edge id round-trips into the edge Selection the rest of the app speaks", () => {
    const model = parseDiagram(
      JSON.stringify({
        v: 1,
        nodes: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
          { id: "c", label: "C" },
        ],
        edges: [
          { id: "e1", from: "a", to: "b" },
          { id: "e2", from: "b", to: "c" },
        ],
      })
    );
    expect(model.edges.map(edgeId)).toEqual(["e1", "e2"]);
  });
});

// 자기루프. The canvas has drawn `A --> A` since selfLoopPath landed; until 2026-08-12 there was no
// gesture that could make one, so the picture could show a shape the UI refused to write.
describe("FlowCanvas — sequence 배치 (W2b)", () => {
  it("노드마다 data-layout=\"sequence\", 라이프라인 점선이 배경 레이어(Panel 아님)에 노드 수만큼; 다른 배치는 없음", () => {
    const { container } = mount(diagramTemplateSource("sequence"), actionsStub());
    const nodes = container.querySelectorAll('.diagram-flow-node[data-layout="sequence"]');
    expect(nodes.length).toBe(3);
    const lifelines = screen.getByTestId("diagram-sequence-lifelines");
    expect(lifelines.closest(".react-flow__panel")).toBeNull();
    const lines = Array.from(lifelines.querySelectorAll("line"));
    expect(lines.length).toBe(3);
    // 세로선: x1 = x2, 아래 끝(y2)은 모두 같은 lifelineH, 위 끝은 상자 아래.
    for (const l of lines) expect(l.getAttribute("x1")).toBe(l.getAttribute("x2"));
    expect(new Set(lines.map((l) => l.getAttribute("y2"))).size).toBe(1);
    expect(Number(lines[0].getAttribute("y2"))).toBeGreaterThan(Number(lines[0].getAttribute("y1")));
    cleanup();
    mount(SRC, actionsStub());
    expect(screen.queryByTestId("diagram-sequence-lifelines")).toBeNull();
    expect(document.querySelector('.diagram-flow-node[data-layout]')).toBeNull();
  });

  // React Flow renders no edge under jsdom (boxes measure 0×0 — see 자기루프 below), so the edge is
  // mounted directly with the `anchorY` FlowCanvas would hand it.
  it("BriseFlowEdge: data.anchorY 가 있으면 그 y 의 수평 경로(M x1 y L x2 y), 오프셋은 무시", () => {
    const seqNodes = [
      { id: "n1", position: { x: 24, y: 24 }, data: {} },
      { id: "n2", position: { x: 216, y: 24 }, data: {} },
    ];
    function Harness({ anchorY }: { anchorY?: number }) {
      const store = useStoreApi();
      const ref = useRef<HTMLDivElement>(null);
      const [ready, setReady] = useState(false);
      useEffect(() => {
        if (ref.current) {
          store.setState({ domNode: ref.current, width: 800, height: 600 });
          setReady(true);
        }
      }, [store]);
      return (
        <div ref={ref}>
          <div className="react-flow__edgelabel-renderer" />
          {ready && (
            <svg>
              <BriseFlowEdge
                id="e1"
                source="n1"
                target="n2"
                data={{ anchorY, offset: 17 }}
                sourceX={0}
                sourceY={0}
                targetX={100}
                targetY={100}
                sourcePosition={"bottom" as any}
                targetPosition={"top" as any}
              />
            </svg>
          )}
        </div>
      );
    }
    const { container } = render(
      <ReactFlowProvider defaultNodes={seqNodes}>
        <Harness anchorY={140} />
      </ReactFlowProvider>,
    );
    const d = container.querySelector("path")!.getAttribute("d")!;
    expect(d).toBe("M 96,140 L 288,140");
    cleanup();
    const { container: c2 } = render(
      <ReactFlowProvider defaultNodes={seqNodes}>
        <Harness />
      </ReactFlowProvider>,
    );
    expect(c2.querySelector("path")!.getAttribute("d")).not.toMatch(/^M [\d.]+,140 L [\d.]+,140$/);
  });
});

// 자기루프: the click-to-connect gesture that used to say `A --> A` (arm a box, click it again) left
// with 여기서 연결 on 2026-10-19 (GRILL R6). A loop is now a drag from one border handle of a box to
// another handle of the SAME box — React Flow's Loose connection mode accepts it (only the very same
// handle is refused) and onConnect hands it to actions.connect like any edge. jsdom measures every
// box 0×0, so that drag has no DOM test here; the write itself stays covered by diagramModel.test.ts.

// 끊어진 노트 링크. The click already said "노트를 찾을 수 없습니다" (DiagramSection.openNote); this
// is about saying it BEFORE the click, without an IPC per node or per render.
describe("FlowCanvas — 끊어진 노트 링크", () => {
  const LINKED = JSON.stringify({
    v: 1,
    nodes: [
      { id: "n1", label: "김철수", link: "note-alive" },
      { id: "n2", label: "김영수", link: "note-gone" },
      { id: "n3", label: "박씨" },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2" },
      { id: "e2", from: "n2", to: "n3" },
    ],
  });

  beforeEach(() => {
    summariesMock.mockReset();
    summariesMock.mockResolvedValue({});
  });

  it("dims only the icon whose note is gone, in ONE batched lookup for the whole diagram", async () => {
    summariesMock.mockResolvedValue({ "note-alive": { id: "note-alive" } });
    const view = mount(LINKED, actionsStub());
    await waitFor(() => expect(view.container.querySelector(".diagram-flow-node-link[data-broken]")).toBeTruthy());
    expect(summariesMock).toHaveBeenCalledTimes(1);
    expect([...summariesMock.mock.calls[0][0]].sort()).toEqual(["note-alive", "note-gone"]);

    const at = (id: string) =>
      view.container
        .querySelector(`.react-flow__node[data-id="${id}"]`)
        ?.querySelector(".diagram-flow-node-link");
    expect(at("n2")?.getAttribute("data-broken")).toBe("true");
    expect(at("n1")?.hasAttribute("data-broken")).toBe(false);
    // The link is DIMMED, never removed — 링크 해제 is still the user's call.
    expect(at("n2")).toBeTruthy();
  });

  it("asks nothing when no node is linked, and a failed lookup leaves every link looking fine", async () => {
    const bare = mount(SRC, actionsStub());
    await waitFor(() => expect(summariesMock).not.toHaveBeenCalled());
    bare.unmount();

    summariesMock.mockRejectedValue(new Error("offline"));
    const view = mount(LINKED, actionsStub());
    await waitFor(() => expect(summariesMock).toHaveBeenCalledTimes(1));
    expect(view.container.querySelector(".diagram-flow-node-link[data-broken]")).toBeNull();
  });
});

// subgraph. React Flow wants a child's position RELATIVE to its parent while `%% brise:pos` is
// always ABSOLUTE, and that conversion happens only here — so the case that matters is the round
// trip: a node placed at (400, 200) in the source has to land at (400, 200) on the canvas even
// though it is drawn inside a frame that starts somewhere else.
describe("FlowCanvas — subgraph frames", () => {
  const GROUPED = JSON.stringify({
    v: 1,
    nodes: [
      { id: "a", label: "가", pos: [400, 200], group: "g1" },
      { id: "b", label: "나", pos: [400, 400], group: "g1" },
      { id: "c", label: "다", pos: [0, 0] },
    ],
    edges: [
      { id: "e1", from: "a", to: "b" },
      { id: "e2", from: "c", to: "a" },
    ],
    groups: [{ id: "g1", title: "조정 회의" }],
  });

  /** React Flow writes each node's ABSOLUTE canvas position into its wrapper transform. */
  const at = (host: HTMLElement, id: string) => {
    const el = Array.from(host.querySelectorAll<HTMLElement>(".react-flow__node")).find(
      (n) => n.getAttribute("data-id") === id,
    );
    const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(el?.style.transform ?? "");
    return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
  };

  it("draws the frame with the block's title, and the boxes inside it", () => {
    mount(GROUPED, actionsStub());
    expect(screen.getByText("조정 회의")).toBeTruthy();
    for (const label of ["가", "나", "다"]) expect(screen.getByText(label)).toBeTruthy();
  });

  it("a grouped node lands on its ABSOLUTE saved coordinate, frame origin notwithstanding", () => {
    const view = mount(GROUPED, actionsStub());
    const host = view.container.querySelector<HTMLElement>(".diagram-flow")!;
    expect(at(host, "a")).toEqual({ x: 400, y: 200 });
    expect(at(host, "b")).toEqual({ x: 400, y: 400 });
    expect(at(host, "c")).toEqual({ x: 0, y: 0 });
    // The frame itself starts ABOVE and LEFT of its members (padding + the title strip), which is
    // exactly the offset the child positions had to be corrected by.
    const frame = at(host, "group:g1")!;
    expect(frame.x).toBeLessThan(400);
    expect(frame.y).toBeLessThan(200);
  });

  it("자동 정렬 still writes NODES only — a frame is derived and has no coordinate to write", () => {
    const actions = actionsStub();
    mount(GROUPED, actions);
    fireEvent.click(screen.getByTestId("diagram-auto-layout"));
    expect(Object.keys(vi.mocked(actions.setNodePositions).mock.calls[0][0]).sort()).toEqual(["a", "b", "c"]);
  });
});

// 아이콘·설명 (`%% brise:meta`). Drawn on the box; since 2026-10-19 (GRILL R6) no bubble verb edits
// them — 소스 보기 does — so what is left to prove here is that existing data still renders.
describe("FlowCanvas — 아이콘·설명", () => {
  const META = JSON.stringify({
    v: 1,
    nodes: [
      { id: "n1", label: "김철수", icon: "🗂", desc: "온디맨드 주입" },
      { id: "n2", label: "김영수" },
    ],
    edges: [{ id: "e1", from: "n1", to: "n2" }],
  });

  it("draws the icon left of the label and the description as its own line", () => {
    mount(META, actionsStub());
    expect(screen.getByText("🗂")).toBeTruthy();
    expect(screen.getByText("온디맨드 주입")).toBeTruthy();
  });

  it("the node bubble offers no 아이콘 / 설명 / 배지 verb any more — the data stays on the box", () => {
    mount(META, actionsStub(), { kind: "node", id: "n1" }, true);
    expect(screen.queryByTestId("diagram-node-icon")).toBeNull();
    expect(screen.queryByTestId("diagram-node-desc")).toBeNull();
    expect(screen.getByText("🗂")).toBeTruthy();
    expect(screen.getByText("온디맨드 주입")).toBeTruthy();
  });
});

// 육각형(diamond) 테두리는 CSS border 가 아니라 노드 뒤의 SVG polygon — clip-path 가 border 와 filter 를 통째
// 잘라내 테두리가 0px 로 그려지던 것(2026-09-20 오너 스크린샷). 점은 정적 SVG 와 같은 hexagonPoints.
describe("FlowCanvas — 육각형 테두리 polygon", () => {
  it("diamond 노드에만 polygon 이 있고, 꼭짓점은 노드 크기(width/height)에서 나온다", () => {
    mount(
      JSON.stringify({
        v: 1,
        nodes: [
          { id: "n1", label: "판단", shape: "diamond" },
          { id: "n2", label: "다음", shape: "round" },
        ],
        edges: [{ id: "e1", from: "n1", to: "n2" }],
      }),
      actionsStub()
    );
    const hex = screen.getAllByTestId("diagram-node-hexagon");
    expect(hex.length).toBe(1);
    const pts = hex[0].querySelector("polygon")!.getAttribute("points")!.split(" ");
    expect(pts.length).toBe(6);
    expect(pts[0]).toBe("14,0"); // 왼쪽 위 = 캔버스 CSS clip-path 의 14px 챔퍼
    const [w] = pts[2].split(",").map(Number); // 오른쪽 꼭짓점 x = 노드 폭
    expect(w).toBeGreaterThan(14);
  });
});

// 그룹 편집 동사. A frame is a subject now: it selects, it carries a bubble, a multi-selection can
// become one, and dropping a box across its border moves house. Everything here is about WRITES and
// STRUCTURE — the drop gesture's arithmetic is jsdom-hostile and lives in the model/actions tests.
describe("FlowCanvas — 그룹 동사", () => {
  const GROUPED = JSON.stringify({
    v: 1,
    nodes: [
      { id: "a", label: "가", pos: [400, 200], group: "g1" },
      { id: "b", label: "나", pos: [400, 400], group: "g1" },
      { id: "c", label: "다", pos: [0, 0] },
    ],
    edges: [
      { id: "e1", from: "a", to: "b" },
      { id: "e2", from: "c", to: "a" },
    ],
    groups: [{ id: "g1", title: "조정 회의" }],
  });

  it("clicking a frame selects it as a GROUP — no longer a pane click", () => {
    const onSelect = vi.fn();
    render(
      <FlowCanvas
        model={parseDiagram(GROUPED)}
        selection={null}
        onSelect={onSelect}
        actions={actionsStub()}
        onEditSource={vi.fn()}
        canUndo={false}
        onUndo={vi.fn()}
        canRedo={false}
        onRedo={vi.fn()}
        error={null}
        bubbles={false}
      />,
    );
    fireEvent.click(screen.getByText("조정 회의"));
    expect(onSelect).toHaveBeenCalledWith({ kind: "group", id: "g1" });
  });

  it("a selected frame gets the group verbs in toolbar — 이름 변경 and 그룹 해제, and NO 삭제", () => {
    const actions = actionsStub();
    mount(GROUPED, actions, { kind: "group", id: "g1" }, true);
    expect(screen.getByTestId("diagram-subject-chip")).toBeTruthy();
    expect(screen.getByTestId("diagram-group-dissolve")).toBeTruthy();
    expect(screen.queryByTestId("diagram-delete-node")).toBeNull();
    fireEvent.click(screen.getByTestId("diagram-group-dissolve"));
    expect(actions.dissolveGroup).toHaveBeenCalledWith("g1");
  });

  it("이름 변경 opens the inline field and commits ONE renameGroup", () => {
    const actions = actionsStub();
    mount(GROUPED, actions, { kind: "group", id: "g1" }, true);
    fireEvent.click(screen.getByTestId("diagram-group-rename"));
    const field = screen.getByTestId("diagram-inline-rename-group") as HTMLInputElement;
    expect(field.value).toBe("조정 회의");
    fireEvent.change(field, { target: { value: "어전 회의" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(actions.renameGroup).toHaveBeenCalledTimes(1);
    expect(vi.mocked(actions.renameGroup).mock.calls[0]).toEqual(["g1", "어전 회의"]);
  });

  it("double-clicking the frame is the same rename (and does NOT rename a node)", () => {
    const actions = actionsStub();
    mount(GROUPED, actions, null, true);
    fireEvent.doubleClick(screen.getByText("조정 회의"));
    expect(screen.getByTestId("diagram-inline-rename-group")).toBeTruthy();
    expect(actions.rename).not.toHaveBeenCalled();
  });

  it("그룹 만들기 rides in the 정렬 bar and hands addGroup exactly the picked boxes", () => {
    const actions = actionsStub();
    mount(SRC, actions, null, false, ["n1", "n2"]);

    fireEvent.click(screen.getByTestId("diagram-group-create"));
    const field = screen.getByTestId("diagram-inline-create-group") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "형제" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(actions.addGroup).toHaveBeenCalledTimes(1);
    const [title, members] = vi.mocked(actions.addGroup).mock.calls[0];
    expect(title).toBe("형제");
    expect([...members].sort()).toEqual(["n1", "n2"]);
  });

  it("no 그룹 만들기 button until 2+ boxes are picked — a group of one is not a group", () => {
    mount(SRC, actionsStub(), { kind: "node", id: "n1" });
    expect(screen.queryByTestId("diagram-group-create")).toBeNull();
  });
});

describe("FlowCanvas — 제자리(in-place) 편집", () => {
  const mockNodes = [
    { id: "n1", position: { x: 0, y: 0 }, data: {} },
    { id: "n2", position: { x: 100, y: 100 }, data: {} },
  ];

  function TestEdgeHarness({
    edit = null,
    commit = vi.fn(),
    cancel = vi.fn(),
    openRelabel = vi.fn(),
    label = "동료",
  }: {
    edit?: any;
    commit?: any;
    cancel?: any;
    openRelabel?: any;
    label?: string;
  }) {
    const store = useStoreApi();
    const [domReady, setDomReady] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
      if (containerRef.current) {
        store.setState({ domNode: containerRef.current, width: 800, height: 600 });
        setDomReady(true);
      }
    }, [store]);

    return (
      <div ref={containerRef}>
        <div className="react-flow__edgelabel-renderer" />
        <InlineEditCtx.Provider value={{ edit, commit, cancel, openRelabel }}>
          {domReady && (
            <svg>
              <BriseFlowEdge
                id="e1"
                source="n1"
                target="n2"
                label={label}
                sourceX={0}
                sourceY={0}
                targetX={100}
                targetY={100}
                sourcePosition={"bottom" as any}
                targetPosition={"top" as any}
              />
            </svg>
          )}
        </InlineEditCtx.Provider>
      </div>
    );
  }

  it("① double-clicking a box renders the inline rename input IN-PLACE inside the node element", () => {
    const actions = actionsStub();
    mount(SRC, actions, { kind: "node", id: "n1" }, true);
    expect(screen.queryByTestId("diagram-rename-open")).toBeNull();
    fireEvent.doubleClick(screen.getByTestId("rf__node-n1"));
    const input = screen.getByTestId("diagram-inline-rename") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.closest(".diagram-flow-node")).toBeTruthy();
    expect(input.closest(".react-flow__node")?.getAttribute("data-id")).toBe("n1");
  });

  it("② has nodrag, nopan, and nowheel classes on in-place input so typing does not drag the node", () => {
    const actions = actionsStub();
    mount(SRC, actions, { kind: "node", id: "n1" }, true);
    fireEvent.doubleClick(screen.getByTestId("rf__node-n1"));
    const input = screen.getByTestId("diagram-inline-rename");
    expect(input.className).toContain("nodrag");
    expect(input.className).toContain("nopan");
    expect(input.className).toContain("nowheel");
  });

  it("③ shares typography CSS selectors between node label and input in tokens.css", () => {
    const tokensCss = readFileSync("src/styles/tokens.css", "utf8");
    expect(tokensCss).toMatch(/\.diagram-flow-node-label,\s*\.diagram-flow-node-label-input/);
    expect(tokensCss).toMatch(/\.diagram-flow-group-title,\s*\.diagram-flow-group-title-input/);
    expect(tokensCss).toMatch(/\.diagram-flow-edge-label,\s*\.diagram-flow-edge-label-input/);
  });

  it("④ double-clicking an edge opens diagram-inline-edge-label", () => {
    const openRelabel = vi.fn();
    const { container } = render(
      <ReactFlowProvider defaultNodes={mockNodes}>
        <TestEdgeHarness openRelabel={openRelabel} label="동료" />
      </ReactFlowProvider>,
    );
    fireEvent.doubleClick(screen.getByText("동료"));
    expect(openRelabel).toHaveBeenCalledWith("e1");

    // Also test double-clicking the edge SVG geometry path directly
    const edgeGroup = container.querySelector("svg g");
    expect(edgeGroup).toBeTruthy();
    fireEvent.doubleClick(edgeGroup!);
    expect(openRelabel).toHaveBeenCalledTimes(2);
  });

  it("⑤ double-clicking an edge without a label also opens diagram-inline-edge-label", () => {
    const openRelabel = vi.fn();
    const { container } = render(
      <ReactFlowProvider defaultNodes={mockNodes}>
        <TestEdgeHarness openRelabel={openRelabel} label="" />
      </ReactFlowProvider>,
    );
    const emptyChip = container.querySelector('.diagram-flow-edge-label[data-empty="true"]');
    expect(emptyChip).toBeTruthy();
    fireEvent.doubleClick(emptyChip!);
    expect(openRelabel).toHaveBeenCalledWith("e1");
  });

  it("⑥ emptying an edge label commits setEdgeLabel with an empty string", () => {
    const commit = vi.fn();
    render(
      <ReactFlowProvider defaultNodes={mockNodes}>
        <TestEdgeHarness
          edit={{ kind: "label", edgeId: "e1", value: "동료" }}
          commit={commit}
          label="동료"
        />
      </ReactFlowProvider>,
    );
    const input = screen.getByTestId("diagram-inline-edge-label") as HTMLInputElement;
    expect(input.value).toBe("동료");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(commit).toHaveBeenCalledWith("");
  });

  it("⑦ inline edge label input adjusts width dynamically to character length", () => {
    render(
      <ReactFlowProvider defaultNodes={mockNodes}>
        <TestEdgeHarness
          edit={{ kind: "label", edgeId: "e1", value: "매우긴관계이름입니다" }}
          label="매우긴관계이름입니다"
        />
      </ReactFlowProvider>,
    );
    const input = screen.getByTestId("diagram-inline-edge-label") as HTMLInputElement;
    expect(input.style.width).toBe(`${"매우긴관계이름입니다".length + 2}ch`);
  });

  it("⑧ double-clicking the canvas pane creates a new node and opens inline rename editing", async () => {
    const actions = actionsStub();
    (actions.addNode as any).mockReturnValue("n_new");
    const view = mount(SRC, actions);
    const host = screen.getByTestId("diagram-flow");
    fireEvent.doubleClick(host, { clientX: 300, clientY: 200 });
    expect(actions.addNode).toHaveBeenCalledTimes(1);
    expect(vi.mocked(actions.addNode).mock.calls[0][0]).toBe("새 노드");
    const pos = vi.mocked(actions.addNode).mock.calls[0][2];
    expect(pos).toHaveProperty("x");
    expect(pos).toHaveProperty("y");

    // When model rerenders with the newly created node, inline rename input is rendered in place
    const updated = JSON.stringify({
      v: 1,
      nodes: [
        { id: "n1", label: "김철수" },
        { id: "n2", label: "김영수" },
        { id: "n3", label: "박씨" },
        { id: "n_new", label: "새 노드" },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2" },
        { id: "e2", from: "n2", to: "n3" },
      ],
    });
    view.rerender(canvas(updated, actions, { kind: "node", id: "n_new" }));
    expect(await screen.findByTestId("diagram-inline-rename")).toBeTruthy();
  });

  it("⑨ verifies performance optimization, magnetic snapping, and pan gesture props on ReactFlow", () => {
    const flowCanvasCode = readFileSync(resolve(__dirname, "FlowCanvas.tsx"), "utf-8");
    expect(flowCanvasCode).toContain("onlyRenderVisibleElements={true}");
    expect(flowCanvasCode).toContain("connectionMode={ConnectionMode.Loose}");
    expect(flowCanvasCode).toContain("connectionRadius={48}");
    expect(flowCanvasCode).toContain("connectionLineType={ConnectionLineType.SmoothStep}");
    expect(flowCanvasCode).toContain('panActivationKeyCode="Space"');
    expect(flowCanvasCode).toContain("panOnDrag={[1, 2]}");
  });

  it("⑩ sets data-edge-id on edge label container and inline label input", () => {
    const { container, rerender } = render(
      <ReactFlowProvider defaultNodes={mockNodes}>
        <TestEdgeHarness label="친구" />
      </ReactFlowProvider>,
    );
    const labelChip = container.querySelector('.diagram-flow-edge-label[data-edge-id="e1"]');
    expect(labelChip).toBeTruthy();

    rerender(
      <ReactFlowProvider defaultNodes={mockNodes}>
        <TestEdgeHarness
          edit={{ kind: "label", edgeId: "e1", value: "친구" }}
          label="친구"
        />
      </ReactFlowProvider>,
    );
    const input = screen.getByTestId("diagram-inline-edge-label");
    expect(input.getAttribute("data-edge-id")).toBe("e1");
  });

  it("⑪ toggles legend visibility via apiRef.current.toggleLegend", async () => {
    const modelWithStates = JSON.stringify({
      v: 1,
      states: ["진행", "완료"],
      nodes: [
        { id: "n1", label: "A", state: 0 },
        { id: "n2", label: "B", state: 1 },
      ],
      edges: [],
    });
    const actions = actionsStub();
    const apiRef = { current: null as unknown as DiagramCanvasApi };
    render(
      <FlowCanvas
        model={parseDiagram(modelWithStates)}
        selection={null}
        onSelect={vi.fn()}
        actions={actions}
        onEditSource={vi.fn()}
        canUndo={false}
        onUndo={vi.fn()}
        canRedo={false}
        onRedo={vi.fn()}
        error={null}
        apiRef={apiRef}
      />
    );

    expect(screen.getByTestId("diagram-legend")).toBeTruthy();
    expect(apiRef.current.isLegendOpen?.()).toBe(true);

    act(() => {
      apiRef.current.toggleLegend?.();
    });

    expect(screen.queryByTestId("diagram-legend")).toBeNull();
    expect(apiRef.current.isLegendOpen?.()).toBe(false);
  });
});

// 2026-10-18 화면 보드 12-note-diagram: 통계 알약("상자 4 · 관계 6 | 강조 0 …")이 맨 위 상자를 덮었다. 원인 둘 —
// ① 전체 맞춤이 알약 자리를 모르고 뷰포트 비율 패딩만 줬다, ② absolute + left:50% 알약의 shrink-to-fit 폭이 캔버스
// 절반이라 두 줄로 접혀 높이가 두 배가 됐다. jsdom 은 레이아웃이 없으니 ①은 React Flow 의 실제 맞춤 산수
// (getViewportForBounds)로, ②와 호출 지점은 소스/CSS 계약으로 본다.
describe("FlowCanvas — 전체 맞춤은 범례 알약 띠를 비운다", () => {
  // 화면 보드 실측 근사: 캔버스 716×492 에 상자 4개가 530×460 쯤 — 세로가 맞춤을 정하는(높이 제한) 그래프다.
  // 가로 제한 그래프는 세로 여유가 남아 원래도 덮지 않는다.
  const W = 716;
  const H = 492;
  const bounds = { x: 0, y: 0, width: 500, height: 400 };
  type FitPad = Parameters<typeof getViewportForBounds>[5];
  const topOf = (pad: FitPad) => {
    const vp = getViewportForBounds(bounds, W, H, 0.25, 4, pad);
    return vp.y + bounds.y * vp.zoom; // 맨 위 상자 윗변의 화면 y
  };

  it("범례가 열려 있으면 맨 위 상자가 알약 띠(LEGEND_FIT_TOP_PX) 아래에서 시작한다", () => {
    // 고치기 전 산수(기본 0.1)는 알약 아래끝(10 + 34px)보다 위 — 이게 '덮는다'였다.
    expect(topOf(0.1)).toBeLessThan(10 + 34);
    expect(topOf(wholeGraphFitPadding(true))).toBeGreaterThanOrEqual(LEGEND_FIT_TOP_PX);
    expect(topOf(wholeGraphFitPadding(true, 0.2))).toBeGreaterThanOrEqual(LEGEND_FIT_TOP_PX);
  });

  it("범례 띠는 위쪽만 바꾸고, 범례가 닫히면 원래 비율 패딩 그대로다", () => {
    expect(wholeGraphFitPadding(true, 0.2)).toEqual({ top: `${LEGEND_FIT_TOP_PX}px`, x: 0.2, bottom: 0.2 });
    expect(wholeGraphFitPadding(false)).toBe(0.1);
    expect(wholeGraphFitPadding(false, 0.2)).toBe(0.2);
    // 띠 = 알약 자리(top 10px) + 알약 한 줄(34px, tokens.css 의 Reach/Finder 오프셋과 같은 가정) 이상.
    expect(LEGEND_FIT_TOP_PX).toBeGreaterThanOrEqual(10 + 34);
  });

  it("전체 맞춤 지점은 전부 같은 옵션을 지난다 — 첫 그리기·Controls·툴바 api·단축키", () => {
    const code = readFileSync(resolve(__dirname, "FlowCanvas.tsx"), "utf-8");
    // ReactFlow 와 Controls 둘 다
    expect(code.match(/fitViewOptions=\{wholeFitOptions\}/g)?.length).toBe(2);
    expect(code).toContain("fitView: () => fitView(wholeFitOptions)");
    expect(code).toContain("padding: wholeGraphFitPadding(legendOpen, 0.2)");
    // 옵션 없는 맨 fitView() 가 다시 생기면 알약 띠를 잊은 것이다.
    expect(code).not.toMatch(/fitView\(\)/);
  });

  it("떠 있는 알약은 내용 폭을 쓴다(width:max-content) — left:50% 의 절반 폭 상한으로 접히지 않게", () => {
    const tokensCss = readFileSync("src/styles/tokens.css", "utf8");
    const rule = tokensCss.match(/\.diagram-canvas-float\{([^}]*)\}/);
    expect(rule, ".diagram-canvas-float 규칙").toBeTruthy();
    expect(rule![1]).toMatch(/left:50%/);
    expect(rule![1]).toMatch(/width:max-content/);
    expect(rule![1]).toMatch(/max-width:calc\(100% - 2\*var\(--space-4\)\)/);
  });
});
