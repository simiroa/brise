import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const call = vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => ({}));
vi.mock("../lib/invoke", () => ({
  call: (cmd: string, args?: Record<string, unknown>) => call(cmd, args),
  callSilent: (cmd: string, args?: Record<string, unknown>) => call(cmd, args),
  emitNotice: vi.fn(),
  registerFlush: vi.fn(() => () => {}),
  flushAll: vi.fn(async () => {}),
}));

import { useSettingsStore } from "../stores/settings";
import { t } from "../i18n/t";
import { MobileBulkSelection } from "./MobileBulkSelection";

const FOLDERS = [{ id: "f1", name: "Folder One", is_open: true, note_count: 1 }] as any;

function setup(over: { selected?: string[]; moveTargets?: any[] } = {}) {
  const onClear = vi.fn();
  const onKeepSelected = vi.fn();
  render(
    <MobileBulkSelection
      selectedNoteIds={over.selected ?? ["n1", "n2"]}
      moveTargets={over.moveTargets ?? FOLDERS}
      onClear={onClear}
      onKeepSelected={onKeepSelected}
    />,
  );
  return { onClear, onKeepSelected };
}

beforeEach(() => {
  call.mockReset();
  call.mockImplementation(async () => ({}));
  useSettingsStore.setState({ aiEnabled: false } as any);
});

describe("MobileBulkSelection", () => {
  it("shows the bar only from 2 selected notes up, and the AI verb only while AI is on", () => {
    const one = render(
      <MobileBulkSelection selectedNoteIds={["n1"]} moveTargets={FOLDERS} onClear={() => {}} onKeepSelected={() => {}} />,
    );
    expect(screen.queryByTestId("mobile-selection-delete")).toBeNull();
    one.unmount();

    setup();
    expect(screen.getByTestId("mobile-selection-move")).toBeTruthy();
    expect(screen.getByTestId("mobile-selection-tag")).toBeTruthy();
    expect(screen.getByTestId("mobile-selection-archive")).toBeTruthy();
    expect(screen.getByTestId("mobile-selection-delete")).toBeTruthy();
    expect(screen.queryByTestId("mobile-selection-ai")).toBeNull();
  });

  it("disables the move verb when there is no folder to move into", () => {
    setup({ moveTargets: [] });
    expect((screen.getByTestId("mobile-selection-move") as HTMLButtonElement).disabled).toBe(true);
  });

  it("delete asks for confirmation, then runs note_delete once per selected id and keeps nothing selected", async () => {
    const { onKeepSelected } = setup();
    fireEvent.click(screen.getByTestId("mobile-selection-delete"));
    expect(screen.getByText(t("selection.delete_confirm_title", { n: 2 }))).toBeTruthy();
    expect(call).not.toHaveBeenCalledWith("note_delete", expect.anything());

    const confirm = screen.getAllByRole("button", { name: t("common.delete") }).find((b) => b.className.includes("mobile-text-btn--danger"))!;
    fireEvent.click(confirm);

    await waitFor(() => expect(onKeepSelected).toHaveBeenCalledWith([]));
    expect(call.mock.calls.filter((c) => c[0] === "note_delete").map((c) => (c[1] as { id: string }).id)).toEqual(["n1", "n2"]);
  });

  it("a failing id stays selected so the user can retry it; the rest of the batch still runs", async () => {
    call.mockImplementation(async (cmd, args) => {
      if (cmd === "note_delete" && args?.id === "n1") throw new Error("boom");
      return {};
    });
    const { onKeepSelected } = setup();
    fireEvent.click(screen.getByTestId("mobile-selection-delete"));
    const confirm = screen.getAllByRole("button", { name: t("common.delete") }).find((b) => b.className.includes("mobile-text-btn--danger"))!;
    fireEvent.click(confirm);

    await waitFor(() => expect(onKeepSelected).toHaveBeenCalledWith(["n1"]));
    expect(call.mock.calls.filter((c) => c[0] === "note_delete")).toHaveLength(2);
  });

  it("the bar's clear button reports onClear", () => {
    const { onClear } = setup();
    fireEvent.click(screen.getByRole("button", { name: t("selection.clear") }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
