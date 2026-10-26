import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDiagramReader } from "./useDiagramReader";
import { parseDiagramJson } from "./diagramSchema";

const TEST_GRAPH = parseDiagramJson(JSON.stringify({
  v: 1,
  states: ["준비", "진행중", "완료"],
  nodes: [
    { id: "n1", label: "Alpha", state: 0, tag: "core" },
    { id: "n2", label: "Beta", state: 1, desc: "second" },
    { id: "n3", label: "Gamma", state: 2 },
  ],
  edges: [
    { id: "e1", from: "n1", to: "n2" },
    { id: "e2", from: "n2", to: "n3" },
  ],
}));

describe("useDiagramReader", () => {
  it("initializes with kind: none and dimmedIds: null", () => {
    const { result } = renderHook(() => useDiagramReader({ model: TEST_GRAPH }));

    expect(result.current.readerMode).toEqual({ kind: "none" });
    expect(result.current.dimmedIds).toBeNull();
  });

  it("toggles filter state correctly", () => {
    const { result } = renderHook(() => useDiagramReader({ model: TEST_GRAPH }));

    act(() => {
      result.current.toggleFilterState(0);
    });

    expect(result.current.readerMode).toEqual({
      kind: "filter",
      selectedStates: new Set([0]),
    });
    // Node n1 has state 0. Edges n1->n2 requires n2 to have state 0 too, so only n1 is active
    expect(result.current.dimmedIds).toEqual(new Set(["n1"]));

    // Toggle same state off
    act(() => {
      result.current.toggleFilterState(0);
    });
    expect(result.current.readerMode).toEqual({ kind: "none" });
    expect(result.current.dimmedIds).toBeNull();
  });

  it("handles reach analysis mode", () => {
    const { result } = renderHook(() => useDiagramReader({ model: TEST_GRAPH }));

    act(() => {
      result.current.handleReach("n1", "downstream");
    });

    expect(result.current.readerMode).toEqual({
      kind: "reach",
      startNodeId: "n1",
      direction: "downstream",
    });
    expect(result.current.dimmedIds).toContain("n1");
    expect(result.current.dimmedIds).toContain("n2");
    expect(result.current.dimmedIds).toContain("e1");

    // Turn off
    act(() => {
      result.current.handleReach("n1", "off");
    });
    expect(result.current.readerMode).toEqual({ kind: "none" });
  });

  it("handles finder query mode", () => {
    const { result } = renderHook(() => useDiagramReader({ model: TEST_GRAPH }));

    act(() => {
      result.current.setReaderMode({ kind: "finder", query: "alpha" });
    });

    expect(result.current.dimmedIds).toEqual(new Set(["n1"]));

    // Searching tag
    act(() => {
      result.current.setReaderMode({ kind: "finder", query: "core" });
    });
    expect(result.current.dimmedIds).toEqual(new Set(["n1"]));

    // Searching desc
    act(() => {
      result.current.setReaderMode({ kind: "finder", query: "second" });
    });
    expect(result.current.dimmedIds).toEqual(new Set(["n2"]));
  });

  it("handles keyboard shortcut Escape and /", () => {
    const { result } = renderHook(() => useDiagramReader({ model: TEST_GRAPH }));

    // '/' opens finder
    const slashEvent = {
      key: "/",
      preventDefault: () => {},
      stopPropagation: () => {},
    } as any;
    let handled = false;
    act(() => {
      handled = result.current.handleReaderKeyDown(slashEvent, false);
    });
    expect(handled).toBe(true);
    expect(result.current.readerMode).toEqual({ kind: "finder", query: "" });

    // Escape clears reader mode
    const escEvent = {
      key: "Escape",
      preventDefault: () => {},
      stopPropagation: () => {},
    } as any;
    act(() => {
      handled = result.current.handleReaderKeyDown(escEvent, false);
    });
    expect(handled).toBe(true);
    expect(result.current.readerMode).toEqual({ kind: "none" });
  });

  it("temporarily spotlights hovered state without changing readerMode", () => {
    const { result } = renderHook(() => useDiagramReader({ model: TEST_GRAPH }));

    act(() => {
      result.current.setHoveredState(1);
    });

    // n2 has state 1, so only n2 is active in dimmedIds
    expect(result.current.readerMode).toEqual({ kind: "none" });
    expect(result.current.hoveredState).toBe(1);
    expect(result.current.dimmedIds).toEqual(new Set(["n2"]));

    // Unhover restores dimmedIds back to null
    act(() => {
      result.current.setHoveredState(null);
    });
    expect(result.current.dimmedIds).toBeNull();
  });
});
