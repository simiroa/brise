import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeAll } from "vitest";
import { t } from "../../i18n/t";
import { DiagramFloatingBubble } from "./DiagramFloatingBubble";
import { DiagramLegend } from "./DiagramLegend";
import type { DiagramModel } from "./diagramModel";
import type { DiagramActions } from "./diagramActions";
import { AskAiModal as LazyAskAiModal } from "../../lazySurfaces";

// 이 화면들은 지연 청크다(lazySurfaces) — 앱이 유휴 시간에 미리 받듯 여기서 미리 받아 클릭 직후 바로 그려지게 한다.
beforeAll(async () => {
  await LazyAskAiModal.preload();
}, 30_000);

const testModel: DiagramModel = {
  v: 1,
  route: "curve",
  direction: "TB",
  nodes: [
    { id: "n1", label: "노드1", shape: "rect", flag: false },
    { id: "n2", label: "노드2", shape: "rect", state: 1 },
  ],
  edges: [
    { id: "e1", from: "n1", to: "n2", label: "연결선" },
  ],
  groups: [
    { id: "g1", title: "테스트그룹" },
  ],
  states: ["대기", "진행중", "완료"],
  flagLabel: "중요",
  empty: false,
  structured: true,
};

function createMockActions(): DiagramActions {
  return {
    shape: "rect",
    style: "solid",
    setShapeDefault: vi.fn(),
    setStyleDefault: vi.fn(),
    addNode: vi.fn(),
    addConnected: vi.fn(),
    connect: vi.fn(),
    connectBatch: vi.fn(),
    createChild: vi.fn(),
    expandChildren: vi.fn(() => []),
    rename: vi.fn(),
    deleteNode: vi.fn(),
    deleteEdge: vi.fn(),
    setNodeShape: vi.fn(),
    setEdgeStyle: vi.fn(),
    setEdgeLine: vi.fn(),
    setEdgeArrow: vi.fn(),
    setEdgeTone: vi.fn(),
    edgeTone: vi.fn(() => "default" as const),
    setNodePositions: vi.fn(),
    setNodePos: vi.fn(),
    reparent: vi.fn(),
    retarget: vi.fn(),
    setNodeTone: vi.fn(),
    nodeTone: vi.fn(() => "default" as const),
    setNodeMark: vi.fn(),
    setNodesMark: vi.fn(),
    openNote: vi.fn(),
    pickNote: vi.fn(),
    unlinkNote: vi.fn(),
    addFromText: vi.fn(() => ({ ok: true })),
    setDirection: vi.fn(),
    setLayout: vi.fn(),
    setEdgeLabel: vi.fn(),
    setNodeMeta: vi.fn(),
    setNodeTag: vi.fn(),
    setNodeRows: vi.fn(),
    setNodeState: vi.fn(),
    setNodeFlag: vi.fn(),
    setStates: vi.fn(),
    toggleNodeFlag: vi.fn(),
    addGroup: vi.fn(),
    renameGroup: vi.fn(),
    setGroupTone: vi.fn(),
    groupTone: vi.fn(() => "default" as const),
    dissolveGroup: vi.fn(),
    setRoute: vi.fn(),
  };
}

