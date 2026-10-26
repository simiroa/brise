import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { List, type RowComponentProps } from "react-window";
import { useShallow } from "zustand/react/shallow";
import { useNotesStore, displayTitle } from "../../../stores/notes";
import { useSearchStore } from "../../../stores/search";
import { useSettingsStore, FACTORY_DEFAULT_MAP_LOCATION } from "../../../stores/settings";
import { WorldMapAuto, type MapMarker, type MapPathLine, type MapViewportBbox } from "../../map/WorldMapAuto";
import { splitByQuery, HighlightedText } from "../notetree/highlight";
import type { NoteSummary } from "../../../lib/commands.gen";
import { t } from "../../../i18n/t";
import { IconClose, IconHome, IconLock, IconUnlock } from "../../icons";
import { startNoteDrag } from "../../../lib/noteDrag";
import { useUiStore } from "../../../stores/ui";
import { Pill } from "../../common/Pill";
import {
  EXPANDED_BOARD_MAX_NOTES,
  noteQueryCollect,
  useNoteQueryVersion,
} from "../../../lib/noteQuery";
import {
  groupByCoordinate,
  noteHasCoords,
  sortNearby,
} from "./viewData";
import { useViewportMarkers, MAP_MARKER_LIMIT } from "../../map/useViewportMarkers";
import { NoteIcon } from "../NoteIconControl";
import {
  buildPathLines,
  buildRegionPath,
  buildWaypointPins,
  toWaypointRegions,
} from "../../attachments/regionDisplay";
import { useNoteWaypoints } from "../../home/useNoteWaypoints";
import { MapCreatePopover } from "../../home/MapCreatePopover";
import { useMapNoteActions } from "../../map/useMapNoteActions";
import { MapContextMenu, type MapContextMenuState } from "../../map/MapContextMenu";
import { MapPlaceSearch } from "../../home/MapPlaceSearch";
import type { GeocodeResultItem } from "../../../lib/useGeocodeSearch";
import { PICK_FLYTO_ZOOM } from "../../map/mapZoomScale";

import { usePendingDelay } from "../../../lib/usePendingDelay";
import { PendingIndicator } from "../../common/PendingIndicator";

export interface UnlocatedRowProps {
  notes: NoteSummary[];
  activeId: string | null;
  query?: string;
  onSelectNote: (id: string) => void;
  onOpenCtx?: (id: string, x: number, y: number) => void;
  /** 폰 보기 전용 — 드래그 시작·우클릭 메뉴 없음. */
  readOnly?: boolean;
}

function UnlocatedRowImpl({
  index,
  style,
  notes,
  activeId,
  query,
  onSelectNote,
  onOpenCtx,
  readOnly,
}: RowComponentProps<UnlocatedRowProps>): React.ReactElement | null {
  const n = notes[index];
  if (!n) return null;

  const isSelected = n.id === activeId;
  const titleText = displayTitle(n.title);
  const titleSegments = splitByQuery(titleText, query ?? "");

  return (
    <div style={{ ...style, display: "flex", alignItems: "stretch" }}>
      <button
        type="button"
        className="treerow menu-row menu-item"
        data-selected={isSelected}
        onPointerDown={readOnly ? undefined : (e) => startNoteDrag(e, n.id, titleText, { pin: true })}
        onClick={() => onSelectNote(n.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!readOnly && onOpenCtx) onOpenCtx(n.id, e.clientX, e.clientY);
        }}
        style={{
          gap: "var(--space-3)",
          padding: "var(--space-2) var(--sidebar-pad) var(--space-2) var(--space-3)",
          position: "relative",
          boxShadow: isSelected ? "inset 2px 0 0 var(--accent)" : undefined,
          height: "100%",
          width: "100%",
          borderRadius: "var(--radius-sm)",
        }}
      >
        <NoteIcon icon={n.icon} size={16} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: "var(--text-md)",
              fontWeight: 400,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              color: "var(--text)",
            }}
          >
            <HighlightedText segments={titleSegments} />
          </div>
          <div style={{ fontSize: "var(--text-label)", color: "var(--muted)" }}>
            {n.year}
            {n.region && ` · ${n.region}`}
            {n.tag_names.length > 0 && ` · #${n.tag_names.join(" #")}`}
          </div>
        </div>
      </button>
    </div>
  );
}

