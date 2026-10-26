import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { IconPickerPopover } from "./IconPicker";

describe("IconPickerPopover", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("clamps left position to at least 12px even on narrow viewports", () => {
    // Simulate very small window width or negative target
    vi.stubGlobal("innerWidth", 200);
    vi.stubGlobal("innerHeight", 500);

    const anchorRect = {
      right: 0,
      top: 50,
      left: -50,
      bottom: 70,
      width: 50,
      height: 20,
    } as DOMRect;

    render(
      <IconPickerPopover anchorRect={anchorRect} onClose={() => {}}>
        <div>Picker Content</div>
      </IconPickerPopover>,
    );

    const popover = screen.getByTestId("icon-picker-popover");
    expect(popover).toBeDefined();
    // left should be clamped to at least 12px
    expect(popover.style.left).toBe("12px");
  });

  it("recomputes position dynamically when window resize event is triggered", () => {
    vi.stubGlobal("innerWidth", 1000);
    vi.stubGlobal("innerHeight", 800);

    const anchorRect = {
      right: 100,
      top: 50,
      left: 80,
      bottom: 70,
      width: 20,
      height: 20,
    } as DOMRect;

    render(
      <IconPickerPopover anchorRect={anchorRect} onClose={() => {}}>
        <div>Picker Content</div>
      </IconPickerPopover>,
    );

    const popover = screen.getByTestId("icon-picker-popover");
    // W = 310, anchorRect.right + 6 = 106. window.innerWidth - 310 - 12 = 678.
    // min(106, 678) = 106. max(12, 106) = 106px.
    expect(popover.style.left).toBe("106px");

    // Resize window to narrow width: 400px.
    // window.innerWidth - W - 12 = 400 - 310 - 12 = 78.
    // min(106, 78) = 78. max(12, 78) = 78px.
    act(() => {
      vi.stubGlobal("innerWidth", 400);
      window.dispatchEvent(new Event("resize"));
    });

    expect(popover.style.left).toBe("78px");
  });
});
