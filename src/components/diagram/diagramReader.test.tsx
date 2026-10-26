import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useRef, useState } from "react";
import { FlowCanvas } from "./FlowCanvas";
import { DiagramToolbar } from "./DiagramToolbar";
import type { DiagramCanvasApi } from "./diagramCanvasApi";
import { parseDiagram } from "./diagramModel";
import type { DiagramActions, Selection } from "./diagramActions";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

vi.mock("../../lib/noteSummaries", () => ({
  fetchNoteSummariesMap: vi.fn(async () => ({})),
}));

// Graph with 4 nodes:
// n1(state 0: 예약완료) -> n2(state 1: 미정) -> n3(state 2: 취소)
// n4(state 0: 예약완료) -> n2
const READER_TEST_GRAPH = JSON.stringify({
  v: 1,
  states: ["예약완료", "미정", "취소"],
  nodes: [
    { id: "n1", label: "인천공항", state: 0, tag: "D-3" },
    { id: "n2", label: "호텔체크인", state: 1, desc: "오후 3시" },
    { id: "n3", label: "저녁식당", state: 2 },
    { id: "n4", label: "환전소", state: 0, desc: "공항 내" },
  ],
  edges: [
    { id: "e1", from: "n1", to: "n2" },
    { id: "e2", from: "n2", to: "n3" },
    { id: "e3", from: "n4", to: "n2" },
  ],
});

function createSpyActions(): { actions: DiagramActions; writeCalls: () => number } {
  let writeCount = 0;
  const spyHandler = {
    get: (target: any, prop: string | symbol) => {
      if (prop === "nodeTone") return () => "default";
      if (prop === "shape") return "rect";
      if (prop === "style") return "solid";
      if (!target[prop]) {
        target[prop] = vi.fn((..._args: any[]) => {
          writeCount++;
        });
      }
      return target[prop];
    },
  };
  const actions = new Proxy({} as DiagramActions, spyHandler);
  return { actions, writeCalls: () => writeCount };
}

function TestReaderCanvas({
  source = READER_TEST_GRAPH,
  onApi,
  onFocusNode,
  actions,
}: {
  source?: string;
  onApi?: (api: DiagramCanvasApi) => void;
  onFocusNode?: (id: string) => void;
  actions: DiagramActions;
}) {
  const model = parseDiagram(source);
  const [selection, setSelection] = useState<Selection>(null);
  const realApiRef = useRef<DiagramCanvasApi | null>(null);

  return (
    <div>
      <DiagramToolbar
        model={model}
        useFlow={true}
        selection={selection}
        selectedBoxIds={[]}
        actions={actions}
        apiRef={realApiRef}
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
        apiRef={{
          get current() {
            return realApiRef.current;
          },
          set current(val) {
            if (val) {
              const origFocus = val.focusNode;
              val.focusNode = (id: string) => {
                onFocusNode?.(id);
                origFocus?.(id);
              };
            }
            realApiRef.current = val;
            if (val && onApi) onApi(val);
          },
        }}
      />
    </div>
  );
}