const UnlocatedRow = React.memo(
  UnlocatedRowImpl
) as unknown as (props: RowComponentProps<UnlocatedRowProps>) => React.ReactElement | null;

/* ── Region (Sidebar Map) expanded view ──
   Wave A-4: markers for the viewport only (note_query bbox); unlocated via has-none.
   No corpus fallback — empty on IPC fail rather than unbounded scan. */
export interface RegionExpandedProps {
  /** 폰(MobileRegionView) 전용: 지도에 쓰는 모든 상호작용(핀 이동·클릭 생성·드롭·검색 핀·우클릭 메뉴·
   *  목록 드래그)을 끄고, 핀/목록 탭은 selectNote 대신 onOpenNote 로 노트를 연다. 데스크톱은 생략. */
  readOnly?: boolean;
  onOpenNote?: (id: string) => void;
  /** 데스크톱 사이드바는 지도 탭을 한 번 연 뒤 다른 보기로 가도 이 컴포넌트를 숨긴 채 살려 둔다
   *  (MapLibre 재생성 = 클릭마다 ~0.5 s 메인 스레드 정지, 2026-10-22 실측). false 인 동안은 조회
   *  입력·지도 props 를 마지막 보이던 값으로 묶어 숨은 지도가 IPC·마커 재생성을 하지 않게 하고,
   *  다시 보이면 바뀐 것만 따라잡는다. 생략 = 항상 보임(폰). */
  active?: boolean;
  /** 지도(WebGL 생성)를 첫 페인트 뒤로 미룬다 — 탭 클릭이 생성 작업에 막혀 늦게 그려지지 않게.
   *  클릭(이산 이벤트)으로 커밋된 passive effect 는 페인트 전에 동기 실행되므로, 마운트 자체를
   *  두 프레임 늦추는 것 말고는 페인트를 먼저 내보낼 방법이 없다. */
  deferMap?: boolean;
}

/** active 가 false 인 동안 마지막으로 보이던 값을 그대로 돌려준다(숨은 동안 effect 가 다시 돌지
 *  않게). 렌더 중 ref 쓰기는 멱등이라 StrictMode 이중 렌더에도 안전하다. */
function useHeldWhileHidden<T>(value: T, active: boolean): T {
  const ref = useRef(value);
  if (active) ref.current = value;
  return ref.current;
}

