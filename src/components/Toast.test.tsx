import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

let reportError: ((error: { code: string; message: string }) => void) | undefined;
let reportNotice: ((message: string) => void) | undefined;
let reportUndo:
  | ((toast: {
      id: number;
      label: string;
      onUndo: () => void;
      actionLabel?: string;
      extraAction?: { label: string; onAction: () => void };
    }) => void)
  | undefined;

vi.mock("../lib/invoke", () => ({
  onAppError: (listener: typeof reportError) => { reportError = listener; },
  onAppNotice: (listener: typeof reportNotice) => { reportNotice = listener; },
}));

vi.mock("../lib/undo", () => ({
  onUndoToast: (listener: typeof reportUndo) => { reportUndo = listener; },
  onUndoToastDismiss: vi.fn(),
}));

import { Toast } from "./Toast";
import { emitProgress } from "../lib/progressToast";
import { useSettingsStore } from "../stores/settings";

describe("Toast", () => {
  beforeEach(() => {
    reportError = undefined;
    reportNotice = undefined;
    reportUndo = undefined;
  });

  it("announces errors assertively, preserves the complete message, and exposes a keyboard-close button", () => {
    render(<Toast />);
    act(() => reportError?.({ code: "NETWORK", message: "The AI request timed out. Check your connection and try again." }));

    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    expect(alert.textContent).toContain("The AI request timed out. Check your connection and try again.");

    const close = screen.getByRole("button", { name: /close notification/i });
    fireEvent.click(close);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders friendly i18n title and rewrites technical IO error message", () => {
    useSettingsStore.setState({ uiLang: "ko" });
    render(<Toast />);
    act(() => reportError?.({ code: "IO", message: "Failed with os error 32: sharing violation" }));

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("파일 오류");
    expect(alert.textContent).toContain("다른 앱에서 열려 있어요");
  });

  it("announces notices without interrupting the current task", () => {
    render(<Toast />);
    act(() => reportNotice?.("AI suggestions are ready."));

    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toContain("AI suggestions are ready.");
  });

  it("updates a progress toast in place for the same key instead of stacking, and clears it on null", () => {
    render(<Toast />);
    act(() => emitProgress("import", "Importing 1/5"));

    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toContain("Importing 1/5");

    act(() => emitProgress("import", "Importing 2/5"));

    expect(screen.getAllByRole("status")).toHaveLength(1); // no second toast stacked
    expect(screen.getByRole("status").textContent).toContain("Importing 2/5");

    act(() => emitProgress("import", null));

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("does not evict a progress toast when the 3-toast cap is exceeded by notices", () => {
    render(<Toast />);
    act(() => emitProgress("import", "Importing 1/5"));
    act(() => reportNotice?.("n1"));
    act(() => reportNotice?.("n2"));
    act(() => reportNotice?.("n3"));

    expect(screen.getByText("Importing 1/5")).toBeTruthy();
  });

  it("an action toast with a second action shows both buttons; each runs its own callback and closes the toast", () => {
    render(<Toast />);
    const onOpen = vi.fn();
    const onFolder = vi.fn();
    act(() =>
      reportUndo?.({
        id: 1,
        label: "report.hwpx saved",
        onUndo: onOpen,
        actionLabel: "Open",
        extraAction: { label: "Show folder", onAction: onFolder },
      }),
    );

    expect(screen.getByText("report.hwpx saved")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show folder" }));
    expect(onFolder).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).toBeNull();

    act(() =>
      reportUndo?.({
        id: 2,
        label: "again",
        onUndo: onOpen,
        actionLabel: "Open",
        extraAction: { label: "Show folder", onAction: onFolder },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onFolder).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a one-action toast keeps its old layout: action then close, no second button", () => {
    render(<Toast />);
    act(() => reportUndo?.({ id: 3, label: "Deleted", onUndo: vi.fn(), actionLabel: "Undo" }));

    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent || b.getAttribute("aria-label"))).toEqual(["Undo", "Close notification"]);
  });
});
