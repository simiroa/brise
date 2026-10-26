import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const fetchPing = vi.fn();
vi.mock("./mobileApi", () => ({
  fetchPing: () => fetchPing(),
}));

import { MobileOfflineBanner } from "./MobileOfflineBanner";

beforeEach(() => {
  fetchPing.mockReset();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
});

describe("MobileOfflineBanner", () => {
  it("renders nothing while ping succeeds", async () => {
    fetchPing.mockResolvedValue({ app_version: "0.5.0" });
    render(<MobileOfflineBanner />);
    await waitFor(() => expect(fetchPing).toHaveBeenCalled());
    expect(screen.queryByTestId("mobile-offline-banner")).toBeNull();
  });

  it("shows the banner when ping fails, and retry hides it after a success", async () => {
    fetchPing.mockResolvedValueOnce(null);
    render(<MobileOfflineBanner />);
    expect(await screen.findByTestId("mobile-offline-banner")).toBeTruthy();

    fetchPing.mockResolvedValueOnce({ app_version: "0.5.0" });
    fireEvent.click(screen.getByText("Retry"));
    await waitFor(() => expect(screen.queryByTestId("mobile-offline-banner")).toBeNull());
  });
});
