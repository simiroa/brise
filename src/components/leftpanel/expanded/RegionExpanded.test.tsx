import { createElement } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NoteSummary } from "../../../lib/commands.gen";
import type { MapMarker, MapViewportBbox } from "../../map/WorldMap";
import { useNotesStore } from "../../../stores/notes";
import { useUiStore } from "../../../stores/ui";
import { RegionExpanded } from "./RegionExpanded";

const noteQueryMock = vi.fn();
const noteQueryCollectMock = vi.fn();
const callMock = vi.fn().mockResolvedValue({});

vi.mock("../../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  flushAll: vi.fn(),
  registerFlush: vi.fn(),
  emitNotice: vi.fn(),
}));

vi.mock("../../../lib/noteQuery", () => ({
  EXPANDED_BOARD_MAX_NOTES: 1000,
  noteQuery: (...args: unknown[]) => noteQueryMock(...args),
  noteQueryCollect: (...args: unknown[]) => noteQueryCollectMock(...args),
  useNoteQueryVersion: () => 0,
  bumpNoteQueryVersion: vi.fn(),
}));

/** Capture WorldMap props so tests can fire onMarkerClick / onViewportChange. */
let lastMapProps: {
  markers: MapMarker[];
  onMarkerClick?: (id: string) => void;
  onMapClick?: (lat: number, lng: number) => void;
  onViewportChange?: (bbox: MapViewportBbox) => void;
} = { markers: [] };
let firedViewportFor: unknown = null;

