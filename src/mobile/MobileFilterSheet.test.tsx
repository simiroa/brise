import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const call = vi.fn(async (cmd: string, _args?: Record<string, unknown>): Promise<unknown> => {
  if (cmd === "tag_counts") return { counts: { travel: 3, work: 1 } };
  return {};
});
const callSilent = vi.fn(async (cmd: string, _args?: Record<string, unknown>): Promise<unknown> => {
  if (cmd === "tag_colors") return { colors: { travel: 140 } };
  return {};
});
vi.mock("../lib/invoke", () => ({
  call: (cmd: string, args?: Record<string, unknown>) => call(cmd, args),
  callSilent: (cmd: string, args?: Record<string, unknown>) => callSilent(cmd, args),
  emitNotice: vi.fn(),
  registerFlush: vi.fn(() => () => {}),
  flushAll: vi.fn(async () => {}),
}));

import { useSearchStore } from "../stores/search";
import { useTaxonomyStore } from "../stores/taxonomy";
import { useNotesStore } from "../stores/notes";
import { MobileFilterSheet } from "./MobileFilterSheet";

beforeEach(() => {
  call.mockClear();
  callSilent.mockClear();
  useNotesStore.setState({ notesByFolder: {}, tagCounts: null, tagColors: null } as any);
  useTaxonomyStore.setState({
    statuses: [{ id: "s1", workspace_id: "w1", name: "Urgent", position: 0 }],
    regions: [{ id: "r1", workspace_id: "w1", name: "Seoul", position: 0 }],
    loaded: true,
  } as any);
  useSearchStore.setState({
    query: "",
    yearBounds: { min: 1900, max: 2100 },
    yearFrom: 1900,
    yearTo: 2100,
    selectedTags: [],
    statusFilter: [],
    dateRange: null,
    regionFilter: null,
  } as any);
});

