import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useViewportMarkers, MAP_MARKER_LIMIT } from "./useViewportMarkers";
import { call } from "../../lib/invoke";
import type { MapViewportBbox } from "./geometry";

// Bbox coalescing (owner-approved perf backlog, 2026-08-10): a committed pan/zoom transform used
// to re-run note_query unconditionally, even for a small pan fully inside the area the previous
// fetch already covered. Each query now pads its bbox ~30% wider than the raw viewport, and the
// next viewport commit skips the fetch entirely when that padded bbox still covers it, filters/
// noteQueryVersion are unchanged, and the prior response wasn't limit-truncated.

vi.mock("../../lib/invoke", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/invoke")>();
  return { ...actual, call: vi.fn(), callSilent: vi.fn() };
});

function note(id: string, lat: number, lng: number) {
  return {
    id,
    folder_id: "f",
    title: id,
    year: 2020,
    is_favorite: false,
    exported_at: null,
    has_image: false,
    tag_names: [],
    region: null,
    status: null,
    icon: null,
    lat,
    lng,
    created_at: "2020-01-01T00:00:00Z",
    updated_at: "2020-01-01T00:00:00Z",
    month: null,
    day: null,
  };
}

const smallViewport: MapViewportBbox = { min_lat: 10, max_lat: 20, min_lng: 10, max_lng: 20 };

describe("useViewportMarkers — bbox re-query coalescing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips the refetch for a small pan that stays inside the previous padded bbox", async () => {
    const mockCall = vi.mocked(call);
    mockCall.mockResolvedValue({ notes: [note("a", 15, 15)], total: 1 });

    const { result, rerender } = renderHook(
      ({ viewport }) => useViewportMarkers(viewport, {}, 0),
      { initialProps: { viewport: smallViewport as MapViewportBbox | null } }
    );

    await waitFor(() => expect(result.current.located).toHaveLength(1));
    expect(mockCall).toHaveBeenCalledTimes(1);

    // Small pan, still within the ~30%-padded bbox of the previous query.
    const pannedWithinPadding: MapViewportBbox = { min_lat: 11, max_lat: 21, min_lng: 11, max_lng: 21 };
    rerender({ viewport: pannedWithinPadding });

    // Give any (incorrectly) fired effect a tick to resolve.
    await new Promise((r) => setTimeout(r, 10));
    expect(mockCall).toHaveBeenCalledTimes(1);
    expect(result.current.located).toHaveLength(1);
  });

  it("refetches when the viewport zooms out past the previous padded coverage", async () => {
    const mockCall = vi.mocked(call);
    mockCall.mockResolvedValue({ notes: [note("a", 15, 15)], total: 1 });

    const { rerender } = renderHook(
      ({ viewport }) => useViewportMarkers(viewport, {}, 0),
      { initialProps: { viewport: smallViewport as MapViewportBbox | null } }
    );
    await waitFor(() => expect(mockCall).toHaveBeenCalledTimes(1));

    const zoomedOut: MapViewportBbox = { min_lat: -50, max_lat: 50, min_lng: -50, max_lng: 50 };
    rerender({ viewport: zoomedOut });

    await waitFor(() => expect(mockCall).toHaveBeenCalledTimes(2));
  });

  it("refetches when the filter axes change even if the viewport is unchanged", async () => {
    const mockCall = vi.mocked(call);
    mockCall.mockResolvedValue({ notes: [note("a", 15, 15)], total: 1 });

    const { rerender } = renderHook(
      ({ tags }) => useViewportMarkers(smallViewport, { selectedTags: tags }, 0),
      { initialProps: { tags: ["x"] as string[] } }
    );
    await waitFor(() => expect(mockCall).toHaveBeenCalledTimes(1));

    rerender({ tags: ["y"] });
    await waitFor(() => expect(mockCall).toHaveBeenCalledTimes(2));
  });

  it("refetches when noteQueryVersion increases even if the viewport is unchanged", async () => {
    const mockCall = vi.mocked(call);
    mockCall.mockResolvedValue({ notes: [note("a", 15, 15)], total: 1 });

    const { rerender } = renderHook(
      ({ version }) => useViewportMarkers(smallViewport, {}, version),
      { initialProps: { version: 0 } }
    );
    await waitFor(() => expect(mockCall).toHaveBeenCalledTimes(1));

    rerender({ version: 1 });
    await waitFor(() => expect(mockCall).toHaveBeenCalledTimes(2));
  });

  it("never skips a refetch when the previous response was limit-truncated (total > MAP_MARKER_LIMIT)", async () => {
    const mockCall = vi.mocked(call);
    // total exceeds the limit — the fetched page is not "the whole bbox".
    mockCall.mockResolvedValue({ notes: [note("a", 15, 15)], total: MAP_MARKER_LIMIT + 1 });

    const { rerender } = renderHook(
      ({ viewport }) => useViewportMarkers(viewport, {}, 0),
      { initialProps: { viewport: smallViewport as MapViewportBbox | null } }
    );
    await waitFor(() => expect(mockCall).toHaveBeenCalledTimes(1));

    // Tiny pan, well within padding — would normally coalesce, but the prior fetch was truncated.
    const tinyPan: MapViewportBbox = { min_lat: 10.1, max_lat: 20.1, min_lng: 10.1, max_lng: 20.1 };
    rerender({ viewport: tinyPan });

    await waitFor(() => expect(mockCall).toHaveBeenCalledTimes(2));
  });
});
