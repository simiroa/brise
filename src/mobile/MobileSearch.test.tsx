import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { NoteSummary } from "../lib/commands.gen";

const call = vi.fn(async (cmd: string, _args?: Record<string, unknown>): Promise<unknown> => {
  if (cmd === "settings_get_all") return { settings: { search_recent: ["alpha", "beta"] } };
  if (cmd === "search_notes") return { results: [], total: 0 };
  return {};
});
vi.mock("../lib/invoke", () => ({
  call: (cmd: string, args?: Record<string, unknown>) => call(cmd, args),
  callSilent: (cmd: string, args?: Record<string, unknown>) => call(cmd, args),
}));

import { useSearchStore } from "../stores/search";
import { MobileSearch } from "./MobileSearch";

function result(patch: Partial<NoteSummary> & { id: string }): NoteSummary {
  return {
    folder_id: "f1",
    title: patch.title ?? patch.id,
    year: 2026,
    is_favorite: false,
    exported_at: null,
    has_image: false,
    tag_names: [],
    region: null,
    status: null,
    icon: null,
    lat: null,
    lng: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    month: null,
    day: null,
    snippet: "",
    ...patch,
  } as NoteSummary;
}

beforeEach(() => {
  call.mockClear();
  useSearchStore.setState({ query: "", searchResults: [], recentSearches: [] } as any);
});

describe("MobileSearch — recent history (W3)", () => {
  it("loads recentSearches from the shared search_recent setting on mount", async () => {
    render(<MobileSearch onOpenNote={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("mobile-search-history-alpha")).toBeTruthy());
    expect(screen.getByTestId("mobile-search-history-beta")).toBeTruthy();
    expect(call).toHaveBeenCalledWith("settings_get_all", undefined);
  });

  it("tapping a history row runs that search immediately (does not navigate)", async () => {
    render(<MobileSearch onOpenNote={() => {}} onClose={() => {}} />);
    const row = await screen.findByTestId("mobile-search-history-alpha");
    fireEvent.click(row);
    expect(useSearchStore.getState().query).toBe("alpha");
  });

  it("the × button removes one entry without touching the rest", async () => {
    render(<MobileSearch onOpenNote={() => {}} onClose={() => {}} />);
    await screen.findByTestId("mobile-search-history-alpha");
    fireEvent.click(screen.getAllByLabelText("Remove from history")[0]!);
    expect(useSearchStore.getState().recentSearches).toEqual(["beta"]);
  });

  it("the clear-all footer empties the whole list", async () => {
    render(<MobileSearch onOpenNote={() => {}} onClose={() => {}} />);
    await screen.findByTestId("mobile-search-history-alpha");
    fireEvent.click(screen.getByText("Clear all"));
    expect(useSearchStore.getState().recentSearches).toEqual([]);
  });

  it("shows the plain search hint (not the history section) once recentSearches is empty", async () => {
    useSearchStore.setState({ recentSearches: [] } as any);
    call.mockImplementation(async (cmd: string) => (cmd === "settings_get_all" ? { settings: {} } : {}));
    render(<MobileSearch onOpenNote={() => {}} onClose={() => {}} />);
    expect(await screen.findByText("Search your notes by title or content.")).toBeTruthy();
    expect(screen.queryByText("Recent searches")).toBeNull();
  });

  it("Enter commits the current query to history, guarded by isComposing", () => {
    render(<MobileSearch onOpenNote={() => {}} onClose={() => {}} />);
    const input = screen.getByLabelText("Search notes, tags, sources…") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "typed query" } });

    // Composing (IME in-progress) — must NOT commit.
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(useSearchStore.getState().recentSearches).toEqual([]);

    // Not composing — commits.
    fireEvent.keyDown(input, { key: "Enter", isComposing: false });
    expect(useSearchStore.getState().recentSearches).toEqual(["typed query"]);
  });

  it("opening a search result records the query that found it, then opens the note", () => {
    useSearchStore.setState({ query: "hits", searchResults: [result({ id: "n1", title: "Found me" })] } as any);
    const onOpenNote = vi.fn();
    render(<MobileSearch onOpenNote={onOpenNote} onClose={() => {}} />);

    fireEvent.click(screen.getByText("Found me"));

    expect(onOpenNote).toHaveBeenCalledWith("n1");
    expect(useSearchStore.getState().recentSearches).toEqual(["hits"]);
  });
});
