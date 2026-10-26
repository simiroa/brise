import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useWorkspacesStore } from "../stores/workspaces";
import { MobileWorkspaceSwitcher } from "./MobileWorkspaceSwitcher";

// switchTo()/load() are stubbed at the store level (not lib/invoke) — same convention
// MobileApp.test.tsx uses for the notes store: this component's job is "call the right store
// action and react to it", not re-verify stores/workspaces.ts's own network/side-effect plumbing.
describe("MobileWorkspaceSwitcher", () => {
  beforeEach(() => {
    useWorkspacesStore.setState({
      workspaces: [
        { id: "w1", name: "Histoire de Corée", note_count: 3 } as any,
        { id: "w2", name: "France", note_count: 1 } as any,
      ],
      activeId: "w1",
      loaded: true,
      load: vi.fn(),
    } as any);
  });

  it("shows the active workspace's name as the trigger", () => {
    render(<MobileWorkspaceSwitcher />);
    expect(screen.getByText("Histoire de Corée")).toBeTruthy();
  });

  it("opens a sheet listing every workspace on tap", () => {
    render(<MobileWorkspaceSwitcher />);
    fireEvent.click(screen.getByRole("button", { name: /Histoire de Corée/ }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("France");
  });

  it("picking a different workspace calls switchTo and closes the sheet", async () => {
    const switchTo = vi.fn().mockResolvedValue(undefined);
    useWorkspacesStore.setState({ switchTo } as any);
    render(<MobileWorkspaceSwitcher />);

    fireEvent.click(screen.getByRole("button", { name: /Histoire de Corée/ }));
    fireEvent.click(screen.getByText("France"));

    await waitFor(() => expect(switchTo).toHaveBeenCalledWith("w2"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Android back (popstate) closes the sheet", () => {
    render(<MobileWorkspaceSwitcher />);
    fireEvent.click(screen.getByRole("button", { name: /Histoire de Corée/ }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.popState(window);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("picking the already-active workspace just closes the sheet, no switchTo call", () => {
    const switchTo = vi.fn();
    useWorkspacesStore.setState({ switchTo } as any);
    render(<MobileWorkspaceSwitcher />);

    fireEvent.click(screen.getByRole("button", { name: /Histoire de Corée/ }));
    fireEvent.click(screen.getAllByText("Histoire de Corée")[1]); // the sheet's own row, not the trigger
    expect(switchTo).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
