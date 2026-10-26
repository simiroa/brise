import { createElement } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, act, fireEvent } from "@testing-library/react";
import type { NoteSummary } from "../../lib/commands.gen";
import type { MapLocation, MapMarker, MapPathLine, MapViewportBbox } from "../map/WorldMap";
import { useSettingsStore } from "../../stores/settings";
import { useNotesStore } from "../../stores/notes";
import { useSearchStore } from "../../stores/search";
import { useUiStore } from "../../stores/ui";
import { HomeMapPane } from "./HomeMapPane";
import { FIT_MAX_ZOOM } from "./mapFit";
import { t } from "../../i18n/t";
import { bumpNoteQueryVersion } from "../../lib/noteQuery";

// Bug 2 regression: dropping a temp create pin (map click or search pick) and confirming it
// must NEVER move the map viewport. Root causes fixed:
//  (a) dropCreatePin used to call panTo() — an unconditional WorldMap defaultLocation reset.
//  (b) confirmCreate's post-create reload used to re-trigger the fit-to-notes effect (the new
//      note changes `located`'s id list, which was the effect's re-fit signature).
// WorldMap itself is mocked (RegionExpanded.test.tsx pattern) so this only asserts the
// `defaultLocation` prop HomeMapPane hands to WorldMap — the actual pan/zoom clamp math lives in
// geometry.test.ts and is independent of this file.

const callMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  flushAll: vi.fn(),
  registerFlush: vi.fn(),
  emitNotice: vi.fn(),
}));

type MockMapProps = {
  defaultLocation?: MapLocation;
  homeLocation?: MapLocation;
  initialTransform?: { k: number; x: number; y: number };
  markers: MapMarker[];
  pathLines?: MapPathLine[];
  onMapClick?: (lat: number, lng: number) => void;
  onMarkerClick?: (id: string) => void;
  onViewportChange?: (bbox: MapViewportBbox) => void;
  onDropNote?: (noteId: string, lat: number, lng: number) => void;
  onMarkerMove?: (noteId: string, lat: number, lng: number) => void;
};

let lastMapProps: MockMapProps = { markers: [] };
/** Per-mount latch: the real WorldMap reports a viewport from an effect keyed on its transform,
 *  not on every render. Re-firing per render here would spin (viewport → query → re-render). */
let firedViewportFor: unknown = null;

vi.mock("../map/WorldMapAuto", () => ({
  WorldMapAuto: (props: MockMapProps) => {
    lastMapProps = props;
    // Markers are now a viewport (bbox) query, same as the sidebar map — hand it a whole-world
    // viewport once so the located-notes effect runs (RegionExpanded.test.tsx pattern).
    if (props.onViewportChange && firedViewportFor !== props.onViewportChange) {
      firedViewportFor = props.onViewportChange;
      queueMicrotask(() =>
        props.onViewportChange!({ min_lat: -90, max_lat: 90, min_lng: -180, max_lng: 180 })
      );
    }
    return createElement("div", { "data-testid": "mock-world-map" });
  },
}));

// Real MapPlaceSearch drags in the debounced geocode hook — a probe button is enough to drive
// HomeMapPane's onSearchPick contract (fly-to + temp pin).
vi.mock("./MapPlaceSearch", () => ({
  MapPlaceSearch: (props: { onPick: (item: { lat: number; lng: number; label: string }, x: number, y: number) => void }) =>
    createElement("button", {
      "data-testid": "mock-place-pick",
      onClick: () => props.onPick({ lat: 48.8566, lng: 2.3522, label: "Paris" }, 100, 100),
    }),
}));

function note(partial: Partial<NoteSummary> & { id: string }): NoteSummary {
  return {
    folder_id: "f",
    title: partial.title ?? partial.id,
    year: partial.year ?? 2020,
    is_favorite: false,
    exported_at: null,
    has_image: false,
    tag_names: [],
    region: null,
    status: null,
    icon: null,
    lat: null,
    lng: null,
    created_at: "2020-01-01T00:00:00Z",
    updated_at: "2020-01-01T00:00:00Z",
    month: null,
    day: null,
    ...partial,
  };
}

