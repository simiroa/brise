import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSettingsStore } from "../../stores/settings";
import { useOnboardingSession } from "../../stores/onboardingSession";
import { OnboardingDataStep } from "./OnboardingDataStep";

const callMock = vi.fn();
const callSilentMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callSilentMock(...args),
}));

const openMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openMock(...args),
}));

const CURRENT = {
  root: "C:/Users/me/AppData/Roaming/brise",
  attachments_dir: "C:/Users/me/AppData/Roaming/brise/attachments",
  backups_dir: "C:/Users/me/AppData/Roaming/brise/backups",
  is_default: true,
  split: false,
};

// PLAN-2026-09-28-onboarding-rebuild.md §6 — data_location_inspect output contract.
function inspection(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    path: "D:/new-location",
    cloud_provider: null,
    writable: true,
    has_existing_data: false,
    free_bytes: 812 * 1024 * 1024 * 1024,
    total_bytes: 1024 * 1024 * 1024 * 1024,
    current_data_bytes: 24 * 1024 * 1024,
    ...overrides,
  };
}

describe("OnboardingDataStep", () => {
  beforeEach(() => {
    callMock.mockReset();
    // data_location_get -> CURRENT, data_location_inspect(현재 위치) -> 여유 공간 숫자.
    callSilentMock.mockReset().mockImplementation((cmd: string) =>
      Promise.resolve(cmd === "data_location_inspect" ? inspection({ path: CURRENT.root, has_existing_data: true }) : CURRENT),
    );
    openMock.mockReset();
    useSettingsStore.setState({
      uiLang: "en",
      attachmentStorageMode: "copy",
      setAttachmentStorageMode: vi.fn().mockResolvedValue(undefined),
    } as never);
    useOnboardingSession.getState().restart();
  });

  it("shows the current storage location from data_location_get", async () => {
    render(<OnboardingDataStep />);
    await waitFor(() => expect(screen.getByTestId("onboarding-data-path").textContent).toContain("brise"));
    expect(callSilentMock).toHaveBeenCalledWith("data_location_get");
  });

  it("shows the drive space bar for the current location before any folder is picked", async () => {
    render(<OnboardingDataStep />);
    await waitFor(() => expect(callSilentMock).toHaveBeenCalledWith("data_location_inspect", { path: CURRENT.root }));
    await waitFor(() => {
      const bar = screen.getByTestId("onboarding-data-space-bar-ratio");
      expect(bar.textContent).toContain("GB");
      expect(bar.textContent).toContain("24 MB");
    });
  });

  it("picking a folder inspects it and renders the space bar numbers", async () => {
    openMock.mockResolvedValue("D:/new-location");
    callMock.mockResolvedValue(inspection());
    render(<OnboardingDataStep />);

    await userEvent.click(screen.getByTestId("onboarding-data-pick"));

    await waitFor(() => expect(callMock).toHaveBeenCalledWith("data_location_inspect", { path: "D:/new-location" }));
    // formatSize renders a human size — just check the ratio caption carries free/total/current.
    await waitFor(() => {
      const bar = screen.getByTestId("onboarding-data-space-bar-ratio");
      expect(bar.textContent).toContain("GB");
      expect(bar.textContent).toContain("24 MB");
    });
  });

  it("picking a folder sets pendingDataPath as a draft — apply is never called here", async () => {
    openMock.mockResolvedValue("D:/new-location");
    callMock.mockResolvedValue(inspection());
    render(<OnboardingDataStep />);

    await userEvent.click(screen.getByTestId("onboarding-data-pick"));

    await waitFor(() => expect(useOnboardingSession.getState().pendingDataPath).toBe("D:/new-location"));
    expect(callMock).not.toHaveBeenCalledWith("data_location_apply", expect.anything());
  });

  it("shows the cloud split note when the candidate folder is a cloud sync folder", async () => {
    openMock.mockResolvedValue("D:/OneDrive/brise-data");
    callMock.mockResolvedValue(inspection({ cloud_provider: "OneDrive" }));
    render(<OnboardingDataStep />);

    await userEvent.click(screen.getByTestId("onboarding-data-pick"));

    await waitFor(() => expect(screen.getByTestId("onboarding-data-cloud-note").textContent).toContain("OneDrive"));
    expect(screen.getByText("Notes (this PC)")).toBeTruthy();
  });

  it("a not-writable folder shows an inline error and does not accept the choice", async () => {
    openMock.mockResolvedValue("D:/locked");
    callMock.mockResolvedValue(inspection({ writable: false }));
    render(<OnboardingDataStep />);

    await userEvent.click(screen.getByTestId("onboarding-data-pick"));

    await waitFor(() => expect(screen.getByTestId("onboarding-data-error")).toBeTruthy());
    expect(useOnboardingSession.getState().pendingDataPath).toBeNull();
  });

  it("a folder that already has Brise data shows an inline error and does not accept the choice", async () => {
    openMock.mockResolvedValue("D:/other-brise-install");
    callMock.mockResolvedValue(inspection({ has_existing_data: true }));
    render(<OnboardingDataStep />);

    await userEvent.click(screen.getByTestId("onboarding-data-pick"));

    await waitFor(() => expect(screen.getByTestId("onboarding-data-error")).toBeTruthy());
    expect(useOnboardingSession.getState().pendingDataPath).toBeNull();
  });

  it("cancelling the folder dialog leaves the current selection untouched", async () => {
    openMock.mockResolvedValue(null);
    render(<OnboardingDataStep />);

    await userEvent.click(screen.getByTestId("onboarding-data-pick"));

    await waitFor(() => expect(openMock).toHaveBeenCalled());
    expect(callMock).not.toHaveBeenCalled();
    expect(useOnboardingSession.getState().pendingDataPath).toBeNull();
  });

  it("changing the attachment policy dropdown calls setAttachmentStorageMode immediately", async () => {
    render(<OnboardingDataStep />);

    await userEvent.click(screen.getByRole("button", { name: "Attachment storage mode" }));
    await userEvent.click(screen.getByRole("option", { name: "Hardlink (Save space)" }));

    expect(useSettingsStore.getState().setAttachmentStorageMode).toHaveBeenCalledWith("link");
  });

  it("shows the reference-mode warning instead of the normal hint when reference is selected", () => {
    useSettingsStore.setState({ attachmentStorageMode: "reference" } as never);
    render(<OnboardingDataStep />);
    expect(screen.getByText(/cannot be opened/i)).toBeTruthy();
  });
});
