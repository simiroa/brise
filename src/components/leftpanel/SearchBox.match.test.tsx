import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

const selectNoteMock = vi.fn(async () => {});
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
    (sel: (s: { selectNote: typeof selectNoteMock }) => unknown) =>
      sel({ selectNote: selectNoteMock }),
    {
      getState: () => ({ selectNote: selectNoteMock }),
    },
  ),
}));

import { SearchBox } from "./SearchBox";
import { useSearchStore } from "../../stores/search";

describe("SearchBox find-next keys + counter", () => {
  beforeEach(() => {
    selectNoteMock.mockClear();
    callMock.mockReset();
    callMock.mockResolvedValue({ results: [], total: 0 });
    useSearchStore.setState({
      query: "silla",
      yearBounds: { min: 900, max: 1960 },
      yearFrom: 900,
      yearTo: 1960,
      selectedTags: [],
      regionFilter: null,
      statusFilter: [],
      matchCursor: null,
      matchIds: ["a", "b", "c", "d", "e"],
      matchRowIndices: [0, 1, 2, 3, 4],
    });
  });

  it("ArrowDown three times moves cursor to 2 without calling selectNote", () => {
    render(<SearchBox />);
    const input = screen.getByRole("combobox");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });

    expect(useSearchStore.getState().matchCursor).toBe(2);
    expect(selectNoteMock).toHaveBeenCalledTimes(0);
  });

  it("Enter on the cursor calls selectNote exactly once with the cursor id", () => {
    useSearchStore.setState({ matchCursor: 2, matchIds: ["a", "b", "c"] });
    render(<SearchBox />);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });

    expect(selectNoteMock).toHaveBeenCalledTimes(1);
    expect(selectNoteMock).toHaveBeenCalledWith("c");
  });

  it("renders the match counter inside the input box when search mode has matches", () => {
    useSearchStore.setState({ matchCursor: 1 });
    render(<SearchBox />);
    const counter = screen.getByTestId("search-match-counter");
    expect(counter.textContent).toMatch(/2\s*\/\s*5/);
  });

  it("inert outside search mode: no counter, ArrowDown does nothing", () => {
    useSearchStore.setState({
      query: "",
      yearFrom: 900,
      yearTo: 1960,
      yearBounds: { min: 900, max: 1960 },
      selectedTags: ["war"],
      matchIds: [],
      matchRowIndices: [],
      matchCursor: null,
    });
    render(<SearchBox />);
    expect(screen.queryByTestId("search-match-counter")).toBeNull();

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    expect(useSearchStore.getState().matchCursor).toBe(null);
    expect(selectNoteMock).not.toHaveBeenCalled();
  });
});
