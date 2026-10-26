import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useSearchStore } from "../stores/search";
import { MobileYearRangeSlider } from "./MobileYearRangeSlider";

// Rail spans x=0..300 on an axis 2000..2030 → 10px per year.
const RAIL = { left: 0, width: 300, top: 0, height: 2, right: 300, bottom: 2, x: 0, y: 0, toJSON: () => ({}) };

beforeEach(() => {
  useSearchStore.setState({ yearCounts: {} } as any);
  // data 2001..2029 → padYearRange → axis 2000..2030
  useSearchStore.getState().applyYearCounts({ 2001: 2, 2029: 5 });
  useSearchStore.getState().setYearRange(2000, 2030);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(RAIL as DOMRect);
});
afterEach(() => vi.restoreAllMocks());

const track = () => screen.getByTestId("mobile-year-range-track");

describe("MobileYearRangeSlider", () => {
  it("full range: muted label names the real note years (not the axis padding), no reset", () => {
    render(<MobileYearRangeSlider />);
    const label = screen.getByTestId("mobile-year-range-label");
    expect(label.textContent).toBe("2001 – 2029");
    expect(label.getAttribute("data-full")).toBe("true");
    expect(screen.queryByTestId("mobile-year-range-reset")).toBeNull();
  });

  it("dragging grabs the nearest handle and commits setYearRange once, on release", () => {
    const spy = vi.spyOn(useSearchStore.getState(), "setYearRange");
    useSearchStore.setState({ setYearRange: spy } as any);
    render(<MobileYearRangeSlider />);
    // x=10 → within 22px of the "from" handle (x=0)
    fireEvent.pointerDown(track(), { button: 0, pointerId: 1, clientX: 10 });
    fireEvent.pointerMove(track(), { pointerId: 1, clientX: 100 });
    // Live label follows the finger; no query yet.
    expect(screen.getByTestId("mobile-year-range-label").textContent).toBe("2010 – 2029");
    expect(spy).not.toHaveBeenCalled();
    fireEvent.pointerUp(track(), { pointerId: 1, clientX: 100 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(2010, 2030);
  });

  it("the right side of the track moves the 'to' handle; handles never cross (≥1 year apart)", () => {
    render(<MobileYearRangeSlider />);
    fireEvent.pointerDown(track(), { button: 0, pointerId: 1, clientX: 290 }); // near the "to" handle (x=300)
    fireEvent.pointerMove(track(), { pointerId: 1, clientX: -50 }); // far left
    fireEvent.pointerUp(track(), { pointerId: 1 });
    const s = useSearchStore.getState();
    expect(s.yearFrom).toBe(2000);
    expect(s.yearTo).toBe(2001);
  });

  it("a tap far from both handles does not move anything (M-6)", () => {
    useSearchStore.getState().setYearRange(2010, 2020);
    render(<MobileYearRangeSlider />);
    fireEvent.pointerDown(track(), { button: 0, pointerId: 1, clientX: 150 });
    fireEvent.pointerUp(track(), { pointerId: 1, clientX: 150 });
    expect(useSearchStore.getState().yearFrom).toBe(2010);
    expect(useSearchStore.getState().yearTo).toBe(2020);
  });

  it("dragging a handle onto the data edge commits the padded axis end (U-9)", () => {
    useSearchStore.getState().setYearRange(2010, 2020);
    render(<MobileYearRangeSlider />);
    fireEvent.pointerDown(track(), { button: 0, pointerId: 1, clientX: 100 }); // from handle (2010)
    fireEvent.pointerMove(track(), { pointerId: 1, clientX: 10 }); // 2001 = data min
    fireEvent.pointerUp(track(), { pointerId: 1, clientX: 10 });
    expect(useSearchStore.getState().yearFrom).toBe(2000);
  });

  it("pointercancel (scroll steal) discards the draft", () => {
    render(<MobileYearRangeSlider />);
    fireEvent.pointerDown(track(), { button: 0, pointerId: 1, clientX: 150 });
    fireEvent.pointerCancel(track(), { pointerId: 1 });
    expect(useSearchStore.getState().yearFrom).toBe(2000);
    expect(useSearchStore.getState().yearTo).toBe(2030);
  });

  it("narrowed range: accent label + reset back to the full axis", () => {
    useSearchStore.getState().setYearRange(2010, 2020);
    render(<MobileYearRangeSlider />);
    const label = screen.getByTestId("mobile-year-range-label");
    expect(label.textContent).toBe("2010 – 2020");
    expect(label.getAttribute("data-full")).toBeNull();
    fireEvent.click(screen.getByTestId("mobile-year-range-reset"));
    expect(useSearchStore.getState().yearFrom).toBe(2000);
    expect(useSearchStore.getState().yearTo).toBe(2030);
  });

  it("handles are keyboard sliders (←/→ = 1 year)", () => {
    render(<MobileYearRangeSlider />);
    const from = screen.getByTestId("mobile-year-range-from");
    expect(from.getAttribute("role")).toBe("slider");
    fireEvent.keyDown(from, { key: "ArrowRight" });
    expect(useSearchStore.getState().yearFrom).toBe(2001);
  });

  it("renders one density mark per year with notes", () => {
    const { container } = render(<MobileYearRangeSlider />);
    expect(container.querySelectorAll(".mobile-year-range-mark")).toHaveLength(2);
  });
});
