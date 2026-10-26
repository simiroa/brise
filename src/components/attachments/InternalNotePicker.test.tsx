import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import {
  InternalNotePicker,
  filterInternalNotes,
  INTERNAL_PICKER_LIMIT,
  INTERNAL_PICKER_DEBOUNCE_MS,
} from "./InternalNotePicker";
import { useNotesStore } from "../../stores/notes";
import { useSettingsStore } from "../../stores/settings";
import type { NoteSummary } from "../../lib/commands.gen";
import { assertRenderSettles } from "../../test/renderLoop";

const callMock = vi.fn();

vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  flushAll: vi.fn(),
  registerFlush: () => () => {},
  emitNotice: vi.fn(),
}));

function makeNote(id: string, title: string, folder_id = "f1"): NoteSummary {
  return {
    id,
    folder_id,
    title,
    year: 1500,
    is_favorite: false,
    exported_at: null,
    has_image: false,
    tag_names: [],
    region: null,
    status: null,
    icon: null,
    lat: null,
    lng: null,
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    month: null,
    day: null,
  };
}

function seedFolders(folders = [{ id: "f1", name: "Notes" }]) {
  useNotesStore.setState({
    folders: folders.map((f) => ({
      id: f.id,
      workspace_id: "ws",
      name: f.name,
      position: 0,
      is_open: true,
      note_count: 0,
      color_hue: null,
      icon: null,
      rules: null,
      search_excluded: false,
      ai_excluded: false,
    })),
    notesByFolder: {},
    noteIndex: new Map(),
    totalNotes: 0,
  });
}

describe("filterInternalNotes (pure)", () => {
  it("excludes self, matches title case-insensitively, and caps at LIMIT", () => {
    const notes = [
      makeNote("self", "Self"),
      makeNote("a", "Alpha"),
      makeNote("b", "beta"),
      makeNote("c", "Omega"),
    ];
    const hits = filterInternalNotes(notes, "alp", "self", 10);
    expect(hits.map((n) => n.id)).toEqual(["a"]);
    expect(hits.every((n) => n.id !== "self")).toBe(true);

    const caseHits = filterInternalNotes(notes, "BETA", "self", 10);
    expect(caseHits.map((n) => n.id)).toEqual(["b"]);

    const many = Array.from({ length: 80 }, (_, i) => makeNote(`n${i}`, `Note ${i}`));
    const capped = filterInternalNotes(many, "", null, INTERNAL_PICKER_LIMIT);
    expect(capped).toHaveLength(INTERNAL_PICKER_LIMIT);
  });
});

describe("InternalNotePicker", () => {
  const seed = [
    makeNote("self", "Current note"),
    makeNote("a1", "Alpha one"),
    makeNote("a2", "Alpha two"),
    makeNote("b1", "Bravo"),
  ];

  // Shared base for note_query/search_notes.
  const baseCallImpl = (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "note_query") {
      return Promise.resolve({ notes: seed, total: seed.length });
    }
    if (cmd === "search_notes") {
      const q = String(args?.query ?? "").toLowerCase();
      const results = seed.filter((n) => n.title.toLowerCase().includes(q));
      return Promise.resolve({ results, total: results.length });
    }
    return Promise.resolve({});
  };

  beforeEach(() => {
    vi.useFakeTimers();
    seedFolders();
    useSettingsStore.setState({ aiEnabled: false } as never);
    callMock.mockReset();
    callMock.mockImplementation(baseCallImpl);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles on mount with store-derived folder list (no render loop)", async () => {
    // folders from the notes store feed a useMemo; must not storm on mount.
    let renders = 0;
    await act(async () => {
      ({ renders } = assertRenderSettles(() =>
        createElement(InternalNotePicker, {
          excludeNoteId: "self",
          onPick: () => {},
          onCancel: () => {},
        }),
      ));
      await vi.advanceTimersByTimeAsync(INTERNAL_PICKER_DEBOUNCE_MS);
      await Promise.resolve();
    });
    expect(renders).toBeLessThanOrEqual(5);
  });

  it("updates results after debounce when typing", async () => {
    const onPick = vi.fn();
    render(
      <InternalNotePicker excludeNoteId="self" onPick={onPick} onCancel={vi.fn()} />,
    );

    // Initial note_query resolves (empty draft → debounced empty query).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INTERNAL_PICKER_DEBOUNCE_MS);
      await Promise.resolve();
    });

    expect(screen.getByTestId("internal-note-results").querySelectorAll('[role="option"]')).toHaveLength(
      3,
    );

    fireEvent.change(screen.getByTestId("internal-note-search"), {
      target: { value: "alpha" },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(INTERNAL_PICKER_DEBOUNCE_MS);
      await Promise.resolve();
    });

    const rows = screen.getByTestId("internal-note-results").querySelectorAll('[role="option"]');
    expect(rows).toHaveLength(2);
    expect(screen.getByTestId("internal-note-row-a1")).toBeTruthy();
    expect(screen.getByTestId("internal-note-row-a2")).toBeTruthy();
    expect(screen.queryByTestId("internal-note-row-b1")).toBeNull();
  });

  it("caps rendered rows at INTERNAL_PICKER_LIMIT (50)", async () => {
    const many = Array.from({ length: 80 }, (_, i) => makeNote(`n${i}`, `Match ${i}`));
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "note_query") {
        return Promise.resolve({ notes: many, total: many.length });
      }
      return Promise.resolve({ results: [], total: 0 });
    });

    render(<InternalNotePicker onPick={vi.fn()} onCancel={vi.fn()} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INTERNAL_PICKER_DEBOUNCE_MS);
      await Promise.resolve();
    });

    const rows = screen.getByTestId("internal-note-results").querySelectorAll('[role="option"]');
    expect(rows).toHaveLength(INTERNAL_PICKER_LIMIT);
  });

  it("calls onPick with note id on row click", async () => {
    const onPick = vi.fn();
    render(
      <InternalNotePicker excludeNoteId="self" onPick={onPick} onCancel={vi.fn()} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INTERNAL_PICKER_DEBOUNCE_MS);
      await Promise.resolve();
    });

    fireEvent.click(screen.getByTestId("internal-note-row-b1"));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("b1");
  });

  it("calls onPick on Enter with the highlighted row", async () => {
    const onPick = vi.fn();
    render(
      <InternalNotePicker excludeNoteId="self" onPick={onPick} onCancel={vi.fn()} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INTERNAL_PICKER_DEBOUNCE_MS);
      await Promise.resolve();
    });

    const input = screen.getByTestId("internal-note-search");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledTimes(1);
    // Default highlight 0; one ArrowDown → index 1 among [a1,a2,b1]
    expect(onPick).toHaveBeenCalledWith("a2");
  });
});
