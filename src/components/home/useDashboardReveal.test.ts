import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDashboardReveal } from "./useDashboardReveal";
import { useUiStore } from "../../stores/ui";

describe("useDashboardReveal", () => {
  beforeEach(() => {
    useUiStore.setState({ homeInnerTab: "board", dashboardReveal: null });
  });

  it("fires onReveal when a fresh reveal arrives while this pane's tab is active", () => {
    useUiStore.setState({ homeInnerTab: "board" });
    const onReveal = vi.fn();
    renderHook(() => useDashboardReveal("board", onReveal));

    act(() => useUiStore.getState().triggerDashboardReveal("note-1"));

    expect(onReveal).toHaveBeenCalledWith("note-1");
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it("does not replay a reveal that arrived while this pane's tab was inactive, even after switching to it", () => {
    // Board is active, not graph — graph's hook still sees the reveal signal (every pane does)
    // and must record it as consumed without invoking onReveal.
    useUiStore.setState({ homeInnerTab: "board" });
    const onReveal = vi.fn();
    renderHook(() => useDashboardReveal("graph", onReveal));

    act(() => useUiStore.getState().triggerDashboardReveal("note-1"));
    expect(onReveal).not.toHaveBeenCalled();

    // Switching to the graph tab afterward must not replay the stale signal — this is the bug:
    // the old per-pane guard only recorded consumption once the tab guard had already passed, so
    // an inactive pane never marked the seq seen and replayed it the moment it became active.
    act(() => useUiStore.setState({ homeInnerTab: "graph" }));
    expect(onReveal).not.toHaveBeenCalled();
  });

  it("does not replay a reveal that happened before this pane mounted", () => {
    // Graph is not kept alive — every tab entry is a fresh mount (docs: see useDashboardReveal.ts
    // doc comment). A reveal fired earlier in the session, while some OTHER tab was active, must
    // not select a node the moment the user later opens the graph tab fresh.
    useUiStore.setState({ homeInnerTab: "board" });
    act(() => useUiStore.getState().triggerDashboardReveal("note-1"));

    useUiStore.setState({ homeInnerTab: "graph" });
    const onReveal = vi.fn();
    renderHook(() => useDashboardReveal("graph", onReveal));

    expect(onReveal).not.toHaveBeenCalled();
  });

  it("still fires for a genuinely new reveal after a pre-mount one was correctly ignored", () => {
    useUiStore.setState({ homeInnerTab: "board" });
    act(() => useUiStore.getState().triggerDashboardReveal("note-1"));

    useUiStore.setState({ homeInnerTab: "graph" });
    const onReveal = vi.fn();
    renderHook(() => useDashboardReveal("graph", onReveal));
    expect(onReveal).not.toHaveBeenCalled();

    act(() => useUiStore.getState().triggerDashboardReveal("note-2"));
    expect(onReveal).toHaveBeenCalledWith("note-2");
    expect(onReveal).toHaveBeenCalledTimes(1);
  });
});
