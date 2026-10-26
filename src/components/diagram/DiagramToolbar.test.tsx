import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DiagramToolbar, type DiagramToolbarProps } from "./DiagramToolbar";
import { parseDiagram, type DiagramModel } from "./diagramModel";
import type { DiagramActions } from "./diagramActions";
import { t } from "../../i18n/t";

const baseModel: DiagramModel = parseDiagram(
  JSON.stringify({
    version: 1,
    nodes: [
      { id: "A", label: "Alpha" },
      { id: "B", label: "Beta" },
    ],
    edges: [{ id: "e1", from: "A", to: "B" }],
  })
);

const mockActions: DiagramActions = {
  shape: "rect",
  style: "solid",
  setShapeDefault: vi.fn(),
  setStyleDefault: vi.fn(),
  addNode: vi.fn(),
  connect: vi.fn(),
  connectBatch: vi.fn(),
  createChild: vi.fn(),
  addConnected: vi.fn(),
  expandChildren: vi.fn(() => []),
  reparent: vi.fn(),
  retarget: vi.fn(),
  setNodeShape: vi.fn(),
  setNodeMeta: vi.fn(),
  setNodePos: vi.fn(),
  setNodePositions: vi.fn(),
  addGroup: vi.fn(),
  renameGroup: vi.fn(),
  setGroupTone: vi.fn(),
  groupTone: vi.fn(() => "default" as const),
  dissolveGroup: vi.fn(),
  setEdgeStyle: vi.fn(),
  setEdgeLine: vi.fn(),
  setEdgeArrow: vi.fn(),
  setEdgeTone: vi.fn(),
  edgeTone: vi.fn(() => "default" as const),
  setRoute: vi.fn(),
  rename: vi.fn(),
  setEdgeLabel: vi.fn(),
  deleteNode: vi.fn(),
  deleteEdge: vi.fn(),
  setDirection: vi.fn(),
  setLayout: vi.fn(),
  setNodeTone: vi.fn(),
  setNodeMark: vi.fn(),
  setNodesMark: vi.fn(),
  nodeTone: vi.fn(() => "default" as const),
  setNodeState: vi.fn(),
  setNodeFlag: vi.fn(),
  toggleNodeFlag: vi.fn(),
  setNodeTag: vi.fn(),
  setNodeRows: vi.fn(),
  setStates: vi.fn(),
  pickNote: vi.fn(),
  unlinkNote: vi.fn(),
  openNote: vi.fn(),
  addFromText: vi.fn(() => ({ ok: true })),
};

function setup(props?: Partial<DiagramToolbarProps>) {
  const defaults: DiagramToolbarProps = {
    model: baseModel,
    useFlow: true,
    selection: null,
    selectedBoxIds: [],
    actions: mockActions,
    canUndo: true,
    onUndo: vi.fn(),
    canRedo: false,
    onRedo: vi.fn(),
    onEditSource: vi.fn(),
    zoom: 1,
    pngBusy: false,
  };
  return render(<DiagramToolbar {...defaults} {...props} />);
}

