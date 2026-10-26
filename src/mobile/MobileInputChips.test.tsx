import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { t } from "../i18n/t";
import { MobileInputChips, type InputChip } from "./MobileInputChips";

const chip = (over: Partial<InputChip> = {}): InputChip => ({
  key: "k1",
  text: "내일 · 2026-10-08",
  onApply: vi.fn(),
  onDismiss: vi.fn(),
  ...over,
});

describe("MobileInputChips", () => {
  it("renders nothing without chips", () => {
    const { container } = render(<MobileInputChips chips={[]} />);
    expect(container.firstChild).toBeNull();
  });

  describe("S2 suggestion cards (default variant)", () => {
    it("the wrapper keeps its test id and carries .mobile-input-chips — the class the keyboard-open rule hides", () => {
      render(<MobileInputChips chips={[chip()]} />);
      const wrap = screen.getByTestId("mobile-input-chips");
      expect(wrap.className).toContain("mobile-input-chips");
    });

    it("Apply and Dismiss go to the chip's own handlers", async () => {
      const c = chip();
      render(<MobileInputChips chips={[c]} />);
      fireEvent.click(screen.getByText(t("mobileInput.chip_apply")));
      await waitFor(() => expect(c.onApply).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByText(t("mobileInput.chip_dismiss")));
      expect(c.onDismiss).toHaveBeenCalledTimes(1);
    });
  });

  describe("typing-nudge row (variant=nudge)", () => {
    it("is its own row (.mobile-nudge-row) — NOT the class the keyboard-open rule hides", () => {
      render(<MobileInputChips chips={[chip({ nudge: true })]} variant="nudge" />);
      const row = screen.getByTestId("mobile-nudge-chips");
      expect(row.className).toContain("mobile-nudge-row");
      expect(row.className).not.toContain("mobile-input-chips");
    });

    it("the chip and its × keep the editor focus (mousedown default prevented)", () => {
      render(<MobileInputChips chips={[chip({ nudge: true })]} variant="nudge" />);
      expect(fireEvent.mouseDown(screen.getByText("내일 · 2026-10-08"))).toBe(false);
      expect(fireEvent.mouseDown(screen.getByLabelText(t("mobileInput.chip_dismiss")))).toBe(false);
    });
  });
});
