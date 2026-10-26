import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const callMock = vi.fn();
vi.mock("../lib/invoke", () => ({ call: (...a: unknown[]) => callMock(...a), callSilent: vi.fn() }));

import { BriefingButton } from "./BriefingButton";

describe("BriefingButton", () => {
  beforeEach(() => {
    callMock.mockReset();
  });

  it("opens the briefing window", async () => {
    callMock.mockResolvedValue(undefined);
    render(<BriefingButton />);
    fireEvent.click(screen.getByTestId("frame-briefing-btn"));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("briefing_window_open", {}));
  });

  it("swallows a rejected open (call() already toasted)", async () => {
    callMock.mockImplementation(() => Promise.reject(new Error("boom")));
    render(<BriefingButton />);
    fireEvent.click(screen.getByTestId("frame-briefing-btn"));
    await waitFor(() => expect(callMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20)); // 거절이 catch 에서 처리될 때까지 — 안 붙잡혔다면 여기서 미처리 rejection 으로 실패한다.
  });
});
