import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TagsExpanded, useTagsExpandedData } from "./TagsExpanded";
import { useSearchStore } from "../../../stores/search";
import { useNotesStore } from "../../../stores/notes";
import type { NoteSummary } from "../../../lib/commands.gen";
import { assertHookSettles } from "../../../test/renderLoop";
import { buildNoteQueryInput, bumpNoteQueryVersion } from "../../../lib/noteQuery";

const callMock = vi.fn();

vi.mock("../../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  flushAll: vi.fn(async () => {}),
  registerFlush: vi.fn(() => () => {}),
  emitNotice: vi.fn(),
}));

global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

function makeNote(partial: Partial<NoteSummary> & { id: string }): NoteSummary {
  return {
    folder_id: "f1",
    title: partial.title ?? partial.id,
    year: partial.year ?? 1500,
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
    ...partial,
  };
}

function noteQueryPayload() {
  return callMock.mock.calls
    .filter((c) => c[0] === "note_query")
    .map((c) => c[1] as Record<string, unknown>);
}

describe("TagsExpanded redesign", () => {
  beforeEach(() => {
    callMock.mockReset();
    // Several tests below share the same filter axes but mock different note_query fixtures —
    // without this, noteQueryCollect's cache (module-level, keyed by axes) would serve an earlier
    // test's cached result instead of calling the freshly-mocked backend.
    bumpNoteQueryVersion();
    useSearchStore.setState({
      selectedTags: [],
      tagMode: "and",
      regionFilter: null,
      statusFilter: [],
      yearFrom: 1000,
      yearTo: 2000,
      query: "",
    });
    useNotesStore.setState({
      notesByFolder: {},
      tagCounts: { alpha: 2, beta: 1, ghost: 0 },
      tagColors: {},
      activeNote: null,
    });

    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_query") {
        return {
          notes: [
            makeNote({
              id: "n-multi",
              title: "Multi Tag Note",
              tag_names: ["alpha", "beta"],
            }),
            makeNote({
              id: "n-alpha",
              title: "Alpha Only",
              tag_names: ["alpha"],
            }),
          ],
          total: 2,
        };
      }
      if (cmd === "note_tags_index") {
        return {
          tags_by_note: {
            "n-multi": ["alpha", "beta"],
            "n-alpha": ["alpha"],
          },
        };
      }
      return {};
    });
  });

  // The OR/AND segmented control was removed: policy is pinned to "and" so that picking
  // more tags narrows, like every other axis in the panel. Selection is carried entirely
  // by the click gesture instead.
  const chip = (name: string) =>
    document.querySelector(`[data-tag-chip="${name}"]`) as HTMLElement;

  const renderPanel = async () => {
    render(
      <div style={{ height: 480, width: 220, display: "flex" }}>
        <TagsExpanded />
      </div>,
    );
    await waitFor(() => {
      expect(noteQueryPayload().length).toBeGreaterThan(0);
    });
  };

  it("renders no tag-mode control and always queries with tag_mode 'and'", async () => {
    await renderPanel();
    expect(screen.queryByTestId("tag-mode-control")).toBeNull();
    expect(screen.queryByTestId("tag-mode-or")).toBeNull();
    expect(screen.queryByTestId("tag-mode-and")).toBeNull();
    for (const p of noteQueryPayload()) {
      expect(p.tag_mode).toBe("and");
    }
  });

  it("a plain click replaces the selection rather than adding to it", async () => {
    const user = userEvent.setup();
    useSearchStore.setState({ selectedTags: ["alpha"] });
    await renderPanel();

    await user.click(chip("beta"));
    expect(useSearchStore.getState().selectedTags).toEqual(["beta"]);
  });

  it("ctrl+click adds to the selection, and removes on a second ctrl+click", async () => {
    const user = userEvent.setup();
    useSearchStore.setState({ selectedTags: ["alpha"] });
    await renderPanel();

    await user.keyboard("{Control>}");
    await user.click(chip("beta"));
    expect(useSearchStore.getState().selectedTags).toEqual(["alpha", "beta"]);

    await user.click(chip("beta"));
    await user.keyboard("{/Control}");
    expect(useSearchStore.getState().selectedTags).toEqual(["alpha"]);
  });

  // Without this the filter can only be undone via the clear button — the gesture that
  // set it would have no inverse.
  it("clicking the sole selected tag clears the filter", async () => {
    const user = userEvent.setup();
    useSearchStore.setState({ selectedTags: ["alpha"] });
    await renderPanel();

    await user.click(chip("alpha"));
    expect(useSearchStore.getState().selectedTags).toEqual([]);
  });

  it("a note carrying two selected tags appears EXACTLY ONCE in the result list", async () => {
    // Old sectionsByTag path put this note under each of its tags (twice).
    // That helper is deleted; this assert is the acceptance for the flat list.
    useSearchStore.setState({ selectedTags: ["alpha", "beta"], tagMode: "or" });

    render(
      <div style={{ height: 480, width: 220, display: "flex" }}>
        <TagsExpanded />
      </div>,
    );

    await waitFor(() => {
      const rows = document.querySelectorAll('[data-note-id="n-multi"]');
      expect(rows.length).toBe(1);
    });

    // Sanity: still present when both tags selected (would have been duplicated before).
    expect(document.querySelectorAll('[data-note-id="n-multi"]').length).toBe(1);
    expect(document.querySelectorAll('[data-note-id="n-alpha"]').length).toBe(1);
  });

  it("tag cloud renders a tag that has zero notes in the current result set", async () => {
    // Results only contain alpha/beta notes; ghost is in tagCounts with count 0
    // and must still appear — full sensing surface, not "tags present in results".
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_query") {
        return {
          notes: [makeNote({ id: "n-alpha", title: "Alpha Only", tag_names: ["alpha"] })],
          total: 1,
        };
      }
      if (cmd === "note_tags_index") {
        return { tags_by_note: { "n-alpha": ["alpha"] } };
      }
      return {};
    });

    render(
      <div style={{ height: 480, width: 220, display: "flex" }}>
        <TagsExpanded />
      </div>,
    );

    await waitFor(() => {
      expect(document.querySelector('[data-tag-chip="ghost"]')).not.toBeNull();
    });
    // ghost is not on any result note
    expect(document.querySelector('[data-note-id]')?.getAttribute("data-note-id")).toBe(
      "n-alpha",
    );
  });

  it("with tagCounts empty (IPC not loaded), cloud falls back to notesByFolder flatten", async () => {
    useNotesStore.setState({
      tagCounts: {},
      notesByFolder: {
        f1: [
          makeNote({ id: "w1", tag_names: ["window-only"] }),
          makeNote({ id: "w2", tag_names: ["window-only", "other"] }),
        ],
      },
    });

    render(
      <div style={{ height: 480, width: 220, display: "flex" }}>
        <TagsExpanded />
      </div>,
    );

    await waitFor(() => {
      expect(document.querySelector('[data-tag-chip="window-only"]')).not.toBeNull();
      expect(document.querySelector('[data-tag-chip="other"]')).not.toBeNull();
    });
    // Server map empty → no ghost from the previous suite state
    expect(document.querySelector('[data-tag-chip="ghost"]')).toBeNull();
  });

  it("useTagsExpandedData settles (no render storm)", async () => {
    const { renders } = await assertHookSettles(() => {
      useTagsExpandedData();
    });
    expect(renders).toBeLessThanOrEqual(40);
  });

  it("buildNoteQueryInput maps store tagMode onto invoke tag_mode (wiring contract)", () => {
    // Documents the only integration path: setTagMode → axes.tagMode → tag_mode.
    expect(buildNoteQueryInput({ selectedTags: ["a"], tagMode: "and" })).toEqual(
      expect.objectContaining({ tags: ["a"], tag_mode: "and" }),
    );
    expect(buildNoteQueryInput({ selectedTags: ["a"], tagMode: "or" })).toEqual(
      expect.objectContaining({ tags: ["a"], tag_mode: "or" }),
    );
  });

  it("chip labels are bare names — no leading # (anti-regression)", async () => {
    useNotesStore.setState({
      tagCounts: { alpha: 2, beta: 1 },
      notesByFolder: {},
      tagColors: {},
      activeNote: null,
    });

    render(
      <div style={{ height: 480, width: 220, display: "flex" }}>
        <TagsExpanded />
      </div>,
    );

    await waitFor(() => {
      expect(document.querySelector('[data-tag-chip="alpha"]')).not.toBeNull();
    });

    const chips = document.querySelectorAll("[data-tag-chip]");
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) {
      const text = (chip.textContent ?? "").trim();
      // Count suffix is digits; the name part must not start with '#'.
      expect(text.startsWith("#")).toBe(false);
      // Anti-vacuity: if the prefix returns as "#alpha2", this fails hard.
      expect(text).not.toMatch(/^#/);
    }
  });

  it("clicking a tag chip toggles it into selectedTags", async () => {
    const user = userEvent.setup();
    render(
      <div style={{ height: 480, width: 220, display: "flex" }}>
        <TagsExpanded />
      </div>,
    );

    await waitFor(() => {
      expect(document.querySelector('[data-tag-chip="alpha"]')).not.toBeNull();
    });

    expect(useSearchStore.getState().selectedTags).toEqual([]);
    await user.click(document.querySelector('[data-tag-chip="alpha"]')!);
    expect(useSearchStore.getState().selectedTags).toEqual(["alpha"]);
    await user.click(document.querySelector('[data-tag-chip="alpha"]')!);
    expect(useSearchStore.getState().selectedTags).toEqual([]);
  });
});
