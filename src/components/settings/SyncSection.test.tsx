import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SyncSection } from "./SyncSection";

const callMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  // Same mock as call() — the tests below assert on callMock regardless of which one the
  // component used; the split only matters to SyncSection.tsx's own toast-vs-silent behavior.
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
}));

const disabledStatus = {
  enabled: false,
  running: false,
  bound_addr: null,
  port: 7332,
  token: "",
  url: null,
  qr_svg: null,
  bind_stale: false,
};

const runningStatus = {
  enabled: true,
  running: true,
  bound_addr: "100.90.12.3:7332",
  port: 7332,
  token: "abcd1234efgh5678",
  url: "http://100.90.12.3:7332/m?token=abcd1234efgh5678",
  qr_svg: "<svg data-testid=\"qr-svg\"><rect/></svg>",
  bind_stale: false,
};

describe("SyncSection", () => {
  beforeEach(() => {
    callMock.mockReset();
  });

  it("loads sync_status on mount and renders the toggle", async () => {
    callMock.mockResolvedValue(disabledStatus);
    render(<SyncSection />);

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("sync_status"));
    expect(await screen.findByText("External Connection")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Turn on sync server" })).toBeTruthy();
  });

  it("shows running status without address, bound address in tile, and copyable URL when enabled+running", async () => {
    callMock.mockResolvedValue(runningStatus);
    render(<SyncSection />);

    const runningStatusEl = await screen.findByText("Running");
    expect(runningStatusEl).toBeTruthy();
    expect(runningStatusEl.textContent).not.toContain("100.90.12.3:7332");
    expect(screen.getByTestId("settings-sync-bind").textContent).toContain("100.90.12.3:7332");
    expect(screen.getByText(runningStatus.url)).toBeTruthy();
    // 주소 복사·토큰 재발급은 아이콘 버튼 — 이름은 aria-label(=title)로만 있다.
    expect(screen.getByRole("button", { name: "Regenerate" })).toBeTruthy();
    expect(screen.getByTestId("settings-sync-copy-url").getAttribute("title")).toBe("Copy Access URL");
  });

  it("shows the no-Tailscale warning when bound to loopback and opens one-time dialog on enable", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "sync_status") return disabledStatus;
      if (cmd === "sync_set_enabled") {
        return { ...runningStatus, bound_addr: "127.0.0.1:7332", url: "http://127.0.0.1:7332/app?token=x" };
      }
      return {};
    });
    render(<SyncSection />);

    const toggle = await screen.findByRole("switch", { name: "Turn on sync server" });
    await userEvent.click(toggle);

    expect(await screen.findByText(/Tailscale required for external access/)).toBeTruthy();
    expect(screen.getByTestId("settings-sync-tailscale-download-btn")).toBeTruthy();
    expect(screen.getByTestId("settings-sync-tailscale-close-btn")).toBeTruthy();

    await userEvent.click(screen.getByTestId("settings-sync-tailscale-close-btn"));
    expect(screen.queryByTestId("settings-sync-tailscale-close-btn")).toBeNull();

    // 인라인 경고는 계속 상주
    expect(screen.getByText(/No Tailscale interface found/)).toBeTruthy();
  });

  it("renders the QR code svg (token-embedded URL) when running", async () => {
    callMock.mockResolvedValue(runningStatus);
    const { container } = render(<SyncSection />);

    await screen.findByText(runningStatus.url);
    expect(container.querySelector('[data-testid="qr-svg"]')).toBeTruthy();
    expect(await screen.findByText("Scan with your phone camera to open it instantly")).toBeTruthy();
  });

  it("shows no QR code when disabled", async () => {
    callMock.mockResolvedValue(disabledStatus);
    const { container } = render(<SyncSection />);

    await screen.findByRole("switch", { name: "Turn on sync server" });
    expect(container.querySelector('[data-testid="qr-svg"]')).toBeFalsy();
  });

  it("toggling calls sync_set_enabled with the flipped value", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "sync_status") return disabledStatus;
      if (cmd === "sync_set_enabled") return runningStatus;
      return {};
    });
    render(<SyncSection />);

    const toggle = await screen.findByRole("switch", { name: "Turn on sync server" });
    await userEvent.click(toggle);

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("sync_set_enabled", { enabled: true }));
    expect(await screen.findByRole("button", { name: "Regenerate" })).toBeTruthy();
  });

  it("regenerate token button calls sync_regenerate_token", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "sync_status") return runningStatus;
      if (cmd === "sync_regenerate_token") return { ...runningStatus, token: "new-token" };
      return {};
    });
    render(<SyncSection />);

    await userEvent.click(await screen.findByRole("button", { name: "Regenerate" }));
    // 재발급은 붙어 있는 모든 기기를 끊는다 — 확인을 한 번 거친다.
    expect(callMock).not.toHaveBeenCalledWith("sync_regenerate_token");
    expect(await screen.findByText(/connected devices/i)).toBeTruthy();
    const regenerateButtons = screen.getAllByRole("button", { name: "Regenerate" });
    await userEvent.click(regenerateButtons[regenerateButtons.length - 1]);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("sync_regenerate_token"));
  });

  it("a failed first load shows an error with retry instead of an empty page", async () => {
    callMock.mockRejectedValueOnce(new Error("ipc down"));
    render(<SyncSection />);

    expect(await screen.findByTestId("settings-sync-load-failed")).toBeTruthy();
    callMock.mockResolvedValue(runningStatus);
    await userEvent.click(screen.getByTestId("settings-sync-retry"));
    expect(await screen.findByText("Running")).toBeTruthy();
    expect(screen.queryByTestId("settings-sync-load-failed")).toBeNull();
  });

  it("the focus/poll reload does not overwrite a port the user is typing", async () => {
    callMock.mockResolvedValue(runningStatus);
    render(<SyncSection />);
    const input = (await screen.findByTestId("settings-sync-port")) as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "8123");

    callMock.mockClear();
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("sync_status"));
    await new Promise((r) => setTimeout(r, 0));
    expect(input.value).toBe("8123");
  });

  it("saving the port rolls the field back when settings_set fails", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "sync_status") return runningStatus;
      if (cmd === "settings_set") throw new Error("nope");
      return {};
    });
    render(<SyncSection />);
    const input = (await screen.findByTestId("settings-sync-port")) as HTMLInputElement;
    await userEvent.clear(input);
    await userEvent.type(input, "8123");
    input.blur();

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { sync_port: 8123 } }));
    await waitFor(() => expect(input.value).toBe("7332"));
  });

  it("polls sync_status every 20s while enabled, and stops once disabled", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      callMock.mockResolvedValue(runningStatus);
      render(<SyncSection />);
      await act(() => vi.advanceTimersByTimeAsync(0)); // flush the mount-time load()
      expect(callMock).toHaveBeenCalledWith("sync_status");
      callMock.mockClear();

      await act(() => vi.advanceTimersByTimeAsync(20_000));
      expect(callMock).toHaveBeenCalledWith("sync_status");

      callMock.mockClear();
      callMock.mockResolvedValue(disabledStatus);
      await act(() => vi.advanceTimersByTimeAsync(20_000)); // this poll flips status.enabled false, clearing the interval
      expect(callMock).toHaveBeenCalledWith("sync_status");

      callMock.mockClear();
      await act(() => vi.advanceTimersByTimeAsync(25_000));
      expect(callMock).not.toHaveBeenCalledWith("sync_status");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refetches sync_status on window focus", async () => {
    callMock.mockResolvedValue(runningStatus);
    render(<SyncSection />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("sync_status"));
    callMock.mockClear();

    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("sync_status"));
  });

  it("shows a warning line when enabled but the server isn't running", async () => {
    callMock.mockResolvedValue({ ...runningStatus, running: false, bound_addr: null, url: null });
    render(<SyncSection />);

    expect(await screen.findByText("Sync server isn't running right now.")).toBeTruthy();
  });

  it("shows the bind_stale warning when the backend reports it (additive field)", async () => {
    callMock.mockResolvedValue({ ...runningStatus, bind_stale: true });
    render(<SyncSection />);

    expect(await screen.findByText(/Network address changed/)).toBeTruthy();
  });

  // PLAN-2026-10-24 D4: 활성화 토글은 페이지 첫 줄 설정 행에 베타 배지와 함께 선다. 모바일 배지는 사라졌다.
  it("first row holds the beta badge and the enable toggle; no mobile badge", async () => {
    callMock.mockResolvedValue(runningStatus);
    render(<SyncSection />);

    await screen.findByText(runningStatus.url);
    const actions = screen.getByTestId("settings-sync-master-card");
    expect(actions.contains(screen.getByRole("switch", { name: "Turn on sync server" }))).toBe(true);
    expect(actions.textContent).not.toContain("Mobile");
  });

  it("shows bind address with a copy button while enabled", async () => {
    callMock.mockResolvedValue(runningStatus);
    render(<SyncSection />);

    await screen.findByText(runningStatus.url);
    expect(screen.getByTestId("settings-sync-bind").textContent).toContain("100.90.12.3:7332");
    expect(screen.getByTestId("settings-sync-bind-copy")).toBeTruthy();
    expect(screen.getByTestId("settings-sync-token-copy")).toBeTruthy();
  });

  it("shows one danger badge in the card header for down/loopback/stale, none when healthy", async () => {
    callMock.mockResolvedValue({ ...runningStatus, bind_stale: true });
    const { unmount } = render(<SyncSection />);
    await screen.findByText(/Network address changed/);
    expect(screen.getByTestId("settings-sync-warning-badge")).toBeTruthy();
    unmount();

    callMock.mockResolvedValue(runningStatus);
    render(<SyncSection />);
    await screen.findByText(runningStatus.url);
    expect(screen.queryByTestId("settings-sync-warning-badge")).toBeNull();
  });

  it("does not show the bind_stale warning when the backend reports it false", async () => {
    callMock.mockResolvedValue(runningStatus);
    render(<SyncSection />);

    await screen.findByText(runningStatus.url);
    expect(screen.queryByText(/Network address changed/)).toBeNull();
  });
});
