import { render, screen, fireEvent, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallLogEntry } from "../lib/commands.gen";

let historyItems: Array<{
  id: string;
  action_type: string;
  prompt_or_input: string | null;
  result_text: string;
  created_at: string;
}> = [];

vi.mock("../stores/ai", () => ({
  useAiStore: <T,>(selector: (state: { historyItems: typeof historyItems }) => T) => selector({ historyItems }),
}));

// lib/invoke — trap #8 (CLAUDE.md): a vi.mock of this module must include callSilent, or every
// caller elsewhere in the tree that expects it silently breaks. AiHistoryPanel itself only ever
// calls callSilent (ai_get_usage / ai_calls_active / ai_calls_recent) — but B3 now reads
// stores/notes.ts's noteIndex (for note_id → title), and that store's module-scope wiring
// (notesActive.ts's makeFieldFlush) calls registerFlush() at store-creation time regardless of
// whether this test ever renders anything that needs it. Missing exports here break at import,
// not at the call site, so every export the transitive store graph touches must be present.
const callMock = vi.fn();
vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
  flushAll: vi.fn(async () => {}),
  registerFlush: vi.fn(),
}));

import { AiHistoryPanel } from "./AiHistoryPanel";

function makeEntry(overrides: Partial<CallLogEntry> = {}): CallLogEntry {
  return {
    ts: new Date().toISOString(),
    id: "call-1",
    provider: "ollama",
    model: "llama3.2",
    fallback_used: false,
    attempts: 1,
    prompt_bytes: 100,
    ...overrides,
  };
}

