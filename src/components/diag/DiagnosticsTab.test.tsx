import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagEntry, DiagWorkerStatus } from "../../lib/commands.gen";

// lib/invoke — trap #8 (CLAUDE.md): a vi.mock of this module must include callSilent, or every
// caller elsewhere in the tree that expects it silently breaks (check:surface ⓓ enforces this).
// DiagnosticsTab only ever calls callSilent (diag_status / diag_recent / data_dir_open) — it has
// no store dependency, so nothing else needs `call` here, but it's kept for parity with the rest
// of the suite's mock shape.
const callMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
  flushAll: vi.fn(async () => {}),
  registerFlush: vi.fn(),
}));

import { DiagnosticsTab } from "./DiagnosticsTab";

function makeEntry(overrides: Partial<DiagEntry> = {}): DiagEntry {
  return {
    id: "diag-1",
    ts: new Date("2026-09-26T12:00:00Z").toISOString(),
    level: "error",
    source: "main",
    feature: "map",
    code: "gl_context_lost",
    message: "WebGL context lost, falling back to SVG",
    count: 1,
    ...overrides,
  };
}

function makeWorker(overrides: Partial<DiagWorkerStatus> = {}): DiagWorkerStatus {
  return {
    name: "schedule",
    last_beat: new Date("2026-09-26T12:00:00Z").toISOString(),
    state: "alive",
    ...overrides,
  };
}

