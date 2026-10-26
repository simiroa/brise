import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const callMock = vi.fn();
const flushAllMock = vi.fn(async () => {});
vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  flushAll: () => flushAllMock(),
  registerFlush: () => () => {},
  emitNotice: vi.fn(),
}));

import { useNotesStore } from "../stores/notes";
import { useSettingsStore } from "../stores/settings";
import { ActivityHistoryPanel } from "./ActivityHistoryPanel";

describe("ActivityHistoryPanel", () => {
  beforeEach(() => {
    callMock.mockReset();
    flushAllMock.mockClear();
    // No active note — history view must open regardless (frame-top placement).
    useNotesStore.setState({ activeNote: null, activeDraft: false });
    useSettingsStore.setState({ activeWorkspaceId: "ws1", uiLang: "en" });
  });

  it("opens and lists activity without an active note", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "activity_list") {
        return [
          {
            id: "a1",
            workspace_id: "ws1",
            note_id: "n1",
            kind: "create",
            summary: "Fresh note",
            payload: null,
            created_at: new Date().toISOString(),
            note_title: "Fresh note",
            note_alive: true,
          },
        ];
      }
      throw new Error(`unexpected call: ${cmd}`);
    });
    render(<ActivityHistoryPanel onClose={() => {}} onRestoreSnapshot={async () => {}} />);
    expect(await screen.findByTestId("activity-history-panel")).toBeTruthy();
    expect(await screen.findByText("Fresh note")).toBeTruthy();
    expect(screen.getByText(/created/i)).toBeTruthy();
    // No active note required — activity_list was called with the workspace.
    expect(callMock).toHaveBeenCalledWith(
      "activity_list",
      expect.objectContaining({ workspace_id: "ws1" }),
    );
  });

  it("renders a collect-kind row (note_id null) like an import row — summary as title, no gone suffix", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "activity_list") {
        return [
          {
            id: "a2",
            workspace_id: "ws1",
            note_id: null,
            kind: "collect",
            summary: "브라우저 기록 3건",
            payload: null,
            created_at: new Date().toISOString(),
            note_title: null,
            note_alive: false,
          },
        ];
      }
      throw new Error(`unexpected call: ${cmd}`);
    });
    render(<ActivityHistoryPanel onClose={() => {}} onRestoreSnapshot={async () => {}} />);
    expect(await screen.findByText("브라우저 기록 3건")).toBeTruthy();
    expect(screen.getByText("Collected")).toBeTruthy();
    // note_alive is false but kind=collect (like import) never shows the "gone" suffix — there
    // was never a live note for this row to begin with (§ActivityHistoryPanel.tsx displayTitle).
    expect(screen.queryByText(/no longer available/i)).toBeNull();
  });

  it("shows empty state when nothing recorded", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "activity_list") return [];
      throw new Error(`unexpected call: ${cmd}`);
    });
    render(<ActivityHistoryPanel onClose={() => {}} onRestoreSnapshot={async () => {}} />);
    expect(await screen.findByText(/no activity yet/i)).toBeTruthy();
  });

  it("restore flow via autosaves drill-down: host onRestoreSnapshot, not in-panel flush/restore", async () => {
    const onRestoreSnapshot = vi.fn(async () => {});
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "activity_list") {
        return [
          {
            id: "a1",
            workspace_id: "ws1",
            note_id: "n1",
            kind: "edit",
            summary: "Note",
            payload: null,
            created_at: new Date().toISOString(),
            note_title: "Note",
            note_alive: true,
          },
        ];
      }
      if (cmd === "note_snapshot_list") {
        return [{ id: "s1", taken_at: new Date().toISOString(), section_count: 1 }];
      }
      if (cmd === "note_snapshot_get") {
        return {
          id: "s1",
          note_id: "n1",
          taken_at: new Date().toISOString(),
          sections: [{ section_id: "sec1", title: "Main", kind: "text", body_md: "old text" }],
        };
      }
      throw new Error(`unexpected call: ${cmd}`);
    });

    render(<ActivityHistoryPanel onClose={() => {}} onRestoreSnapshot={onRestoreSnapshot} />);
    await userEvent.click(await screen.findByRole("button", { name: /autosaves/i }));
    await userEvent.click(await screen.findByText(/1 sections/i));
    await userEvent.click(await screen.findByRole("button", { name: /restore this version/i }));
    const confirmDialog = await screen.findByRole("dialog", { name: /restore this version\?/i });
    await userEvent.click(within(confirmDialog).getByRole("button", { name: /restore this version/i }));

    await waitFor(() => expect(onRestoreSnapshot).toHaveBeenCalledWith("s1"));
    expect(flushAllMock).not.toHaveBeenCalled();
    expect(callMock).not.toHaveBeenCalledWith("note_snapshot_restore", expect.anything());
  });

  // W2b 신뢰성 결함 회귀: doRestore 는 onRestoreSnapshot 을 try/finally 로만 감쌌었다(catch 없음).
  // onRestoreSnapshot 은 Promise<void> 라 언제든 거절될 수 있다 — 거절되면 `void doRestore(confirmId)`
  // 호출부에서 unhandled rejection 이 샜다(CLAUDE.md 함정 8, finally 는 rejection 을 못 잡는다).
  // 이 테스트는 그 자체로 회귀 가드다: doRestore 가 여전히 catch 없이 다시 던지면 아래 클릭이
  // unhandled rejection 을 내며 이 테스트가 실패한다.
  it("does not throw an unhandled rejection when onRestoreSnapshot rejects", async () => {
    const onRestoreSnapshot = vi.fn(async () => {
      throw new Error("boom");
    });
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "activity_list") {
        return [
          {
            id: "a1",
            workspace_id: "ws1",
            note_id: "n1",
            kind: "edit",
            summary: "Note",
            payload: null,
            created_at: new Date().toISOString(),
            note_title: "Note",
            note_alive: true,
          },
        ];
      }
      if (cmd === "note_snapshot_list") {
        return [{ id: "s1", taken_at: new Date().toISOString(), section_count: 1 }];
      }
      if (cmd === "note_snapshot_get") {
        return {
          id: "s1",
          note_id: "n1",
          taken_at: new Date().toISOString(),
          sections: [{ section_id: "sec1", title: "Main", kind: "text", body_md: "old text" }],
        };
      }
      throw new Error(`unexpected call: ${cmd}`);
    });

    render(<ActivityHistoryPanel onClose={() => {}} onRestoreSnapshot={onRestoreSnapshot} />);
    await userEvent.click(await screen.findByRole("button", { name: /autosaves/i }));
    await userEvent.click(await screen.findByText(/1 sections/i));
    await userEvent.click(await screen.findByRole("button", { name: /restore this version/i }));
    const confirmDialog = await screen.findByRole("dialog", { name: /restore this version\?/i });
    await userEvent.click(within(confirmDialog).getByRole("button", { name: /restore this version/i }));

    await waitFor(() => expect(onRestoreSnapshot).toHaveBeenCalledWith("s1"));
    // Confirm dialog closed and the panel is still usable — nothing crashed or got stuck.
    expect(screen.queryByRole("dialog", { name: /restore this version\?/i })).toBeNull();
  });

  // 신뢰성 결함 회귀: note_snapshot_list 가 실패하면 드릴다운 화면이 스피너도 없이 영원히
  // 빈 채로 남아서는 안 된다 — "저장된 스냅샷 없음" 상태로 확정돼야 한다.
  it("settles into the empty-snapshots state (not a permanent blank) when note_snapshot_list rejects", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "activity_list") {
        return [
          {
            id: "a1",
            workspace_id: "ws1",
            note_id: "n1",
            kind: "edit",
            summary: "Note",
            payload: null,
            created_at: new Date().toISOString(),
            note_title: "Note",
            note_alive: true,
          },
        ];
      }
      if (cmd === "note_snapshot_list") throw { code: "IO", message: "boom" };
      throw new Error(`unexpected call: ${cmd}`);
    });

    render(<ActivityHistoryPanel onClose={() => {}} onRestoreSnapshot={async () => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /autosaves/i }));

    // Must resolve to the determinate "no autosaves" copy, not stay blank forever.
    expect(await screen.findByText(/no autosaves yet/i)).toBeTruthy();
  });

  // 신뢰성 결함 회귀: note_snapshot_get 이 실패해도 unhandled rejection 없이 조용히 삼켜져야
  // 한다(상세 패널은 이미 null 이었으므로 그냥 안 펼쳐지는 것으로 확정 상태다).
  it("does not throw an unhandled rejection when note_snapshot_get rejects", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "activity_list") {
        return [
          {
            id: "a1",
            workspace_id: "ws1",
            note_id: "n1",
            kind: "edit",
            summary: "Note",
            payload: null,
            created_at: new Date().toISOString(),
            note_title: "Note",
            note_alive: true,
          },
        ];
      }
      if (cmd === "note_snapshot_list") {
        return [{ id: "s1", taken_at: new Date().toISOString(), section_count: 1 }];
      }
      if (cmd === "note_snapshot_get") throw { code: "IO", message: "boom" };
      throw new Error(`unexpected call: ${cmd}`);
    });

    render(<ActivityHistoryPanel onClose={() => {}} onRestoreSnapshot={async () => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /autosaves/i }));
    await userEvent.click(await screen.findByText(/1 sections/i));

    // Detail panel never appears (snapDetail stayed null) — no crash, no dangling promise.
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("note_snapshot_get", { id: "s1" }));
    expect(screen.queryByText(/restore this version/i)).toBeNull();
  });
});