describe("AiHistoryPanel", () => {
  beforeEach(() => {
    historyItems = [{
      id: "history-1",
      action_type: "fill_metadata",
      prompt_or_input: "Project notes",
      result_text: "Suggested title: Project roadmap",
      created_at: "2026-08-09T12:00:00Z",
    }];
    callMock.mockReset();
    // Matches the old real-invoke-in-jsdom behavior (no Tauri bridge -> rejects) unless a test
    // below installs a more specific mockImplementation.
    callMock.mockRejectedValue(new Error("no tauri"));
  });

  it("uses a keyboard-operable, localized action button to reveal an entry's full result", async () => {
    render(<AiHistoryPanel />);

    const row = screen.getByRole("button", { name: /auto-fill metadata/i });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("ai-history-result-history-1")).toBeNull();
    expect(screen.queryByText("fill_metadata")).toBeNull();

    row.focus();
    await userEvent.keyboard("{Enter}");

    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("ai-history-result-history-1").textContent).toContain("Suggested title: Project roadmap");
    expect(screen.getByText(/Input:/)).toBeTruthy();
  });

  it("renders operation and terminal audit outcome separately", () => {
    historyItems = [{
      id: "history-failed",
      action_type: "cleanup.failed",
      prompt_or_input: "cleanup request",
      result_text: "[failed · IO] provider unavailable",
      created_at: "2026-08-09T12:00:00Z",
    }];

    render(<AiHistoryPanel />);

    expect(screen.getByRole("button", { name: /cleanup.*failed/i })).toBeTruthy();
  });

  it("defaults to the Audit tab and switches to Call log on click", async () => {
    render(<AiHistoryPanel />);

    const auditTab = screen.getByRole("tab", { name: "Audit" });
    const callsTab = screen.getByRole("tab", { name: "Call log" });
    expect(auditTab.getAttribute("aria-selected")).toBe("true");
    expect(callsTab.getAttribute("aria-selected")).toBe("false");
    expect(screen.getByTestId("ai-history-panel")).toBeTruthy();

    fireEvent.click(callsTab);

    expect(callsTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("ai-calllog-panel")).toBeTruthy();
    expect(screen.queryByTestId("ai-history-panel")).toBeNull();
  });

  // diag-viewer (docs/AUDIT-2026-09-26-fallback-observability.md §7.1 W3) — third tab, same
  // switch-and-unmount contract as Audit/Call log above. DiagnosticsTab's own behavior (workers,
  // filters, polling) is covered in src/components/diag/DiagnosticsTab.test.tsx; this only checks
  // that AiHistoryPanel wires it in as a third tab correctly.
  it("switches to the Diagnostics tab and shows its panel", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "diag_status") return { workers: [], log_dir: "/tmp/brise-data" };
      if (cmd === "diag_recent") return { items: [] };
      throw new Error("unexpected command " + cmd);
    });

    render(<AiHistoryPanel />);
    const diagTab = screen.getByRole("tab", { name: "Diagnostics" });
    expect(diagTab.getAttribute("aria-selected")).toBe("false");

    fireEvent.click(diagTab);

    expect(diagTab.getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByTestId("ai-diag-panel")).toBeTruthy();
    expect(screen.queryByTestId("ai-history-panel")).toBeNull();
    expect(screen.queryByTestId("ai-calllog-panel")).toBeNull();
  });

  it("shows an in-progress call above recent calls, with an elapsed-time reading", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "ai_calls_active") {
        return { items: [makeEntry({ id: "call-active", ts: new Date(Date.now() - 7000).toISOString() })] };
      }
      if (cmd === "ai_calls_recent") {
        return { items: [makeEntry({ id: "call-done", outcome: "ok", duration_ms: 1200 })] };
      }
      throw new Error("unexpected command " + cmd);
    });

    render(<AiHistoryPanel />);
    fireEvent.click(screen.getByRole("tab", { name: "Call log" }));

    expect(await screen.findByText("In progress")).toBeTruthy();
    expect(screen.getByText("Recent calls")).toBeTruthy();
    // Elapsed-time reading next to the running entry's status label (m:ss format).
    expect(screen.getByText(/Running · \d:\d{2}/)).toBeTruthy();
    // Finished entry shows its outcome + duration.
    expect(screen.getByText("OK")).toBeTruthy();
    expect(screen.getByText("1.2s")).toBeTruthy();
  });

  it("polls ai_calls_active every second while a call is running, and stops once the tab unmounts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      callMock.mockImplementation(async (cmd: string) => {
        if (cmd === "ai_calls_active") return { items: [makeEntry({ id: "call-active" })] };
        if (cmd === "ai_calls_recent") return { items: [] };
        throw new Error("unexpected command " + cmd);
      });

      const { unmount } = render(<AiHistoryPanel />);
      fireEvent.click(screen.getByRole("tab", { name: "Call log" }));
      await act(() => vi.advanceTimersByTimeAsync(0)); // flush the mount-time fetch

      callMock.mockClear();
      await act(() => vi.advanceTimersByTimeAsync(1000));
      expect(callMock).toHaveBeenCalledWith("ai_calls_active", {});

      callMock.mockClear();
      unmount();
      await act(() => vi.advanceTimersByTimeAsync(5000));
      expect(callMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("B3: shows op/caller/note title/request_id now that the backend fills them in", async () => {
    const { useNotesStore } = await import("../stores/notes");
    useNotesStore.setState({
      noteIndex: new Map([["note-42", { id: "note-42", title: "훈민정음 반포" } as never]]),
    } as never);

    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "ai_calls_active") return { items: [] };
      if (cmd === "ai_calls_recent") {
        return {
          items: [
            makeEntry({
              id: "call-done",
              outcome: "ok",
              duration_ms: 1200,
              op: "generate",
              caller: "summarize",
              note_id: "note-42",
              request_id: "req-abcdef1234567890",
            }),
          ],
        };
      }
      throw new Error("unexpected command " + cmd);
    });

    render(<AiHistoryPanel />);
    fireEvent.click(screen.getByRole("tab", { name: "Call log" }));

    expect(await screen.findByText("Generate")).toBeTruthy();
    expect(screen.getByText("훈민정음 반포")).toBeTruthy();

    fireEvent.click(screen.getByText("Show body"));
    expect(screen.getByText(/summarize/)).toBeTruthy();
    expect(screen.getByText(/req-abcd/)).toBeTruthy();
  });

  it("B3: falls back to the note id's first 8 chars when the note isn't in noteIndex", async () => {
    const { useNotesStore } = await import("../stores/notes");
    useNotesStore.setState({ noteIndex: new Map() } as never);

    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "ai_calls_active") return { items: [] };
      if (cmd === "ai_calls_recent") {
        return { items: [makeEntry({ id: "call-done", outcome: "ok", note_id: "01Junknownlongid" })] };
      }
      throw new Error("unexpected command " + cmd);
    });

    render(<AiHistoryPanel />);
    fireEvent.click(screen.getByRole("tab", { name: "Call log" }));

    expect(await screen.findByText("01Junkno")).toBeTruthy();
  });

  it("shows an empty-state message when the call log fails to load", async () => {
    callMock.mockRejectedValue(new Error("ipc unavailable"));
    render(<AiHistoryPanel />);

    fireEvent.click(screen.getByRole("tab", { name: "Call log" }));

    expect(await screen.findByText("Could not load the call log.")).toBeTruthy();
  });

  // K4(2026-09-06) — 호출 로그 탭 상단 7일 요약 카드. ai_calls_summary는 탭 마운트 시 한 번만 부른다.
  describe("K4: 7일 요약 카드", () => {
    it("renders the summary card with totals, durations, providers, and discard reasons", async () => {
      callMock.mockImplementation(async (cmd: string) => {
        if (cmd === "ai_calls_active") return { items: [] };
        if (cmd === "ai_calls_recent") return { items: [] };
        if (cmd === "ai_calls_summary") {
          return {
            total: 12,
            by_outcome: { ok: 8, error: 2, deadline: 1, cancelled: 1 },
            by_provider: { ollama: 10, gemini: 2 },
            median_duration_ms: 2500,
            p90_duration_ms: 9000,
            discard_reasons: { wrong: 2, too_long: 1 },
          };
        }
        throw new Error("unexpected command " + cmd);
      });

      render(<AiHistoryPanel />);
      fireEvent.click(screen.getByRole("tab", { name: "Call log" }));

      const card = await screen.findByTestId("ai-calllog-summary-card");
      expect(card.textContent).toContain("12");
      expect(card.textContent).toContain("ollama: 10");
      expect(card.textContent).toContain("gemini: 2");
      expect(screen.getByTestId("ai-calllog-summary-discard-reasons").textContent).toContain("2");
      expect(callMock).toHaveBeenCalledWith("ai_calls_summary", { days: 7 });
    });

    it("hides the card entirely when the summary fetch fails", async () => {
      callMock.mockImplementation(async (cmd: string) => {
        if (cmd === "ai_calls_active") return { items: [] };
        if (cmd === "ai_calls_recent") return { items: [] };
        if (cmd === "ai_calls_summary") throw new Error("summary unavailable");
        throw new Error("unexpected command " + cmd);
      });

      render(<AiHistoryPanel />);
      fireEvent.click(screen.getByRole("tab", { name: "Call log" }));

      await screen.findByText("No calls recorded yet.");
      expect(screen.queryByTestId("ai-calllog-summary-card")).toBeNull();
    });

    it("shows a row's discard reason next to its outcome badge", async () => {
      callMock.mockImplementation(async (cmd: string) => {
        if (cmd === "ai_calls_active") return { items: [] };
        if (cmd === "ai_calls_recent") {
          return { items: [makeEntry({ id: "call-done", outcome: "cancelled", discard_reason: "too_long" })] };
        }
        if (cmd === "ai_calls_summary") throw new Error("no summary needed here");
        throw new Error("unexpected command " + cmd);
      });

      render(<AiHistoryPanel />);
      fireEvent.click(screen.getByRole("tab", { name: "Call log" }));

      expect(await screen.findByTestId("ai-calllog-discard-reason")).toHaveProperty("textContent", "Too long");
    });
  });
});