describe("HomeMapPane — creation interaction never moves the viewport", () => {
  const existing = note({ id: "existing-1", title: "Existing", lat: 10, lng: 20 });
  let created = false;

  beforeEach(() => {
    callMock.mockReset();
    lastMapProps = { markers: [] };
    // Module-level singleton shared with the dashboard search box — reset so a query left over
    // from another test in this file never leaks into an unrelated one. yearFrom/yearTo/
    // yearBounds are deliberately left alone — these tests rely on the store's neutral fallback
    // bounds, not a seeded range.
    useSearchStore.setState({ query: "", searchResults: [] });
    created = false;

    useSettingsStore.setState({
      activeWorkspaceId: "ws1",
      uiLang: "en",
      defaultMapLocation: { lat: 37.5665, lng: 126.978, zoom: 50 },
    });
    useNotesStore.setState({
      selectNote: vi.fn().mockResolvedValue(undefined),
      loadTree: vi.fn().mockResolvedValue(undefined),
      ensureInboxId: vi.fn().mockResolvedValue("inbox1"),
      inboxId: "inbox1",
    } as never);

    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_query") {
        const notes = created ? [existing, note({ id: "new-1", title: "새 노트", lat: 30, lng: 40 })] : [existing];
        return { notes, total: notes.length };
      }
      if (cmd === "note_create") {
        return { note: note({ id: "new-1", title: "새 노트" }) };
      }
      if (cmd === "note_set_location") {
        created = true;
        return {};
      }
      if (cmd === "note_set_region") return {};
      if (cmd === "geocode_reverse") return { label: null };
      return {};
    });
  });

  it("stays put through click → temp pin → confirm → note added to the map", async () => {
    render(<HomeMapPane />);

    await waitFor(() => {
      expect(lastMapProps.markers.some((m) => m.id === "existing-1")).toBe(true);
      // Owner QA 2026-08-10: no fit-to-notes on mount — first paint stays on 설정 홈
      // (defaultMapLocation). The "before" snapshot below is that stable settings value.
      expect(lastMapProps.defaultLocation).toEqual({ lat: 37.5665, lng: 126.978, zoom: 50 });
    });
    const locationBeforeClick = lastMapProps.defaultLocation;

    // Empty-map click → temp pin drop. Must not touch defaultLocation.
    act(() => {
      lastMapProps.onMapClick?.(12, 22);
    });
    expect(lastMapProps.defaultLocation).toBe(locationBeforeClick);
    expect(lastMapProps.markers.some((m) => m.id === "__home_map_temp__")).toBe(true);

    // Confirm the temp pin → note_create + note_set_location, then a query-version-triggered
    // reload that must NOT re-run fit-to-notes.
    const confirmBtn = await waitFor(() => {
      const btn = document.querySelector('[data-testid="home-map-create-confirm"]');
      expect(btn).toBeTruthy();
      return btn as HTMLElement;
    });
    await act(async () => {
      fireEvent.click(confirmBtn);
      // bumpNoteQueryVersion() debounces its listener notification by 250ms.
      await new Promise((r) => setTimeout(r, 400));
    });

    await waitFor(() => {
      expect(lastMapProps.markers.some((m) => m.id === "new-1")).toBe(true);
    });
    // The new note is now on the map, but the viewport never moved from its pre-click value.
    expect(lastMapProps.defaultLocation).toBe(locationBeforeClick);
    expect(lastMapProps.markers.some((m) => m.id === "__home_map_temp__")).toBe(false);
  });
});

// Parity with the sidebar map (RegionExpanded): the dashboard map must honour every search
// filter axis and scope its markers to the camera, and it must accept the same two write
// gestures (tree-drag drop, pin move) via the shared useMapNoteActions hook.
describe("HomeMapPane — sidebar-map parity: filters, bbox scoping, drop/move", () => {
  const inView = note({ id: "in-view", title: "In view", lat: 10, lng: 20 });

  beforeEach(() => {
    callMock.mockReset();
    lastMapProps = { markers: [] };
    useSearchStore.setState({
      query: "",
      searchResults: [],
      selectedTags: ["voyage"],
      tagMode: "and",
      statusFilter: ["done"],
      regionFilter: null,
      dateRange: null,
    });
    useSettingsStore.setState({
      activeWorkspaceId: "ws1",
      uiLang: "en",
      defaultMapLocation: { lat: 37.5665, lng: 126.978, zoom: 50 },
    });
    useNotesStore.setState({
      selectNote: vi.fn().mockResolvedValue(undefined),
      loadTree: vi.fn().mockResolvedValue(undefined),
      ensureInboxId: vi.fn().mockResolvedValue("inbox1"),
      inboxId: "inbox1",
    } as never);
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_query") return { notes: [inView], total: 1 };
      if (cmd === "note_set_location") return inView;
      if (cmd === "geocode_reverse") return { label: null };
      return {};
    });
  });

  afterEach(() => {
    // Restore yearFrom/yearTo to the full corpus range — the filter-axis test above mutates them
    // to trigger a fit-to-notes refetch, and this is a module-level store singleton shared with
    // every other test in this file.
    const { yearBounds } = useSearchStore.getState();
    useSearchStore.setState({
      selectedTags: [],
      tagMode: "and",
      statusFilter: [],
      yearFrom: yearBounds.min,
      yearTo: yearBounds.max,
    });
  });

  it("queries markers by viewport bbox and carries the tag/status filter axes", async () => {
    render(<HomeMapPane />);

    await waitFor(() => {
      expect(lastMapProps.markers.some((m) => m.id === "in-view")).toBe(true);
    });

    // Fit-to-notes' corpus-wide query never runs on mount (see the "does not run" test below) — drive
    // a filter change so it actually runs, same trigger the "changing a filter" test downstream
    // uses, then check it carries the same filter axes as the bbox query.
    act(() => {
      useSearchStore.setState({ yearFrom: 2019, yearTo: 2021 });
    });
    await waitFor(() => {
      const queries = callMock.mock.calls
        .filter(([cmd]) => cmd === "note_query")
        .map(([, input]) => input as Record<string, unknown>);
      expect(
        queries.some((q) => (q.coords as { kind?: string } | undefined)?.kind === "has")
      ).toBe(true);
    });

    const queries = callMock.mock.calls
      .filter(([cmd]) => cmd === "note_query")
      .map(([, input]) => input as Record<string, unknown>);

    const bboxQuery = queries.find(
      (q) => (q.coords as { kind?: string } | undefined)?.kind === "bbox"
    );
    expect(bboxQuery).toBeTruthy();
    expect(bboxQuery!.tags).toEqual(["voyage"]);
    expect(bboxQuery!.statuses).toEqual(["done"]);
    expect(bboxQuery!.workspace_id).toBe("ws1");

    // Fit-to-notes keeps its own viewport-unconstrained query (coords: has) so a filter whose
    // notes sit outside the current camera can still be flown to. It also carries the same
    // filter axes as the bbox query.
    const hasQuery = queries.find(
      (q) => (q.coords as { kind?: string } | undefined)?.kind === "has"
    );
    expect(hasQuery).toBeTruthy();
    expect(hasQuery!.tags).toEqual(["voyage"]);
    expect(hasQuery!.statuses).toEqual(["done"]);
  });

  // Owner-approved analysis item 6: the corpus-wide fit-to-notes query used to fire on every
  // mount even though its result was thrown away (fit-to-notes never runs on first paint). The fit
  // effect now keys on the filter signature alone, seeded with the mount signature (fittedSigRef
  // in HomeMapPane.tsx), so the fetch itself is skipped until a filter actually changes.
  it("does not run the corpus-wide coords:has query on mount (fit result would be discarded anyway)", async () => {
    render(<HomeMapPane />);

    await waitFor(() => {
      expect(lastMapProps.markers.some((m) => m.id === "in-view")).toBe(true);
    });

    const queries = callMock.mock.calls
      .filter(([cmd]) => cmd === "note_query")
      .map(([, input]) => input as Record<string, unknown>);
    expect(
      queries.some((q) => (q.coords as { kind?: string } | undefined)?.kind === "has")
    ).toBe(false);
  });

  it("exposes onDropNote / onMarkerMove — both write the new location", async () => {
    render(<HomeMapPane />);
    await waitFor(() => {
      expect(lastMapProps.markers.some((m) => m.id === "in-view")).toBe(true);
    });

    await act(async () => {
      lastMapProps.onDropNote?.("in-view", 1, 2);
      lastMapProps.onMarkerMove?.("in-view", 3, 4);
      await Promise.resolve();
    });

    const writes = callMock.mock.calls
      .filter(([cmd]) => cmd === "note_set_location")
      .map(([, args]) => args as { lat: number; lng: number });
    expect(writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lat: 1, lng: 2 }),
        expect.objectContaining({ lat: 3, lng: 4 }),
      ])
    );
  });
});

