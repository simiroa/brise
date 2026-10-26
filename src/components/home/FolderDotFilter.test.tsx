import { describe, it, expect, beforeEach } from "vitest";
import { render, fireEvent, screen, act } from "@testing-library/react";
import { FolderDotFilter } from "./FolderDotFilter";
import { useNotesStore } from "../../stores/notes";
import { useUiStore } from "../../stores/ui";
import type { Folder } from "../../lib/commands.gen";

function folder(partial: Partial<Folder> & Pick<Folder, "id" | "name" | "position">): Folder {
  return {
    workspace_id: "ws1",
    is_open: true,
    note_count: 0,
    color_hue: null,
    icon: null,
    rules: null,
    search_excluded: false,
    ai_excluded: false,
    ...partial,
  };
}

describe("FolderDotFilter", () => {
  beforeEach(() => {
    useUiStore.setState({ dashboardFolderFilter: null });
    useNotesStore.setState({
      folders: [
        folder({ id: "f1", name: "Work", position: 0, color_hue: 120 }),
        folder({ id: "f2", name: "Personal", position: 1, color_hue: 240 }),
      ],
    } as never);
  });

  it("does not render with 0 or 1 folders (same guard as the old per-tab legends)", () => {
    useNotesStore.setState({ folders: [folder({ id: "f1", name: "Only", position: 0 })] } as never);
    const { queryByTestId } = render(<FolderDotFilter />);
    expect(queryByTestId("home-folder-dots")).toBeNull();
  });

  it("clicking a folder icon sets the shared dashboard folder filter; clicking again clears it", () => {
    const { getByTestId } = render(<FolderDotFilter />);
    const row = getByTestId("home-folder-dots");
    const dot = row.querySelector('[data-folder-id="f1"]') as HTMLButtonElement;
    expect(dot).toBeTruthy();
    expect(dot.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(dot);
    expect(useUiStore.getState().dashboardFolderFilter).toBe("f1");
    expect(dot.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(dot);
    expect(useUiStore.getState().dashboardFolderFilter).toBeNull();
    expect(dot.getAttribute("aria-pressed")).toBe("false");
  });

  it("selecting a different folder switches the filter (not a second selection)", () => {
    const { getByTestId } = render(<FolderDotFilter />);
    const row = getByTestId("home-folder-dots");
    const dotF1 = row.querySelector('[data-folder-id="f1"]') as HTMLButtonElement;
    const dotF2 = row.querySelector('[data-folder-id="f2"]') as HTMLButtonElement;

    fireEvent.click(dotF1);
    expect(useUiStore.getState().dashboardFolderFilter).toBe("f1");

    fireEvent.click(dotF2);
    expect(useUiStore.getState().dashboardFolderFilter).toBe("f2");
    expect(dotF1.getAttribute("aria-pressed")).toBe("false");
    expect(dotF2.getAttribute("aria-pressed")).toBe("true");
  });

  it("does not use native title attribute (avoids ~1s browser delay) but keeps aria-label", () => {
    const { getByTestId } = render(<FolderDotFilter />);
    const row = getByTestId("home-folder-dots");
    const dotF1 = row.querySelector('[data-folder-id="f1"]') as HTMLButtonElement;

    expect(dotF1.getAttribute("title")).toBeNull();
    expect(dotF1.getAttribute("aria-label")).toBe("Work");
  });

  it("shows instant tooltip on mouseEnter and removes it on mouseLeave", () => {
    const { getByTestId } = render(<FolderDotFilter />);
    const row = getByTestId("home-folder-dots");
    const dotF1 = row.querySelector('[data-folder-id="f1"]') as HTMLButtonElement;

    expect(screen.queryByTestId("folder-dot-tooltip")).toBeNull();

    fireEvent.mouseEnter(dotF1);
    const tooltip = screen.getByTestId("folder-dot-tooltip");
    expect(tooltip).toBeTruthy();
    expect(tooltip.textContent).toBe("Work");

    fireEvent.mouseLeave(dotF1);
    expect(screen.queryByTestId("folder-dot-tooltip")).toBeNull();
  });

  it("shows tooltip on keyboard focus and dismisses on blur / Escape", () => {
    const { getByTestId } = render(<FolderDotFilter />);
    const row = getByTestId("home-folder-dots");
    const dotF2 = row.querySelector('[data-folder-id="f2"]') as HTMLButtonElement;

    fireEvent.focus(dotF2);
    expect(screen.getByTestId("folder-dot-tooltip")).toBeTruthy();
    expect(screen.getByTestId("folder-dot-tooltip").textContent).toBe("Personal");

    fireEvent.keyDown(dotF2, { key: "Escape" });
    expect(screen.queryByTestId("folder-dot-tooltip")).toBeNull();

    fireEvent.focus(dotF2);
    expect(screen.getByTestId("folder-dot-tooltip")).toBeTruthy();

    fireEvent.blur(dotF2);
    expect(screen.queryByTestId("folder-dot-tooltip")).toBeNull();
  });

  it("renders tooltip outside the scroll container via portal into document.body", () => {
    const { getByTestId } = render(<FolderDotFilter />);
    const row = getByTestId("home-folder-dots");
    const dotF1 = row.querySelector('[data-folder-id="f1"]') as HTMLButtonElement;

    fireEvent.mouseEnter(dotF1);
    const tooltip = screen.getByTestId("folder-dot-tooltip");

    // Must NOT be clipped inside the overflow-x scroll container
    expect(row.contains(tooltip)).toBe(false);
    expect(document.body.contains(tooltip)).toBe(true);
  });

  it("renders custom folder icon when folder.icon is specified and updates dynamically", () => {
    useNotesStore.setState({
      folders: [
        folder({ id: "f1", name: "Work", position: 0, color_hue: 120, icon: "book" }),
        folder({ id: "f2", name: "Personal", position: 1, color_hue: 240, icon: "star" }),
      ],
    } as never);

    const { getByTestId } = render(<FolderDotFilter />);
    const row = getByTestId("home-folder-dots");
    const dotF1 = row.querySelector('[data-folder-id="f1"]') as HTMLButtonElement;
    const dotF2 = row.querySelector('[data-folder-id="f2"]') as HTMLButtonElement;

    expect(dotF1.querySelector("svg")).toBeTruthy();
    expect(dotF2.querySelector("svg")).toBeTruthy();

    // Dynamically update folder icon in store (e.g. via sidebar note tree / color control)
    act(() => {
      useNotesStore.setState({
        folders: [
          folder({ id: "f1", name: "Work", position: 0, color_hue: 120, icon: "landmark" }),
          folder({ id: "f2", name: "Personal", position: 1, color_hue: 240, icon: "star" }),
        ],
      } as never);
    });

    expect(dotF1.querySelector("svg")).toBeTruthy();
  });
});
