import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { FolderShortcutsCard } from "./FolderShortcutsCard";

const callMock = vi.fn();
const callSilentMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callSilentMock(...args),
  emitNotice: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(),
}));

describe("FolderShortcutsCard — 일반 > 폴더 바로가기", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callMock.mockResolvedValue({ ok: true });
    callSilentMock.mockResolvedValue({
      root: "C:/data",
      attachments_dir: "D:/cloud/attachments",
      backups_dir: "C:/data/backups",
      is_default: false,
      split: true,
    });
  });

  it("세 폴더 행이 지금 위치를 힌트로 보여 준다(포인터로 옮겨진 첨부 위치 포함)", async () => {
    render(<FolderShortcutsCard />);
    expect(await screen.findByText("D:/cloud/attachments")).toBeTruthy();
    expect(screen.getByText("C:/data")).toBeTruthy();
    expect(screen.getByText("C:/data/backups")).toBeTruthy();
  });

  it("열기 버튼은 각 kind 로 data_subdir_open 을 부른다", async () => {
    render(<FolderShortcutsCard />);
    fireEvent.click(screen.getByTestId("settings-folder-attachments-open"));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("data_subdir_open", { kind: "attachments" }));
    fireEvent.click(screen.getByTestId("settings-folder-backups-open"));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("data_subdir_open", { kind: "backups" }));
  });

  it("경로 조회가 실패해도 열기 버튼은 그대로 동작한다", async () => {
    callSilentMock.mockRejectedValue(new Error("x"));
    render(<FolderShortcutsCard />);
    fireEvent.click(screen.getByTestId("settings-folder-data-open"));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("data_subdir_open", { kind: "data" }));
  });
});