// Bug fix: selecting a marker used to call panTo(), which fed the last *remembered* fit zoom
// back into WorldMap's `defaultLocation` prop as a new object. WorldMap resets its live pan/zoom
// transform to `defaultLocation` in a `useEffect([initialTransform])` whenever that prop changes —
// the same mechanism 7827547 fixed for the create-pin path — so any manual zoom the user made by
// scrolling on the map (tracked only inside WorldMap's own `useMapPanZoom`, never reported back up)
// got silently discarded the instant a pin was selected. Fix: focusNote no longer touches
// mapLocation at all — "선택 중 뷰포트 불변" (viewport invariant during selection).
describe("HomeMapPane — selecting a marker never moves the viewport", () => {
  const a = note({ id: "note-a", title: "A", lat: 10, lng: 20 });
  const b = note({ id: "note-b", title: "B", lat: 11, lng: 21 });

  beforeEach(() => {
    callMock.mockReset();
    lastMapProps = { markers: [] };
    // Module-level singleton shared with the dashboard search box — reset so a query left over
    // from another test in this file never leaks into an unrelated one. yearFrom/yearTo/
    // yearBounds are deliberately left alone — these tests rely on the store's neutral fallback
    // bounds, not a seeded range.
    useSearchStore.setState({ query: "", searchResults: [] });

    useSettingsStore.setState({
      activeWorkspaceId: "ws1",
      uiLang: "en",
      defaultMapLocation: { lat: 37.5665, lng: 126.978, zoom: 50 },
    });
    useNotesStore.setState({
      selectNote: vi.fn().mockResolvedValue(undefined),
      loadTree: vi.fn().mockResolvedValue(undefined),
      ensureInboxId: vi.fn().mockResolvedValue("inbox1"),
      inboxId: "inbox1",
    } as never);

    callMock.mockImplementation(async (cmd: string, args: { note_id?: string }) => {
      if (cmd === "note_query") return { notes: [a, b], total: 2 };
      if (cmd === "note_regions_list") {
        if (args?.note_id === "note-a") {
          return {
            regions: [
              { id: "r1", note_id: "note-a", name: "Waypoint 1", lat: 10.5, lng: 20.5, position: 0 },
            ],
          };
        }
        return { regions: [] };
      }
      return {};
    });
  });

  it("clicking a marker sets selection without changing defaultLocation (reference-equal, not just equal)", async () => {
    render(<HomeMapPane />);

    await waitFor(() => {
      expect(lastMapProps.markers.some((m) => m.id === "note-a")).toBe(true);
      // Owner QA 2026-08-10: no fit-to-notes on mount — first paint is 설정 홈. The snapshot
      // below just needs the value to have settled.
      expect(lastMapProps.defaultLocation).toBeTruthy();
    });
    const locationBeforeSelect = lastMapProps.defaultLocation;

    await act(async () => {
      lastMapProps.onMarkerClick?.("note-a");
    });

    expect(lastMapProps.defaultLocation).toBe(locationBeforeSelect);
    expect(lastMapProps.markers.find((m) => m.id === "note-a")?.active).toBe(true);
  });

  // Feature: selecting a note shows its note_regions waypoints as distinct-color, non-interactive
  // markers connected to the primary pin by a thin path line ("이 노트의 장소들" at a glance).
  // Reuses the same note_regions_list command + buildRegionPath helper RegionExpanded (sidebar
  // map) already uses — no new backend command.
  it("selecting a note with note_regions renders its waypoints as distinct-color markers connected by a path line", async () => {
    render(<HomeMapPane />);

    await waitFor(() => {
      expect(lastMapProps.markers.some((m) => m.id === "note-a")).toBe(true);
    });

    await act(async () => {
      lastMapProps.onMarkerClick?.("note-a");
    });

    await waitFor(() => {
      expect(lastMapProps.markers.some((m) => m.id === "wp:r1")).toBe(true);
    });
    const wp = lastMapProps.markers.find((m) => m.id === "wp:r1");
    expect(wp?.pinSize).toBe("waypoint");
    expect(wp?.color).toBe("var(--info)");
    expect(wp?.interactive).toBe(false);

    expect(lastMapProps.pathLines).toEqual([
      {
        id: "note-a",
        points: [
          { lat: 10, lng: 20 },
          { lat: 10.5, lng: 20.5 },
        ],
      },
    ]);

    // Deselecting clears the waypoints and the path line.
    await act(async () => {
      lastMapProps.onMarkerClick?.("note-b");
    });
    await waitFor(() => {
      expect(lastMapProps.markers.some((m) => m.id === "wp:r1")).toBe(false);
    });
    expect(lastMapProps.pathLines).toEqual([]);
  });

  it("dashboard search dims non-matching markers in place, never removing them", async () => {
    render(<HomeMapPane />);

    await waitFor(() => {
      expect(lastMapProps.markers.some((m) => m.id === "note-a")).toBe(true);
      expect(lastMapProps.markers.some((m) => m.id === "note-b")).toBe(true);
    });
    // No query yet — nothing dimmed.
    for (const m of lastMapProps.markers) {
      expect(m.dim).toBeFalsy();
    }

    act(() => {
      useSearchStore.setState({
        query: "A",
        searchResults: [
          { id: "note-a", folder_id: "f", title: "A", year: 2020, is_favorite: false, exported_at: null, has_image: false, tag_names: [], region: null, status: null, icon: null, lat: null, lng: null, created_at: "", updated_at: "", month: null, day: null },
        ],
      });
    });

    await waitFor(() => {
      expect(lastMapProps.markers.find((m) => m.id === "note-b")?.dim).toBe(true);
    });
    // Still on the map, just dimmed — never removed.
    expect(lastMapProps.markers.some((m) => m.id === "note-b")).toBe(true);
    expect(lastMapProps.markers.find((m) => m.id === "note-a")?.dim).toBe(false);
  });
});

