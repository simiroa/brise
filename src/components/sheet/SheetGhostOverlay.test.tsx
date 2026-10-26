import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SheetGhostOverlay } from "./SheetGhostOverlay";
import { usePresetsStore } from "../../stores/presets";

describe("SheetGhostOverlay component", () => {
  beforeEach(() => {
    usePresetsStore.setState({
      targetState: "ready",
      hovered: null,
      isEditorEmpty: true,
      activeEditorKind: "sheet",
    });
  });

  it("does not render when not empty", () => {
    usePresetsStore.setState({
      targetState: "ready",
      hovered: { id: "budget", bodyMd: '{"cells":{"A1":{"raw":"날짜"}}}' },
    });
    const { container } = render(<SheetGhostOverlay isEmpty={false} />);
    expect(screen.queryByTestId("sheet-ghost-overlay")).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it("does not render when nothing is hovered", () => {
    usePresetsStore.setState({
      targetState: "ready",
      hovered: null,
    });
    render(<SheetGhostOverlay isEmpty={true} />);
    expect(screen.queryByTestId("sheet-ghost-overlay")).toBeNull();
  });

  it("does not render for non-sheet preset hover (e.g. todo)", () => {
    usePresetsStore.setState({
      targetState: "ready",
      hovered: { id: "todo", bodyMd: "- [ ] 할 일 1" },
    });
    render(<SheetGhostOverlay isEmpty={true} />);
    expect(screen.queryByTestId("sheet-ghost-overlay")).toBeNull();
  });

  it("renders preview ghost cells when empty and budget preset is hovered", () => {
    usePresetsStore.setState({
      targetState: "ready",
      hovered: {
        id: "budget",
        bodyMd: JSON.stringify({
          cols: [{ w: 100 }, { w: 120 }],
          cells: {
            A1: { raw: "날짜" },
            B1: { raw: "항목" },
            A2: { raw: "2026-09-03" },
          },
        }),
      },
    });

    render(<SheetGhostOverlay isEmpty={true} />);

    expect(screen.getByTestId("sheet-ghost-overlay")).toBeTruthy();
    expect(screen.getByTestId("sheet-ghost-cell-0-0")).toBeTruthy();
    expect(screen.getByText("날짜")).toBeTruthy();
    expect(screen.getByText("항목")).toBeTruthy();
    expect(screen.getByText("2026-09-03")).toBeTruthy();
  });

  it("falls back to SHEET_PRESET_GHOSTS when bodyMd is empty or non-JSON", () => {
    usePresetsStore.setState({
      targetState: "ready",
      hovered: {
        id: "sheet_schedule",
        bodyMd: "",
      },
    });

    render(<SheetGhostOverlay isEmpty={true} />);

    expect(screen.getByTestId("sheet-ghost-overlay")).toBeTruthy();
    expect(screen.getByText("시간")).toBeTruthy();
    expect(screen.getByText("월")).toBeTruthy();
  });
});
