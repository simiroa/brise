import { createElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NoteSummary } from "../lib/commands.gen";
import type { MapMarker, MapViewportBbox } from "../components/map/WorldMap";
import { useNotesStore } from "../stores/notes";
import { MobileRegionView } from "./MobileRegionView";
import { t } from "../i18n/t";

const noteQueryMock = vi.fn();
const noteQueryCollectMock = vi.fn();
const callMock = vi.fn().mockResolvedValue({});

vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  flushAll: vi.fn(),
  registerFlush: vi.fn(),
  emitNotice: vi.fn(),
}));

vi.mock("../lib/noteQuery", () => ({
  EXPANDED_BOARD_MAX_NOTES: 1000,
  noteQuery: (...args: unknown[]) => noteQueryMock(...args),
  noteQueryCollect: (...args: unknown[]) => noteQueryCollectMock(...args),
  useNoteQueryVersion: () => 0,
  bumpNoteQueryVersion: vi.fn(),
}));

vi.mock("../lib/useGeocodeSearch", () => ({
  useGeocodeSearch: () => ({
    results: [{ label: "Paris, France", lat: 48.85, lng: 2.35 }],
    searching: false,
    unavailable: false,
  }),
}));

// dropCreatePin only sets local state (no IPC), so a write-call filter can't see it — spy on it.
const dropCreatePinMock = vi.fn();
vi.mock("../components/map/useMapNoteActions", () => ({
  useMapNoteActions: () => ({
    refreshRegionFromCoords: vi.fn(),
    onDropNote: vi.fn(),
    onMarkerMove: vi.fn(),
    createNoteAt: vi.fn(),
    createPin: null,
    creating: false,
    onMapClick: vi.fn(),
    dropCreatePin: (...args: unknown[]) => dropCreatePinMock(...args),
    cancelCreate: vi.fn(),
    confirmCreate: vi.fn(),
  }),
}));

/** Capture WorldMap props so tests can fire onMarkerClick / onViewportChange. */
let lastMapProps: {
  markers: MapMarker[];
  onMarkerClick?: (id: string) => void;
  onMapClick?: (lat: number, lng: number) => void;
  onMarkerMove?: unknown;
  onDropNote?: unknown;
  onMapContextMenu?: unknown;
  onViewportChange?: (bbox: MapViewportBbox) => void;
  defaultLocation?: { lat: number; lng: number; zoom?: number } | null;
} = { markers: [] };
let firedViewportFor: unknown = null;