vi.mock("../../map/WorldMapAuto", () => ({
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

describe("RegionExpanded — Aperçu preview follows selection", () => {
  let selectNoteSpy: ReturnType<typeof vi.spyOn>;
  let setPreviewItemSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    noteQueryMock.mockReset();
    noteQueryCollectMock.mockReset();
    lastMapProps = { markers: [] };

    noteQueryMock.mockResolvedValue({ notes: [], total: 0 });
    noteQueryCollectMock.mockResolvedValue({ notes: [], total: 0 });

    useUiStore.setState({ previewItem: null });
    selectNoteSpy = vi
      .spyOn(useNotesStore.getState(), "selectNote")
      .mockResolvedValue(undefined);
    setPreviewItemSpy = vi.spyOn(useUiStore.getState(), "setPreviewItem");
    selectNoteSpy.mockClear();
    setPreviewItemSpy.mockClear();
  });

  afterEach(() => {
    selectNoteSpy.mockRestore();
    setPreviewItemSpy.mockRestore();
  });

  it("marker click on a located note sets previewItem to { kind: 'region', id: 'region' } and selectNote", async () => {
    const located = makeNote({
      id: "loc-1",
      title: "Located Note",
      lat: 48.85,
      lng: 2.35,
    });
    noteQueryMock.mockResolvedValue({ notes: [located], total: 1 });
    noteQueryCollectMock.mockResolvedValue({ notes: [], total: 0 });

    render(<RegionExpanded />);

    await waitFor(() => {
      expect(lastMapProps.markers.some((m) => m.id === "loc-1")).toBe(true);
    });

    act(() => {
      lastMapProps.onMarkerClick?.("loc-1");
    });

    expect(selectNoteSpy).toHaveBeenCalledWith("loc-1");
    expect(setPreviewItemSpy).toHaveBeenCalledWith({ kind: "region", id: "region" });
  });

  it("marker click on stacked coords selects the next note and previews region for that note", async () => {
    const a = makeNote({ id: "stack-a", title: "A", lat: 10, lng: 20 });
    const b = makeNote({ id: "stack-b", title: "B", lat: 10, lng: 20 });
    noteQueryMock.mockResolvedValue({ notes: [a, b], total: 2 });
    noteQueryCollectMock.mockResolvedValue({ notes: [], total: 0 });

    render(<RegionExpanded />);

    await waitFor(() => {
      expect(lastMapProps.markers.length).toBeGreaterThan(0);
    });

    const displayedId = lastMapProps.markers[0].id;
    selectNoteSpy.mockClear();
    setPreviewItemSpy.mockClear();
    act(() => {
      lastMapProps.onMarkerClick?.(displayedId);
    });

    expect(selectNoteSpy).toHaveBeenCalled();
    const selectedId = selectNoteSpy.mock.calls[selectNoteSpy.mock.calls.length - 1][0] as string;
    expect(["stack-a", "stack-b"]).toContain(selectedId);
    // Stacked markers cycle: selected note is the next in the group, not necessarily displayedId.
    if (displayedId === "stack-a") {
      expect(selectedId).toBe("stack-b");
    } else {
      expect(selectedId).toBe("stack-a");
    }
    expect(setPreviewItemSpy).toHaveBeenCalledWith({ kind: "region", id: "region" });
  });

  it("selecting an unlocated list row does NOT set region previewItem", async () => {
    const unlocated = makeNote({
      id: "unloc-1",
      title: "Unlocated Note",
      lat: null,
      lng: null,
    });
    noteQueryMock.mockResolvedValue({ notes: [], total: 0 });
    noteQueryCollectMock.mockResolvedValue({ notes: [unlocated], total: 1 });

    const user = userEvent.setup();
    render(<RegionExpanded />);

    await screen.findByText("Unlocated Note");
    setPreviewItemSpy.mockClear();
    selectNoteSpy.mockClear();
    await user.click(screen.getByText("Unlocated Note"));

    expect(selectNoteSpy).toHaveBeenCalledWith("unloc-1");
    expect(setPreviewItemSpy).not.toHaveBeenCalled();
  });

  it("selecting a nearby (located) list row sets region previewItem", async () => {
    const located = makeNote({
      id: "near-1",
      title: "Nearby Note",
      lat: 1,
      lng: 2,
    });
    noteQueryMock.mockResolvedValue({ notes: [located], total: 1 });
    noteQueryCollectMock.mockResolvedValue({ notes: [], total: 0 });

    const user = userEvent.setup();
    render(<RegionExpanded />);

    await waitFor(() => {
      expect(lastMapProps.markers.some((m) => m.id === "near-1")).toBe(true);
    });

    // Focus the coord so the list switches to nearby notes.
    act(() => {
      lastMapProps.onMarkerClick?.("near-1");
    });
    setPreviewItemSpy.mockClear();
    selectNoteSpy.mockClear();

    await screen.findByText("Nearby Note");
    await user.click(screen.getByText("Nearby Note"));

    expect(selectNoteSpy).toHaveBeenCalledWith("near-1");
    expect(setPreviewItemSpy).toHaveBeenCalledWith({ kind: "region", id: "region" });
  });
});

// Parity with the dashboard map (HomeMapPane): left-clicking empty map drops a temp pin and
// opens the shared MapCreatePopover. Confirm writes coords + the reverse-geocoded region string
// through the shared useMapNoteActions path, and — per app convention — does not navigate.
describe("RegionExpanded — left-click empty map → create-pin popover", () => {
  let selectNoteSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    noteQueryMock.mockReset();
    noteQueryCollectMock.mockReset();
    callMock.mockReset();
    lastMapProps = { markers: [] };

    noteQueryMock.mockResolvedValue({ notes: [], total: 0 });
    noteQueryCollectMock.mockResolvedValue({ notes: [], total: 0 });

    useNotesStore.setState({
      inboxId: "inbox1",
      ensureInboxId: vi.fn().mockResolvedValue("inbox1"),
      loadTree: vi.fn().mockResolvedValue(undefined),
    } as never);
    selectNoteSpy = vi
      .spyOn(useNotesStore.getState(), "selectNote")
      .mockResolvedValue(undefined);

    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_create") return { note: makeNote({ id: "made-1" }) };
      if (cmd === "geocode_reverse") return { label: "Reims" };
      if (cmd === "note_set_region") return makeNote({ id: "made-1", region: "Reims" });
      return {};
    });
  });

  afterEach(() => {
    selectNoteSpy.mockRestore();
  });

  it("confirm creates the note at the clicked point, writes its region, and stays put", async () => {
    render(<RegionExpanded />);

    await waitFor(() => {
      expect(lastMapProps.onMapClick).toBeTruthy();
    });

    act(() => {
      lastMapProps.onMapClick!(49.25, 4.03);
    });

    const confirmBtn = await waitFor(() => {
      const btn = document.querySelector('[data-testid="home-map-create-confirm"]');
      expect(btn).toBeTruthy();
      return btn as HTMLElement;
    });

    await act(async () => {
      fireEvent.click(confirmBtn);
      await new Promise((r) => setTimeout(r, 50));
    });

    const cmds = callMock.mock.calls.map(([cmd]) => cmd as string);
    expect(cmds).toContain("note_create");
    const loc = callMock.mock.calls.find(([cmd]) => cmd === "note_set_location");
    expect(loc?.[1]).toMatchObject({ id: "made-1", lat: 49.25, lng: 4.03 });
    // Region string comes from the ONE shared reverse-geocode path.
    expect(callMock.mock.calls.find(([cmd]) => cmd === "note_set_region")?.[1]).toMatchObject({
      id: "made-1",
      region: "Reims",
    });
    // Title omitted → backend default; no navigation after create.
    expect(callMock.mock.calls.find(([cmd]) => cmd === "note_create")?.[1]).not.toHaveProperty(
      "title"
    );
    expect(selectNoteSpy).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(document.querySelector('[data-testid="home-map-create-popover"]')).toBeNull();
    });
  });
});

