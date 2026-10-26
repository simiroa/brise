/**
 * Wave 7 — home "Map" tab: promote the existing WorldMap into a full-width pane.
 * Fit-to-notes, year-slider linkage, right rail, folder bubble filter legend,
 * place search → temp pin → note_create.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  WorldMapAuto,
  type MapLocation,
  type MapMarker,
  type MapPathLine,
  type MapViewportBbox,
} from "../map/WorldMapAuto";
import { useSearchStore } from "../../stores/search";
import { useSettingsStore } from "../../stores/settings";
import { useNotesStore, displayTitle } from "../../stores/notes";
import { useUiStore } from "../../stores/ui";
import { noteQuery, useNoteQueryVersion } from "../../lib/noteQuery";
import { noteHasCoords } from "../leftpanel/expanded/viewData";
import { useViewportMarkers, MAP_MARKER_LIMIT } from "../map/useViewportMarkers";
import { IconClose } from "../icons";
import type { NoteSummary } from "../../lib/commands.gen";
import type { GeocodeResultItem } from "../../lib/useGeocodeSearch";
import { fitNotesLocation, nearestAround, nearestTo, formatKm, FIT_MAX_ZOOM } from "./mapFit";
import { PICK_FLYTO_ZOOM } from "../map/mapZoomScale";
import { MapPlaceSearch } from "./MapPlaceSearch";
import { MapCreatePopover } from "./MapCreatePopover";
import { useMapNoteActions } from "../map/useMapNoteActions";
import { MapContextMenu, type MapContextMenuState } from "../map/MapContextMenu";
import { buildRegionPath, buildWaypointPins, toWaypointRegions } from "../attachments/regionDisplay";
import { useDashboardSearchHits } from "./useDashboardSearchHits";
import { useDashboardReveal } from "./useDashboardReveal";
import { useNoteWaypoints } from "./useNoteWaypoints";
import { useActiveTabResize } from "./useActiveTabResize";
import { folderColorCss } from "../../lib/ui";
import { snippetText } from "../../lib/ui";
import { t } from "../../i18n/t";

const STRIP_NEIGHBORS = 8;
const FIT_FALLBACK_W = 960;
const FIT_FALLBACK_H = 520;
/** Synthetic marker id for the temporary create pin (not a note). */
const TEMP_PIN_ID = "__home_map_temp__";
/** World view a notebook switch lands on (GRILL-2026-10-19 R15): k=1 (useMapPanZoom's absolute
 *  minimum, the whole world) at a mid-northern latitude so the inhabited band fills the frame. */
const WORLD_VIEW_ZOOM = 1;
const WORLD_VIEW_LAT = 20;

