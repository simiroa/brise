import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AttachmentStorageSection } from "./AttachmentStorageSection";
import { useSettingsStore } from "../../stores/settings";

vi.mock("../../lib/invoke", () => ({
  call: vi.fn(() => Promise.resolve({})),
  callSilent: vi.fn(() => Promise.resolve({})),
  emitNotice: vi.fn(),
}));

const openMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openMock(...args),
}));

describe("AttachmentStorageSection", () => {
  // 히어로는 페이지 주인(DataManagementSection)이 그린다 — 카드 부품이 페이지 머리를 갖지 않는다.
  it("카드만 그리고 페이지 히어로는 그리지 않는다", () => {
    render(<AttachmentStorageSection />);
    expect(screen.getByTestId("settings-attachment-storage")).toBeTruthy();
  });

  // F9(PLAN-2026-09-15): 손 타이핑만이면 오타를 pptx 를 열 때야 안다 — 옆 카드와 같은 피커를 연다.
  it("찾아보기 버튼이 파일 피커에서 고른 경로를 그대로 저장한다", async () => {
    const setSofficePath = vi.fn().mockResolvedValue(undefined);
    useSettingsStore.setState({ sofficePath: "", setSofficePath } as never);
    openMock.mockReset().mockResolvedValue("C:/Program Files/LibreOffice/program/soffice.exe");

    render(<AttachmentStorageSection />);
    await userEvent.click(screen.getByTestId("settings-soffice-browse"));

    await waitFor(() =>
      expect(setSofficePath).toHaveBeenCalledWith("C:/Program Files/LibreOffice/program/soffice.exe"),
    );
    expect((screen.getByLabelText("LibreOffice path") as HTMLInputElement).value).toBe(
      "C:/Program Files/LibreOffice/program/soffice.exe",
    );
  });

  it("피커를 취소하면(null) 아무것도 저장하지 않는다", async () => {
    const setSofficePath = vi.fn().mockResolvedValue(undefined);
    useSettingsStore.setState({ sofficePath: "", setSofficePath } as never);
    openMock.mockReset().mockResolvedValue(null);

    render(<AttachmentStorageSection />);
    await userEvent.click(screen.getByTestId("settings-soffice-browse"));

    await waitFor(() => expect(openMock).toHaveBeenCalled());
    expect(setSofficePath).not.toHaveBeenCalled();
  });
});