// QA8 1D: home/recenter target is notebook settings, not the fit-to-notes seed.
describe("HomeMapPane — home target is settings location, independent of note fit", () => {
  const paris = note({ id: "paris", title: "Paris", lat: 48.8566, lng: 2.3522 });
  const settingsHome = { lat: 37.5665, lng: 126.978, zoom: 150 };

  beforeEach(() => {
    callMock.mockReset();
    lastMapProps = { markers: [] };
    useSearchStore.setState({ query: "", searchResults: [] });
    useSettingsStore.setState({
      activeWorkspaceId: "ws1",
      uiLang: "en",
      defaultMapLocation: settingsHome,
    });
    useNotesStore.setState({
      selectNote: vi.fn().mockResolvedValue(undefined),
      loadTree: vi.fn().mockResolvedValue(undefined),
      ensureInboxId: vi.fn().mockResolvedValue("inbox1"),
      inboxId: "inbox1",
    } as never);
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_query") return { notes: [paris], total: 1 };
      return {};
    });
  });

  // Owner QA 2026-08-10: first paint no longer fits to notes — 설정 홈이 기본값. Paris notes
  // stay markers; the camera opens on Seoul settings (both defaultLocation seed and the home
  // button target).
  it("first paint seeds from settings home even when every note is overseas", async () => {
    render(<HomeMapPane />);

    await waitFor(() => {
      expect(lastMapProps.markers.some((m) => m.id === "paris")).toBe(true);
    });
    expect(lastMapProps.defaultLocation).toEqual(settingsHome);
    expect(lastMapProps.homeLocation).toEqual(settingsHome);
  });
});

