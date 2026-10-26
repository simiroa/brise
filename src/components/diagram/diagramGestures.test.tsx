import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useDiagramGestures } from "./diagramGestures";
import { parseDiagram } from "./diagramModel";
import type { DiagramActions, Selection } from "./diagramActions";

/**
 * The rules a diagram canvas must agree with itself on, tested ONCE — which is the whole point of
 * the file under test.
 *
 * Until 2026-08-12 the node-click precedence and the Delete/Ctrl+Z keys were written out in both
 * DiagramCanvas (mermaid SVG) and FlowCanvas (React Flow), and only FlowCanvas's copy had a test
 * (its 자기루프 block). The two had already drifted: Delete removed a selected EDGE on the flow
 * canvas and did nothing on the mermaid one. Asserting the rules against the hook covered both
 * renderers without dragging jsdom through React Flow's geometry or mermaid's SVG.
 *
 * DiagramCanvas was deleted in the 2026-09-04 JSON IR rebuild (commit 88195857), so today FlowCanvas
 * is the hook's only consumer — but the hook (and this test) stay in place as the single source of
 * truth the next renderer, if one ever exists, would share instead of re-drifting.
 */
const SRC = JSON.stringify(
  {
    v: 1,
    nodes: [
      { id: "n1", label: "김철수", link: "note-abc" },
      { id: "n2", label: "김영수" },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", line: "solid", arrow: "end" },
    ],
  },
  null,
  2,
);

function stubActions() {
  return {
    connect: vi.fn(),
    openNote: vi.fn(),
    deleteNode: vi.fn(),
    deleteEdge: vi.fn(),
  } as unknown as DiagramActions & {
    connect: ReturnType<typeof vi.fn>;
    openNote: ReturnType<typeof vi.fn>;
    deleteNode: ReturnType<typeof vi.fn>;
    deleteEdge: ReturnType<typeof vi.fn>;
  };
}

function mount(opts: {
  actions: ReturnType<typeof stubActions>;
  selection?: Selection;
  onSelect?: (s: Selection) => void;
  onUndo?: () => void;
  onRedo?: () => void;
}) {
  const handled: boolean[] = [];
  function Probe() {
    const g = useDiagramGestures({
      model: parseDiagram(SRC),
      selection: opts.selection ?? null,
      onSelect: opts.onSelect ?? vi.fn(),
      actions: opts.actions,
      onUndo: opts.onUndo ?? vi.fn(),
      onRedo: opts.onRedo ?? vi.fn(),
    });
    return (
      <div data-testid="host" onKeyDown={(e) => handled.push(g.handleKey(e))}>
        <button type="button" data-testid="click-n1" onClick={() => g.clickNode("n1")} />
        <button type="button" data-testid="clear" onClick={g.clear} />
        <span data-testid="resolved">{`${g.selectedNode?.label ?? "-"}/${g.selectedEdge?.to ?? "-"}`}</span>
      </div>
    );
  }
  // Scoped to THIS render's container — one test mounts the probe twice (node selection, then
  // edge), and RTL's own queries are bound to document.body, which would then find both.
  const view = render(<Probe />);
  return { handled, host: () => view.container.querySelector("[data-testid='host']") as HTMLElement };
}

describe("useDiagramGestures — 클릭 우선순위", () => {
  it("a second click on an already-selected linked node opens its note", () => {
    const actions = stubActions();
    const onSelect = vi.fn();
    mount({ actions, selection: { kind: "node", id: "n1" }, onSelect });
    fireEvent.click(screen.getByTestId("click-n1"));
    expect(actions.openNote).toHaveBeenCalledWith("note-abc");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("a plain click on an unselected box selects it — a node click never connects anything", () => {
    // 여기서 연결 / [+ 관계] arming left the canvas on 2026-10-19 (GRILL R6): connecting is the
    // border-handle drag (desktop) or the 관계 추가 form (phone), never a click.
    const actions = stubActions();
    const onSelect = vi.fn();
    mount({ actions, onSelect });
    fireEvent.click(screen.getByTestId("click-n1"));
    expect(onSelect).toHaveBeenCalledWith({ kind: "node", id: "n1" });
    expect(actions.connect).not.toHaveBeenCalled();
    expect(actions.openNote).not.toHaveBeenCalled();
  });

  it("clear() drops the selection", () => {
    const actions = stubActions();
    const onSelect = vi.fn();
    mount({ actions, selection: { kind: "node", id: "n1" }, onSelect });
    fireEvent.click(screen.getByTestId("clear"));
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});

describe("useDiagramGestures — 키보드", () => {
  it("Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y are 되돌리기·앞으로 on both canvases", () => {
    const onUndo = vi.fn();
    const onRedo = vi.fn();
    const { host } = mount({ actions: stubActions(), onUndo, onRedo });
    fireEvent.keyDown(host(), { key: "z", ctrlKey: true });
    fireEvent.keyDown(host(), { key: "Z", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(host(), { key: "y", ctrlKey: true });
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(onRedo).toHaveBeenCalledTimes(2);
  });

  it("Delete removes the selected node OR the selected edge — the drift the two canvases had", () => {
    const nodeActions = stubActions();
    const onNode = mount({ actions: nodeActions, selection: { kind: "node", id: "n1" } });
    fireEvent.keyDown(onNode.host(), { key: "Delete" });
    expect(nodeActions.deleteNode).toHaveBeenCalledWith("n1");

    const edgeActions = stubActions();
    const edge = parseDiagram(SRC).edges[0];
    const { host } = mount({ actions: edgeActions, selection: { kind: "edge", id: edge.id } });
    fireEvent.keyDown(host(), { key: "Backspace" });
    expect(edgeActions.deleteEdge).toHaveBeenCalledWith(edge.id);
  });

  it("reports a plain unclaimed key as NOT handled, so a canvas keeps its own verbs (Tab/F2)", () => {
    const { handled, host } = mount({ actions: stubActions(), selection: { kind: "node", id: "n1" } });
    fireEvent.keyDown(host(), { key: "Tab" });
    fireEvent.keyDown(host(), { key: "F2" });
    fireEvent.keyDown(host(), { key: "Delete" });
    expect(handled).toEqual([false, false, true]);
  });
});
