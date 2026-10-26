import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { SettingsNavFooter } from "./SettingsNavFooter";

// PLAN-2026-10-24 D2 — 레일 하단은 버전만이다. 업데이트 버튼·자동 칩은 일반 페이지 제품 카드
// (ProductUpdateCard.test.tsx)로 이사했다.

const mockGetVersion = vi.fn().mockResolvedValue("0.5.3");
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: () => mockGetVersion(),
}));

let mockBrowser = false;
vi.mock("../../lib/env", () => ({ isBrowser: () => mockBrowser }));

describe("SettingsNavFooter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBrowser = false;
    mockGetVersion.mockResolvedValue("0.5.3");
  });

  it("앱 버전만 보여준다 — 버튼도 칩도 없다", async () => {
    render(<SettingsNavFooter />);
    const footer = screen.getByTestId("settings-nav-footer");
    await waitFor(() => expect(footer.textContent).toBe("v0.5.3"));
    expect(footer.querySelector("button")).toBeNull();
    expect(footer.children).toHaveLength(0);
  });

  it("가운데 정렬·muted 의 작은 글자다", () => {
    render(<SettingsNavFooter />);
    const footer = screen.getByTestId("settings-nav-footer");
    expect(footer.style.textAlign).toBe("center");
    expect(footer.style.color).toBe("var(--muted)");
    expect(footer.style.fontSize).toBe("var(--text-xs)");
  });

  it("버전을 못 읽으면 빈 줄로 둔다", async () => {
    mockGetVersion.mockRejectedValue(new Error("no tauri"));
    render(<SettingsNavFooter />);
    await waitFor(() => expect(mockGetVersion).toHaveBeenCalled());
    expect(screen.getByTestId("settings-nav-footer").textContent).toBe("");
  });

  it("브라우저(태블릿)에서는 getVersion 을 부르지 않는다", () => {
    mockBrowser = true;
    render(<SettingsNavFooter />);
    expect(mockGetVersion).not.toHaveBeenCalled();
    expect(screen.getByTestId("settings-nav-footer").textContent).toBe("");
  });
});
