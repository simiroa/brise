import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSettingsStore } from "../../stores/settings";
import { OnboardingConnectStep, ConnectQr } from "./OnboardingConnectStep";

const callMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
}));

const idleStatus = {
  enabled: false,
  running: false,
  bound_addr: null,
  port: 7332,
  token: "tok",
  url: null,
  qr_svg: null,
  bind_stale: false,
};

describe("OnboardingConnectStep", () => {
  beforeEach(() => {
    callMock.mockReset().mockResolvedValue(idleStatus);
    useSettingsStore.setState({ uiLang: "en" });
  });

  it("does not start the server on mount, and reports the idle status", async () => {
    const onStatusChange = vi.fn();
    render(<OnboardingConnectStep onStatusChange={onStatusChange} />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("sync_status"));

    expect(callMock).not.toHaveBeenCalledWith("sync_set_enabled", expect.anything());
    await waitFor(() => expect(onStatusChange).toHaveBeenCalledWith({ enabled: false, qrSvg: null }));
  });

  it("has no same-Wi-Fi (LAN) option", async () => {
    render(<OnboardingConnectStep onStatusChange={vi.fn()} />);
    await screen.findByTestId("onboarding-connect-tailscale");
    expect(screen.queryByTestId("onboarding-connect-lan")).toBeNull();
  });

  it("renders the app-install card visibly disabled", async () => {
    render(<OnboardingConnectStep onStatusChange={vi.fn()} />);
    const appCard = await screen.findByTestId("onboarding-connect-app-install");
    expect(appCard.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("Coming soon")).toBeTruthy();
  });

  it("starting the connection calls the enable command from the visible primary button (no toggle needed first)", async () => {
    render(<OnboardingConnectStep onStatusChange={vi.fn()} />);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("sync_status"));
    callMock.mockClear();

    await userEvent.click(screen.getByTestId("onboarding-connect-start-btn"));

    expect(callMock).toHaveBeenCalledWith("sync_set_enabled", { enabled: true });
  });

  it("shows no QR and a loopback explanation when the bound address is loopback, and reports qrSvg null", async () => {
    callMock.mockResolvedValue({
      ...idleStatus,
      enabled: true,
      running: true,
      bound_addr: "127.0.0.1:7332",
      url: "http://127.0.0.1:7332",
      qr_svg: "<svg>fake</svg>",
    });
    const onStatusChange = vi.fn();

    render(<OnboardingConnectStep onStatusChange={onStatusChange} />);

    const statusCard = await screen.findByTestId("onboarding-connect-status");
    expect(document.querySelector(".brise-connect-qr")).toBeNull();
    expect(statusCard.textContent).toMatch(/Tailscale/);
    await waitFor(() => expect(onStatusChange).toHaveBeenCalledWith({ enabled: true, qrSvg: null }));
  });

  it("reports qrSvg when the bound address is reachable (not loopback) with qr_svg present", async () => {
    callMock.mockResolvedValue({
      ...idleStatus,
      enabled: true,
      running: true,
      bound_addr: "100.64.0.1:7332",
      url: "http://100.64.0.1:7332",
      qr_svg: "<svg>fake</svg>",
    });
    const onStatusChange = vi.fn();

    render(<OnboardingConnectStep onStatusChange={onStatusChange} />);

    await screen.findByTestId("onboarding-connect-url");
    // QR itself no longer renders inside the step — only the wizard's art column does, via ConnectQr.
    expect(document.querySelector(".brise-connect-qr")).toBeNull();
    expect(screen.getByTestId("onboarding-connect-url").textContent).toBe("http://100.64.0.1:7332");
    await waitFor(() => expect(onStatusChange).toHaveBeenCalledWith({ enabled: true, qrSvg: "<svg>fake</svg>" }));
  });

  // 오너 실기(2026-09-28): QR 이 뜬 뒤엔 끌 방법이 없었다.
  it("once connected, the off button disables the server and the QR goes away", async () => {
    callMock.mockImplementation((cmd: string, args?: { enabled?: boolean }) =>
      Promise.resolve(
        cmd === "sync_set_enabled" && args?.enabled === false
          ? idleStatus
          : { ...idleStatus, enabled: true, running: true, bound_addr: "100.64.0.1:7332", qr_svg: "<svg>fake</svg>" },
      ),
    );
    const onStatusChange = vi.fn();
    render(<OnboardingConnectStep onStatusChange={onStatusChange} />);

    await userEvent.click(await screen.findByTestId("onboarding-connect-stop-btn"));

    expect(callMock).toHaveBeenCalledWith("sync_set_enabled", { enabled: false });
    await waitFor(() => expect(onStatusChange).toHaveBeenLastCalledWith({ enabled: false, qrSvg: null }));
    expect(screen.getByTestId("onboarding-connect-start-btn")).toBeTruthy();
  });

  it("on loopback, 'check again' re-enables (restart re-picks the Tailscale address)", async () => {
    callMock.mockResolvedValue({ ...idleStatus, enabled: true, running: true, bound_addr: "127.0.0.1:7332" });
    render(<OnboardingConnectStep onStatusChange={vi.fn()} />);

    await userEvent.click(await screen.findByTestId("onboarding-connect-recheck-btn"));

    expect(callMock).toHaveBeenCalledWith("sync_set_enabled", { enabled: true });
    expect(screen.getByTestId("onboarding-connect-stop-btn")).toBeTruthy();
  });
});

describe("ConnectQr", () => {
  it("renders the given svg inside the white quiet-zone box", () => {
    render(<ConnectQr svg="<svg data-testid='inner'>fake</svg>" />);
    const box = document.querySelector(".brise-connect-qr");
    expect(box).toBeTruthy();
    expect(box?.innerHTML).toContain("fake");
  });
});
