import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { useSettingsStore } from "../../stores/settings";
import { NotificationsCard } from "./NotificationsCard";

const callMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(),
}));

let mockBrowser = false;
vi.mock("../../lib/env", () => ({
  isBrowser: () => mockBrowser,
}));

describe("NotificationsCard — 일반 > 알림 (PLAN-2026-10-27, 달력 및 일정에서 이사)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBrowser = false;
    callMock.mockResolvedValue({});
    useSettingsStore.setState({
      uiLang: "ko",
      closeToTray: true,
      notificationsEnabled: false,
      reminderAllDayAt: "00:00",
    } as any);
  });

it("알림 마스터는 기본 OFF 이고 켜면 notifications_enabled 를 저장한다", async () => {
    render(<NotificationsCard />);
    const toggle = screen.getByTestId("settings-switch-notifications");
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { notifications_enabled: true } }),
    );
  });

  it("종일 노트 알림 시각은 00:00 에서 시작해 reminder_all_day_at 로 저장된다", async () => {
    render(<NotificationsCard />);
    const input = screen.getByTestId("settings-notifications-all-day-at") as HTMLInputElement;
    expect(input.value).toBe("00:00");

    // fireEvent (not userEvent.type) — native <input type="time"> needs a single onChange with
    // the full value. 저장은 입력마다가 아니라 포커스 이탈(또는 Enter)에서 한 번(TimeField).
    expect(input.getAttribute("aria-label")).toBe("종일 노트 알림 시각");
    fireEvent.change(input, { target: { value: "09:00" } });
    expect(callMock).not.toHaveBeenCalledWith("settings_set", expect.anything());
    fireEvent.blur(input);
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { reminder_all_day_at: "09:00" } }),
    );
  });

  it("트레이 경고는 close_to_tray 가 꺼지고 알림이 켜졌을 때만, 데스크톱에서만 뜬다", () => {
    act(() => {
      useSettingsStore.setState({ notificationsEnabled: true, closeToTray: true });
    });
    const { rerender } = render(<NotificationsCard />);
    expect(screen.queryByTestId("settings-notifications-needs-tray")).toBeNull();

    act(() => {
      useSettingsStore.setState({ notificationsEnabled: true, closeToTray: false });
    });
    rerender(<NotificationsCard />);
    expect(screen.getByTestId("settings-notifications-needs-tray")).toBeTruthy();

    act(() => {
      useSettingsStore.setState({ notificationsEnabled: false, closeToTray: false });
    });
    rerender(<NotificationsCard />);
    expect(screen.queryByTestId("settings-notifications-needs-tray")).toBeNull();
  });

  // W2-ⓓ 회귀(GeneralSection 시절): 브라우저에는 트레이도, 원인을 고칠 토글도 없다 — 할 수 있는
  // 일이 없는 경고는 띄우지 않는다.
  it("브라우저 모드에서는 트레이 경고가 뜨지 않는다", () => {
    mockBrowser = true;
    act(() => {
      useSettingsStore.setState({ notificationsEnabled: true, closeToTray: false });
    });
    render(<NotificationsCard />);
    expect(screen.queryByTestId("settings-notifications-needs-tray")).toBeNull();
  });
});