// Owner reports (W8-b + W8 "아를리트"): dashboard → 지도 tab first paint must always land in a
// "home" state. Two distinct failure modes are pinned here:
//  (1) zoom ceiling — a wheel-zoom past FIT_MAX_ZOOM restored verbatim = blank green landmass;
//  (2) 저장 단위 — the session store now holds a *geographic* view ({lat,lng,zoom}), not a pixel
//      transform: pixels are viewport-size-dependent, and restoring them at a different size
//      pinned x to the placeholder clamp bound and teleported Seoul into the Sahara ("아를리트").
// A sane stored view flows into WorldMap through the ordinary defaultLocation seed path (which
// waits for a real measured size); a stale over-zoomed one is discarded and fit-to-notes runs.
describe("HomeMapPane — session viewport restore is validated before first paint", () => {
  const seoul = note({ id: "seoul", title: "Seoul", lat: 37.5665, lng: 126.978 });

  beforeEach(() => {
    callMock.mockReset();
    lastMapProps = { markers: [] };
    useSearchStore.setState({ query: "", searchResults: [] });
    useSettingsStore.setState({
      activeWorkspaceId: "ws1",
      uiLang: "en",
      defaultMapLocation: { lat: 37.5665, lng: 126.978, zoom: 150 },
    });
    useNotesStore.setState({
      selectNote: vi.fn().mockResolvedValue(undefined),
      loadTree: vi.fn().mockResolvedValue(undefined),
      ensureInboxId: vi.fn().mockResolvedValue("inbox1"),
      inboxId: "inbox1",
    } as never);
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_query") return { notes: [seoul], total: 1 };
      return {};
    });
  });

  it("a sane persisted view (zoom <= FIT_MAX_ZOOM) seeds WorldMap via defaultLocation", async () => {
    const saved = { lat: 48.8566, lng: 2.3522, zoom: FIT_MAX_ZOOM };
    useUiStore.setState({ homeMapView: saved });

    render(<HomeMapPane />);

    await waitFor(() => {
      expect(lastMapProps.markers.some((m) => m.id === "seoul")).toBe(true);
    });
    // Restore rides the seed path — no separate pixel-transform prop exists anymore.
    expect(lastMapProps.defaultLocation).toEqual(saved);
  });

  it("a stale over-zoomed persisted viewport (> FIT_MAX_ZOOM) is discarded — first paint uses 설정 홈 instead", async () => {
    // Reachable via free wheel-zoom (max k=400, useMapPanZoom) — well past anything fit-to-notes
    // would ever produce on its own.
    useUiStore.setState({ homeMapView: { lat: 37.5665, lng: 126.978, zoom: 400 } });

    render(<HomeMapPane />);

    await waitFor(() => {
      expect(lastMapProps.markers.some((m) => m.id === "seoul")).toBe(true);
      // Over-zoomed restore discarded; owner QA 2026-08-10: mount does not fit-to-notes, so the
      // camera lands on defaultMapLocation (설정 홈, zoom 150 in this describe's beforeEach).
      expect(lastMapProps.defaultLocation).toEqual({ lat: 37.5665, lng: 126.978, zoom: 150 });
    });
  });

  // The mount-seeded signature must NOT swallow deliberate refits: changing a filter while mounted
  // is the one route into fit-to-notes (filterSig differs from the signature last placed for).
  it("changing a filter after mount still fits to the filtered notes", async () => {
    useUiStore.setState({ homeMapView: null });
    render(<HomeMapPane />);
    await waitFor(() => {
      // Mount: camera on 설정 홈 (zoom 150), no fit.
      expect(lastMapProps.defaultLocation).toEqual({ lat: 37.5665, lng: 126.978, zoom: 150 });
    });

    act(() => {
      useSearchStore.setState({ yearFrom: 2019, yearTo: 2021 });
    });
    await waitFor(() => {
      // User filter change → new signature → single-note fit (zoom 50), not settings zoom.
      expect(lastMapProps.defaultLocation).toEqual({ lat: 37.5665, lng: 126.978, zoom: 50 });
    });
  });

  // GRILL-2026-10-19 R5: the camera stays on the default region unless the *user* changes a
  // filter. The year histogram arriving after mount (search.ts applyYearCounts) moves
  // yearFrom/yearTo from the neutral fallback bounds to the real corpus bounds — a full range
  // before and after, so nothing the user chose changed. It used to deactivate the mount guard
  // and fit the camera to every note.
  it("year histogram arriving after mount does not move the camera", async () => {
    useUiStore.setState({ homeMapView: null });
    useSearchStore.setState({
      yearBounds: { min: 1926, max: 2026, dataMin: null, dataMax: null, padded: true },
      yearFrom: 1926,
      yearTo: 2026,
    });
    try {
      render(<HomeMapPane />);
      await waitFor(() => {
        expect(lastMapProps.markers.some((m) => m.id === "seoul")).toBe(true);
        expect(lastMapProps.defaultLocation).toEqual({ lat: 37.5665, lng: 126.978, zoom: 150 });
      });
      const before = lastMapProps.defaultLocation;

      await act(async () => {
        useSearchStore.getState().applyYearCounts({ 2010: 2, 2020: 5 });
        await new Promise((r) => setTimeout(r, 50));
      });
      // The histogram really did move the year state — this is the non-user change under test.
      expect(useSearchStore.getState().yearFrom).not.toBe(1926);

      expect(lastMapProps.defaultLocation).toBe(before);
      const hasQueries = callMock.mock.calls.filter(
        ([cmd, input]) =>
          cmd === "note_query" &&
          ((input as Record<string, unknown>).coords as { kind?: string } | undefined)?.kind === "has"
      );
      expect(hasQueries).toHaveLength(0);
    } finally {
      const { yearBounds } = useSearchStore.getState();
      useSearchStore.setState({ yearFrom: yearBounds.min, yearTo: yearBounds.max });
    }
  });

  // Same family: once a user filter change has fitted the camera, a later data refetch (any
  // note write bumps noteQueryVersion) must not refit — only another user filter change may.
  it("a note write after a user filter fit does not refit the camera", async () => {
    useUiStore.setState({ homeMapView: null });
    let lng = 126.978;
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_query") return { notes: [note({ id: "seoul", lat: 37.5665, lng })], total: 1 };
      return {};
    });
    try {
      render(<HomeMapPane />);
      await waitFor(() => {
        expect(lastMapProps.defaultLocation).toEqual({ lat: 37.5665, lng: 126.978, zoom: 150 });
      });
      act(() => {
        useUiStore.getState().toggleDashboardFolderFilter("f");
      });
      await waitFor(() => {
        expect(lastMapProps.defaultLocation).toEqual({ lat: 37.5665, lng: 126.978, zoom: 50 });
      });
      const fitted = lastMapProps.defaultLocation;

      // The note moves (pin drag elsewhere, sync, …) → query version bump → refetch.
      lng = 127.5;
      await act(async () => {
        bumpNoteQueryVersion();
        // bumpNoteQueryVersion() debounces its listener notification by 250ms.
        await new Promise((r) => setTimeout(r, 400));
      });
      expect(lastMapProps.defaultLocation).toBe(fitted);
    } finally {
      useUiStore.setState({ dashboardFolderFilter: null });
    }
  });

  // GRILL-2026-10-19 R15: switching notebooks while the map is mounted lands on a world view
  // (k=1, lat 20, the default location's longitude) — not a fit to the new notebook's notes.
  it("a notebook switch moves the camera to the world view, not a fit", async () => {
    useUiStore.setState({ homeMapView: null });
    try {
      render(<HomeMapPane />);
      await waitFor(() => {
        expect(lastMapProps.defaultLocation).toEqual({ lat: 37.5665, lng: 126.978, zoom: 150 });
      });
      callMock.mockClear();

      act(() => {
        useSettingsStore.setState({ activeWorkspaceId: "ws2" });
      });
      await waitFor(() => {
        expect(lastMapProps.defaultLocation).toEqual({ lat: 20, lng: 126.978, zoom: 1 });
      });
      // No corpus-wide fit query for the new notebook.
      const hasQueries = callMock.mock.calls.filter(
        ([cmd, input]) =>
          cmd === "note_query" &&
          ((input as Record<string, unknown>).coords as { kind?: string } | undefined)?.kind === "has"
      );
      expect(hasQueries).toHaveLength(0);

      // A user filter change inside the new notebook still fits as before.
      act(() => {
        useUiStore.getState().toggleDashboardFolderFilter("f");
      });
      await waitFor(() => {
        expect(lastMapProps.defaultLocation).toEqual({ lat: 37.5665, lng: 126.978, zoom: 50 });
      });
    } finally {
      useUiStore.setState({ dashboardFolderFilter: null });
      useSettingsStore.setState({ activeWorkspaceId: "ws1" });
    }
  });

  // Owner QA 2026-08-11: 장소 검색 픽은 카메라가 그 장소로 날아간다 — 멀리 있는 곳을
  // 검색했는데 핀이 화면 밖에 조용히 찍히는 건 무동작과 같았다. (뷰포트 불변 계약은 지도
  // 클릭 생성·확정 전용 — 위의 creation 테스트가 그대로 지킨다.)
  it("a place-search pick flies the camera to the result and drops the temp pin", async () => {
    useUiStore.setState({ homeMapView: null });
    render(<HomeMapPane />);
    await waitFor(() => {
      expect(lastMapProps.defaultLocation).toEqual({ lat: 37.5665, lng: 126.978, zoom: 150 });
    });

    act(() => {
      (document.querySelector('[data-testid="mock-place-pick"]') as HTMLElement).click();
    });
    await waitFor(() => {
      expect(lastMapProps.defaultLocation).toEqual({ lat: 48.8566, lng: 2.3522, zoom: 320 });
      expect(lastMapProps.markers.some((m) => m.id === "__home_map_temp__")).toBe(true);
    });
  });
});

