import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { HistoryMenu } from "./HistoryMenu";

const callSilentMock = vi.fn().mockResolvedValue(undefined);
const callMock = vi.fn().mockResolvedValue([]);
vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callSilentMock(...args),
  registerFlush: () => () => {},
  flushAll: async () => {},
  emitNotice: () => {},
}));

describe("HistoryMenu", () => {
  beforeEach(() => {
    callSilentMock.mockClear();
    callMock.mockClear();
  });

  // 오너 2026-10-27: 새 OS 창이 아니라 알림 벨과 같은 드롭다운 — 창은 메뉴 아래 버튼으로만.
  it("opens the activity list as a frame menu, and the window only from its footer", async () => {
    const { getByTestId, queryByTestId } = render(<HistoryMenu title="h" ariaLabel="h" />);
    fireEvent.click(getByTestId("frame-history-btn"));
    expect(getByTestId("frame-history-pop").className).toContain("frame-menu");
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("activity_list", expect.anything()));
    expect(callSilentMock).not.toHaveBeenCalledWith("activity_window_open", {});

    fireEvent.click(getByTestId("frame-history-open-window"));
    expect(callSilentMock).toHaveBeenCalledWith("activity_window_open", {});
    expect(queryByTestId("frame-history-pop")).toBeNull();
  });

  it("retries the failed save instead of opening the menu", () => {
    const onRetry = vi.fn();
    const { getByTestId, queryByTestId } = render(<HistoryMenu title="h" ariaLabel="h" onRetry={onRetry} />);
    fireEvent.click(getByTestId("frame-history-btn"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(queryByTestId("frame-history-pop")).toBeNull();
  });
});