describe("W2: Reader features (Filter, Reach, Finder, Single Dimming Owner)", () => {
  it("initial rendering: nothing is dimmed (dimmedIds is null)", () => {
    const { actions } = createSpyActions();
    const { container } = render(<TestReaderCanvas actions={actions} />);

    // None of the nodes should have data-dimmed="true"
    const dimmedNodes = container.querySelectorAll('.diagram-flow-node[data-dimmed="true"]');
    expect(dimmedNodes.length).toBe(0);
  });

  describe("1. Filter (Legend Chips)", () => {
    it("clicking a legend chip dims nodes not in that state and non-connecting edges", () => {
      const { actions, writeCalls } = createSpyActions();
      const { container } = render(<TestReaderCanvas actions={actions} />);

      // Click legend chip for slot 0 ("예약완료" -> n1, n4)
      const chip0 = screen.getByTestId("diagram-legend-chip-0");
      act(() => {
        fireEvent.click(chip0);
      });

      expect(chip0.getAttribute("data-active")).toBe("true");

      // n2 (state 1) and n3 (state 2) should be dimmed
      const dimmedNodes = container.querySelectorAll('.diagram-flow-node[data-dimmed="true"]');
      expect(dimmedNodes.length).toBe(2);

      // Verify zero saves happened
      expect(writeCalls()).toBe(0);
    });

    it("toggling legend chip off clears dimming back to null", () => {
      const { actions } = createSpyActions();
      const { container } = render(<TestReaderCanvas actions={actions} />);

      const chip0 = screen.getByTestId("diagram-legend-chip-0");
      // Turn on
      act(() => {
        fireEvent.click(chip0);
      });
      expect(container.querySelectorAll('.diagram-flow-node[data-dimmed="true"]').length).toBe(2);

      // Turn off (re-click)
      act(() => {
        fireEvent.click(chip0);
      });
      expect(chip0.getAttribute("data-active")).toBeNull();
      expect(container.querySelectorAll('.diagram-flow-node[data-dimmed="true"]').length).toBe(0);
    });

    it("supports multi-selection of states by clicking multiple chips", () => {
      const { actions } = createSpyActions();
      const { container } = render(<TestReaderCanvas actions={actions} />);

      const chip0 = screen.getByTestId("diagram-legend-chip-0"); // n1, n4
      const chip1 = screen.getByTestId("diagram-legend-chip-1"); // n2

      act(() => {
        fireEvent.click(chip0);
      });
      act(() => {
        fireEvent.click(chip1);
      });

      // Both chip 0 and chip 1 are active
      expect(chip0.getAttribute("data-active")).toBe("true");
      expect(chip1.getAttribute("data-active")).toBe("true");

      // Only n3 (state 2) should be dimmed
      const dimmedNodes = container.querySelectorAll('.diagram-flow-node[data-dimmed="true"]');
      expect(dimmedNodes.length).toBe(1);
    });
  });

  describe("2. Reach (Path probing)", () => {
    it("activates upstream reach and dims nodes outside upstream reach", () => {
      let api: DiagramCanvasApi | null = null;
      const { actions, writeCalls } = createSpyActions();
      const { container } = render(<TestReaderCanvas actions={actions} onApi={(a) => (api = a)} />);

      // Engage reach for n2 upstream: n1 -> n2, n4 -> n2. Upstream reach is {n1, n4}.
      // All active nodes: n2 (start) + n1, n4. n3 is outside reach!
      act(() => {
        api?.reach?.("n2", "upstream");
      });

      // Reach banner should be visible
      expect(screen.getByTestId("diagram-reach-bar")).toBeDefined();

      // n3 should be dimmed, n1, n2, n4 should NOT be dimmed
      const dimmedNodes = container.querySelectorAll('.diagram-flow-node[data-dimmed="true"]');
      expect(dimmedNodes.length).toBe(1);

      // Check banner active button
      expect(screen.getByTestId("diagram-reach-btn-upstream").getAttribute("data-active")).toBe("true");

      // Zero saves
      expect(writeCalls()).toBe(0);
    });

    it("switching reach direction to downstream updates dimming immediately", () => {
      let api: DiagramCanvasApi | null = null;
      const { actions } = createSpyActions();
      const { container } = render(<TestReaderCanvas actions={actions} onApi={(a) => (api = a)} />);

      act(() => {
        api?.reach?.("n2", "upstream");
      });

      // Switch direction to downstream via banner button
      const downstreamBtn = screen.getByTestId("diagram-reach-btn-downstream");
      act(() => {
        fireEvent.click(downstreamBtn);
      });

      expect(downstreamBtn.getAttribute("data-active")).toBe("true");

      // For n2 downstream, only n3 is reached. Active nodes: {n2, n3}.
      // n1 and n4 should be dimmed!
      const dimmedNodes = container.querySelectorAll('.diagram-flow-node[data-dimmed="true"]');
      expect(dimmedNodes.length).toBe(2);
    });

    it("closing reach banner restores normal rendering", () => {
      let api: DiagramCanvasApi | null = null;
      const { actions } = createSpyActions();
      const { container } = render(<TestReaderCanvas actions={actions} onApi={(a) => (api = a)} />);

      act(() => {
        api?.reach?.("n2", "upstream");
      });
      expect(screen.getByTestId("diagram-reach-bar")).toBeDefined();

      act(() => {
        fireEvent.click(screen.getByTestId("diagram-reach-close"));
      });

      expect(screen.queryByTestId("diagram-reach-bar")).toBeNull();
      expect(container.querySelectorAll('.diagram-flow-node[data-dimmed="true"]').length).toBe(0);
    });
  });

  describe("3. Finder (In-canvas search)", () => {
    it("opens finder on '/' keypress when canvas is focused", () => {
      const { actions } = createSpyActions();
      render(<TestReaderCanvas actions={actions} />);

      const flow = screen.getByTestId("diagram-flow");
      act(() => {
        fireEvent.keyDown(flow, { key: "/" });
      });

      expect(screen.getByTestId("diagram-finder")).toBeDefined();
      expect(screen.getByTestId("diagram-finder-input")).toBeDefined();
    });

    it("matches label, tag, desc and dims non-matching nodes", () => {
      const { actions, writeCalls } = createSpyActions();
      const { container } = render(<TestReaderCanvas actions={actions} />);

      const flow = screen.getByTestId("diagram-flow");
      act(() => {
        fireEvent.keyDown(flow, { key: "/" });
      });

      const input = screen.getByTestId("diagram-finder-input");

      // Search by desc ("공항 내" -> matches n4, and label "인천공항" -> matches n1)
      act(() => {
        fireEvent.change(input, { target: { value: "공항" } });
      });

      // Matches n1 ("인천공항") and n4 (desc "공항 내").
      // n2 and n3 should be dimmed!
      const dimmedNodes = container.querySelectorAll('.diagram-flow-node[data-dimmed="true"]');
      expect(dimmedNodes.length).toBe(2);

      // Search by tag ("D-3" -> matches n1 only)
      act(() => {
        fireEvent.change(input, { target: { value: "D-3" } });
      });
      expect(container.querySelectorAll('.diagram-flow-node[data-dimmed="true"]').length).toBe(3);

      expect(writeCalls()).toBe(0);
    });

    it("navigates results with keyboard and focuses node on Enter", () => {
      const { actions } = createSpyActions();
      const focusSpy = vi.fn();
      render(<TestReaderCanvas actions={actions} onFocusNode={focusSpy} />);

      const flow = screen.getByTestId("diagram-flow");
      act(() => {
        fireEvent.keyDown(flow, { key: "/" });
      });

      const input = screen.getByTestId("diagram-finder-input");
      act(() => {
        fireEvent.change(input, { target: { value: "공항" } });
      });

      // Press ArrowDown to navigate to second result, then Enter
      act(() => {
        fireEvent.keyDown(input, { key: "ArrowDown" });
      });
      act(() => {
        fireEvent.keyDown(input, { key: "Enter" });
      });

      expect(focusSpy).toHaveBeenCalledWith("n4");
      // Finder should be closed after commit
      expect(screen.queryByTestId("diagram-finder")).toBeNull();
    });

    it("closes finder on Escape key", () => {
      const { actions } = createSpyActions();
      render(<TestReaderCanvas actions={actions} />);

      const flow = screen.getByTestId("diagram-flow");
      act(() => {
        fireEvent.keyDown(flow, { key: "/" });
      });
      expect(screen.getByTestId("diagram-finder")).toBeDefined();

      const input = screen.getByTestId("diagram-finder-input");
      act(() => {
        fireEvent.keyDown(input, { key: "Escape" });
      });

      expect(screen.queryByTestId("diagram-finder")).toBeNull();
    });
  });

  describe("4. Single Dimming Owner & Esc dismissal", () => {
    it("switching between Filter, Reach, and Finder overrides previous mode cleanly", () => {
      let api: DiagramCanvasApi | null = null;
      const { actions } = createSpyActions();
      const { container } = render(<TestReaderCanvas actions={actions} onApi={(a) => (api = a)} />);

      // 1. Turn on Filter (chip 0)
      const chip0 = screen.getByTestId("diagram-legend-chip-0");
      act(() => {
        fireEvent.click(chip0);
      });
      expect(chip0.getAttribute("data-active")).toBe("true");
      expect(container.querySelectorAll('.diagram-flow-node[data-dimmed="true"]').length).toBe(2);

      // 2. Turn on Reach: Reach becomes the new single owner, Filter is disengaged!
      act(() => {
        api?.reach?.("n2", "downstream");
      });
      expect(chip0.getAttribute("data-active")).toBeNull(); // Filter chip deselected
      expect(screen.getByTestId("diagram-reach-bar")).toBeDefined();

      // 3. Open Finder: Finder becomes the new single owner, Reach is disengaged!
      const flow = screen.getByTestId("diagram-flow");
      act(() => {
        fireEvent.keyDown(flow, { key: "/" });
      });
      expect(screen.queryByTestId("diagram-reach-bar")).toBeNull(); // Reach banner closed
      expect(screen.getByTestId("diagram-finder")).toBeDefined();
    });

    it("single Escape key clears any active reader mode and all dimming immediately", () => {
      let api: DiagramCanvasApi | null = null;
      const { actions } = createSpyActions();
      const { container } = render(<TestReaderCanvas actions={actions} onApi={(a) => (api = a)} />);

      // Activate Reach
      act(() => {
        api?.reach?.("n2", "upstream");
      });
      expect(container.querySelectorAll('.diagram-flow-node[data-dimmed="true"]').length).toBe(1);

      // Hit Escape on canvas
      const flow = screen.getByTestId("diagram-flow");
      act(() => {
        fireEvent.keyDown(flow, { key: "Escape" });
      });

      // Everything cleared
      expect(screen.queryByTestId("diagram-reach-bar")).toBeNull();
      expect(container.querySelectorAll('.diagram-flow-node[data-dimmed="true"]').length).toBe(0);
    });

    it("zero body_md writes occur during any W2 reader interactions", () => {
      let api: DiagramCanvasApi | null = null;
      const { actions, writeCalls } = createSpyActions();
      render(<TestReaderCanvas actions={actions} onApi={(a) => (api = a)} />);

      const chip0 = screen.getByTestId("diagram-legend-chip-0");
      act(() => {
        fireEvent.click(chip0);
      });
      act(() => {
        api?.reach?.("n2", "both");
      });
      const flow = screen.getByTestId("diagram-flow");
      act(() => {
        fireEvent.keyDown(flow, { key: "/" });
      });
      const input = screen.getByTestId("diagram-finder-input");
      act(() => {
        fireEvent.change(input, { target: { value: "호텔" } });
      });
      act(() => {
        fireEvent.keyDown(input, { key: "Escape" });
      });

      expect(writeCalls()).toBe(0);
    });
  });
});
