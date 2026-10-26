import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

beforeAll(() => {
  // React Flow throws on mount without one; jsdom has no ResizeObserver at all.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

// DiagramSection reads content_locked via useNotesStore(selector) (zustand hook style), not just
// getState() — a plain {getState,setState} object isn't callable and throws "not a function".
vi.mock("../../stores/notes", () => {
  const getState = () => ({ updateSectionBody: vi.fn(), activeNote: null });
  const useNotesStore = Object.assign(
    (selector?: (s: ReturnType<typeof getState>) => unknown) => {
      const state = getState();
      return selector ? selector(state) : state;
    },
    { getState, setState: () => {} },
  );
  return { useNotesStore };
});

import { DiagramSection } from "./DiagramSection";
import type { Section } from "../../lib/commands.gen";

const section = (body_md: string): Section => ({
  id: "sec-1",
  name: "Relations",
  body_md,
  position: 0,
  kind: "diagram",
});

const JSON_DIAGRAM = JSON.stringify({
  version: 1,
  direction: "TD",
  nodes: [
    { id: "n1", label: "김철수" },
    { id: "n2", label: "김영수" },
    { id: "n3", label: "박씨" },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2" },
    { id: "e2", source: "n2", target: "n3" },
  ],
  groups: [],
});


// Tests run in `en` (see DiagramSection.test.tsx's own note on the i18n default).
describe("DiagramSection — 관계도 하단 힌트 바", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  const flush = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));

  // 개수(상자/관계/그룹)는 캔버스 상단 중앙의 DiagramLegend 로 옮겼다 — 같은 숫자를 한 화면에
  // 두 번 적던 자리였다. legend 쪽 커버리지는 diagramStateModel.test.tsx 가 들고 있다.
  it("keeps the bottom slot the prose editor's stats bar owns, without repeating the canvas counts", async () => {
    render(<DiagramSection section={section(JSON_DIAGRAM)} />);
    await flush();
    const bar = screen.getByTestId("diagram-hint-bar");
    expect(bar.className).toContain("section-statusbar");
    expect(bar.textContent).not.toContain("boxes");
    expect(bar.textContent).not.toContain("relations");
  });

  it("carries the gesture cheatsheet, and every row is a gesture FlowCanvas implements", async () => {
    render(<DiagramSection section={section(JSON_DIAGRAM)} />);
    await flush();
    const toggle = screen.getByTestId("diagram-hint-bar").querySelector('[data-testid="cheatsheet-toggle"]')!;
    fireEvent.click(toggle);
    const panel = screen.getByTestId("cheatsheet-panel");
    // Rows are gesture/key chips now (icon+label, <kbd> caps), not <code> text — 10 rows, and rows
    // 5/6/9/10 are the ones with an actual keyboard modifier: Shift, Ctrl, Delete, Ctrl, Z (5 caps).
    expect(panel.querySelectorAll("kbd")).toHaveLength(5);
    for (const gesture of [
      "Drag",
      "Drag a handle",
      "Drop on empty",
      "Double-click",
      "Shift",
      "Ctrl",
      "Select 2+",
      "Drag a line end",
      "Delete",
      "Z",
    ]) {
      expect(panel.textContent).toContain(gesture);
    }
  });

  it("is absent on the phone (DiagramControls already owns the bottom) and in source-edit mode", async () => {
    const { unmount } = render(<DiagramSection section={section(JSON_DIAGRAM)} touch />);
    await flush();
    expect(screen.queryByTestId("diagram-hint-bar")).toBeNull();
    unmount();

    render(<DiagramSection section={section(JSON_DIAGRAM)} />);
    await flush();
    expect(screen.getByTestId("diagram-hint-bar")).toBeTruthy();
    fireEvent.click(screen.getByTestId("diagram-edit-source"));
    expect(screen.queryByTestId("diagram-hint-bar")).toBeNull();
  });

  it("is absent on an empty diagram — the template gallery is the invitation there", async () => {
    render(<DiagramSection section={section("   ")} />);
    await flush();
    expect(screen.getByTestId("diagram-empty-state")).toBeTruthy();
    expect(screen.queryByTestId("diagram-hint-bar")).toBeNull();
  });
});