// W-P3: active prop accepted for tab switching. HomeMapPane keeps maplibre canvas rendered
// to avoid WebGL context loss; viewport marker queries are tied to user pan/zoom movements.
export function HomeMapPane({ active = true }: { active?: boolean }) {
  useActiveTabResize(active);
  const yearFrom = useSearchStore((s) => s.yearFrom);
  const yearTo = useSearchStore((s) => s.yearTo);
  const yearBounds = useSearchStore((s) => s.yearBounds);
  const isFilterNarrowed = yearBounds ? (yearFrom > yearBounds.min || yearTo < yearBounds.max) : false;
  // Same filter axes the sidebar map (RegionExpanded) has always honoured — the dashboard map
  // used to ignore them, so a tag/status/region/date filter narrowed every other view but left
  // this one showing the whole notebook.
  const selectedTags = useSearchStore((s) => s.selectedTags);
  const tagMode = useSearchStore((s) => s.tagMode);
  const regionFilter = useSearchStore((s) => s.regionFilter);
  const statusFilter = useSearchStore((s) => s.statusFilter);
  const dateRange = useSearchStore((s) => s.dateRange);
  const defaultMapLocation = useSettingsStore((s) => s.defaultMapLocation);
  const uiLang = useSettingsStore((s) => s.uiLang);
  const activeWorkspaceId = useSettingsStore((s) => s.activeWorkspaceId);
  const folders = useNotesStore((s) => s.folders);
  const selectNote = useNotesStore((s) => s.selectNote);
  const noteQueryVersion = useNoteQueryVersion();
  const searchHits = useDashboardSearchHits();
  const setHomeMapView = useUiStore((s) => s.setHomeMapView);
  const [restoredView] = useState<MapLocation | null>(() => {
    const v = useUiStore.getState().homeMapView;
    return v != null && v.zoom <= FIT_MAX_ZOOM ? v : null;
  });

  const [viewport, setViewport] = useState<MapViewportBbox | null>(null);
  const [mapLocation, setMapLocation] = useState<MapLocation | null>(restoredView);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Dashboard-wide folder filter (nav row dot control, stores/ui.ts) — replaces the old local
  // useState + the home-map-legend rail. Removal (not dim) semantics below (filteredLocated /
  // markers) are unchanged from before the move.
  const folderFilter = useUiStore((s) => s.dashboardFolderFilter);
  const containerRef = useRef<HTMLDivElement>(null);

  /** Every axis that changes *which* notes belong on this map, in the form the *user* chose it.
   *  The year axis is `null` while the range is not narrowed: the year histogram arriving
   *  (search.ts `applyYearCounts`, also re-run by every `refreshYearHistogram` after loadTree)
   *  moves yearFrom/yearTo from one full range to another, which is not a filter change anyone
   *  made. Raw years here are what used to refit the camera to every note right after mount
   *  (GRILL-2026-10-19 R5).
   *  ponytail: a narrowed range that a bounds change clamps still reads as a change — rare (the
   *  corpus has to shrink past the user's range) and lands on the same notes anyway. */
  const yearAxis = isFilterNarrowed ? `${yearFrom}-${yearTo}` : null;
  const filterSig = useMemo(
    () =>
      JSON.stringify([
        activeWorkspaceId,
        yearAxis,
        selectedTags,
        tagMode,
        regionFilter,
        statusFilter,
        dateRange,
        folderFilter,
      ]),
    [
      activeWorkspaceId,
      yearAxis,
      selectedTags,
      tagMode,
      regionFilter,
      statusFilter,
      dateRange,
      folderFilter,
    ]
  );

  /** The filter signature the camera was last placed for. Seeded with the mount signature: the
   *  camera opens on the restored session view or the notebook's default region, never on a fit. */
  const fittedSigRef = useRef(filterSig);
  /** The notebook the camera was last placed for — tells a notebook switch apart from a filter
   *  change inside one notebook (both change filterSig). */
  const placedWorkspaceRef = useRef(activeWorkspaceId);

  const onViewportChange = useCallback((bbox: MapViewportBbox) => {
    setViewport(bbox);
  }, []);

  // Markers: viewport-scoped, server-bounded — the same query shape the sidebar map uses (see
  // useViewportMarkers).
  const { located, loading, settled: markersSettled } = useViewportMarkers(
    viewport,
    {
      workspaceId: activeWorkspaceId ?? undefined,
      yearFrom,
      yearTo,
      selectedTags,
      tagMode,
      regionFilter,
      statusFilter,
      dateRange,
    },
    noteQueryVersion
  );

  // Wave E reveal handler: fly to note coordinates + select note. Consumption/tab-guard ordering
  // lives in useDashboardReveal (see that file — fixes stale replay on tab switch, and stops a
  // stale reveal from clobbering the viewport this session already restored into `restoredView`
  // above).
  useDashboardReveal("map", (noteId: string) => {
    const note =
      located.find((n) => n.id === noteId) ??
      useNotesStore.getState().noteIndex.get(noteId);

    if (note && note.lat != null && note.lng != null) {
      setMapLocation({ lat: note.lat, lng: note.lng, zoom: PICK_FLYTO_ZOOM });
    }
    setSelectedId(noteId);
  });

  const folderById = useMemo(() => new Map(folders.map((folder) => [folder.id, folder])), [folders]);

  // Toggling the filter used to also clear a stale selectedId inline (same click handler, the
  // legend bubble). The click now happens in a sibling component (FolderDotFilter, nav row), so
  // replicate the side effect declaratively: react only when folderFilter itself actually changes
  // (prevFilterRef guard — a same-value re-render, e.g. from `located` refetching, must not
  // re-fire this).
  const prevFolderFilterRef = useRef(folderFilter);
  useEffect(() => {
    if (prevFolderFilterRef.current === folderFilter) return;
    prevFolderFilterRef.current = folderFilter;
    if (!folderFilter || !selectedId) return;
    const sel = located.find((n) => n.id === selectedId);
    if (sel && sel.folder_id !== folderFilter) setSelectedId(null);
  }, [folderFilter, located, selectedId]);

  const filteredLocated = useMemo(() => {
    if (!folderFilter) return located;
    return located.filter((n) => n.folder_id === folderFilter);
  }, [located, folderFilter]);

  // Fit-to-notes runs only as the answer to a user-made filter change (filterSig above). A data
  // refetch under the same signature — any note write bumps noteQueryVersion: create from the
  // map, pin move, tree drop, sync — never refits, so this effect neither depends on the query
  // version nor re-fetches on it. Deps are deliberately `[filterSig]` alone: listing the raw axes
  // would re-run (and cancel an in-flight fit) on a histogram-only year change.
  // The source query is deliberately NOT the bbox query above: fitting the camera to whatever is
  // already inside the camera is the chicken-and-egg RegionExpanded documents for its region focus.
  useEffect(() => {
    if (filterSig === fittedSigRef.current) return;
    fittedSigRef.current = filterSig;
    // Notebook switch → world view, not a fit to the new notebook's notes (GRILL-2026-10-19 R15):
    // a fit lands wherever that notebook's notes happen to cluster, which read as the map jumping
    // somewhere arbitrary. Longitude = the default location's, so the home region sits mid-screen.
    // ponytail: default_map_location is one device-wide key, so every notebook shares that
    // longitude. Once a per-notebook default location exists, switch to that notebook's own
    // default view here instead of the world view.
    if (activeWorkspaceId !== placedWorkspaceRef.current) {
      placedWorkspaceRef.current = activeWorkspaceId;
      const home = useSettingsStore.getState().defaultMapLocation;
      setMapLocation({ lat: WORLD_VIEW_LAT, lng: home.lng, zoom: WORLD_VIEW_ZOOM });
      return;
    }
    let cancelled = false;
    void (async () => {
      let points: { lat: number; lng: number }[] = [];
      try {
        const r = await noteQuery({
          workspaceId: activeWorkspaceId ?? undefined,
          folderIds: folderFilter ? [folderFilter] : undefined,
          yearFrom,
          yearTo,
          selectedTags,
          tagMode,
          regionFilter,
          statusFilter,
          dateRange,
          coords: { kind: "has" },
          sort: "title_asc",
          offset: 0,
          limit: MAP_MARKER_LIMIT,
        });
        points = r.notes.filter(noteHasCoords).map((n) => ({ lat: n.lat!, lng: n.lng! }));
      } catch {
        // noteQuery's own call() already logged the failure — land on the default region rather
        // than leaving the camera on the previous filter's notes.
        points = [];
      }
      if (cancelled) return;
      // Read at resolve time, not from the closure: deps are `[filterSig]` alone, and a notebook
      // switch sets activeWorkspaceId before reloadAppearance() brings that notebook's default.
      const home = useSettingsStore.getState().defaultMapLocation;
      if (points.length === 0) {
        setMapLocation(home);
        return;
      }
      const el = containerRef.current;
      const w = el && el.clientWidth > 0 ? el.clientWidth : FIT_FALLBACK_W;
      const h = el && el.clientHeight > 0 ? el.clientHeight : FIT_FALLBACK_H;
      setMapLocation(fitNotesLocation(points, w, h) ?? home);
    })();
    return () => {
      cancelled = true;
    };
  }, [filterSig]);

  // Note writes from the map (create / tree-drop / pin-move) — shared with the sidebar map. None
  // of them moves the camera: they only bump noteQueryVersion, which the fit effect ignores.
  const {
    createPin,
    creating,
    onMapClick: dropPinAt,
    dropCreatePin,
    cancelCreate,
    confirmCreate,
    onDropNote,
    onMarkerMove,
  } = useMapNoteActions({ anchorRef: containerRef });

  const [mapCtxOpen, setMapCtxOpen] = useState<MapContextMenuState | null>(null);

  // noteIndex covers notes that fell outside the MAP_MARKER_LIMIT slice or a future bbox
  // query — the selected note's primary pin must still be drawable (waypoints alone look wrong).
  const noteIndex = useNotesStore((s) => s.noteIndex);

  const selectedNote = useMemo(() => {
    if (!selectedId) return null;
    const candidate =
      filteredLocated.find((n) => n.id === selectedId) ??
      located.find((n) => n.id === selectedId) ??
      noteIndex.get(selectedId) ??
      null;
    if (candidate && folderFilter && candidate.folder_id !== folderFilter) return null;
    return candidate;
  }, [filteredLocated, located, selectedId, noteIndex, folderFilter]);

  const stripEntries = useMemo(() => {
    if (!selectedNote) return [];
    return nearestAround(selectedNote, filteredLocated, STRIP_NEIGHBORS);
  }, [selectedNote, filteredLocated]);

  // Nothing selected → the rail reads as if the notebook's default region had been picked
  // (GRILL-2026-10-19 R5): same pool (filteredLocated), same distance sort, same cap as a
  // marker click — only the origin is the default region instead of a note.
  // ponytail: the pool is the viewport-scoped marker set, so after panning far away this ranks
  // the notes in view by distance to the default region (marker selection shares the limit). A
  // dedicated "notes near a point" query is the upgrade if that ever reads wrong.
  const defaultAreaEntries = useMemo(() => {
    if (selectedNote) return [];
    return nearestTo(defaultMapLocation, filteredLocated, STRIP_NEIGHBORS);
  }, [selectedNote, defaultMapLocation, filteredLocated]);
  // Nothing loaded and either no marker fetch has finished yet or one is in flight: that is
  // "loading", not "empty" (useViewportMarkers `settled`).
  const markersPending = located.length === 0 && (loading || !markersSettled);

  const selectedWaypoints = useNoteWaypoints(selectedId);

  const waypointPath = useMemo(() => {
    if (!selectedNote || selectedWaypoints.length === 0) return [];
    const primary = { region: selectedNote.region, lat: selectedNote.lat, lng: selectedNote.lng };
    const wps = toWaypointRegions(selectedWaypoints);
    return buildRegionPath(primary, selectedNote.id, wps).filter((p) => p.kind === "waypoint");
  }, [selectedNote, selectedWaypoints]);

  // 선택 노트의 경유지 핀 — 홈 지도는 --info 로 칠한 보기 전용 핀. 경로선(아래 pathLines)은 대표점 +
  // 경유지라 조립이 달라 waypointPath 를 그대로 쓴다.
  const waypointPins = useMemo(
    () =>
      selectedNote && selectedWaypoints.length > 0
        ? buildWaypointPins(selectedNote, selectedNote.id, toWaypointRegions(selectedWaypoints), {
            color: "var(--info)",
          })
        : [],
    [selectedNote, selectedWaypoints],
  );

  const pathLines: MapPathLine[] = useMemo(() => {
    if (!selectedNote || waypointPath.length === 0) return [];
    return [
      {
        id: selectedNote.id,
        points: [
          { lat: selectedNote.lat!, lng: selectedNote.lng! },
          ...waypointPath.map((p) => ({ lat: p.lat, lng: p.lng })),
        ],
      },
    ];
  }, [selectedNote, waypointPath]);

  const focusNote = useCallback(
    (note: NoteSummary) => {
      setSelectedId(note.id);
      cancelCreate();
    },
    [cancelCreate]
  );

  const markers: MapMarker[] = useMemo(() => {
    const list: MapMarker[] = filteredLocated.slice(0, MAP_MARKER_LIMIT).map((n) => ({
      id: n.id,
      lat: n.lat!,
      lng: n.lng!,
      active: n.id === selectedId && !createPin,
      region: n.region,
      dim: searchHits !== null && !searchHits.has(n.id),
    }));
    // Selected note's representative pin is always included, even when it was outside the
    // located query (limit truncation / bbox).
    if (
      selectedNote &&
      selectedNote.lat != null &&
      selectedNote.lng != null &&
      (!folderFilter || selectedNote.folder_id === folderFilter) &&
      !list.some((m) => m.id === selectedNote.id)
    ) {
      list.push({
        id: selectedNote.id,
        lat: selectedNote.lat,
        lng: selectedNote.lng,
        active: !createPin,
        region: selectedNote.region,
        dim: searchHits !== null && !searchHits.has(selectedNote.id),
      });
    }
    // Temp create pin sits on top of note markers (distinct active pulse).
    if (createPin) {
      list.push({
        id: TEMP_PIN_ID,
        lat: createPin.lat,
        lng: createPin.lng,
        active: true,
        pinSize: "primary",
        interactive: false,
      });
    }
    // Selected note's waypoints
    list.push(...waypointPins);
    return list;
  }, [filteredLocated, selectedId, selectedNote, folderFilter, createPin, waypointPins, searchHits]);

  const onMarkerClick = useCallback(
    (id: string) => {
      // Temp pin is non-interactive; real markers must not open the create popover.
      if (id === TEMP_PIN_ID) return;
      const note = located.find((n) => n.id === id);
      if (note) focusNote(note);
      else setSelectedId(id);
    },
    [located, focusNote]
  );

  // Empty map click → temp pin + create popover (shared hook), plus this pane's own
  // "a create interaction clears the note selection".
  const onMapClick = useCallback(
    (lat: number, lng: number) => {
      setSelectedId(null);
      dropPinAt(lat, lng);
    },
    [dropPinAt]
  );

  const onSearchPick = useCallback(
    (item: GeocodeResultItem, clientX: number, clientY: number) => {
      setSelectedId(null);
      setMapLocation({ lat: item.lat, lng: item.lng, zoom: PICK_FLYTO_ZOOM });
      dropCreatePin(item.lat, item.lng, clientX, clientY, item.label);
    },
    [dropCreatePin]
  );

  const onItemClick = useCallback(
    (note: NoteSummary) => {
      focusNote(note);
    },
    [focusNote]
  );

  const onItemDoubleClick = useCallback(
    (note: NoteSummary) => {
      void selectNote(note.id);
    },
    [selectNote]
  );

  const location = mapLocation ?? defaultMapLocation;

  return (
    <div
      data-testid="home-map-pane"
      className="home-map-wrap"
      style={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        display: "flex",
        flexDirection: "row",
        overflow: "hidden",
        padding: "0 var(--space-4) var(--space-4)",
        gap: "var(--space-3)",
      }}
    >
      <div
        ref={containerRef}
        data-testid="home-map-canvas"
        style={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          position: "relative",
          borderRadius: "var(--radius-md)",
          overflow: "hidden",
          border: "1px solid var(--line)",
        }}
      >
        <WorldMapAuto
          frameless
          markers={markers}
          pathLines={pathLines}
          defaultLocation={location}
          homeLocation={defaultMapLocation}
          onViewChange={setHomeMapView}
          onViewportChange={onViewportChange}
          onMarkerClick={onMarkerClick}
          onMapClick={onMapClick}
          onMapContextMenu={(lat, lng, x, y) => setMapCtxOpen({ lat, lng, x, y })}
          onDropNote={onDropNote}
          onMarkerMove={onMarkerMove}
          uiLang={uiLang}
        />

        {/* Left rail: place search only now — folder legend moved to the nav row's dot control
            (FolderDotFilter), shared by every dashboard tab. */}
        <div className="dashboard-rail-left" data-testid="home-map-rail-left">
          <div className="dashboard-rail-left__top">
            <MapPlaceSearch onPick={onSearchPick} />
          </div>
        </div>

        {/* Year range badge — mirrors global year slider (search store). Placed below the
            lock/home button column so it doesn't sit underneath them. */}
        <div
          data-testid="home-map-year-badge"
          className="overlay"
          style={{
            position: "absolute",
            top: "calc(var(--space-4) + 56px + 6px)",
            right: "var(--space-4)",
            zIndex: 2,
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            padding: "0 8px",
            height: 26,
            boxSizing: "border-box",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--divider)",
            boxShadow: "var(--shadow-lg)",
            fontSize: "var(--text-xs)",
            fontWeight: 600,
            color: "var(--muted)",
            pointerEvents: "none",
          }}
          title={t("home.map_year_linked")}
        >
          {isFilterNarrowed
            ? (yearFrom === yearTo ? yearFrom : `${yearFrom} – ${yearTo}`)
            : t("home.map_year_all")}
        </div>

        {loading && located.length === 0 && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "grid",
              placeItems: "center",
              pointerEvents: "none",
              color: "var(--faint)",
              fontSize: "var(--text-sm)",
            }}
          >
            {t("common.loading")}
          </div>
        )}
      </div>

      {/* Right rail (280px) */}
      <aside
        className="dashboard-rail"
        data-testid="home-map-rail"
        aria-label={selectedNote ? displayTitle(selectedNote.title) : t("home.map_default_area")}
      >
        {selectedNote ? (
          <div className="dashboard-detail">
            <header>
              {(() => {
                const folder = folderById.get(selectedNote.folder_id);
                const color = folder?.color_hue == null ? "var(--muted)" : folderColorCss(folder.color_hue);
                return (
                  <span className="dashboard-folder-chip">
                    <i style={{ background: color }} />
                    {folder?.name ?? "—"}
                  </span>
                );
              })()}
              <button
                type="button"
                className="icon-btn icon-btn--sm"
                aria-label={t("home.graph_close")}
                title={t("home.graph_close")}
                onClick={() => setSelectedId(null)}
              >
                <IconClose size={13} strokeWidth={2} />
              </button>
            </header>
            <h2>{displayTitle(selectedNote.title)}</h2>
            <time>{selectedNote.year ?? "—"}</time>
            {selectedNote.snippet ? (
              <p className="dashboard-snippet">{snippetText(selectedNote.snippet)}</p>
            ) : null}
            <h3>{t("home.graph_related")} {stripEntries.length}</h3>
            <NearbyList
              entries={stripEntries}
              selectedId={selectedId}
              searchHits={searchHits}
              folderById={folderById}
              onItemClick={onItemClick}
              onItemDoubleClick={onItemDoubleClick}
            />
          </div>
        ) : (
          <div className="dashboard-detail" data-testid="home-map-default-area">
            <h3>
              {t("home.map_default_area")}
              {markersPending ? null : ` ${defaultAreaEntries.length}`}
            </h3>
            {defaultAreaEntries.length > 0 ? (
              <NearbyList
                entries={defaultAreaEntries}
                selectedId={selectedId}
                searchHits={searchHits}
                folderById={folderById}
                onItemClick={onItemClick}
                onItemDoubleClick={onItemDoubleClick}
              />
            ) : markersPending ? (
              <p className="dashboard-rail-note">{t("common.loading")}</p>
            ) : (
              <>
                <p className="dashboard-rail-note" data-testid="home-map-default-empty">
                  {t("home.map_default_area_empty")}
                </p>
                <p className="dashboard-rail-note">{t("home.map_strip_empty")}</p>
              </>
            )}
          </div>
        )}
      </aside>

      {createPin && (
        <MapCreatePopover
          pin={createPin}
          creating={creating}
          onConfirm={() => void confirmCreate()}
          onCancel={cancelCreate}
        />
      )}

      <MapContextMenu
        state={mapCtxOpen}
        uiLang={uiLang}
        onClose={() => setMapCtxOpen(null)}
        onCreateHere={dropCreatePin}
      />
    </div>
  );
}

