import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useSearchStore } from "../stores/search";
import { buildActiveFilterChips } from "../components/leftpanel/buildActiveFilterChips";
import { MobileActiveFilterChips } from "./MobileActiveFilterChips";

const BASE = {
  query: "",
  selectedTags: [] as string[],
  regionFilter: null,
  statusFilter: [] as string[],
  dateRange: null,
  yearFrom: 2000,
  yearTo: 2030,
  yearBounds: { min: 2000, max: 2030 },
};

beforeEach(() => {
  useSearchStore.setState(BASE as any);
});

describe("MobileActiveFilterChips", () => {
  it("renders no row when no axis is active", () => {
    render(<MobileActiveFilterChips onOpenSheet={() => {}} />);
    expect(screen.queryByTestId("mobile-active-chips")).toBeNull();
  });

  it("renders one chip per active axis, including query", () => {
    useSearchStore.setState({
      query: "paris",
      selectedTags: ["travel", "food"],
      statusFilter: ["done"],
      yearFrom: 2010,
      regionFilter: { kind: "none" },
    } as any);
    render(<MobileActiveFilterChips onOpenSheet={() => {}} />);
    // query + 1 status + 2 tags + region + year
    expect(screen.getAllByTestId("mobile-active-chip")).toHaveLength(6);
    expect(screen.getByText("#travel")).toBeTruthy();
    expect(screen.getByText("2010–2030")).toBeTruthy();
  });

  it("x clears only that axis", () => {
    useSearchStore.setState({ selectedTags: ["travel"], statusFilter: ["done"], query: "paris" } as any);
    render(<MobileActiveFilterChips onOpenSheet={() => {}} />);
    fireEvent.click(screen.getByLabelText(/#travel/));
    expect(useSearchStore.getState().selectedTags).toEqual([]);
    expect(useSearchStore.getState().statusFilter).toEqual(["done"]);
    expect(useSearchStore.getState().query).toBe("paris");
    fireEvent.click(screen.getByLabelText(/“paris”/));
    expect(useSearchStore.getState().query).toBe("");
    expect(useSearchStore.getState().statusFilter).toEqual(["done"]);
  });

  it("tapping the label opens the sheet without clearing", () => {
    const onOpenSheet = vi.fn();
    useSearchStore.setState({ selectedTags: ["travel"] } as any);
    render(<MobileActiveFilterChips onOpenSheet={onOpenSheet} />);
    fireEvent.click(screen.getByText("#travel"));
    expect(onOpenSheet).toHaveBeenCalledTimes(1);
    expect(useSearchStore.getState().selectedTags).toEqual(["travel"]);
  });
});

describe("buildActiveFilterChips", () => {
  const noop = () => {};
  const input = (over: object) =>
    ({
      ...BASE,
      toggleStatusFilter: noop, selectTag: noop, setRegionFilter: noop, setDateRangeFilter: noop,
      setYearRange: noop, customStatuses: [], ...over,
    }) as any;

  it("omits the query chip unless includeQuery is set", () => {
    expect(buildActiveFilterChips(input({ query: "x" }))).toHaveLength(0);
    expect(buildActiveFilterChips(input({ query: "x" }), { includeQuery: true })).toHaveLength(1);
  });

  it("year chip clear resets to bounds", () => {
    const setYearRange = vi.fn();
    const [chip] = buildActiveFilterChips(input({ yearTo: 2020, setYearRange }));
    chip.onRemove();
    expect(setYearRange).toHaveBeenCalledWith(2000, 2030);
  });
});