export function RegionExpanded({
  readOnly = false,
  onOpenNote,
  active = true,
  deferMap = false,
}: RegionExpandedProps = {}) {
  const selectNote = useNotesStore((s) => s.selectNote);
  const activeId = useHeldWhileHidden(
    useNotesStore((s) => s.activeNote?.note?.id ?? null),
    active
  );
  // Active note detail / noteIndex — bbox-locatedMarkers can miss the open note when the user
  // pans away; we still need its representative lat/lng for the primary pin + path origin.
  const activeNoteSummary = useNotesStore(
    useShallow((s) => s.activeNote?.note ?? null)
  );
  const noteIndex = useNotesStore((s) => s.noteIndex);
  const openCtx = useUiStore((s) => s.openCtx);
  const setPreviewItem = useUiStore((s) => s.setPreviewItem);


  const [mapCtxOpen, setMapCtxOpen] = useState<MapContextMenuState | null>(null);

  // 조회 입력은 숨은 동안 묶는다(useHeldWhileHidden) — 트리 보기에서 필터를 바꿔도 숨은 지도가
  // coords:none 수집(최대 1000)·지역 맞춤 조회를 쏘지 않고, 다시 보일 때 바뀐 축만 한 번 조회한다.
  const liveAxes = useSearchStore(
    useShallow((s) => ({
      yearFrom: s.yearFrom,
      yearTo: s.yearTo,
      selectedTags: s.selectedTags,
      tagMode: s.tagMode,
      regionFilter: s.regionFilter,
      statusFilter: s.statusFilter,
      dateRange: s.dateRange,
      query: s.query,
    }))
  );
  const liveVersion = useNoteQueryVersion();
  const held = useHeldWhileHidden({ ...liveAxes, noteQueryVersion: liveVersion }, active);
  const { yearFrom, yearTo, selectedTags, tagMode, regionFilter, statusFilter, dateRange, query } = held;
  const noteQueryVersion = held.noteQueryVersion;

  const [viewport, setViewport] = useState<MapViewportBbox | null>(null);
  // Viewport markers — server-bounded (shared with HomeMapPane's dashboard map).
  // 뷰포트도 묶는다 — 숨은 동안 사이드바 폭이 바뀌면 MapLibre 가 resize→moveend 로 bbox 를 보낸다.
  const { located: locatedNotes, loading: locatedLoading } = useViewportMarkers(
    useHeldWhileHidden(viewport, active),
    { yearFrom, yearTo, selectedTags, tagMode, regionFilter, statusFilter, dateRange },
    noteQueryVersion
  );
  const [unlocatedNotes, setUnlocatedNotes] = useState<NoteSummary[]>([]);
  // Starts true: the effect below always fetches on mount. With no loading branch in the list (and
  // this starting false) the tab painted "0 · every note has a location" until the answer arrived
  // (~0.3 s on the phone /app, 2026-10-19 screen board) — an empty array before the first answer
  // is "not known yet", not empty. See unlocatedPending below.
  const [unlocatedLoading, setUnlocatedLoading] = useState(true);
  // A failed fetch is its own state too — clearing to [] used to claim every note was located.
  const [unlocatedFailed, setUnlocatedFailed] = useState(false);
  const [unlocatedRetry, setUnlocatedRetry] = useState(0);
  const loading = locatedLoading || unlocatedLoading;
  const showPending = usePendingDelay(loading, 150);

  // Unlocated list — server has-none coords.
  useEffect(() => {
    let cancelled = false;
    setUnlocatedLoading(true);
    setUnlocatedFailed(false);
    void (async () => {
      try {
        const r = await noteQueryCollect(
          {
            yearFrom,
            yearTo,
            selectedTags,
            tagMode,
            regionFilter,
            statusFilter,
            dateRange,
            coords: { kind: "none" },
            sort: "title_asc",
          },
          { maxNotes: EXPANDED_BOARD_MAX_NOTES }
        );
        if (!cancelled) setUnlocatedNotes(r.notes);
      } catch {
        // call() already toasted + logged it; this only keeps the list from lying about it.
        if (!cancelled) {
          setUnlocatedNotes([]);
          setUnlocatedFailed(true);
        }
      } finally {
        if (!cancelled) setUnlocatedLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [yearFrom, yearTo, selectedTags, tagMode, regionFilter, statusFilter, dateRange, noteQueryVersion, unlocatedRetry]);

  // W7-e Task 2: 지역 필터를 고르면 그 지역 노트가 모두 보이도록 카메라를 옮긴다. 위 locatedNotes
  // 이펙트는 뷰포트 bbox 안에서만 조회하므로 못 쓴다 — 새로 고른 지역이 이전 뷰포트 밖에 있으면
  // 교집합이 비어 "카메라를 어디로 옮겨야 하는지"조차 알 수 없는 닭-달걀 문제. 뷰포트 제약 없이
  // 좌표 유무만 걸어 별도 조회한다(HomeMapPane과 같은 coords:"has" 패턴).
  const [regionFocusPoints, setRegionFocusPoints] = useState<Array<{ lat: number; lng: number }> | null>(
    null
  );

  useEffect(() => {
    if (!regionFilter) {
      setRegionFocusPoints(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const r = await noteQueryCollect(
          {
            yearFrom,
            yearTo,
            selectedTags,
            tagMode,
            regionFilter,
            statusFilter,
            dateRange,
            coords: { kind: "has" },
          },
          { maxNotes: EXPANDED_BOARD_MAX_NOTES }
        );
        if (!cancelled) {
          setRegionFocusPoints(
            r.notes.filter(noteHasCoords).map((n) => ({ lat: n.lat!, lng: n.lng! }))
          );
        }
      } catch {
        if (!cancelled) setRegionFocusPoints(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [regionFilter, yearFrom, yearTo, selectedTags, tagMode, statusFilter, dateRange, noteQueryVersion]);

  const [focusedCoord, setFocusedCoord] = useState<{ lat: number; lng: number } | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(30);

  // Reset visible limit back to 30 whenever focusedCoord changes
  useEffect(() => {
    setVisibleLimit(30);
  }, [focusedCoord]);

  // Nearby uses located notes currently in the viewport (same as before with visible markers).
  const nearbyNotes = useMemo(() => {
    if (!focusedCoord) return [];
    return sortNearby(locatedNotes, focusedCoord.lat, focusedCoord.lng);
  }, [focusedCoord, locatedNotes]);

  const listNotes = useMemo(() => {
    if (!focusedCoord) return unlocatedNotes;
    return nearbyNotes.slice(0, visibleLimit);
  }, [focusedCoord, unlocatedNotes, nearbyNotes, visibleLimit]);

  const hasMoreNearby = focusedCoord ? nearbyNotes.length > visibleLimit : false;
  // Unfocused, the list IS the coords:none answer — with nothing to show yet (first load) or after
  // a failure, its zero means nothing. A refetch with rows already on screen keeps showing them.
  const unlocatedPending = !focusedCoord && unlocatedLoading && unlocatedNotes.length === 0;
  const unlocatedError = !focusedCoord && unlocatedFailed;

  const coordGroups = useMemo(() => groupByCoordinate(locatedNotes), [locatedNotes]);

  const [groupIndexMap, setGroupIndexMap] = useState<Record<string, number>>({});

  // 경유지 버전(첨부·노트 변경 카운터)은 살아 움직이므로 activeId 만 묶으면 숨은 동안 다른 노트로
  // 옮긴 뒤에도 묶인 노트를 노트 변경마다 다시 조회한다 — 숨은 동안은 조회 자체를 끄고 값만 묶는다.
  const activeWaypoints = useHeldWhileHidden(useNoteWaypoints(active ? activeId : null), active);

  /** Resolve the active note's coords even when the viewport bbox query dropped it. */
  const resolveActiveNote = useCallback((): NoteSummary | null => {
    if (!activeId) return null;
    return (
      locatedNotes.find((n) => n.id === activeId) ??
      unlocatedNotes.find((n) => n.id === activeId) ??
      (activeNoteSummary?.id === activeId ? activeNoteSummary : null) ??
      noteIndex.get(activeId) ??
      null
    );
  }, [activeId, locatedNotes, unlocatedNotes, activeNoteSummary, noteIndex]);

  const markers: MapMarker[] = useMemo(() => {
    const list: MapMarker[] = [];
    for (const [key, notes] of coordGroups.entries()) {
      const idx = groupIndexMap[key] ?? 0;
      const displayNote = notes[idx % notes.length];
      const isAnyActive = notes.some((n) => n.id === activeId);

      list.push({
        id: displayNote.id,
        lat: displayNote.lat!,
        lng: displayNote.lng!,
        active: isAnyActive,
        region: displayNote.region,
        // Active multi-region note: primary pin is larger than ordinary note pins.
        pinSize: isAnyActive && activeWaypoints.length > 0 ? "primary" : "note",
      });
      if (list.length >= MAP_MARKER_LIMIT) break;
    }

    // Always keep the selected note's representative pin, even outside the bbox query —
    // otherwise waypoints + path render without a primary and look broken.
    if (activeId && !list.some((m) => m.id === activeId)) {
      const outside = resolveActiveNote();
      if (outside && outside.lat != null && outside.lng != null) {
        list.push({
          id: outside.id,
          lat: outside.lat,
          lng: outside.lng,
          active: true,
          region: outside.region,
          pinSize: activeWaypoints.length > 0 ? "primary" : "note",
        });
      }
    }

    // Waypoint pins for the active note (non-interactive path stops).
    if (activeId) {
      const activeNote = resolveActiveNote();
      const primary = {
        region: activeNote?.region ?? null,
        lat: activeNote?.lat ?? null,
        lng: activeNote?.lng ?? null,
      };
      list.push(...buildWaypointPins(primary, activeId, toWaypointRegions(activeWaypoints)));
    }
    return list;
  }, [coordGroups, groupIndexMap, activeId, activeWaypoints, resolveActiveNote]);

  const pathLines: MapPathLine[] = useMemo(() => {
    if (!activeId) return [];
    const activeNote = resolveActiveNote();
    if (!activeNote && activeWaypoints.length === 0) return [];
    const primary = {
      region: activeNote?.region ?? null,
      lat: activeNote?.lat ?? null,
      lng: activeNote?.lng ?? null,
    };
    return buildPathLines(buildRegionPath(primary, activeId, toWaypointRegions(activeWaypoints)), activeId);
  }, [activeId, activeWaypoints, resolveActiveNote]);

  const onMarkerClick = useCallback(
    (markerNoteId: string) => {
      for (const [key, notes] of coordGroups.entries()) {
        const hit = notes.find((n) => n.id === markerNoteId);
        if (hit && hit.lat !== null && hit.lng !== null) {
          setFocusedCoord({ lat: hit.lat, lng: hit.lng });
        }
        if (readOnly && hit) {
          // 폰: 한 점에 노트 하나면 바로 연다. 겹친 핀은 "근처" 목록(위 setFocusedCoord)으로 고르게 한다.
          if (notes.length === 1) onOpenNote?.(hit.id);
          break;
        }
        const foundIdx = notes.findIndex((n) => n.id === markerNoteId);
        if (foundIdx !== -1) {
          // Cycle stacked notes at the same coord — preview must follow the note we select,
          // not the marker id that was clicked.
          let selected: NoteSummary;
          if (notes.length === 1) {
            selected = notes[foundIdx];
            void selectNote(markerNoteId);
          } else {
            const currentIdx = groupIndexMap[key] ?? foundIdx;
            const nextIdx = (currentIdx + 1) % notes.length;
            setGroupIndexMap((prev) => ({ ...prev, [key]: nextIdx }));
            selected = notes[nextIdx];
            void selectNote(selected.id);
          }
          // Only set region preview when the selected note has coordinates — unlocated
          // notes would fall through to the empty Aperçu hint (worse than leaving the prior preview).
          if (selected.lat != null && selected.lng != null) {
            setPreviewItem({ kind: "region", id: "region" });
          }
          break;
        }
      }
    },
    [coordGroups, groupIndexMap, selectNote, setPreviewItem, readOnly, onOpenNote]
  );

  // Shared by nearby (located) and unlocated list rows. Region preview only for notes with coords.
  const onSelectFromList = useCallback(
    (id: string) => {
      if (readOnly) {
        onOpenNote?.(id);
        return;
      }
      void selectNote(id);
      const note =
        locatedNotes.find((n) => n.id === id) ?? unlocatedNotes.find((n) => n.id === id);
      // Unlocated: leave previewItem untouched — a region preview without lat/lng shows the
      // empty select-hint, and note-kind preview is a different (related-notes) interaction model.
      if (note != null && note.lat != null && note.lng != null) {
        setPreviewItem({ kind: "region", id: "region" });
      }
    },
    [selectNote, locatedNotes, unlocatedNotes, setPreviewItem, readOnly, onOpenNote]
  );

  const listWrapRef = useRef<HTMLDivElement>(null);

  const getRowHeight = useCallback(() => 48, []);

  const onOpenCtx = useCallback(
    (id: string, x: number, y: number) => {
      openCtx(id, x, y);
    },
    [openCtx]
  );

  const unlocatedRowProps: UnlocatedRowProps = useMemo(
    () => ({
      notes: listNotes,
      activeId,
      query,
      onSelectNote: onSelectFromList,
      onOpenCtx,
      readOnly,
    }),
    [listNotes, activeId, query, onSelectFromList, onOpenCtx, readOnly]
  );

  const uiLang = useSettingsStore((s) => s.uiLang);
  const defaultMapLocation = useSettingsStore((s) => s.defaultMapLocation);
  // Search-pick fly-to camera override — same "new object reference = fly-to intent" contract
  // HomeMapPane uses for its dashboard map (see mapFit/onSearchPick there). null = home/settings.
  const [mapLocation, setMapLocation] = useState<{ lat: number; lng: number; zoom: number } | null>(
    null
  );

  const onViewportChange = useCallback((bbox: MapViewportBbox) => {
    setViewport(bbox);
  }, []);

  // Map → note writes (create-at-point, tree drop, pin move) — one implementation, shared with
  // the dashboard map. The create popover is anchored to the map wrapper below.
  const mapWrapRef = useRef<HTMLDivElement>(null);
  const {
    createPin,
    creating,
    onMapClick,
    dropCreatePin,
    cancelCreate,
    confirmCreate,
    onDropNote,
    onMarkerMove,
  } = useMapNoteActions({ anchorRef: mapWrapRef });

  const onSearchPick = useCallback(
    (item: GeocodeResultItem, clientX: number, clientY: number) => {
      setMapLocation({ lat: item.lat, lng: item.lng, zoom: PICK_FLYTO_ZOOM });
      // readOnly(폰) = 이동만. 데스크톱의 "검색 → 그 자리 핀 → 노트 만들기"는 쓰기라서, 보기 전용
      // 지도가 막으려던 오조작 쓰기를 검색이 뒷문으로 다시 열면 안 된다.
      if (readOnly) return;
      dropCreatePin(item.lat, item.lng, clientX, clientY, item.label);
    },
    [dropCreatePin, readOnly]
  );

  const [isLocked, setIsLocked] = useState(false);

  const handleGoHome = useCallback(() => {
    const loc = defaultMapLocation ?? FACTORY_DEFAULT_MAP_LOCATION;
    setMapLocation({ ...loc });
  }, [defaultMapLocation]);

  // 지도로 가는 props 도 숨은 동안 묶는다 — 마커 배열이 새로 오면 WorldMapGL 이 핀 DOM(최대 500)을
  // 전부 다시 만들고, 기본 위치가 바뀌면 보이지 않는 지도가 flyTo 한다. 보이는 순간 최신값으로.
  const mapMarkers = useHeldWhileHidden(markers, active);
  const mapPathLines = useHeldWhileHidden(pathLines, active);
  const mapFocusPoints = useHeldWhileHidden(regionFocusPoints, active);
  const mapDefaultLocation = useHeldWhileHidden(mapLocation ?? defaultMapLocation, active);

  // 숨겨질 때 열려 있던 생성 팝오버(body 포털이라 부모를 숨겨도 남는다)·우클릭 메뉴를 닫는다.
  useEffect(() => {
    if (active) return;
    cancelCreate();
    setMapCtxOpen(null);
  }, [active, cancelCreate]);

  // deferMap: 첫 마운트만 두 프레임 늦춘다(첫 rAF 는 이번 프레임 페인트 전, 두 번째가 페인트 뒤).
  // 이후 열기는 상위(LeftPanel)가 이 컴포넌트를 살려 두므로 다시 미룰 일이 없다.
  const [mapMounted, setMapMounted] = useState(!deferMap);
  useEffect(() => {
    if (mapMounted || !active) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setMapMounted(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [mapMounted, active]);
  // 쓰기 핸들러는 보일 때만 — 특히 드롭은 전역 핸들러 등록이라(targetId "map" 은 대시보드 지도와
  // 같다) 숨은 지도가 살아 있으면 대시보드 지도에 떨군 노트를 숨은 지도 좌표로 한 번 더 쓴다.
  const writable = !readOnly && active;

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        padding: "var(--space-4) 0 var(--space-5) var(--sidebar-pad)",
        gap: "var(--space-3)",
        position: "relative",
      }}
    >
      <PendingIndicator active={showPending} />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          paddingRight: "var(--sidebar-pad)",
          flex: "none",
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <MapPlaceSearch onPick={onSearchPick} compact touch={readOnly} style={{ width: "100%" }} />
        </div>
        {!readOnly && (
        <button
          type="button"
          onClick={() => setIsLocked((v) => !v)}
          title={isLocked ? t("settings.map_unlock") : t("settings.map_lock")}
          aria-label={isLocked ? t("settings.map_unlock") : t("settings.map_lock")}
          className="icon-btn icon-btn--sm icon-btn--glow"
          data-active={isLocked ? "true" : undefined}
          aria-pressed={isLocked}
        >
          {isLocked ? (
            <IconLock size={14} strokeWidth={2} />
          ) : (
            <IconUnlock size={14} strokeWidth={2} />
          )}
        </button>
        )}
        <button
          type="button"
          onClick={handleGoHome}
          title={t("settings.map_home")}
          aria-label={t("settings.map_home")}
          className="icon-btn icon-btn--sm icon-btn--glow"
          style={readOnly ? { minWidth: 48, minHeight: 48 } : undefined}
        >
          <IconHome size={readOnly ? 18 : 14} strokeWidth={2} />
        </button>
      </div>
      <div
        ref={mapWrapRef}
        style={{ flex: "1 1 55%", minHeight: 0, width: "calc(100% - var(--sidebar-pad))", position: "relative" }}
      >
        {mapMounted ? (
          <WorldMapAuto
            markers={mapMarkers}
            pathLines={mapPathLines}
            onMarkerClick={onMarkerClick}
            onMapClick={writable ? onMapClick : undefined}
            onDropNote={writable ? onDropNote : undefined}
            onMarkerMove={writable ? onMarkerMove : undefined}
            onViewportChange={onViewportChange}
            defaultLocation={mapDefaultLocation}
            homeLocation={defaultMapLocation}
            onMapContextMenu={writable ? (lat, lng, x, y) => setMapCtxOpen({ lat, lng, x, y }) : undefined}
            regionFocusPoints={mapFocusPoints}
            uiLang={uiLang}
            hideControls
            isLocked={isLocked}
          />
        ) : (
          // 지도 자리 그대로(테두리·모서리 같음) — 지도가 들어와도 레이아웃이 움직이지 않는다.
          <div
            data-testid="region-map-placeholder"
            style={{
              width: "100%",
              height: "100%",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--line)",
              boxSizing: "border-box",
            }}
          />
        )}
      </div>

      {!readOnly && createPin && (
        <MapCreatePopover
          pin={createPin}
          creating={creating}
          onConfirm={() => void confirmCreate()}
          onCancel={cancelCreate}
        />
      )}

      {!readOnly && (
        <MapContextMenu
          state={mapCtxOpen}
          uiLang={uiLang}
          onClose={() => setMapCtxOpen(null)}
          onCreateHere={dropCreatePin}
        />
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          paddingTop: "var(--space-1)",
          paddingRight: "var(--sidebar-pad)",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-heading)",
            fontWeight: 600,
            fontSize: "var(--text-xs)",
            color: "var(--muted)",
            textTransform: "uppercase",
          }}
        >
          {focusedCoord ? t("search.region_nearby") : t("search.region_no_region")}
        </span>
        {!unlocatedPending && !unlocatedError && (
          <Pill tone="muted">{focusedCoord ? nearbyNotes.length : listNotes.length}</Pill>
        )}
        <div
          style={{
            flex: 1,
            height: 1,
            background: "var(--divider)",
          }}
        />
        {focusedCoord && (
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            title={t("search.region_clear_focus")}
            aria-label={t("search.region_clear_focus")}
            onClick={() => setFocusedCoord(null)}
          >
            <IconClose size={12} strokeWidth={2.2} />
          </button>
        )}
      </div>

      <div
        ref={listWrapRef}
        style={{
          flex: "1 1 45%",
          minHeight: 0,
          position: "relative",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {listNotes.length === 0 ? (
          <div
            data-testid="region-list-status"
            data-state={unlocatedPending ? "loading" : unlocatedError ? "error" : "empty"}
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: "var(--space-2)",
              height: "100%",
              color: unlocatedError ? "var(--danger)" : "var(--faint)",
              fontSize: "var(--text-sm)",
              paddingRight: "var(--sidebar-pad)",
            }}
          >
            {/* This list is the "no location yet" bucket (coords:none) when unfocused, or
                notes near a clicked coordinate when focused — empty means opposite things
                per branch, so each gets its own accurate copy (not a single "add a region"
                CTA, which would be backwards for the unfocused/coords:none case). Loading and
                failure come first: neither is "empty" (MobileCalendarView's 3-state split). */}
            {unlocatedPending ? (
              t("common.loading")
            ) : unlocatedError ? (
              <>
                {t("search.region_load_failed")}
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setUnlocatedRetry((n) => n + 1)}
                  style={{ minHeight: readOnly ? 48 : undefined }}
                >
                  {t("common.retry")}
                </button>
              </>
            ) : focusedCoord ? (
              t("search.expanded_empty")
            ) : (
              t("search.region_empty")
            )}
          </div>
        ) : (
          <>
            <List
              className="scroll scroll--slim"
              rowComponent={UnlocatedRow}
              rowCount={listNotes.length}
              rowHeight={getRowHeight}
              rowProps={unlocatedRowProps}
              overscanCount={8}
              style={{ height: "100%", width: "100%", position: "relative" }}
            />
            {hasMoreNearby && (
              <button
                type="button"
                className="more-row-btn overlay"
                onClick={() => setVisibleLimit((prev) => prev + 30)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: "var(--space-2) var(--space-4)",
                  margin: "var(--space-2) var(--sidebar-pad) 0 0",
                  fontSize: "var(--text-xs)",
                  fontWeight: 600,
                  color: "var(--accent)",
                  border: "1px solid var(--divider)",
                  borderRadius: "var(--radius-sm)",
                  cursor: "pointer",
                  width: "calc(100% - var(--sidebar-pad))",
                  flex: "none",
                  minHeight: readOnly ? 48 : undefined,
                }}
              >
                더보기 / Voir plus
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
