import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ActiveFilterChips } from "./ActiveFilterChips";
import { useSearchStore } from "../../stores/search";
import { useTaxonomyStore } from "../../stores/taxonomy";
import { useUiStore } from "../../stores/ui";
import { t } from "../../i18n/t";

vi.mock("../../lib/invoke", () => ({
  call: vi.fn(async () => ({})),
  callSilent: vi.fn(),
  flushAll: vi.fn(async () => {}),
  registerFlush: vi.fn(() => () => {}),
  emitNotice: vi.fn(),
}));

function baseState() {
  return {
    filterMode: "tree" as const,
    query: "",
    yearBounds: { min: 1900, max: 2000 },
    yearFrom: 1900,
    yearTo: 2000,
    selectedTags: [],
    statusFilter: [],
    dateRange: null,
    regionFilter: null,
  };
}

describe("ActiveFilterChips", () => {
  beforeEach(() => {
    useSearchStore.setState(baseState());
    useTaxonomyStore.setState({ statuses: [], regions: [], eras: [], workspaceId: "ws1", loaded: true });
    useUiStore.setState({ filtersOpen: false });
  });

  it("renders nothing with zero active axes", () => {
    const { container } = render(<ActiveFilterChips />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing in chat mode even with active axes", () => {
    useSearchStore.setState({ ...baseState(), filterMode: "chat", statusFilter: ["done"] });
    const { container } = render(<ActiveFilterChips />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a chip per active axis: status, tag, region, date, year", () => {
    useSearchStore.setState({
      ...baseState(),
      statusFilter: ["done"],
      selectedTags: ["fantasy"],
      regionFilter: { kind: "region", name: "서울" },
      dateRange: "last7",
      yearFrom: 1950,
      yearTo: 1990,
    });
    render(<ActiveFilterChips />);
    expect(screen.getByText(t("status.done"))).toBeTruthy();
    expect(screen.getByText("#fantasy")).toBeTruthy();
    expect(screen.getByText(t("search.filter_chip_region", { name: "서울" }))).toBeTruthy();
    expect(screen.getByText(t("search.date_range_last7"))).toBeTruthy();
    expect(screen.getByText("1950–1990")).toBeTruthy();
  });

  it("query alone renders no chip", () => {
    useSearchStore.setState({ ...baseState(), query: "hello" });
    const { container } = render(<ActiveFilterChips />);
    expect(container.firstChild).toBeNull();
  });

  it("removing the tag chip only clears that axis", () => {
    useSearchStore.setState({
      ...baseState(),
      statusFilter: ["done"],
      selectedTags: ["fantasy"],
    });
    render(<ActiveFilterChips />);
    fireEvent.click(screen.getByLabelText(t("search.era_remove_custom", { name: "#fantasy" })));
    const s = useSearchStore.getState();
    expect(s.selectedTags).toEqual([]);
    expect(s.statusFilter).toEqual(["done"]);
  });

  it("clicking a chip label opens the filter modal", () => {
    useSearchStore.setState({ ...baseState(), statusFilter: ["done"] });
    render(<ActiveFilterChips />);
    fireEvent.click(screen.getByText(t("status.done")));
    expect(useUiStore.getState().filtersOpen).toBe(true);
  });
});
