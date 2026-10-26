import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

vi.mock("../../../lib/invoke", () => ({
  call: vi.fn(async () => ({})),
  callSilent: vi.fn(async () => ({})),
  emitNotice: vi.fn(),
  flushAll: vi.fn(async () => {}),
  registerFlush: vi.fn(() => () => {}),
}));
vi.mock("../../../lib/env", () => ({ isBrowser: () => false }));
vi.mock("../../../i18n/t", () => ({ t: (k: string) => k }));

import { BackupNudgeBanner } from "./BackupNudgeBanner";
import { useSettingsStore } from "../../../stores/settings";
import { call } from "../../../lib/invoke";

describe("BackupNudgeBanner", () => {
  beforeEach(() => {
    vi.mocked(call).mockReset();
    vi.mocked(call).mockImplementation(async () => ({}));
  });

  // 사이드바 보기 전환마다 트리가 다시 마운트된다 — 띠는 설정 스토어 값만 보고 설정 전체를 다시 읽지 않는다.
  it("reads the flag from the settings store without settings_get_all", () => {
    useSettingsStore.setState({ backupNudgePending: true });
    render(<BackupNudgeBanner />);
    expect(screen.getByText("tree.backup_nudge_message")).toBeTruthy();
    expect(vi.mocked(call).mock.calls.map((c) => c[0])).not.toContain("settings_get_all");
  });

  it("stays hidden when the flag is off", () => {
    useSettingsStore.setState({ backupNudgePending: false });
    render(<BackupNudgeBanner />);
    expect(screen.queryByText("tree.backup_nudge_message")).toBeNull();
  });

  it("dismiss persists false and rolls back when the save fails", async () => {
    useSettingsStore.setState({ backupNudgePending: true });
    vi.mocked(call).mockImplementation(async (cmd: string) => {
      if (cmd === "settings_set") throw new Error("ipc down");
      return {};
    });
    render(<BackupNudgeBanner />);
    await act(async () => {
      fireEvent.click(screen.getByLabelText("common.close"));
    });
    expect(vi.mocked(call)).toHaveBeenCalledWith("settings_set", { entries: { backup_nudge_pending: false } });
    expect(useSettingsStore.getState().backupNudgePending).toBe(true);
    expect(screen.getByText("tree.backup_nudge_message")).toBeTruthy();
  });
});
