import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { SearchBox } from "./SearchBox";
import { useSearchStore } from "../../stores/search";
import { useUiStore } from "../../stores/ui";

vi.mock("../../lib/invoke", () => ({
  call: vi.fn().mockResolvedValue({ results: [], total: 0 }),
  callSilent: vi.fn().mockResolvedValue({ results: [], total: 0 }),
  flushAll: vi.fn(),
  registerFlush: () => () => {},
  emitNotice: vi.fn(),
}));

describe("SearchBox — filter toggle + reset badge", () => {
  beforeEach(() => {
    useSearchStore.setState({
      query: "",
      yearBounds: { min: 1900, max: 2000 },
      yearFrom: 1900,
      yearTo: 2000,
      selectedTags: [],
      regionFilter: null,
      statusFilter: [],
      dateRange: null,
      searchResults: [],
      filterMode: "tree",
    });
    useUiStore.setState({ filtersOpen: false });
  });

  it("shows filter toggle when chrome is visible", () => {
    render(<SearchBox />);
    expect(screen.getByTestId("filter-strip-toggle")).toBeTruthy();
  });

  it("hides filter chrome in chat mode", () => {
    render(<SearchBox hideFilterChrome />);
    expect(screen.queryByTestId("filter-strip-toggle")).toBeNull();
    expect(screen.queryByTestId("filter-reset-badge")).toBeNull();
  });

  it("shows numeric reset badge when filtered; click clears axes", () => {
    useSearchStore.setState({
      query: "hello",
      yearFrom: 1950,
      yearTo: 1990,
      selectedTags: ["tag1"],
      regionFilter: { kind: "none" },
      statusFilter: ["done"],
      dateRange: "last7",
    });

    render(<SearchBox />);

    const badge = screen.getByTestId("filter-reset-badge");
    // query + year + tags + region + status + dateRange = 6
    expect(badge.textContent).toBe("6");
    fireEvent.click(badge);

    const s = useSearchStore.getState();
    expect(s.query).toBe("");
    expect(s.selectedTags).toEqual([]);
    expect(s.regionFilter).toBeNull();
    expect(s.statusFilter).toEqual([]);
    expect(s.dateRange).toBeNull();
    expect(s.yearFrom).toBe(1900);
    expect(s.yearTo).toBe(2000);
  });

  it("clicking the toggle opens the filter modal", () => {
    render(<SearchBox />);
    fireEvent.click(screen.getByTestId("filter-strip-toggle"));
    expect(useUiStore.getState().filtersOpen).toBe(true);
  });

  it("shows reset badge regardless of modal open state (badge is unified reset affordance)", () => {
    useSearchStore.setState({ query: "x" });
    useUiStore.setState({ filtersOpen: true });
    render(<SearchBox />);
    expect(screen.getByTestId("filter-reset-badge")).toBeTruthy();
  });

  it("reset badge overlays a fixed-size toggle wrapper and does not change search row height", () => {
    const { rerender } = render(<SearchBox />);
    const row = screen.getByTestId("search-box");
    const wrap = screen.getByTestId("filter-toggle-wrap");
    expect(wrap.style.position).toBe("relative");
    expect(wrap.style.width).toBe("var(--row-search)");
    expect(wrap.style.height).toBe("var(--row-search)");
    expect(wrap.style.overflow).toBe("visible");
    const heightWithout = row.getBoundingClientRect().height;

    act(() => {
      useSearchStore.setState({ query: "hello" });
    });
    rerender(<SearchBox />);

    const badge = screen.getByTestId("filter-reset-badge");
    expect(badge.style.position).toBe("absolute");
    expect(wrap.contains(badge)).toBe(true);
    expect(wrap.style.height).toBe("var(--row-search)");
    expect(row.getBoundingClientRect().height).toBe(heightWithout);
  });
});