// Wave D — dashboard map reorganization: right rail (280px), single-line items, folder color dots,
// click/double-click action transfer, left folder legend bubbles.
describe("HomeMapPane — Wave D right rail and left legend reorganization", () => {
  const noteA = note({
    id: "note-a",
    title: "Note Alpha",
    folder_id: "folder-1",
    lat: 37.5,
    lng: 127.0,
    snippet: "<p>Alpha description</p>",
  });
  const noteB = note({
    id: "note-b",
    title: "Note Beta",
    folder_id: "folder-2",
    lat: 37.6,
    lng: 127.1,
    snippet: "<p>Beta description</p>",
  });
  const noteC = note({
    id: "note-c",
    title: "Note Gamma",
    folder_id: "folder-1",
    lat: 37.55,
    lng: 127.05,
  });

  const selectNoteMock = vi.fn();

  beforeEach(() => {
    callMock.mockReset();
    selectNoteMock.mockReset();
    lastMapProps = { markers: [] };
    useSearchStore.setState({ query: "", searchResults: [] });
    useUiStore.setState({ dashboardFolderFilter: null });
    useSettingsStore.setState({
      activeWorkspaceId: "ws1",
      uiLang: "en",
      defaultMapLocation: { lat: 37.5665, lng: 126.978, zoom: 50 },
    });
    useNotesStore.setState({
      selectNote: selectNoteMock,
      loadTree: vi.fn().mockResolvedValue(undefined),
      ensureInboxId: vi.fn().mockResolvedValue("inbox1"),
      inboxId: "inbox1",
      folders: [
        { id: "folder-1", name: "Folder One", color_hue: 120, parent_id: null, position: 0 },
        { id: "folder-2", name: "Folder Two", color_hue: 240, parent_id: null, position: 1 },
      ],
    } as never);
    callMock.mockImplementation(async (cmd: string, input?: Record<string, unknown>) => {
      if (cmd === "note_query") {
        const folderIds = input?.folder_ids as string[] | undefined;
        let notes = [noteA, noteB, noteC];
        if (folderIds && folderIds.length > 0) {
          notes = notes.filter((n) => folderIds.includes(n.folder_id));
        }
        return { notes, total: notes.length };
      }
      if (cmd === "note_regions_list") return { regions: [] };
      return {};
    });
  });

  // GRILL-2026-10-19 R5: with nothing selected the rail lists the notes around the notebook's
  // default region (Seoul here), as if that region had been picked — same nearest-first ranking
  // and cap a marker click uses. A marker click switches to that note's neighbourhood; closing it
  // comes back to the default-region list.
  it("renders 280px right rail with the default-region list initially, then shows detail and 1-line item list on marker click", async () => {
    const { getByTestId } = render(<HomeMapPane />);

    await waitFor(() => {
      expect(lastMapProps.markers.some((m) => m.id === "note-a")).toBe(true);
    });

    const rail = getByTestId("home-map-rail");
    expect(rail).toBeTruthy();
    const defaultArea = getByTestId("home-map-default-area");
    expect(defaultArea.querySelector("h3")?.textContent).toBe("Near your default location 3");
    // Nearest to the default region (37.5665, 126.978) first: Gamma ~6.6km, Alpha ~7.6km, Beta ~11km.
    const order = Array.from(defaultArea.querySelectorAll("[data-testid^='home-map-item-']")).map(
      (el) => el.getAttribute("data-testid")
    );
    expect(order).toEqual(["home-map-item-note-c", "home-map-item-note-a", "home-map-item-note-b"]);
    expect(getByTestId("home-map-item-note-c").textContent).toContain("6.6km");
    expect(rail.textContent).not.toContain("Click a marker to explore nearby notes");

    // Click marker note-a
    await act(async () => {
      lastMapProps.onMarkerClick?.("note-a");
    });

    // Detail header & items shown
    expect(rail.textContent).toContain("Note Alpha");
    expect(rail.textContent).toContain("Folder One");
    expect(rail.textContent).toContain("Alpha description");

    const itemA = getByTestId("home-map-item-note-a");
    const itemC = getByTestId("home-map-item-note-c");
    expect(itemA).toBeTruthy();
    expect(itemC).toBeTruthy();

    // Single click on itemC focuses noteC
    await act(async () => {
      fireEvent.click(itemC);
    });
    expect(rail.textContent).toContain("Note Gamma");

    // Double click on itemA opens noteA
    const updatedItemA = getByTestId("home-map-item-note-a");
    await act(async () => {
      fireEvent.doubleClick(updatedItemA);
    });
    expect(selectNoteMock).toHaveBeenCalledWith("note-a");

    // Close button dismisses selection → back to the default-region list.
    const closeBtn = rail.querySelector("button.icon-btn");
    expect(closeBtn).toBeTruthy();
    await act(async () => {
      fireEvent.click(closeBtn!);
    });
    expect(getByTestId("home-map-default-area").querySelector("h3")?.textContent).toBe(
      "Near your default location 3"
    );
    // The selected-note detail (snippet) is gone.
    expect(rail.textContent).not.toContain("Alpha description");
  });

  it("clicking a default-region list item focuses that note's neighbourhood", async () => {
    const { getByTestId } = render(<HomeMapPane />);
    await waitFor(() => {
      expect(getByTestId("home-map-item-note-b")).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(getByTestId("home-map-item-note-b"));
    });
    const rail = getByTestId("home-map-rail");
    expect(rail.querySelector("h2")?.textContent).toBe("Note Beta");
    // Beta's neighbourhood: itself first, then the nearest others.
    const order = Array.from(rail.querySelectorAll("[data-testid^='home-map-item-']")).map((el) =>
      el.getAttribute("data-testid")
    );
    expect(order[0]).toBe("home-map-item-note-b");
  });

  it("first marker fetch still in flight → loading line, not the empty state", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "note_query") return new Promise(() => {});
      return Promise.resolve({});
    });
    const { getByTestId, queryByTestId } = render(<HomeMapPane />);
    await waitFor(() => {
      expect(getByTestId("home-map-default-area").textContent).toContain(t("common.loading"));
    });
    expect(queryByTestId("home-map-default-empty")).toBeNull();
    expect(getByTestId("home-map-default-area").querySelector("h3")?.textContent).toBe(
      "Near your default location"
    );
  });

  it("no located notes in view → a calm empty line plus the marker hint, not a bare count", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_query") return { notes: [], total: 0 };
      return {};
    });
    const { getByTestId } = render(<HomeMapPane />);
    await waitFor(() => {
      expect(getByTestId("home-map-default-empty").textContent).toBe("No notes nearby yet");
    });
    const area = getByTestId("home-map-default-area");
    expect(area.querySelector("h3")?.textContent).toBe("Near your default location 0");
    expect(area.textContent).toContain("Click a marker to explore nearby notes");
  });

  it("renders left rail (place search only — folder legend moved to the shared nav dot row) and honours the shared folder filter to fit camera", async () => {
    const { getByTestId, queryByTestId } = render(<HomeMapPane />);

    await waitFor(() => {
      expect(lastMapProps.markers.length).toBe(3);
    });

    const railLeft = getByTestId("home-map-rail-left");
    expect(railLeft).toBeTruthy();
    // The folder legend bubbles (home-map-legend) are gone from this pane — they live in
    // FolderDotFilter (nav row), which isn't mounted by this test.
    expect(queryByTestId("home-map-legend")).toBeNull();

    const initialLocation = lastMapProps.defaultLocation;

    // Set the shared filter to "folder-1" — same effect a FolderDotFilter click has.
    await act(async () => {
      useUiStore.getState().toggleDashboardFolderFilter("folder-1");
    });

    expect(useUiStore.getState().dashboardFolderFilter).toBe("folder-1");
    // Only note-a and note-c remain on the map
    expect(lastMapProps.markers.every((m) => m.id === "note-a" || m.id === "note-c")).toBe(true);
    expect(lastMapProps.markers.some((m) => m.id === "note-b")).toBe(false);

    // Camera has fitted to folder 1's notes (noteA & noteC)
    await waitFor(() => {
      expect(lastMapProps.defaultLocation).not.toEqual(initialLocation);
      expect(lastMapProps.defaultLocation?.lat).toBeCloseTo(37.525, 2);
      expect(lastMapProps.defaultLocation?.lng).toBeCloseTo(127.025, 2);
    });

    const folder1Location = lastMapProps.defaultLocation;

    // Toggling the same id again clears it.
    await act(async () => {
      useUiStore.getState().toggleDashboardFolderFilter("folder-1");
    });

    expect(useUiStore.getState().dashboardFolderFilter).toBeNull();
    expect(lastMapProps.markers.length).toBe(3);

    // Camera returns to fitting all notes
    await waitFor(() => {
      expect(lastMapProps.defaultLocation).not.toEqual(folder1Location);
    });
  });
});