describe("DiagramToolbar", () => {
  it("renders 3-zone layout with leading, contextual, and trailing tools", () => {
    setup();

    // Leading tools
    expect(screen.getByTestId("diagram-add-node-toggle")).toBeTruthy();
    expect(screen.getByTestId("diagram-lock-toggle")).toBeTruthy();
    expect(screen.getByTestId("diagram-undo")).toBeTruthy();
    expect(screen.getByTestId("diagram-redo")).toBeTruthy();
    expect(screen.getByTestId("diagram-search-trigger")).toBeTruthy();
    expect(screen.getByTestId("diagram-auto-layout")).toBeTruthy();

    // Trailing tools
    expect(screen.getByTestId("diagram-export-png")).toBeTruthy();
    expect(screen.getByTestId("diagram-export-png-attach")).toBeTruthy();
    expect(screen.getByTestId("diagram-edit-source")).toBeTruthy();

    // Button class standardization and tooltips
    const addNodeBtn = screen.getByTestId("diagram-add-node-toggle");
    expect(addNodeBtn.className).toContain("toolbar-btn");
    expect(addNodeBtn.getAttribute("title")).toBe(t("editor.diagram_add_node_tooltip"));

    const lockBtn = screen.getByTestId("diagram-lock-toggle");
    expect(lockBtn.getAttribute("title")).toBe(t("editor.diagram_lock"));
  });

  it("handles multi-selection contextual tools", () => {
    setup({ selectedBoxIds: ["A", "B"] });

    expect(screen.getByTestId("diagram-align-tools")).toBeTruthy();
    expect(screen.getByTestId("diagram-multi-count")).toBeTruthy();
    expect(screen.getByTestId("diagram-group-create")).toBeTruthy();
    expect(screen.getByTestId("diagram-align-left")).toBeTruthy();
    expect(screen.getByTestId("diagram-align-center-x")).toBeTruthy();
    expect(screen.getByTestId("diagram-distribute-y")).toBeTruthy();
  });

  it("handles single node, edge, and group selection contextual slot with subject chip only (no VerbButtons)", () => {
    // Single node selection
    const { rerender } = setup({ selection: { kind: "node", id: "A" } });
    const subjectChip = screen.getByTestId("diagram-subject-chip");
    expect(subjectChip).toBeTruthy();
    expect(subjectChip.textContent).toBe("Alpha");
    // Verb buttons should NOT be in the toolbar
    expect(screen.queryByTestId("diagram-verb-rename")).toBeNull();
    expect(screen.queryByTestId("diagram-verb-delete")).toBeNull();

    // Edge selection
    rerender(
      <DiagramToolbar
        model={baseModel}
        useFlow={true}
        selection={{ kind: "edge", id: "e1" }}
        selectedBoxIds={[]}
        actions={mockActions}
        canUndo={true}
        onUndo={vi.fn()}
        canRedo={false}
        onRedo={vi.fn()}
        onEditSource={vi.fn()}
        zoom={1}
        pngBusy={false}
      />
    );
    const edgeChip = screen.getByTestId("diagram-subject-chip");
    expect(edgeChip.textContent).toBe("Alpha → Beta");
    expect(screen.queryByTestId("diagram-verb-relabel")).toBeNull();
  });

  it("triggers lock toggle on lock button click", () => {
    const onToggleLock = vi.fn();
    setup({ onToggleLock });

    fireEvent.click(screen.getByTestId("diagram-lock-toggle"));
    expect(onToggleLock).toHaveBeenCalled();
  });

  // 2026-09-26: AI 진입점은 노트 제목 줄(☆ 옆) 한 곳 — AI 가 켜져 있어도 섹션 툴바엔 두지 않는다.
  it("does not render an AI entry in the toolbar even when AI is available (it lives in the title row)", async () => {
    const { useSettingsStore } = await import("../../stores/settings");
    const { useAiStore } = await import("../../stores/ai");
    useSettingsStore.setState({ aiEnabled: true } as never);
    useAiStore.setState({ aiReachable: true } as never);

    setup();
    expect(screen.queryByTestId("ai-actions-menu")).toBeNull();
  });

  it("renders extract todos button and copies checklist on click", async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText: writeTextMock },
    });

    setup();
    const extractBtn = screen.getByTestId("diagram-toolbar-extract-todos");
    expect(extractBtn).toBeTruthy();

    fireEvent.click(extractBtn);
    await vi.waitFor(() => {
      expect(writeTextMock).toHaveBeenCalled();
    });
  });

  it("renders toggle legend button when states exist and calls api.toggleLegend", () => {
    const toggleLegend = vi.fn();
    const modelWithStates: DiagramModel = {
      ...baseModel,
      states: ["시작", "완료"],
    };
    const api = {
      toggleLegend,
    } as unknown as any;

    setup({ model: modelWithStates, api });
    const legendBtn = screen.getByTestId("diagram-toggle-legend");
    expect(legendBtn).toBeTruthy();

    fireEvent.click(legendBtn);
    expect(toggleLegend).toHaveBeenCalledTimes(1);
  });

  it("renders node search button and triggers openFinder on click", () => {
    const onOpenFinder = vi.fn();
    setup({ onOpenFinder });
    const searchBtn = screen.getByTestId("diagram-search-trigger");
    expect(searchBtn).toBeTruthy();

    fireEvent.click(searchBtn);
    expect(onOpenFinder).toHaveBeenCalledTimes(1);
  });

  it("텍스트로 추가 — 캔버스 동사가 인라인 폼을 열고, 확정하면 actions.addFromText 를 호출하고 닫힌다", () => {
    const addFromText = vi.fn(() => ({ ok: true }));
    setup({ actions: { ...mockActions, addFromText } });

    fireEvent.click(screen.getByTestId("diagram-add-text"));
    expect(screen.getByTestId("diagram-text-form")).toBeTruthy();

    fireEvent.change(screen.getByTestId("diagram-text-input"), { target: { value: "A -> B" } });
    fireEvent.click(screen.getByTestId("diagram-text-apply"));

    expect(addFromText).toHaveBeenCalledWith("A -> B");
    expect(screen.queryByTestId("diagram-text-form")).toBeNull();
  });
});