describe("DiagramFloatingBubble", () => {
  it("renders floating bubble when a node is selected and target DOM element is found", async () => {
    const containerEl = document.createElement("div");
    const nodeEl = document.createElement("div");
    nodeEl.setAttribute("data-id", "n1");
    // Mock getBoundingClientRect
    vi.spyOn(nodeEl, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 100,
      width: 160,
      height: 44,
      right: 260,
      bottom: 144,
      x: 100,
      y: 100,
      toJSON: () => {},
    });
    vi.spyOn(containerEl, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 800,
      height: 600,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => {},
    });
    containerEl.appendChild(nodeEl);
    document.body.appendChild(containerEl);

    const containerRef = { current: containerEl };
    const actions = createMockActions();

    render(
      <DiagramFloatingBubble
        model={testModel}
        selection={{ kind: "node", id: "n1" }}
        actions={actions}
        containerRef={containerRef}
      />
    );

    // After animation frame / position update
    const bubble = await screen.findByTestId("diagram-floating-bubble");
    expect(bubble).toBeTruthy();

    // 강조 칩(flagLabel = "중요") 클릭 — 강조 하나로 바꾸는 ONE 쓰기
    fireEvent.click(screen.getByTestId("diagram-mark-flag"));
    expect(actions.setNodeMark).toHaveBeenCalledWith("n1", "flag");

    // 남는 항목: 색 칩 · 모양 · 노드 추가 · AI · 삭제
    expect(screen.getByTitle(t("editor.diagram_shape"))).toBeTruthy();
    expect(screen.getByTitle(t("editor.diagram_add_node_tooltip"))).toBeTruthy();
    expect(screen.getByTestId("diagram-ai-btn")).toBeTruthy();
    // 빠진 항목(GRILL-2026-10-19 R6): 여기서 연결 · 배지 · 아이콘 · 설명 · 구획 · 이름 변경 버튼, 따로 놓인 톤/상태 메뉴
    for (const key of [
      "editor.diagram_connect_from",
      "editor.diagram_tag",
      "editor.diagram_node_icon",
      "editor.diagram_node_desc",
      "editor.diagram_node_rows",
      "editor.diagram_rename",
      "editor.diagram_tone",
      "editor.diagram_state",
    ]) {
      expect(screen.queryByTitle(t(key))).toBeNull();
    }
    for (const id of ["diagram-rename-open", "diagram-node-icon", "diagram-node-desc", "diagram-node-rows"]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }

    // 삭제 버튼 클릭
    const deleteBtn = screen.getByTitle(t("editor.diagram_delete"));
    fireEvent.click(deleteBtn);
    expect(actions.deleteNode).toHaveBeenCalledWith("n1");

    document.body.removeChild(containerEl);
  });

  it("renders edge bubble when an edge is selected", async () => {
    const containerEl = document.createElement("div");
    const edgeEl = document.createElement("div");
    edgeEl.setAttribute("data-id", "e1");
    edgeEl.className = "react-flow__edge";
    vi.spyOn(edgeEl, "getBoundingClientRect").mockReturnValue({
      left: 200,
      top: 200,
      width: 100,
      height: 20,
      right: 300,
      bottom: 220,
      x: 200,
      y: 200,
      toJSON: () => {},
    });
    vi.spyOn(containerEl, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 800,
      height: 600,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => {},
    });
    containerEl.appendChild(edgeEl);
    document.body.appendChild(containerEl);

    const containerRef = { current: containerEl };
    const actions = createMockActions();

    render(
      <DiagramFloatingBubble
        model={testModel}
        selection={{ kind: "edge", id: "e1" }}
        actions={actions}
        containerRef={containerRef}
      />
    );

    const bubble = await screen.findByTestId("diagram-floating-bubble");
    expect(bubble).toBeTruthy();

    // 엣지 삭제 클릭
    const deleteBtn = screen.getByTitle(t("editor.diagram_delete"));
    fireEvent.click(deleteBtn);
    expect(actions.deleteEdge).toHaveBeenCalledWith("e1");

    document.body.removeChild(containerEl);
  });

  describe("색 칩 한 줄 (GRILL-2026-10-19 R6/R7)", () => {
    function mountNodeBubble(model: DiagramModel, nodeId: string) {
      const containerEl = document.createElement("div");
      const nodeEl = document.createElement("div");
      nodeEl.setAttribute("data-id", nodeId);
      vi.spyOn(nodeEl, "getBoundingClientRect").mockReturnValue({
        left: 100, top: 100, width: 160, height: 44, right: 260, bottom: 144, x: 100, y: 100, toJSON: () => {},
      });
      vi.spyOn(containerEl, "getBoundingClientRect").mockReturnValue({
        left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => {},
      });
      containerEl.appendChild(nodeEl);
      document.body.appendChild(containerEl);
      const actions = createMockActions();
      const view = render(
        <DiagramFloatingBubble
          model={model}
          selection={{ kind: "node", id: nodeId }}
          actions={actions}
          containerRef={{ current: containerEl }}
        />
      );
      return {
        actions,
        done: () => {
          view.unmount();
          document.body.removeChild(containerEl);
        },
      };
    }

    const chips = () => Array.from(screen.getByTestId("diagram-mark-chips").querySelectorAll("button"));
    const pressed = () => chips().filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent);

    it("칩 = 기본 · 강조 이름 · 상태 이름들, 순서대로 글자가 붙어 있고 지금 표시가 눌려 있다", async () => {
      const { done } = mountNodeBubble(testModel, "n1");
      await screen.findByTestId("diagram-mark-chips");
      expect(chips().map((b) => b.textContent)).toEqual([t("editor.diagram_tone_default"), "중요", "대기", "진행중", "완료"]);
      // n1 은 표시가 없다 → 기본만 눌림
      expect(pressed()).toEqual([t("editor.diagram_tone_default")]);
      // 점마다 색 — 기본은 빈 점(점선), 나머지는 CSS 변수(인라인 리터럴 색 없음)
      const dots = chips().map((b) => b.querySelector(".diagram-legend-marker") as HTMLElement);
      expect(dots[0].getAttribute("data-empty")).toBe("true");
      expect(dots[1].style.color).toBe("var(--accent)");
      expect(dots[2].style.color).toBe("var(--danger-soft)");
      expect(dots[3].style.color).toBe("var(--ok)");
      done();
    });

    it("꺼진 칩을 누르면 그 표시 하나로(ONE setNodeMark), 켜진 '기본'을 누르면 아무것도 쓰지 않는다", async () => {
      const { actions, done } = mountNodeBubble(testModel, "n1");
      await screen.findByTestId("diagram-mark-chips");
      fireEvent.click(screen.getByTestId("diagram-mark-0"));
      expect(actions.setNodeMark).toHaveBeenLastCalledWith("n1", 0);
      fireEvent.click(screen.getByTestId("diagram-mark-flag"));
      expect(actions.setNodeMark).toHaveBeenLastCalledWith("n1", "flag");
      fireEvent.click(screen.getByTestId("diagram-mark-default"));
      expect(actions.setNodeMark).toHaveBeenCalledTimes(2);
      expect(actions.setNodeState).not.toHaveBeenCalled();
      expect(actions.setNodeFlag).not.toHaveBeenCalled();
      done();
    });

    it("켜진 상태 칩을 다시 누르면 상태만 지운다", async () => {
      const { actions, done } = mountNodeBubble(testModel, "n2");
      await screen.findByTestId("diagram-mark-chips");
      expect(pressed()).toEqual(["진행중"]);
      fireEvent.click(screen.getByTestId("diagram-mark-1"));
      expect(actions.setNodeState).toHaveBeenCalledWith("n2", undefined);
      expect(actions.setNodeMark).not.toHaveBeenCalled();
      // 꺼진 '기본' 은 둘 다 지운다
      fireEvent.click(screen.getByTestId("diagram-mark-default"));
      expect(actions.setNodeMark).toHaveBeenCalledWith("n2", null);
      done();
    });

    it("켜진 강조 칩을 다시 누르면 강조만 끈다 — 강조+상태가 둘 다 걸린 옛 노드는 두 칩이 함께 눌려 있다", async () => {
      const legacy: DiagramModel = {
        ...testModel,
        nodes: [{ id: "n1", label: "노드1", shape: "rect", flag: true, state: 2 }, ...testModel.nodes.slice(1)],
      };
      const { actions, done } = mountNodeBubble(legacy, "n1");
      await screen.findByTestId("diagram-mark-chips");
      expect(pressed()).toEqual(["중요", "완료"]);
      fireEvent.click(screen.getByTestId("diagram-mark-flag"));
      expect(actions.setNodeFlag).toHaveBeenCalledWith("n1", false);
      expect(actions.setNodeMark).not.toHaveBeenCalled();
      done();
    });

    it("상태 어휘가 없으면 칩은 기본 · 강조 둘뿐, 강조 이름은 기본값", async () => {
      const bare: DiagramModel = { ...testModel, states: [], flagLabel: undefined };
      const { done } = mountNodeBubble(bare, "n1");
      await screen.findByTestId("diagram-mark-chips");
      expect(chips().map((b) => b.textContent)).toEqual([t("editor.diagram_tone_default"), t("editor.diagram_flag")]);
      done();
    });

    it("칩 이름 = 범례 이름 (R7)", async () => {
      // 범례는 강조된 노드가 하나라도 있어야 강조 항목을 그린다.
      const flagged: DiagramModel = {
        ...testModel,
        nodes: [{ id: "n1", label: "노드1", shape: "rect", flag: true }, ...testModel.nodes.slice(1)],
      };
      const legend = render(<DiagramLegend model={flagged} />);
      const legendText = (id: string) => legend.getByTestId(id).textContent ?? "";
      const { done } = mountNodeBubble(flagged, "n1");
      await screen.findByTestId("diagram-mark-chips");
      const labels = chips().map((b) => b.textContent ?? "");
      expect(legendText("diagram-legend-chip-flag")).toContain(labels[1]);
      flagged.states!.forEach((name, idx) => {
        expect(labels[2 + idx]).toBe(name);
        expect(legendText(`diagram-legend-chip-${idx}`)).toContain(labels[2 + idx]);
      });
      done();
      legend.unmount();
    });
  });

  it("renders multi-selection bubble when multiple nodes are selected and supports batch actions", async () => {
    const containerEl = document.createElement("div");
    const n1El = document.createElement("div");
    n1El.setAttribute("data-id", "n1");
    vi.spyOn(n1El, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 100,
      width: 160,
      height: 44,
      right: 260,
      bottom: 144,
      x: 100,
      y: 100,
      toJSON: () => {},
    });
    const n2El = document.createElement("div");
    n2El.setAttribute("data-id", "n2");
    vi.spyOn(n2El, "getBoundingClientRect").mockReturnValue({
      left: 300,
      top: 200,
      width: 160,
      height: 44,
      right: 460,
      bottom: 244,
      x: 300,
      y: 200,
      toJSON: () => {},
    });

    vi.spyOn(containerEl, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 800,
      height: 600,
      right: 800,
      bottom: 600,
      x: 0,
      y: 0,
      toJSON: () => {},
    });
    containerEl.appendChild(n1El);
    containerEl.appendChild(n2El);
    document.body.appendChild(containerEl);

    const containerRef = { current: containerEl };
    const actions = createMockActions();
    const arrangeMock = vi.fn();
    const apiRef = { current: { arrange: arrangeMock } as any };

    render(
      <DiagramFloatingBubble
        model={testModel}
        selection={null}
        selectedBoxIds={["n1", "n2"]}
        actions={actions}
        apiRef={apiRef}
        containerRef={containerRef}
      />
    );

    const bubble = await screen.findByTestId("diagram-floating-bubble");
    expect(bubble).toBeTruthy();

    // 선택 카운트 표시 확인
    expect(screen.getByTestId("diagram-floating-multi-count")).toBeTruthy();

    // 일괄 그룹화 버튼 클릭
    const groupBtn = screen.getByTitle(t("editor.diagram_group_create"));
    fireEvent.click(groupBtn);
    expect(actions.addGroup).toHaveBeenCalledWith("새 그룹", ["n1", "n2"]);

    // 일괄 삭제 버튼 클릭
    const deleteBtn = screen.getByTitle(t("editor.diagram_delete"));
    fireEvent.click(deleteBtn);
    expect(actions.deleteNode).toHaveBeenCalledWith("n1");
    expect(actions.deleteNode).toHaveBeenCalledWith("n2");

    // 일괄 색 표시 — 단일 버블과 같은 칩 이름(범례), 선택 전부에 ONE 쓰기
    const toneBtn = screen.getByTitle(t("editor.diagram_tone"));
    fireEvent.click(toneBtn);
    const chips = screen.getByTestId("diagram-multi-mark-chips");
    expect([...chips.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      t("editor.diagram_tone_default"),
      testModel.flagLabel,
      "대기",
      "진행중",
      "완료",
    ]);
    fireEvent.click(screen.getByTestId("diagram-multi-mark-1"));
    expect(actions.setNodesMark).toHaveBeenCalledTimes(1);
    expect(actions.setNodesMark).toHaveBeenCalledWith(["n1", "n2"], 1);
    expect(actions.setNodeTone).not.toHaveBeenCalled();

    // 일괄 모양 변경
    const shapeBtn = screen.getByTitle(t("editor.diagram_shape"));
    fireEvent.click(shapeBtn);
    const stadiumBtn = screen.getByText(t("editor.diagram_shape_stadium"));
    fireEvent.click(stadiumBtn);
    expect(actions.setNodeShape).toHaveBeenCalledWith("n1", "stadium");
    expect(actions.setNodeShape).toHaveBeenCalledWith("n2", "stadium");

    // 스마트 정렬 툴
    const alignBtn = screen.getByTitle(t("editor.diagram_align_tools"));
    fireEvent.click(alignBtn);
    const leftAlignBtn = screen.getByText(t("editor.diagram_align_left"));
    fireEvent.click(leftAlignBtn);
    expect(arrangeMock).toHaveBeenCalled();

    document.body.removeChild(containerEl);
  });

  it("renders AI button for single node and opens AskAiModal on click", async () => {
    const containerEl = document.createElement("div");
    const nodeEl = document.createElement("div");
    nodeEl.setAttribute("data-id", "n1");
    vi.spyOn(nodeEl, "getBoundingClientRect").mockReturnValue({
      left: 100, top: 100, width: 160, height: 44, right: 260, bottom: 144, x: 100, y: 100, toJSON: () => {},
    });
    vi.spyOn(containerEl, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => {},
    });
    containerEl.appendChild(nodeEl);
    document.body.appendChild(containerEl);

    const containerRef = { current: containerEl };
    const actions = createMockActions();

    render(
      <DiagramFloatingBubble
        model={testModel}
        selection={{ kind: "node", id: "n1" }}
        actions={actions as any}
        containerRef={containerRef}
      />
    );

    const aiBtn = await screen.findByTestId("diagram-ai-btn");
    expect(aiBtn).toBeTruthy();

    fireEvent.click(aiBtn);

    // AskAiModal's title is the action name (t("ai.ask_ai") — "Ask AI" in the en test locale).
    const modal = await screen.findByRole("dialog", { name: "Ask AI" });
    expect(modal).toBeTruthy();

    document.body.removeChild(containerEl);
  });

  it("renders extract todos button in multi-selection context and triggers extraction on click", async () => {
    const containerEl = document.createElement("div");
    const n1El = document.createElement("div");
    n1El.setAttribute("data-id", "n1");
    const n2El = document.createElement("div");
    n2El.setAttribute("data-id", "n2");

    vi.spyOn(n1El, "getBoundingClientRect").mockReturnValue({
      left: 100, top: 100, width: 160, height: 44, right: 260, bottom: 144, x: 100, y: 100, toJSON: () => {},
    });
    vi.spyOn(n2El, "getBoundingClientRect").mockReturnValue({
      left: 100, top: 200, width: 160, height: 44, right: 260, bottom: 244, x: 100, y: 200, toJSON: () => {},
    });
    vi.spyOn(containerEl, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => {},
    });
    containerEl.appendChild(n1El);
    containerEl.appendChild(n2El);
    document.body.appendChild(containerEl);

    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText: writeTextMock },
    });

    const containerRef = { current: containerEl };
    const actions = createMockActions();

    render(
      <DiagramFloatingBubble
        model={testModel}
        selection={null}
        selectedBoxIds={["n1", "n2"]}
        actions={actions}
        containerRef={containerRef}
      />
    );

    const extractBtn = await screen.findByTestId("diagram-extract-todos");
    expect(extractBtn).toBeTruthy();

    fireEvent.click(extractBtn);
    await vi.waitFor(() => {
      expect(writeTextMock).toHaveBeenCalled();
    });

    document.body.removeChild(containerEl);
  });

  it("positions toolbar with 18px gap above node and flips dropdown upwards (top placement)", async () => {
    const containerEl = document.createElement("div");
    const nodeEl = document.createElement("div");
    nodeEl.setAttribute("data-id", "n1");
    vi.spyOn(nodeEl, "getBoundingClientRect").mockReturnValue({
      left: 100, top: 120, width: 160, height: 44, right: 260, bottom: 164, x: 100, y: 120, toJSON: () => {},
    });
    vi.spyOn(containerEl, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => {},
    });
    containerEl.appendChild(nodeEl);
    document.body.appendChild(containerEl);

    const containerRef = { current: containerEl };
    const actions = createMockActions();

    render(
      <DiagramFloatingBubble
        model={testModel}
        selection={{ kind: "node", id: "n1" }}
        actions={actions}
        containerRef={containerRef}
      />
    );

    const bubble = await screen.findByTestId("diagram-floating-bubble");
    // y = 120 - 0 - 18 = 102px
    expect(bubble.style.top).toBe("102px");
    expect(bubble.getAttribute("data-flipped")).toBeNull();

    // 메뉴 열기 -> 드롭다운 data-placement="top" 확인
    const shapeBtn = screen.getByTitle(t("editor.diagram_shape"));
    await act(async () => {
      fireEvent.click(shapeBtn);
    });

    await vi.waitFor(() => {
      const dropdown = bubble.querySelector(".diagram-floating-bubble-dropdown");
      expect(dropdown?.getAttribute("data-placement")).toBe("top");
    });

    document.body.removeChild(containerEl);
  });

  it("flips toolbar to bottom (+18px) when top space is narrow (<48px) and flips dropdown downwards (bottom placement)", async () => {
    const containerEl = document.createElement("div");
    const nodeEl = document.createElement("div");
    nodeEl.setAttribute("data-id", "n1");
    // top = 20: 20 - 18 = 2 < 48 -> flipped to bottom: 64 + 18 = 82
    vi.spyOn(nodeEl, "getBoundingClientRect").mockReturnValue({
      left: 100, top: 20, width: 160, height: 44, right: 260, bottom: 64, x: 100, y: 20, toJSON: () => {},
    });
    vi.spyOn(containerEl, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => {},
    });
    containerEl.appendChild(nodeEl);
    document.body.appendChild(containerEl);

    const containerRef = { current: containerEl };
    const actions = createMockActions();

    render(
      <DiagramFloatingBubble
        model={testModel}
        selection={{ kind: "node", id: "n1" }}
        actions={actions}
        containerRef={containerRef}
      />
    );

    const bubble = await screen.findByTestId("diagram-floating-bubble");
    // y = bottom (64) + 18 = 82px
    expect(bubble.style.top).toBe("82px");
    expect(bubble.getAttribute("data-flipped")).toBe("true");

    // 메뉴 열기 -> 드롭다운 data-placement="bottom" 확인
    const shapeBtn = screen.getByTitle(t("editor.diagram_shape"));
    await act(async () => {
      fireEvent.click(shapeBtn);
    });

    await vi.waitFor(() => {
      const dropdown = bubble.querySelector(".diagram-floating-bubble-dropdown");
      expect(dropdown?.getAttribute("data-placement")).toBe("bottom");
    });

    document.body.removeChild(containerEl);
  });

  it("positions bubble directly at label center when edge label is present", async () => {
    const containerEl = document.createElement("div");
    const labelEl = document.createElement("div");
    labelEl.className = "diagram-flow-edge-label";
    labelEl.setAttribute("data-edge-id", "e1");
    vi.spyOn(labelEl, "getBoundingClientRect").mockReturnValue({
      left: 200, top: 150, width: 60, height: 20, right: 260, bottom: 170, x: 200, y: 150, toJSON: () => {},
    });
    vi.spyOn(containerEl, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => {},
    });
    containerEl.appendChild(labelEl);
    document.body.appendChild(containerEl);

    const containerRef = { current: containerEl };
    const actions = createMockActions();

    render(
      <DiagramFloatingBubble
        model={testModel}
        selection={{ kind: "edge", id: "e1" }}
        actions={actions}
        containerRef={containerRef}
      />
    );

    const bubble = await screen.findByTestId("diagram-floating-bubble");
    // x = 200 + 30 = 230, y = 150 - 18 = 132
    expect(bubble.style.left).toBe("230px");
    expect(bubble.style.top).toBe("132px");

    document.body.removeChild(containerEl);
  });

  it("positions bubble at path bounding midpoint (not top corner) when edge label is empty", async () => {
    const containerEl = document.createElement("div");
    const edgeEl = document.createElement("div");
    edgeEl.className = "react-flow__edge";
    edgeEl.setAttribute("data-id", "e1");
    const pathEl = document.createElementNS("http://www.w3.org/2000/svg", "path");
    pathEl.setAttribute("class", "react-flow__edge-path");
    // Diagonal edge from (100, 100) to (500, 500)
    vi.spyOn(pathEl, "getBoundingClientRect").mockReturnValue({
      left: 100, top: 100, width: 400, height: 400, right: 500, bottom: 500, x: 100, y: 100, toJSON: () => {},
    });
    vi.spyOn(containerEl, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => {},
    });
    edgeEl.appendChild(pathEl);
    containerEl.appendChild(edgeEl);
    document.body.appendChild(containerEl);

    const containerRef = { current: containerEl };
    const actions = createMockActions();

    render(
      <DiagramFloatingBubble
        model={testModel}
        selection={{ kind: "edge", id: "e1" }}
        actions={actions}
        containerRef={containerRef}
      />
    );

    const bubble = await screen.findByTestId("diagram-floating-bubble");
    // midX = (100+500)/2 = 300, midY = (100+500)/2 = 300
    // y = 300 - 18 = 282px (NOT 100 - 18 = 82px!)
    expect(bubble.style.left).toBe("300px");
    expect(bubble.style.top).toBe("282px");

    document.body.removeChild(containerEl);
  });

  it("allows selecting edge tone and invokes actions.setEdgeTone", async () => {
    const containerEl = document.createElement("div");
    const labelEl = document.createElement("div");
    labelEl.className = "diagram-flow-edge-label";
    labelEl.setAttribute("data-edge-id", "e1");
    vi.spyOn(labelEl, "getBoundingClientRect").mockReturnValue({
      left: 200, top: 150, width: 60, height: 20, right: 260, bottom: 170, x: 200, y: 150, toJSON: () => {},
    });
    vi.spyOn(containerEl, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => {},
    });
    containerEl.appendChild(labelEl);
    document.body.appendChild(containerEl);

    const containerRef = { current: containerEl };
    const actions = createMockActions();

    render(
      <DiagramFloatingBubble
        model={testModel}
        selection={{ kind: "edge", id: "e1" }}
        actions={actions}
        containerRef={containerRef}
      />
    );

    await screen.findByTestId("diagram-floating-bubble");
    const toneBtn = screen.getByTitle(t("editor.diagram_tone"));
    await act(async () => {
      fireEvent.click(toneBtn);
    });

    const accentOption = await screen.findByText(t("editor.diagram_tone_accent"));
    await act(async () => {
      fireEvent.click(accentOption);
    });

    expect(actions.setEdgeTone).toHaveBeenCalledWith("e1", "accent");

    document.body.removeChild(containerEl);
  });
});