describe("HomeMapPane — year filter badge displays '전체 기간' when filter is not narrowed", () => {
  beforeEach(() => {
    callMock.mockReset();
    lastMapProps = { markers: [] };
    useSettingsStore.setState({
      activeWorkspaceId: "ws1",
      uiLang: "ko",
      defaultMapLocation: { lat: 37.5665, lng: 126.978, zoom: 50 },
    });
    useNotesStore.setState({
      selectNote: vi.fn().mockResolvedValue(undefined),
      loadTree: vi.fn().mockResolvedValue(undefined),
      ensureInboxId: vi.fn().mockResolvedValue("inbox1"),
      inboxId: "inbox1",
    } as never);
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_query") return { notes: [], total: 0 };
      return {};
    });
  });

  afterEach(() => {
    useSettingsStore.setState({ uiLang: "en" });
  });

  it("displays '전체 기간' when filter is not narrowed (yearFrom <= min && yearTo >= max)", () => {
    useSearchStore.setState({
      yearBounds: { min: 2025, max: 2028 },
      yearFrom: 2025,
      yearTo: 2028,
    });
    const { getByTestId } = render(<HomeMapPane />);
    const badge = getByTestId("home-map-year-badge");
    expect(badge.textContent).toBe("전체 기간");
    expect(badge.getAttribute("title")).toBe("연도 범위는 사이드바 연도 슬라이더와 연동됩니다");
  });

  it("displays range text when filter is narrowed (yearFrom > min)", () => {
    useSearchStore.setState({
      yearBounds: { min: 2025, max: 2028 },
      yearFrom: 2026,
      yearTo: 2028,
    });
    const { getByTestId } = render(<HomeMapPane />);
    const badge = getByTestId("home-map-year-badge");
    expect(badge.textContent).toBe("2026 – 2028");
    expect(badge.getAttribute("title")).toBe("연도 범위는 사이드바 연도 슬라이더와 연동됩니다");
  });

  it("displays range text when filter is narrowed on the upper bound (yearTo < max)", () => {
    useSearchStore.setState({
      yearBounds: { min: 2025, max: 2028 },
      yearFrom: 2025,
      yearTo: 2027,
    });
    const { getByTestId } = render(<HomeMapPane />);
    const badge = getByTestId("home-map-year-badge");
    expect(badge.textContent).toBe("2025 – 2027");
  });

  it("displays single year when narrowed to a single year", () => {
    useSearchStore.setState({
      yearBounds: { min: 2025, max: 2028 },
      yearFrom: 2026,
      yearTo: 2026,
    });
    const { getByTestId } = render(<HomeMapPane />);
    const badge = getByTestId("home-map-year-badge");
    expect(badge.textContent).toBe("2026");
  });

  it("displays localized 'All time' when language is English and filter is not narrowed", () => {
    useSettingsStore.setState({ uiLang: "en" });
    useSearchStore.setState({
      yearBounds: { min: 2025, max: 2028 },
      yearFrom: 2025,
      yearTo: 2028,
    });
    const { getByTestId } = render(<HomeMapPane />);
    const badge = getByTestId("home-map-year-badge");
    expect(badge.textContent).toBe("All time");
    expect(badge.getAttribute("title")).toBe(t("home.map_year_linked"));
  });
});