vi.mock("../components/map/WorldMapAuto", () => ({
  WorldMapAuto: (props: {
    markers: MapMarker[];
    onMarkerClick?: (id: string) => void;
    onMapClick?: (lat: number, lng: number) => void;
    onViewportChange?: (bbox: MapViewportBbox) => void;
  }) => {
    lastMapProps = props;
    // Fire a viewport once *per mount* so the located-notes effect runs. The real WorldMap
    // reports from an effect keyed on its transform, not on every render — re-firing per render
    // here spins a microtask loop that starves timers (any setTimeout in a test never fires).
    if (props.onViewportChange && firedViewportFor !== props.onViewportChange) {
      firedViewportFor = props.onViewportChange;
      queueMicrotask(() =>
        props.onViewportChange!({
          min_lat: -90,
          max_lat: 90,
          min_lng: -180,
          max_lng: 180,
        }),
      );
    }
    return createElement("div", {
      "data-testid": "mock-world-map",
      "data-marker-count": String(props.markers.length),
    });
  },
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


describe("MobileRegionView (view-only)", () => {
  beforeEach(() => {
    noteQueryMock.mockReset();
    noteQueryCollectMock.mockReset();
    lastMapProps = { markers: [] };
    noteQueryMock.mockResolvedValue({ notes: [], total: 0 });
    noteQueryCollectMock.mockResolvedValue({ notes: [], total: 0 });
  });

  it("pin tap opens the note via onOpenNote and does not select it in the store", async () => {
    const located = makeNote({ id: "loc-1", title: "Located", lat: 48.85, lng: 2.35 });
    noteQueryMock.mockResolvedValue({ notes: [located], total: 1 });
    const spy = vi.spyOn(useNotesStore.getState(), "selectNote").mockResolvedValue(undefined);
    const onOpenNote = vi.fn();
    render(<MobileRegionView onOpenNote={onOpenNote} />);
    // 첫 테스트는 lazy 청크 로드 비용을 낸다 — 기본 1초 타임아웃으론 모자라다.
    await waitFor(() => expect(lastMapProps.markers.some((m) => m.id === "loc-1")).toBe(true), { timeout: 5000 });
    act(() => lastMapProps.onMarkerClick?.("loc-1"));
    expect(onOpenNote).toHaveBeenCalledWith("loc-1");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("stacked pin does not open a note; it lists the nearby notes to pick from", async () => {
    const a = makeNote({ id: "a", title: "Note A", lat: 10, lng: 20 });
    const b = makeNote({ id: "b", title: "Note B", lat: 10, lng: 20 });
    noteQueryMock.mockResolvedValue({ notes: [a, b], total: 2 });
    const onOpenNote = vi.fn();
    const user = userEvent.setup();
    render(<MobileRegionView onOpenNote={onOpenNote} />);
    await waitFor(() => expect(lastMapProps.markers.length).toBeGreaterThan(0));
    act(() => lastMapProps.onMarkerClick?.(lastMapProps.markers[0].id));
    expect(onOpenNote).not.toHaveBeenCalled();
    await user.click(await screen.findByText("Note B"));
    expect(onOpenNote).toHaveBeenCalledWith("b");
  });

  it("list row tap opens the note", async () => {
    const unloc = makeNote({ id: "u1", title: "No Place" });
    noteQueryCollectMock.mockResolvedValue({ notes: [unloc], total: 1 });
    const onOpenNote = vi.fn();
    const user = userEvent.setup();
    render(<MobileRegionView onOpenNote={onOpenNote} />);
    await user.click(await screen.findByText("No Place"));
    expect(onOpenNote).toHaveBeenCalledWith("u1");
  });

  it("passes no write handlers to the map and renders no create/lock affordance", async () => {
    render(<MobileRegionView onOpenNote={vi.fn()} />);
    await screen.findByTestId("mock-world-map");
    expect(lastMapProps.onMapClick).toBeUndefined();
    expect(lastMapProps.onMarkerMove).toBeUndefined();
    expect(lastMapProps.onDropNote).toBeUndefined();
    expect(lastMapProps.onMapContextMenu).toBeUndefined();
    expect(screen.queryByRole("button", { pressed: false })).toBeNull();
    expect(screen.queryByRole("button", { pressed: true })).toBeNull();
  });

  it("place search is shown, and a pick only flies the map — no create pin, no note write", async () => {
    dropCreatePinMock.mockClear();
    const user = userEvent.setup();
    render(<MobileRegionView onOpenNote={vi.fn()} />);
    await screen.findByTestId("mock-world-map");
    const input = screen.getByTestId("home-map-search-input");
    await user.click(input); // focus opens the dropdown (mocked results already present)
    await user.type(input, "Paris");
    await user.click(await screen.findByTestId("home-map-search-result-0"));
    await waitFor(() => expect(lastMapProps.defaultLocation).toMatchObject({ lat: 48.85, lng: 2.35 }));
    expect(dropCreatePinMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("home-map-create-backdrop")).toBeNull();
  });

  // 2026-10-19 화면 보드: 탭을 연 직후 응답 전 약 0.3초 동안 "0 · 모든 노트에 위치가 지정되어
  // 있습니다" 가 보였다가 "지역 없음 49" 로 바뀌었다. 응답 전은 '모름'이지 '없음'이 아니다.
  it("shows a loading state, not the 'every note is located' copy, until the list answers", async () => {
    let resolveList!: (v: { notes: NoteSummary[]; total: number }) => void;
    noteQueryCollectMock.mockReturnValue(new Promise((r) => (resolveList = r)));
    render(<MobileRegionView onOpenNote={vi.fn()} />);

    const status = await screen.findByTestId("region-list-status", undefined, { timeout: 5000 });
    expect(status.getAttribute("data-state")).toBe("loading");
    expect(status.textContent).toBe(t("common.loading"));
    expect(screen.queryByText(t("search.region_empty"))).toBeNull();

    await act(async () => resolveList({ notes: [makeNote({ id: "u1", title: "No Place" })], total: 1 }));
    expect(await screen.findByText("No Place")).toBeTruthy();
    expect(screen.queryByTestId("region-list-status")).toBeNull();
  });

  it("a genuinely empty answer still reads 'every note is located'", async () => {
    render(<MobileRegionView onOpenNote={vi.fn()} />);
    await waitFor(
      () => expect(screen.getByTestId("region-list-status").getAttribute("data-state")).toBe("empty"),
      { timeout: 5000 },
    );
    expect(screen.getByText(t("search.region_empty"))).toBeTruthy();
  });

  it("a failed load says so (with retry) instead of claiming every note is located", async () => {
    noteQueryCollectMock.mockRejectedValueOnce({ code: "NET", message: "offline" });
    const user = userEvent.setup();
    render(<MobileRegionView onOpenNote={vi.fn()} />);

    await waitFor(
      () => expect(screen.getByTestId("region-list-status").getAttribute("data-state")).toBe("error"),
      { timeout: 5000 },
    );
    expect(screen.getByText(t("search.region_load_failed"))).toBeTruthy();
    expect(screen.queryByText(t("search.region_empty"))).toBeNull();

    noteQueryCollectMock.mockResolvedValueOnce({ notes: [makeNote({ id: "u2", title: "Back Online" })], total: 1 });
    await user.click(screen.getByRole("button", { name: t("common.retry") }));
    expect(await screen.findByText("Back Online")).toBeTruthy();
  });
});
