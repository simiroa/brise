import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SearchBox } from "./SearchBox";
import { useSearchStore } from "../../stores/search";

const callMock = vi.fn();

vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  flushAll: vi.fn(async () => {}),
  registerFlush: () => () => {},
  emitNotice: vi.fn(),
}));

vi.mock("../../stores/notes", () => ({
  useNotesStore: Object.assign(
    (sel: (s: { selectNote: () => Promise<void> }) => unknown) =>
      sel({ selectNote: async () => {} }),
    {
      getState: () => ({ selectNote: async () => {} }),
    },
  ),
}));

describe("SearchBox — recent search history (QA8 3A)", () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockResolvedValue({ results: [], total: 0, settings: { search_recent: [] } });
    useSearchStore.setState({
      query: "",
      yearBounds: { min: 900, max: 1960 },
      yearFrom: 900,
      yearTo: 1960,
      selectedTags: [],
      regionFilter: null,
      statusFilter: [],
      searchResults: [],
      matchCursor: null,
      matchIds: [],
      matchRowIndices: [],
      recentSearches: ["silla", "baekje", "goguryeo"],
    });
  });

  it("on focus shows recent list from the shared store", () => {
    render(<SearchBox />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    expect(screen.getByTestId("search-history")).toBeDefined();
    expect(screen.getByTestId("search-history-item-0").textContent).toContain("silla");
    expect(screen.getByTestId("search-history-item-1").textContent).toContain("baekje");
  });

  it("filters the list by in-progress substring", () => {
    render(<SearchBox />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "baek" } });
    expect(screen.getByTestId("search-history-item-0").textContent).toContain("baekje");
    expect(screen.queryByTestId("search-history-item-1")).toBeNull();
  });

  it("ArrowDown/Enter picks a history item into the shared query", () => {
    render(<SearchBox />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useSearchStore.getState().query).toBe("silla");
    // promote: already head stays head
    expect(useSearchStore.getState().recentSearches[0]).toBe("silla");
  });

  it("per-item × removes one entry without picking it", () => {
    render(<SearchBox />);
    fireEvent.focus(screen.getByRole("combobox"));
    fireEvent.click(screen.getByTestId("search-history-remove-1"));
    expect(useSearchStore.getState().recentSearches).toEqual(["silla", "goguryeo"]);
  });

  it("clear all empties history", () => {
    render(<SearchBox />);
    fireEvent.focus(screen.getByRole("combobox"));
    fireEvent.click(screen.getByTestId("search-history-clear-all"));
    expect(useSearchStore.getState().recentSearches).toEqual([]);
    expect(screen.queryByTestId("search-history")).toBeNull();
  });

  it("Escape closes the dropdown", () => {
    render(<SearchBox />);
    const input = screen.getByRole("combobox");
    fireEvent.focus(input);
    expect(screen.getByTestId("search-history")).toBeDefined();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("search-history")).toBeNull();
  });
});
