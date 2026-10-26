import { describe, expect, it, vi } from "vitest";
import { useFlowKeybindings } from "./useFlowKeybindings";
import type { DiagramModel } from "./diagramModel";
import type { DiagramActions } from "./diagramActions";

const testModel: DiagramModel = {
  v: 1,
  route: "curve",
  states: [],
  direction: "TB",
  nodes: [
    { id: "root", label: "루트", pos: [100, 100] },
    { id: "child1", label: "자식1", pos: [100, 200] },
  ],
  edges: [
    { id: "e1", from: "root", to: "child1" },
  ],
  groups: [],
  empty: false,
  structured: true,
};

function createMockActions(): DiagramActions {
  return {
    shape: "rect",
    style: "solid",
    setShapeDefault: vi.fn(),
    setStyleDefault: vi.fn(),
    addNode: vi.fn(() => "new-node-id"),
    addConnected: vi.fn(() => "new-child-id"),
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
    setNodeMark: vi.fn(),
    setNodesMark: vi.fn(),
    nodeTone: vi.fn(() => "default" as const),
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

describe("useFlowKeybindings", () => {
  it("creates and connects downstream node on Tab key press", () => {
    const actions = createMockActions();
    const openRename = vi.fn();
    const handleKey = vi.fn();

    const { onKeyDown } = useFlowKeybindings({
      model: testModel,
      selection: { kind: "node", id: "root" },
      actions,
      openRename,
      handleKey,
    });

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const event = {
      key: "Tab",
      target: document.createElement("div"),
      preventDefault,
      stopPropagation,
    } as unknown as React.KeyboardEvent<HTMLDivElement>;

    onKeyDown(event);

    expect(preventDefault).toHaveBeenCalled();
    expect(actions.addConnected).toHaveBeenCalledWith("root", "새 노드", expect.objectContaining({ y: 200 }));
    expect(openRename).toHaveBeenCalledWith("new-child-id", "새 노드");
    expect(handleKey).not.toHaveBeenCalled();
  });

  it("creates sibling node on Enter key press when parent edge exists", () => {
    const actions = createMockActions();
    const openRename = vi.fn();
    const handleKey = vi.fn();

    const { onKeyDown } = useFlowKeybindings({
      model: testModel,
      selection: { kind: "node", id: "child1" },
      actions,
      openRename,
      handleKey,
    });

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const event = {
      key: "Enter",
      target: document.createElement("div"),
      preventDefault,
      stopPropagation,
    } as unknown as React.KeyboardEvent<HTMLDivElement>;

    onKeyDown(event);

    expect(preventDefault).toHaveBeenCalled();
    // child1의 부모는 root이므로 root에서 연결된 새 노드 생성
    expect(actions.addConnected).toHaveBeenCalledWith("root", "새 노드", expect.anything());
    expect(openRename).toHaveBeenCalledWith("new-child-id", "새 노드");
  });

  it("delegates to handleKey for regular keys or when inside input", () => {
    const actions = createMockActions();
    const handleKey = vi.fn();

    const { onKeyDown } = useFlowKeybindings({
      model: testModel,
      selection: { kind: "node", id: "root" },
      actions,
      handleKey,
    });

    // Delete key
    const deleteEvent = {
      key: "Delete",
      target: document.createElement("div"),
    } as unknown as React.KeyboardEvent<HTMLDivElement>;

    onKeyDown(deleteEvent);
    expect(handleKey).toHaveBeenCalledWith(deleteEvent);

    // Typing inside input should be ignored
    handleKey.mockClear();
    const inputEl = document.createElement("input");
    const inputEvent = {
      key: "Tab",
      target: inputEl,
    } as unknown as React.KeyboardEvent<HTMLDivElement>;

    onKeyDown(inputEvent);
    expect(handleKey).not.toHaveBeenCalled();
    expect(actions.addConnected).not.toHaveBeenCalled();
  });

  it("groups selected nodes on Ctrl+G key press", () => {
    const actions = createMockActions();
    const handleKey = vi.fn();

    const { onKeyDown } = useFlowKeybindings({
      model: testModel,
      selectedBoxIds: ["root", "child1"],
      actions,
      handleKey,
    });

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const event = {
      key: "g",
      ctrlKey: true,
      shiftKey: false,
      target: document.createElement("div"),
      preventDefault,
      stopPropagation,
    } as unknown as React.KeyboardEvent<HTMLDivElement>;

    onKeyDown(event);

    expect(preventDefault).toHaveBeenCalled();
    expect(actions.addGroup).toHaveBeenCalledWith("새 그룹", ["root", "child1"]);
  });

  it("dissolves group on Ctrl+Shift+G key press when group is selected", () => {
    const actions = createMockActions();
    const handleKey = vi.fn();

    const { onKeyDown } = useFlowKeybindings({
      model: testModel,
      selection: { kind: "group", id: "g1" },
      actions,
      handleKey,
    });

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const event = {
      key: "G",
      ctrlKey: true,
      shiftKey: true,
      target: document.createElement("div"),
      preventDefault,
      stopPropagation,
    } as unknown as React.KeyboardEvent<HTMLDivElement>;

    onKeyDown(event);

    expect(preventDefault).toHaveBeenCalled();
    expect(actions.dissolveGroup).toHaveBeenCalledWith("g1");
  });

  it("calls fitView on Shift+1 key press", () => {
    const actions = createMockActions();
    const handleKey = vi.fn();
    const fitView = vi.fn();

    const { onKeyDown } = useFlowKeybindings({
      model: testModel,
      actions,
      handleKey,
      fitView,
    });

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const event = {
      key: "1",
      shiftKey: true,
      target: document.createElement("div"),
      preventDefault,
      stopPropagation,
    } as unknown as React.KeyboardEvent<HTMLDivElement>;

    onKeyDown(event);

    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
    expect(fitView).toHaveBeenCalledTimes(1);
    expect(handleKey).not.toHaveBeenCalled();
  });

  it("calls zoomToSelection on Shift+2 key press", () => {
    const actions = createMockActions();
    const handleKey = vi.fn();
    const zoomToSelection = vi.fn();

    const { onKeyDown } = useFlowKeybindings({
      model: testModel,
      selection: { kind: "node", id: "root" },
      actions,
      handleKey,
      zoomToSelection,
    });

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const event = {
      key: "2",
      shiftKey: true,
      target: document.createElement("div"),
      preventDefault,
      stopPropagation,
    } as unknown as React.KeyboardEvent<HTMLDivElement>;

    onKeyDown(event);

    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
    expect(zoomToSelection).toHaveBeenCalledTimes(1);
    expect(handleKey).not.toHaveBeenCalled();
  });

  it("groups selected nodes on F key press", () => {
    const actions = createMockActions();
    const handleKey = vi.fn();

    const { onKeyDown } = useFlowKeybindings({
      model: testModel,
      selection: { kind: "node", id: "root" },
      actions,
      handleKey,
    });

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const event = {
      key: "f",
      target: document.createElement("div"),
      preventDefault,
      stopPropagation,
    } as unknown as React.KeyboardEvent<HTMLDivElement>;

    onKeyDown(event);

    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
    expect(actions.addGroup).toHaveBeenCalledWith("새 단계", ["root"]);
  });
});