/** One-line nearby-note rows — shared by the selected-note neighbourhood and the default-region
 *  list so the two rail states can't drift apart. Click = focus, double-click = open. */
function NearbyList({
  entries,
  selectedId,
  searchHits,
  folderById,
  onItemClick,
  onItemDoubleClick,
}: {
  entries: { note: NoteSummary; km: number }[];
  selectedId: string | null;
  searchHits: ReadonlySet<string> | null;
  folderById: ReadonlyMap<string, { color_hue: number | null }>;
  onItemClick: (note: NoteSummary) => void;
  onItemDoubleClick: (note: NoteSummary) => void;
}) {
  return (
    <div className="dashboard-list">
      {entries.map(({ note, km }) => {
        const folder = folderById.get(note.folder_id);
        const color = folder?.color_hue == null ? "var(--muted)" : folderColorCss(folder.color_hue);
        const dist = formatKm(km);
        const isSel = note.id === selectedId;
        return (
          <button
            key={note.id}
            type="button"
            data-testid={`home-map-item-${note.id}`}
            data-selected={isSel ? "true" : undefined}
            data-search-dim={searchHits !== null && !searchHits.has(note.id) ? "true" : undefined}
            onClick={() => onItemClick(note)}
            onDoubleClick={() => onItemDoubleClick(note)}
            title={displayTitle(note.title)}
          >
            <i style={{ background: color }} />
            <span>{displayTitle(note.title)}</span>
            <small>{dist}</small>
            {note.year != null ? <em>{note.year}</em> : null}
          </button>
        );
      })}
    </div>
  );
}
