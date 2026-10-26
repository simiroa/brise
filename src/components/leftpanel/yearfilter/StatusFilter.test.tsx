import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";

const callMock = vi.fn();
vi.mock("../../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  flushAll: () => Promise.resolve(),
  registerFlush: () => () => {},
}));

import { StatusFilter } from "./StatusFilter";
import { useSearchStore } from "../../../stores/search";
import { useTaxonomyStore } from "../../../stores/taxonomy";
import { useSettingsStore } from "../../../stores/settings";
import { t } from "../../../i18n/t";

const CUSTOM = { id: "s1", workspace_id: "ws", name: "Relecture", position: 0 };
const originalAddStatus = useTaxonomyStore.getState().addStatus;
const originalRenameStatus = useTaxonomyStore.getState().renameStatus;
const originalRemoveStatus = useTaxonomyStore.getState().removeStatus;

describe("StatusFilter inline rename (custom statuses)", () => {
  beforeEach(() => {
    callMock.mockClear();
    useSearchStore.setState({ statusFilter: [] });
    useTaxonomyStore.setState({
      workspaceId: "ws",
      statuses: [CUSTOM],
      addStatus: originalAddStatus,
      renameStatus: originalRenameStatus,
      removeStatus: originalRemoveStatus,
    });
    useSettingsStore.setState({ statusAddLocked: false });
  });

  it("dblclick on a custom chip opens an inline input prefilled with the name; Enter commits via renameStatus", () => {
    const renameStatus = vi.fn().mockResolvedValue(undefined);
    useTaxonomyStore.setState({ renameStatus });

    render(<StatusFilter />);
    fireEvent.doubleClick(screen.getByText("Relecture"));

    const input = screen.getByTestId("status-rename-input") as HTMLInputElement;
    expect(input.value).toBe("Relecture");

    fireEvent.change(input, { target: { value: "  Revu  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(renameStatus).toHaveBeenCalledTimes(1);
    expect(renameStatus).toHaveBeenCalledWith("s1", "Revu");
    // Input closed after commit; chip (still old name — store is mocked) is back.
    expect(screen.queryByTestId("status-rename-input")).toBeNull();
    expect(screen.getByText("Relecture")).toBeTruthy();
  });

  it("Escape cancels without calling renameStatus", () => {
    const renameStatus = vi.fn();
    useTaxonomyStore.setState({ renameStatus });

    render(<StatusFilter />);
    fireEvent.doubleClick(screen.getByText("Relecture"));
    const input = screen.getByTestId("status-rename-input");
    fireEvent.change(input, { target: { value: "Autre" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(renameStatus).not.toHaveBeenCalled();
    expect(screen.queryByTestId("status-rename-input")).toBeNull();
  });

  it("blur commits like Enter", () => {
    const renameStatus = vi.fn().mockResolvedValue(undefined);
    useTaxonomyStore.setState({ renameStatus });

    render(<StatusFilter />);
    fireEvent.doubleClick(screen.getByText("Relecture"));
    const input = screen.getByTestId("status-rename-input");
    fireEvent.change(input, { target: { value: "Revu" } });
    fireEvent.blur(input);

    expect(renameStatus).toHaveBeenCalledWith("s1", "Revu");
  });

  it("built-in chips have no rename affordance: dblclick never opens an input", () => {
    const renameStatus = vi.fn();
    useTaxonomyStore.setState({ renameStatus });

    const { container } = render(<StatusFilter />);
    // Built-in chips are the plain (non-removable) buttons with a color dot — dblclick each.
    const buttons = Array.from(container.querySelectorAll("button")).filter(
      (b) => b.textContent !== "Relecture" && b.querySelector("span[aria-hidden]"),
    );
    expect(buttons.length).toBe(3);
    for (const b of buttons) fireEvent.doubleClick(b);

    expect(screen.queryByTestId("status-rename-input")).toBeNull();
    expect(renameStatus).not.toHaveBeenCalled();
  });
});

describe("StatusFilter and taxonomy store status_add_locked behavior", () => {
  beforeEach(() => {
    callMock.mockClear();
    useSearchStore.setState({ statusFilter: [] });
    useTaxonomyStore.setState({
      workspaceId: "ws-1",
      statuses: [CUSTOM],
      addStatus: originalAddStatus,
      renameStatus: originalRenameStatus,
      removeStatus: originalRemoveStatus,
    });
    useSettingsStore.setState({ statusAddLocked: false });
  });

  it("renders '+' add button when statusAddLocked is false and allows adding", () => {
    const addStatus = vi.fn().mockResolvedValue(null);
    useTaxonomyStore.setState({ addStatus });

    render(<StatusFilter />);
    const addBtn = screen.getByRole("button", { name: t("search.status_add") });
    expect(addBtn).toBeTruthy();

    fireEvent.click(addBtn);
    const input = screen.getByPlaceholderText(t("search.status_add_placeholder"));
    expect(input).toBeTruthy();

    fireEvent.change(input, { target: { value: "NewStatus" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(addStatus).toHaveBeenCalledWith("NewStatus");
  });

  it("hides '+' add button and input completely when statusAddLocked is true", () => {
    useSettingsStore.setState({ statusAddLocked: true });

    render(<StatusFilter />);
    expect(screen.queryByRole("button", { name: t("search.status_add") })).toBeNull();
    expect(screen.queryByPlaceholderText(t("search.status_add_placeholder"))).toBeNull();
  });

  it("taxonomyStore.addStatus returns null and skips IPC when statusAddLocked is true", async () => {
    useSettingsStore.setState({ statusAddLocked: true });

    const result = await useTaxonomyStore.getState().addStatus("BlockedStatus");
    expect(result).toBeNull();
    expect(callMock).not.toHaveBeenCalled();
  });

  it("taxonomyStore.addStatus makes IPC call when statusAddLocked is false", async () => {
    useSettingsStore.setState({ statusAddLocked: false });
    const added = { id: "s2", workspace_id: "ws-1", name: "AllowedStatus", position: 1 };
    callMock.mockResolvedValueOnce(added);

    const result = await useTaxonomyStore.getState().addStatus("AllowedStatus");
    expect(result).toEqual(added);
    expect(callMock).toHaveBeenCalledWith("workspace_status_add", {
      workspace_id: "ws-1",
      name: "AllowedStatus",
    });
  });

  it("taxonomyStore.renameStatus and removeStatus are NOT locked when statusAddLocked is true", async () => {
    useSettingsStore.setState({ statusAddLocked: true });
    const renamed = { id: "s1", workspace_id: "ws-1", name: "RenamedStatus", position: 0 };
    callMock.mockResolvedValueOnce(renamed);

    await useTaxonomyStore.getState().renameStatus("s1", "RenamedStatus");
    expect(callMock).toHaveBeenCalledWith("workspace_status_rename", {
      id: "s1",
      name: "RenamedStatus",
    });
  });
});
