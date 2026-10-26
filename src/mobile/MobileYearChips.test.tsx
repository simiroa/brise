import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useSearchStore } from "../stores/search";
import { useTaxonomyStore } from "../stores/taxonomy";
import { clampYearChip, MobileYearChips } from "./MobileYearChips";

beforeEach(() => {
  useSearchStore.setState({
    yearBounds: { min: 1900, max: 2100 },
    yearFrom: 1900,
    yearTo: 2100,
  } as any);
  useTaxonomyStore.setState({ eras: [], loaded: true } as any);
});

describe("clampYearChip", () => {
  it("returns null when the range collapses or covers the full bounds", () => {
    expect(clampYearChip(2026, 2026, { min: 1900, max: 2100 })).toBeNull();
    expect(clampYearChip(1800, 2200, { min: 1900, max: 2100 })).toBeNull();
  });

  it("clamps into bounds when the span still filters", () => {
    expect(clampYearChip(2017, 2026, { min: 1900, max: 2100 })).toEqual({ from: 2017, to: 2026 });
  });
});

describe("MobileYearChips", () => {
  it("applies last-10 as setYearRange and re-tap restores full bounds", () => {
    render(<MobileYearChips nowYear={2026} />);
    const chip = screen.getByTestId("mobile-filter-year-last10");
    fireEvent.click(chip);
    expect(useSearchStore.getState().yearFrom).toBe(2017);
    expect(useSearchStore.getState().yearTo).toBe(2026);
    expect(chip.getAttribute("data-active")).toBe("true");

    fireEvent.click(chip);
    expect(useSearchStore.getState().yearFrom).toBe(1900);
    expect(useSearchStore.getState().yearTo).toBe(2100);
  });

  it("renders a taxonomy era chip and applies its range", () => {
    useTaxonomyStore.setState({
      eras: [{ id: "joseon", workspace_id: "w1", name: "조선", from_year: 1392, to_year: 1897, position: 0 }],
    } as any);
    // Bounds must include the era or clampYearChip drops it.
    useSearchStore.setState({ yearBounds: { min: 1000, max: 2100 }, yearFrom: 1000, yearTo: 2100 } as any);

    render(<MobileYearChips nowYear={2026} />);
    fireEvent.click(screen.getByTestId("mobile-filter-year-era-joseon"));
    expect(useSearchStore.getState().yearFrom).toBe(1392);
    expect(useSearchStore.getState().yearTo).toBe(1897);
  });
});