describe("DiagnosticsTab", () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockRejectedValue(new Error("no tauri"));
  });

  it("renders worker status and recent entries from diag_status/diag_recent", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "diag_status") {
        return { workers: [makeWorker()], log_dir: "/data/brise" };
      }
      if (cmd === "diag_recent") {
        return {
          items: [
            makeEntry({ id: "e1", level: "error", feature: "map", code: "gl_context_lost", count: 3 }),
            makeEntry({ id: "e2", level: "info", feature: "sync", code: "bind_loopback", message: "Tailscale unavailable" }),
          ],
        };
      }
      throw new Error("unexpected command " + cmd);
    });

    render(<DiagnosticsTab />);

    expect(await screen.findByText("Reminder/schedule worker")).toBeTruthy();
    expect(screen.getByText("Alive")).toBeTruthy();
    expect(screen.getByText("WebGL context lost, falling back to SVG")).toBeTruthy();
    expect(screen.getByText("Tailscale unavailable")).toBeTruthy();
    expect(screen.getByText("×3")).toBeTruthy();
    expect(screen.getByTestId("ai-diag-logdir-path").textContent).toBe("/data/brise");
  });

  it("shows the empty-worker and empty-entry states when nothing has been recorded", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "diag_status") return { workers: [], log_dir: "/data/brise" };
      if (cmd === "diag_recent") return { items: [] };
      throw new Error("unexpected command " + cmd);
    });

    render(<DiagnosticsTab />);

    expect(await screen.findByText("No worker has reported in yet.")).toBeTruthy();
    expect(screen.getByText("No diagnostics recorded yet.")).toBeTruthy();
  });

  it("shows an inline error state when both loads fail", async () => {
    callMock.mockRejectedValue(new Error("ipc unavailable"));

    render(<DiagnosticsTab />);

    expect(await screen.findByText("Could not load diagnostics.")).toBeTruthy();
  });

  it("filters entries by the text filter over feature/code/message", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "diag_status") return { workers: [], log_dir: "/data/brise" };
      if (cmd === "diag_recent") {
        return {
          items: [
            makeEntry({ id: "e1", feature: "map", code: "gl_context_lost", message: "map fallback" }),
            makeEntry({ id: "e2", feature: "weather", code: "fetch_failed", message: "weather slot gone" }),
          ],
        };
      }
      throw new Error("unexpected command " + cmd);
    });

    render(<DiagnosticsTab />);
    await screen.findByText("map fallback");
    expect(screen.getByText("weather slot gone")).toBeTruthy();

    fireEvent.change(screen.getByTestId("ai-diag-filter-text"), { target: { value: "weather" } });

    expect(screen.queryByText("map fallback")).toBeNull();
    expect(screen.getByText("weather slot gone")).toBeTruthy();
  });

  it("hides entries of a level when its filter toggle is switched off", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "diag_status") return { workers: [], log_dir: "/data/brise" };
      if (cmd === "diag_recent") {
        return {
          items: [
            makeEntry({ id: "e1", level: "error", message: "error entry" }),
            makeEntry({ id: "e2", level: "info", message: "info entry" }),
          ],
        };
      }
      throw new Error("unexpected command " + cmd);
    });

    render(<DiagnosticsTab />);
    await screen.findByText("error entry");
    expect(screen.getByText("info entry")).toBeTruthy();

    const errorToggle = screen.getByTestId("ai-diag-filter-level-error");
    expect(errorToggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(errorToggle);

    expect(errorToggle.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByText("error entry")).toBeNull();
    expect(screen.getByText("info entry")).toBeTruthy();
  });

  it("shows the filtered empty state when a filter matches nothing, distinct from the no-entries state", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "diag_status") return { workers: [], log_dir: "/data/brise" };
      if (cmd === "diag_recent") return { items: [makeEntry({ id: "e1", feature: "map" })] };
      throw new Error("unexpected command " + cmd);
    });

    render(<DiagnosticsTab />);
    await screen.findByTestId("ai-diag-entry-row");

    fireEvent.change(screen.getByTestId("ai-diag-filter-text"), { target: { value: "nothing-matches-this" } });

    expect(await screen.findByText("No entries match the filter.")).toBeTruthy();
    expect(screen.queryByText("No diagnostics recorded yet.")).toBeNull();
  });

  it("polls diag_status/diag_recent every 5s while mounted, and stops once unmounted", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      callMock.mockImplementation(async (cmd: string) => {
        if (cmd === "diag_status") return { workers: [], log_dir: "/data/brise" };
        if (cmd === "diag_recent") return { items: [] };
        throw new Error("unexpected command " + cmd);
      });

      const { unmount } = render(<DiagnosticsTab />);
      await act(() => vi.advanceTimersByTimeAsync(0)); // flush the mount-time fetch

      callMock.mockClear();
      await act(() => vi.advanceTimersByTimeAsync(5000));
      expect(callMock).toHaveBeenCalledWith("diag_status", {});
      expect(callMock).toHaveBeenCalledWith("diag_recent", { limit: 300 });

      callMock.mockClear();
      unmount();
      await act(() => vi.advanceTimersByTimeAsync(15000));
      expect(callMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens the log folder via the existing data_dir_open command", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "diag_status") return { workers: [], log_dir: "/data/brise" };
      if (cmd === "diag_recent") return { items: [] };
      if (cmd === "data_dir_open") return { ok: true };
      throw new Error("unexpected command " + cmd);
    });

    render(<DiagnosticsTab />);
    await screen.findByTestId("ai-diag-panel");
    callMock.mockClear();

    fireEvent.click(screen.getByTestId("ai-diag-open-log-dir"));

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("data_dir_open", {}));
    expect(screen.queryByText("Could not open the log folder.")).toBeNull();
  });

  it("shows an inline failure message when opening the log folder fails", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "diag_status") return { workers: [], log_dir: "/data/brise" };
      if (cmd === "diag_recent") return { items: [] };
      if (cmd === "data_dir_open") throw new Error("opener unavailable");
      throw new Error("unexpected command " + cmd);
    });

    render(<DiagnosticsTab />);
    await screen.findByTestId("ai-diag-panel");

    fireEvent.click(screen.getByTestId("ai-diag-open-log-dir"));

    expect(await screen.findByText("Could not open the log folder.")).toBeTruthy();
  });

  it("copies the log dir path to the clipboard", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "diag_status") return { workers: [], log_dir: "/data/brise" };
      if (cmd === "diag_recent") return { items: [] };
      throw new Error("unexpected command " + cmd);
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    render(<DiagnosticsTab />);
    await screen.findByTestId("ai-diag-panel");

    fireEvent.click(screen.getByTestId("ai-diag-copy-path"));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("/data/brise"));
    expect(await screen.findByText("Copied")).toBeTruthy();
  });
});
