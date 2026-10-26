import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FilterModal } from "./FilterModal";
import { useUiStore } from "../../stores/ui";
import { useSearchStore, countActiveFilterAxes } from "../../stores/search";
import { useNotesStore } from "../../stores/notes";
import { useTaxonomyStore } from "../../stores/taxonomy";
import { t } from "../../i18n/t";

vi.mock("../../lib/invoke", () => ({
  call: vi.fn(async () => ({})),
  callSilent: vi.fn(),
  flushAll: vi.fn(async () => {}),
  registerFlush: vi.fn(() => () => {}),
  emitNotice: vi.fn(),
}));

global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

describe("FilterModal", () => {
  beforeEach(() => {
    useUiStore.setState({ filtersOpen: false });
    useSearchStore.setState({
      query: "",
      yearBounds: { min: 1900, max: 2000 },
      yearFrom: 1900,
      yearTo: 2000,
      selectedTags: [],
      statusFilter: [],
      dateRange: null,
      regionFilter: null,
    });
    useNotesStore.setState({
      notesByFolder: {},
      tagCounts: { fantasy: 3, scifi: 1 },
      tagColors: {},
    });
    useTaxonomyStore.setState({
      workspaceId: "ws1",
      regions: [
        { id: "r1", name: "서울" } as never,
        { id: "r2", name: "부산" } as never,
      ],
      eras: [],
      statuses: [],
      loaded: true,
    });
  });

  it("renders nothing when closed", () => {
    const { container } = render(<FilterModal />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a dialog with all 4 sections when open", () => {
    useUiStore.setState({ filtersOpen: true });
    render(<FilterModal />);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(t("search.filter_section_status"))).toBeTruthy();
    expect(screen.getByText(t("search.mode_tags"))).toBeTruthy();
    expect(screen.getByText(t("search.mode_region"))).toBeTruthy();
    expect(screen.getByText(t("search.filter_section_date"))).toBeTruthy();
  });

  it("region chip click sets regionFilter; re-click clears it", () => {
    useUiStore.setState({ filtersOpen: true });
    render(<FilterModal />);
    fireEvent.click(screen.getByText("서울"));
    expect(useSearchStore.getState().regionFilter).toEqual({ kind: "region", name: "서울" });
    fireEvent.click(screen.getByText("서울"));
    expect(useSearchStore.getState().regionFilter).toBeNull();
  });

  it("tag search input filters the cloud", () => {
    useUiStore.setState({ filtersOpen: true });
    render(<FilterModal />);
    expect(screen.getByText("fantasy")).toBeTruthy();
    expect(screen.getByText("scifi")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(t("search.filter_tag_search")), {
      target: { value: "fan" },
    });
    expect(screen.getByText("fantasy")).toBeTruthy();
    expect(screen.queryByText("scifi")).toBeNull();
  });

  it("reset clears every filter axis", () => {
    useUiStore.setState({ filtersOpen: true });
    useSearchStore.setState({
      query: "hello",
      yearFrom: 1950,
      yearTo: 1990,
      selectedTags: ["fantasy"],
      regionFilter: { kind: "none" },
      statusFilter: ["done"],
      dateRange: "last7",
    });
    render(<FilterModal />);
    fireEvent.click(screen.getByText(t("search.filter_reset")));
    expect(countActiveFilterAxes(useSearchStore.getState())).toBe(0);
  });
});