describe("MobileFilterSheet", () => {
  it("fetches tag_counts and tag_colors on mount without going through folder_list/loadTree", async () => {
    render(<MobileFilterSheet onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("mobile-filter-tag-travel")).toBeTruthy());
    expect(call).toHaveBeenCalledWith("tag_counts", undefined);
    expect(callSilent).toHaveBeenCalledWith("tag_colors", undefined);
    expect(call).not.toHaveBeenCalledWith("folder_list", expect.anything());
  });

  it("toggles a built-in status axis (OR, multi) and reflects data-active", () => {
    render(<MobileFilterSheet onClose={() => {}} />);
    const pill = screen.getByTestId("mobile-filter-status-in_progress");
    expect(pill.getAttribute("data-active")).toBe("false");

    fireEvent.click(pill);
    expect(useSearchStore.getState().statusFilter).toEqual(["in_progress"]);
    expect(pill.getAttribute("data-active")).toBe("true");

    fireEvent.click(pill);
    expect(useSearchStore.getState().statusFilter).toEqual([]);
  });

  it("renders a custom workspace status alongside the built-ins", () => {
    render(<MobileFilterSheet onClose={() => {}} />);
    const custom = screen.getByText("Urgent");
    fireEvent.click(custom);
    expect(useSearchStore.getState().statusFilter).toEqual(["s1"]);
  });

  it("tag checkboxes are additive (AND) toggles onto selectedTags", async () => {
    render(<MobileFilterSheet onClose={() => {}} />);
    const checkbox = await waitFor(() => screen.getByTestId("mobile-filter-tag-travel") as HTMLInputElement);

    fireEvent.click(checkbox);
    expect(useSearchStore.getState().selectedTags).toEqual(["travel"]);

    fireEvent.click(checkbox);
    expect(useSearchStore.getState().selectedTags).toEqual([]);
  });

  it("shows the empty-tags hint when the notebook has no tags", async () => {
    call.mockImplementation(async (cmd: string) => (cmd === "tag_counts" ? { counts: {} } : {}));
    render(<MobileFilterSheet onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("No tags yet.")).toBeTruthy());
  });

  it("year chips write setYearRange and re-tap restores bounds", () => {
    render(<MobileFilterSheet onClose={() => {}} />);
    const chip = screen.getByTestId("mobile-filter-year-last10");
    fireEvent.click(chip);
    const after = useSearchStore.getState();
    expect(after.yearFrom).toBeGreaterThan(after.yearBounds.min);
    expect(after.yearTo).toBeLessThanOrEqual(after.yearBounds.max);
    fireEvent.click(chip);
    expect(useSearchStore.getState().yearFrom).toBe(1900);
    expect(useSearchStore.getState().yearTo).toBe(2100);
  });

  it("date range chips are single-select, re-tap clears", () => {
    render(<MobileFilterSheet onClose={() => {}} />);
    const last7 = screen.getByTestId("mobile-filter-date-last7");
    const last30 = screen.getByTestId("mobile-filter-date-last30");

    fireEvent.click(last7);
    expect(useSearchStore.getState().dateRange).toBe("last7");

    fireEvent.click(last30);
    expect(useSearchStore.getState().dateRange).toBe("last30");

    fireEvent.click(last30);
    expect(useSearchStore.getState().dateRange).toBeNull();
  });

  it("전체 해제 clears all six filter axes, matching the desktop reset badge's scope", async () => {
    useSearchStore.setState({
      query: "hello",
      yearFrom: 1950,
      yearTo: 2000,
      selectedTags: ["travel"],
      statusFilter: ["in_progress"],
      dateRange: "last7",
      regionFilter: { kind: "region", name: "Seoul" },
    } as any);
    render(<MobileFilterSheet onClose={() => {}} />);

    fireEvent.click(screen.getByTestId("mobile-filter-sheet-clear"));

    const s = useSearchStore.getState();
    expect(s.query).toBe("");
    expect(s.yearFrom).toBe(1900);
    expect(s.yearTo).toBe(2100);
    expect(s.selectedTags).toEqual([]);
    expect(s.statusFilter).toEqual([]);
    expect(s.dateRange).toBeNull();
    expect(s.regionFilter).toBeNull();
  });

  it("region chips render from the taxonomy store; tap sets, re-tap clears", () => {
    render(<MobileFilterSheet onClose={() => {}} />);
    const seoul = screen.getByTestId("mobile-filter-region-Seoul");
    expect(screen.getByTestId("mobile-filter-region-all").getAttribute("data-active")).toBe("true");
    fireEvent.click(seoul);
    expect(useSearchStore.getState().regionFilter).toEqual({ kind: "region", name: "Seoul" });
    expect(seoul.getAttribute("data-active")).toBe("true");
    fireEvent.click(seoul);
    expect(useSearchStore.getState().regionFilter).toBeNull();
  });

  it("no-region chip sets {kind:none}, re-tap clears; 전체 chip resets", () => {
    render(<MobileFilterSheet onClose={() => {}} />);
    const none = screen.getByTestId("mobile-filter-region-none");
    fireEvent.click(none);
    expect(useSearchStore.getState().regionFilter).toEqual({ kind: "none" });
    fireEvent.click(none);
    expect(useSearchStore.getState().regionFilter).toBeNull();
    fireEvent.click(none);
    fireEvent.click(screen.getByTestId("mobile-filter-region-all"));
    expect(useSearchStore.getState().regionFilter).toBeNull();
  });

  it("tag search input filters the tag list case-insensitively", async () => {
    call.mockImplementation(async (cmd: string) => (cmd === "tag_counts" ? { counts: { travel: 3, work: 1 } } : {}));
    render(<MobileFilterSheet onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("mobile-filter-tag-travel")).toBeTruthy());
    fireEvent.change(screen.getByTestId("mobile-filter-tag-search"), { target: { value: "WOR" } });
    expect(screen.queryByTestId("mobile-filter-tag-travel")).toBeNull();
    expect(screen.getByTestId("mobile-filter-tag-work")).toBeTruthy();
  });

  it("적용 just closes the sheet (changes are already live)", () => {
    const onClose = vi.fn();
    render(<MobileFilterSheet onClose={onClose} />);
    fireEvent.click(screen.getByText("Apply"));
    expect(onClose).toHaveBeenCalled();
  });
});