// 2026-10-22: 데스크톱 사이드바는 지도 보기를 숨긴 채 살려 둔다(LeftPanel). 숨은 동안은 조회·지도
// props·쓰기 핸들러가 멈춰야 하고, 보이는 순간 바뀐 것만 따라잡아야 한다.
describe("RegionExpanded — kept mounted while hidden (active=false)", () => {
  beforeEach(async () => {
    noteQueryMock.mockReset();
    noteQueryCollectMock.mockReset();
    lastMapProps = { markers: [] };
    noteQueryMock.mockResolvedValue({ notes: [], total: 0 });
    noteQueryCollectMock.mockResolvedValue({ notes: [], total: 0 });
    const { useSearchStore } = await import("../../../stores/search");
    useSearchStore.setState({ yearFrom: 1000, yearTo: 2000 });
  });

  it("hidden: filter changes fire no queries; showing again catches up once", async () => {
    const { useSearchStore } = await import("../../../stores/search");
    // 잘린 응답(total > 500)은 bbox 재사용이 안 돼 뷰포트가 바뀌면 늘 다시 조회한다 — 아래 숨은
    // 동안의 뷰포트 변경이 정말 묶였는지를 그래서 가를 수 있다.
    noteQueryMock.mockResolvedValue({ notes: [], total: 501 });
    const { rerender } = render(<RegionExpanded active />);
    await waitFor(() => expect(noteQueryCollectMock).toHaveBeenCalledTimes(1));

    await waitFor(() => expect(noteQueryMock).toHaveBeenCalledTimes(1));

    rerender(<RegionExpanded active={false} />);
    act(() => useSearchStore.setState({ yearFrom: 1200 }));
    // 숨은 지도의 resize→moveend 가 보낸 bbox 도 조회를 일으키지 않는다.
    act(() =>
      lastMapProps.onViewportChange?.({ min_lat: 10, max_lat: 20, min_lng: 10, max_lng: 20 }),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(noteQueryCollectMock).toHaveBeenCalledTimes(1);
    expect(noteQueryMock).toHaveBeenCalledTimes(1);

    rerender(<RegionExpanded active />);
    await waitFor(() => expect(noteQueryCollectMock).toHaveBeenCalledTimes(2));
    expect(noteQueryCollectMock.mock.calls[1][0]).toMatchObject({ yearFrom: 1200 });

    // 바뀐 게 없으면 다시 보여도 조회하지 않는다.
    rerender(<RegionExpanded active={false} />);
    rerender(<RegionExpanded active />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(noteQueryCollectMock).toHaveBeenCalledTimes(2);
  });

  it("hidden: map write handlers (drop · click · pin move · context menu) are withdrawn", async () => {
    const { rerender } = render(<RegionExpanded active />);
    const props = () => lastMapProps as unknown as Record<string, unknown>;
    await waitFor(() => expect(props().onDropNote).toBeTruthy());
    expect(props().onMapClick).toBeTruthy();

    rerender(<RegionExpanded active={false} />);
    expect(props().onDropNote).toBeUndefined();
    expect(props().onMapClick).toBeUndefined();
    expect(props().onMarkerMove).toBeUndefined();
    expect(props().onMapContextMenu).toBeUndefined();
  });

  it("hidden: markers handed to the map keep their identity while the selection changes", async () => {
    const located = makeNote({ id: "loc-h", lat: 1, lng: 2 });
    noteQueryMock.mockResolvedValue({ notes: [located], total: 1 });
    const { rerender } = render(<RegionExpanded active />);
    await waitFor(() => expect(lastMapProps.markers.some((m) => m.id === "loc-h")).toBe(true));

    rerender(<RegionExpanded active={false} />);
    const heldMarkers = lastMapProps.markers;
    act(() => {
      useNotesStore.setState({ activeNote: { note: located, sections: [] } as never });
    });
    expect(lastMapProps.markers).toBe(heldMarkers);

    rerender(<RegionExpanded active />);
    expect(lastMapProps.markers).not.toBe(heldMarkers);
    expect(lastMapProps.markers.find((m) => m.id === "loc-h")?.active).toBe(true);
    act(() => {
      useNotesStore.setState({ activeNote: null } as never);
    });
  });

  it("hidden: the held note's waypoints are not refetched on note mutations after switching notes", async () => {
    const regionsFor = (id: string) =>
      callMock.mock.calls.filter(([cmd, args]) => cmd === "note_regions_list" && (args as { note_id?: string })?.note_id === id).length;
    callMock.mockReset();
    callMock.mockImplementation(async (cmd: string) => (cmd === "note_regions_list" ? { regions: [] } : {}));
    const a = makeNote({ id: "wp-held-a" });
    const b = makeNote({ id: "wp-held-b" });
    act(() => {
      useNotesStore.setState({ activeNote: { note: a, sections: [] } as never });
    });
    const { rerender } = render(<RegionExpanded active />);
    await waitFor(() => expect(regionsFor("wp-held-a")).toBe(1));

    rerender(<RegionExpanded active={false} />);
    act(() => {
      useNotesStore.setState({ activeNote: { note: b, sections: [] } as never });
    });
    act(() => useNotesStore.getState().bumpAttachmentRevision());
    act(() => useNotesStore.getState().bumpAttachmentRevision());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(regionsFor("wp-held-a")).toBe(1);
    expect(regionsFor("wp-held-b")).toBe(0);

    // 다시 보이면 지금 노트의 경유지를 한 번 조회한다.
    rerender(<RegionExpanded active />);
    await waitFor(() => expect(regionsFor("wp-held-b")).toBe(1));
    act(() => {
      useNotesStore.setState({ activeNote: null } as never);
    });
  });

  it("deferMap: paints a same-box placeholder first, mounts the map after two frames", async () => {
    render(<RegionExpanded deferMap />);
    expect(screen.getByTestId("region-map-placeholder")).toBeTruthy();
    expect(screen.queryByTestId("mock-world-map")).toBeNull();
    await screen.findByTestId("mock-world-map");
    expect(screen.queryByTestId("region-map-placeholder")).toBeNull();
  });
});
