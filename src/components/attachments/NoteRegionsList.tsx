import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NoteRegion } from "../../lib/commands.gen";
import { call, emitNotice } from "../../lib/invoke";
import { reportFallback } from "../../lib/diag";
import { noteRegionsCache, useNoteRegionsVersion } from "../../lib/noteMeta";
import { findDuplicatePlace, splitPlaceLabel, DUPLICATE_PLACE_RADIUS_M } from "../../lib/placeLabel";
import { writePrimaryPlace, type PrimaryPlace } from "../../lib/placeCommit";
import type { GeocodeResultItem } from "../../lib/useGeocodeSearch";
import { usePlaceSearch, PlaceSearchResults } from "./PlaceSearch";
import { useSearchStore } from "../../stores/search";
import { useNotesStore } from "../../stores/notes";
import { useSettingsStore } from "../../stores/settings";
import { Toggle } from "../settings/Toggle";
import { t } from "../../i18n/t";
import {
  IconClose,
  IconEdit,
  IconStar,
  IconCaret,
  IconTrash,
  IconArrowUp,
  IconArrowDown,
  IconHome,
  IconLock,
  IconUnlock,
} from "../icons";
import { WorldMapAuto, type MapMarker, type MapPathLine, type MapLocation } from "../map/WorldMapAuto";
import { SINGLE_NOTE_FOCUS_ZOOM, PICK_FLYTO_ZOOM } from "../map/mapZoomScale";
import {
  buildPathLines,
  buildRegionMarkers,
  buildRegionPath,
  clickedPlaceName,
  dedupeWaypoints,
  nextWaypointPosition,
  toWaypointRegions,
  waypointPathNumber,
  type PrimaryRegion,
  type WaypointRegion,
} from "./regionDisplay";

/** PLAN-2026-09-19-date-region-ui.md §P2/§P4 — 펼친 행 헤더·본문의 아이콘/필드 버튼. NoteDatesList.tsx의
 *  같은 자리·같은 스케일(코드 공유 없이, 같은 관용구만 복제 — §P2 "왜 컴포넌트를 강제로 공유하지
 *  않는가" 참고). */
const chipScaleField: React.CSSProperties = {
  minHeight: "var(--ctrl-h-sm)",
  height: "var(--ctrl-h-sm)",
  padding: "0 var(--space-2)",
  fontSize: "var(--text-xs)",
};

/** 헤더 아이콘 버튼(§P4 D14 — 대표로/삭제/해제) — 셰브런과 같은 22×22 icon-btn 규격. */
const headerIconBtnStyle: React.CSSProperties = { width: 22, height: 22, flex: "none" };

/** 펼친 행 본문의 좌측 들여쓰기 — 헤더의 마커(10px/8px) + 그 gap(8px/6px)과 한 기둥으로 읽히게,
 *  NoteDatesList.tsx의 rowBodyIndent와 같은 값. */
const rowBodyIndent = 18;

/** 목록 스크롤 문턱 — NoteDatesList.tsx 의 같은 이름 상수와 같은 규칙(오너 2026-09-19: "10개
 *  미만으로 운영하니, 그 이상일 때만 … 넉넉하게"). 10곳까지는 전부 한 번에 보이고, 넘을 때만
 *  **행 영역만** 스크롤한다(위의 지도와 아래의 "+ 장소 추가"는 제자리). 높이는 접힌 행 10개 +
 *  펼친 본문 하나. inline(RegionPreview)은 그 카드가 이미 자기 스크롤을 갖고 있어 적용하지 않는다. */
const SCROLL_AFTER_ROWS = 10;
const ROWS_SCROLL_MAX_H = 320;

/** 대표 행의 openRowId 센티널 — note_dates의 실제 id가 아니라 규칙으로 정한 문자열이라 경유지 id
 *  (note_regions.id, uuid)와 절대 충돌하지 않는다. */
const PRIMARY_ROW_ID = "primary";

/** 팝오버 지도 높이. 180 → 200 — 핀과 경로가 한눈에 들어오게 조금 키웠다(잠금/홈 컨트롤이 지도 아래 한
 *  줄로 빠지며 지도 위 겹침이 사라진 만큼). */
const MAP_HEIGHT = 200;

export type NoteRegionsListProps = {
  noteId: string;
  primary: PrimaryRegion;
  /** Bump to force a re-fetch (e.g. after external mutation). */
  refreshKey?: number;
  onChanged?: () => void;
  /** QA feedback (dashboard integrate, 항목 2): fires after a place-name click applies the sidebar
   * region filter — a caller mounting this inside a title-bar popover (RegionMetaBadge) uses it to
   * close the popover, since the filter's own side effect would otherwise fire invisibly behind it. */
  onFilterApplied?: () => void;
  /** 프리뷰(RegionPreview) 모드: 추가는 지도 위 검색/클릭이 이미 담당하므로 "+ 장소 추가" 진입점과
   * 인라인 지도(§P4 D3′)를 숨기고, 대표 이름 편집도 이 카드 안 인라인 input 으로 처리한다 —
   * RegionPreview 자체가 이미 큰 지도와 검색을 갖고 있어 여기 또 그리면 중복이다. 타이틀바 배지
   * (RegionMetaBadge)처럼 지도가 없는 마운트 지점은 !inline 이라 이 컴포넌트가 자기 지도를 그린다
   * (§P4 D3′ — 예전엔 여기서 RegionPickerDialog 모달을 열었지만 그 탈출구는 없어졌다). */
  inline?: boolean;
  /** 오너 피드백: 팝오버(RegionMetaBadge)를 열었을 때 지역이 하나도 없으면 "+ 장소 추가"를 한 번
   * 더 누르게 하지 않고 검색 입력을 바로 연다. 지역이 이미 있을 때(목록을 보러 온 사람)나 inline
   * 모드(지도가 이미 담당)에서는 적용하지 않는다 — 초기 로드가 끝나 실제로 비어있음이 확인된
   * 뒤에만 한 번 연다(비동기 fetch 완료 전엔 아직 모름). */
  autoOpenSearch?: boolean;
};

// 이름 버튼은 "글자처럼" 보여야 한다 — 행이 버튼 밭이 되면 무엇이 주된 동작인지 흐려진다.
const nameButtonStyle: React.CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  textAlign: "left",
  border: "none",
  background: "transparent",
  padding: 0,
  color: "inherit",
  font: "inherit",
  cursor: "pointer",
};

/**
 * D4 multi-region list for the active note:
 *
 *   서울 (대표) ●
 *    └ 경주 ○ 2
 *    └ 부산 ○ 3
 *   [+ 장소 추가]
 *
 * Primary is notes.region/lat/lng — editable here too (edit/clear/promote-a-waypoint), not just
 * displayed. Waypoints are note_regions rows — add / remove / reorder / promote live here.
 *
 * §P4 D3′/D14 — 팝오버(!inline)에선 이 목록 위에 `WorldMapAuto` 지도가 항상 뜬다(날짜 팝오버의
 * 달력 자리와 같은 뼈대: 지도 → 구분선 → 목록 → "+ 장소 추가"). 예전엔 지도가 addTarget 이 있을
 * 때만, 그것도 SVG(WorldMap)만 그렸고 정밀 선택은 RegionPickerDialog 모달이 맡았다 — 둘 다 사라
 * 졌다(아래 mapBlock/handleMapClick 주석 참고).
 */
export function NoteRegionsList({
  noteId,
  primary,
  refreshKey = 0,
  onChanged,
  onFilterApplied,
  inline = false,
  autoOpenSearch = false,
}: NoteRegionsListProps) {
  const [regions, setRegions] = useState<NoteRegion[]>([]);
  const [loaded, setLoaded] = useState(false);
  const autoOpenedRef = useRef(false);
  const [busy, setBusy] = useState(false);
  // addTarget = 지금 검색/지도 클릭이 채우는 대상("first"=최초 대표, "waypoint"=경유지 추가,
  // "primary"=대표 교체). §P4 D3′ 이전엔 지도가 이 값의 "드문 탈출구"였다 — 이제 지도는 항상
  // 보이고, addTarget 은 그 지도의 클릭을 등록으로 이어줄지(추가 모드)만 가른다(§P4 D14: 추가
  // 모드가 아닐 땐 지도 클릭이 그냥 패닝이다 — 팝오버 지도가 작아 팬/줌 중 오클릭이 잦다).
  const [addTarget, setAddTarget] = useState<"first" | "waypoint" | "primary" | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  // 같은 장소(약 50m 이내) 중복 추가를 막았을 때의 안내 — 검색 블록 안에 인라인으로 뜬다.
  const [dupNotice, setDupNotice] = useState<string | null>(null);
  // 지도 잠금(패닝/클릭 막기) — 컨트롤은 지도 위 겹침이 아니라 지도 아래 한 줄이라 여기서 들고 있다.
  const [mapLocked, setMapLocked] = useState(false);
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  // §P2 D4 — 행 펼침(NoteDatesList의 openRowId 패턴을 복제, 다른 useState 인스턴스로, 코드 공유
  // 없이). 이름 클릭은 계속 filterByRegion만 부른다(아래) — 펼침 트리거는 셰브런 전용.
  // 대표 행은 "primary" 센티널 id를 쓴다(NoteDatesList의 headerId/bodyId 관용구와 같은 방식).
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  // §P4 D14 — 검색 픽/지도 클릭이 카메라를 그 지점으로 날린다(RegionPreview.cameraSeed 와 같은
  // 규칙 — defaultLocation 레퍼런스 변경 = fly-to 의도). null 이면 아래 cameraLocation 이 첫 핀
  // 또는 지도 탭 기본 위치로 대신 시드한다.
  const [cameraSeed, setCameraSeed] = useState<MapLocation | null>(null);
  // 지도 클릭 등록 뒤 "줌을 유지한 채" 재중심하려면 그 순간의 실제 줌이 필요하다 — WorldMapAuto가
  // onViewChange로 매 커밋마다 알려주는 값을 ref에 들고 있는다(state로 두면 팬/줌마다 이 목록이
  // 리렌더된다 — 지도를 다시 그릴 이유가 없는 값이라 ref로 충분하다).
  const lastViewRef = useRef<MapLocation | null>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const handleViewChange = useCallback((v: MapLocation) => {
    lastViewRef.current = v;
  }, []);
  const toggleRow = (id: string, coords?: { lat: number; lng: number } | null) => {
    const opening = openRowId !== id;
    setOpenRowId(opening ? id : null);
    // §P4 D14 — 행을 펼치면 지도가 그 장소로 간다(좌표가 있을 때만 — 대표는 좌표 없이 이름만
    // 있을 수 있다). 이미 그 장소보다 더 깊이 줌한 상태였다면 줌아웃하지 않는다(날짜에서 행
    // 선택이 달력을 그 날짜로 옮기는 것의 짝).
    if (opening && coords) {
      setCameraSeed({
        lat: coords.lat,
        lng: coords.lng,
        zoom: Math.max(lastViewRef.current?.zoom ?? 0, SINGLE_NOTE_FOCUS_ZOOM),
      });
    }
  };
  const uiLang = useSettingsStore((s) => s.uiLang);
  // "현재 위치" 요청에 대한 답: 브라우저 지오로케이션/IP 추정은 이 앱에서 쓰지 않는다(권한·조용한
  // 실패·네트워크+프라이버시) — 대신 이미 있는 설정값(지도 탭 기본 위치)을 한 번에 넣는다.
  // customized 플래그가 false 면 공장 서울 좌표뿐이라 버튼 자체를 숨긴다.
  const defaultMapLocation = useSettingsStore((s) => s.defaultMapLocation);
  const regionNudgeEnabled = useSettingsStore((s) => s.regionNudgeEnabled);
  const setRegionNudgeEnabled = useSettingsStore((s) => s.setRegionNudgeEnabled);
  const activeNoteId = useNotesStore((s) => s.activeNote?.note.id ?? null);
  // 대표 편집/해제/승격은 notes 스토어의 activeNote 를 통해서만 쓰인다(setRegion/setLocation) —
  // 이 컴포넌트의 props 계약은 "아무 노트나" 지만, 두 스토어 setter 는 activeNote 불일치를
  // 체크하지 않고(그냥 !activeNote 만 early-return) 조용히 엉뚱한 노트에 쓸 수 있다. 두 마운트
  // 지점(TitleBar 메타줄, PreviewAttachment) 모두 오늘은 항상 activeNote 를 넘기지만, 미래의
  // 세 번째 호출부가 실수하지 않도록 여기 한 곳에서 막는다 — 매 호출부를 감사하는 것보다 싸다.
  const canEditPrimary = activeNoteId === noteId;

  const reload = useCallback(async () => {
    try {
      const res = await call<{ regions: NoteRegion[] }>("note_regions_list", { note_id: noteId });
      setRegions(res?.regions ?? []);
    } catch (e) {
      emitNotice(e instanceof Error ? e.message : String(e));
    }
  }, [noteId]);

  // 마운트 조회는 제목줄 칩·첨부 바와 같은 캐시(lib/noteMeta.ts)를 탄다 — 팝오버를 열 때 IPC 가 없다.
  // 편집 뒤의 reload() 는 캐시를 거치지 않는 새 조회(afterMutation 의 bump 가 캐시 버전도 옮긴다).
  const regionsVersion = useNoteRegionsVersion(noteId);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await noteRegionsCache.get(noteId, regionsVersion);
        if (!cancelled) setRegions(list);
      } catch {
        // Mount path: empty list in mock/offline; mutations surface errors via reload().
        if (!cancelled) setRegions([]);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [noteId, refreshKey, regionsVersion]);

  const waypoints = useMemo(() => toWaypointRegions(regions), [regions]);
  const visibleWaypoints = useMemo(
    () => dedupeWaypoints(primary, waypoints),
    [primary, waypoints],
  );

  const hasPrimary = Boolean(primary.region) || (primary.lat != null && primary.lng != null);

  // 스크롤 모드에서 아래쪽 행을 펼치면 본문이 행 영역 창 밖에 생긴다 — 그 컨테이너의 scrollTop 만
  // 민다(scrollIntoView 는 조상까지 밀어 position:fixed 팝오버에서 앱 셸을 움직일 수 있다 —
  // NoteDatesList.tsx 의 같은 effect 참고). 스크롤 모드가 아니면 넘침이 없어 아무 일도 없다.
  useEffect(() => {
    const c = rowsRef.current;
    if (!c || !openRowId) return;
    const el = Array.from(c.children).find((n) => (n as HTMLElement).dataset.rowId === openRowId) as
      | HTMLElement
      | undefined;
    if (!el) return;
    const cr = c.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    if (er.bottom > cr.bottom) c.scrollTop += er.bottom - cr.bottom;
    else if (er.top < cr.top) c.scrollTop -= cr.top - er.top;
  }, [openRowId]);

  // autoOpenSearch(팝오버 전용): 초기 fetch 가 끝나 실제로 빈 상태임이 확인된 뒤 딱 한 번만
  // 검색을 연다 — fetch 완료 전(regions=[] 이지만 아직 모름) 판단하면 실제로는 지역이 있는
  // 노트에서 검색이 잘못 튀어나올 수 있다. ref 로 한 번만 실행되게 막아, 이후 addTarget 을
  // 사용자가 직접 닫아도 다시 열리지 않는다.
  useEffect(() => {
    if (!autoOpenSearch || inline || !loaded || autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    if (!hasPrimary && visibleWaypoints.length === 0) {
      setAddTarget("first");
    }
  }, [autoOpenSearch, inline, loaded, hasPrimary, visibleWaypoints.length]);

  // 지역 이름 자체가 필터 트리거다(owner 미결 #1: 이름으로 지역 필터를 거는 진입점이 앱
  // 어디에도 없었다 — setRegionFilter 호출부가 전부 해제(null)뿐이었다). 행에 버튼을 하나 더
  // 붙이면 이미 빽빽한 줄이 더 빽빽해지므로, 이름을 누르는 것이 곧 "이 지역만 보기"다.
  // 해제는 기존 지역 필터 칩이 맡는다(RegionFilter.tsx) — 그쪽은 원래 해제만 할 수 있었다.
  const filterByRegion = (name: string) => {
    useSearchStore.getState().setRegionFilter({ kind: "region", name });
    emitNotice(t("region.filtered_by", { name }));
    onFilterApplied?.();
  };

  const afterMutation = async () => {
    await reload();
    // N1-3: PreviewAttachment now mounts this list, but AttachmentsBar's region tile (badge
    // count + visibility) lives in a sibling component with no direct data link — it re-fetches
    // on attachmentRevision, the same counter every other attachment mutation already bumps
    // (see useAttachmentActions.ts's refresh()). Reusing it here needs no new plumbing.
    useNotesStore.getState().bumpAttachmentRevision();
    onChanged?.();
  };

  const resetAddUI = () => {
    setAddTarget(null);
    setSearchQuery("");
    setDupNotice(null);
  };

  const addWaypoint = async (name: string | null, lat: number | null, lng: number | null) => {
    resetAddUI();
    if (!name || lat == null || lng == null) {
      emitNotice(t("region.need_name_and_coords"));
      return;
    }
    setBusy(true);
    try {
      // 지도 클릭 추가(PreviewAttachment)와 같은 규칙을 써야 순서가 어긋나지 않는다.
      const nextPos = nextWaypointPosition(regions);
      await call("note_region_add", {
        note_id: noteId,
        name,
        lat,
        lng,
        position: nextPos,
      });
      await afterMutation();
    } catch (e) {
      emitNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const removeWaypoint = async (id: string) => {
    setBusy(true);
    try {
      await call("note_region_remove", { id });
      await afterMutation();
    } catch (e) {
      emitNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const moveWaypoint = async (id: string, dir: -1 | 1) => {
    // Reorder uses the full note_regions set (including any primary-duplicate rows still in DB),
    // so ordered_ids still matches the server-side set contract.
    const ids = [...regions].sort((a, b) => a.position - b.position).map((r) => r.id);
    const idx = ids.indexOf(id);
    if (idx < 0) return;
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return;
    const next = [...ids];
    [next[idx], next[j]] = [next[j], next[idx]];
    setBusy(true);
    try {
      await call("note_region_reorder", { note_id: noteId, ordered_ids: next });
      await afterMutation();
    } catch (e) {
      emitNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // 대표 장소 쓰기의 단일 관문 — lib/placeCommit.ts::writePrimaryPlace 가 이름→좌표를 순서대로 await
  // 하고 하나라도 안 들어가면 직전 상태로 되돌린다. 여기서는 busy 와 실패 안내만 얹는다.
  const writePrimary = async (next: PrimaryPlace): Promise<boolean> => {
    setBusy(true);
    try {
      const ok = await writePrimaryPlace(next);
      if (!ok) emitNotice(t("region.save_failed"));
      return ok;
    } catch (e) {
      emitNotice(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  // QA feedback (항목 2): promote a waypoint to primary. No backend "swap" command exists — this
  // orchestrates the existing primitives: demote the current primary into a waypoint row (only
  // possible when it has coords; a name-only primary with no lat/lng can't become a note_regions
  // row, so it's dropped — matches the pre-existing constraint that note_region_add requires
  // lat/lng), write the promoted place as the new primary, then remove its old waypoint row.
  // 순서는 add → write → remove: 어느 단계가 실패해도 장소를 **잃지 않는다.** write 가 실패하면
  // 방금 만든 강등 행을 지워 원상복구하고(대표는 스토어가 롤백), remove 만 실패하면 승격된 장소가
  // 대표와 같은 경유지로 남을 뿐이라 dedupeWaypoints 가 숨긴다(무해한 중복).
  const makePrimary = async (wp: WaypointRegion) => {
    if (!canEditPrimary) return;
    setBusy(true);
    try {
      let demotedId: string | null = null;
      if (hasPrimary && primary.lat != null && primary.lng != null) {
        const res = await call<{ id?: string }>("note_region_add", {
          note_id: noteId,
          name: primary.region || t("region.unnamed"),
          lat: primary.lat,
          lng: primary.lng,
          position: nextWaypointPosition(regions),
        });
        demotedId = res?.id ?? null;
      }
      const ok = await writePrimaryPlace({ region: wp.name, lat: wp.lat, lng: wp.lng });
      if (!ok) {
        if (demotedId) {
          try {
            await call("note_region_remove", { id: demotedId });
          } catch (e) {
            reportFallback("region", "make_primary_rollback_failed", e instanceof Error ? e.message : String(e));
          }
        }
        emitNotice(t("region.save_failed"));
        await afterMutation();
        return;
      }
      await call("note_region_remove", { id: wp.id });
      await afterMutation();
    } catch (e) {
      emitNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const editPrimary = async (newRegion: string | null, newLat: number | null, newLng: number | null) => {
    resetAddUI();
    await writePrimary({ region: newRegion, lat: newLat, lng: newLng });
  };

  // Clears both region name and coords — hasPrimary (below) keys on either, and previewResolver's
  // region gate does the same (region || lat != null || lng != null). Region-only would leave the
  // primary row visibly stuck at "Unnamed place" with no way back to the empty state (regression
  // found in review: the old single-field RegionEditor got away with region-only because it never
  // looked at lat/lng at all — mirrors MobileNoteBadges.clearRegion, which already clears both).
  const clearPrimary = async () => {
    if (!canEditPrimary) return;
    await writePrimary({ region: null, lat: null, lng: null });
  };

  // First place for a note becomes the primary (matches the old single-region RegionEditor this
  // component now subsumes), not a waypoint — only when we're allowed to write the primary at all
  // (canEditPrimary); otherwise fall back to the waypoint path so a foreign-note render still works.
  const addFirstPlace = async (name: string | null, lat: number | null, lng: number | null) => {
    resetAddUI();
    if (!name || lat == null || lng == null) {
      emitNotice(t("region.need_name_and_coords"));
      return;
    }
    if (!canEditPrimary) {
      await addWaypoint(name, lat, lng);
      return;
    }
    await writePrimary({ region: name, lat, lng });
  };

  // 대표 이름 인라인 편집(inline 모드) — 이름만 바꾼다(좌표는 지금 값 그대로).
  const commitRename = () => {
    const next = (renameDraft ?? "").trim();
    setRenameDraft(null);
    if (next === (primary.region ?? "")) return;
    void writePrimary({ region: next || null, lat: primary.lat, lng: primary.lng });
  };

  // §P4 D14 — 검색 픽/지도 클릭이 함께 타는 단일 커밋 분기(addTarget 으로 갈린다). 모달이
  // 사라졌으니 "dialogSubmit"이라는 옛 이름은 더 이상 맞지 않는다 — "이 장소를 확정한다"는
  // 뜻으로 고쳤다.
  // 같은 장소 가드: 새 좌표가 기존 장소(대표 + 경유지, 대표 교체 모드에선 경유지만)와 약 50m 이내
  // 면 추가하지 않고 검색 블록에 안내만 띄운다(검색은 열어 둔다 — 다른 곳을 고르면 된다).
  const existingPlaces = (): { name: string; lat: number | null; lng: number | null }[] => [
    ...(addTarget === "primary" || !hasPrimary
      ? []
      : [{ name: primary.region || t("region.unnamed"), lat: primary.lat, lng: primary.lng }]),
    ...visibleWaypoints.map((w) => ({ name: w.name, lat: w.lat, lng: w.lng })),
  ];
  const commitPlace = async (region: string | null, lat: number | null, lng: number | null) => {
    if (region && lat != null && lng != null) {
      // 결과 목록이 이미 등록된 장소를 비활성으로 막지만, 지도 클릭 경로는 여기서 마지막으로 거른다.
      const dup = findDuplicatePlace(lat, lng, existingPlaces());
      if (dup) {
        setDupNotice(t("region.duplicate_place", { name: dup.name, m: DUPLICATE_PLACE_RADIUS_M }));
        return;
      }
    }
    if (addTarget === "waypoint") return addWaypoint(region, lat, lng);
    if (addTarget === "primary") return editPrimary(region, lat, lng);
    return addFirstPlace(region, lat, lng);
  };

  // 검색 결과 하나를 고르면 addTarget 이 가리키는 동작으로 바로 이어지고(commitPlace), 지도는
  // 그 좌표로 fly-to 한다(§P4 D14 — 모달의 "핀 미리보기 → 적용" 2단계는 없다. 틀렸으면 행의
  // 휴지통으로 지운다). 이름은 splitPlaceLabel(번지수로 시작하는 라벨 보정).
  const pickSearchResult = (item: GeocodeResultItem) => {
    const name = splitPlaceLabel(item.label).name || item.label;
    void commitPlace(name, item.lat, item.lng);
    setCameraSeed({ lat: item.lat, lng: item.lng, zoom: PICK_FLYTO_ZOOM });
  };

  // 팝오버를 열기만 해서는 검색이 돌면 안 된다(네트워크 절약 회귀 고정) — addTarget 이 설정됐을
  // 때만 실제 쿼리 문자열을 훅에 넘긴다.
  const placeSearch = usePlaceSearch({
    query: addTarget ? searchQuery : "",
    uiLang,
    onPick: pickSearchResult,
    onEscape: resetAddUI,
    disabled: busy,
    isRegistered: (item) => findDuplicatePlace(item.lat, item.lng, existingPlaces()) != null,
  });

  // §P4 D3′/D14 — 지도 클릭 커밋. 추가 모드(addTarget != null)일 때만 등록한다: 팝오버 지도는
  // 작아 팬/줌 중 오클릭이 잦고, 그 게이트는 mapBlock 의 onMapClick 자체가 이미 건다(추가 모드가
  // 아니면 핸들러를 넘기지 않는다) — 여기 busy 체크는 지오코딩 왕복 도중의 이중 클릭을 막는
  // 추가 방어선이다. useDefaultLocation 과 정확히 같은 모양(좌표 → geocode_reverse →
  // clickedPlaceName 폴백)으로 라벨을 만들고, commitPlace 에 실어 addTarget 분기를 그대로 탄다.
  // 커밋 뒤에는 "줌을 유지한 채" 그 지점으로 재중심한다 — 안 그러면 첫 핀이 생기는 순간
  // cameraLocation 이 SINGLE_NOTE_FOCUS_ZOOM 으로 줌아웃돼 방금 찍은 자리를 잃는다(lastViewRef
  // 에 들고 있던 직전 줌을 그대로 쓴다).
  const handleMapClick = async (lat: number, lng: number) => {
    if (!addTarget || busy) return;
    setBusy(true);
    let label: string | null = null;
    try {
      const res = await call<{ label: string | null }>("geocode_reverse", { lat, lng, lang: uiLang || "ko" });
      label = res?.label ?? null;
    } catch {
      label = null;
    }
    setBusy(false);
    void commitPlace(clickedPlaceName(label, lat, lng), lat, lng);
    setCameraSeed({ lat, lng, zoom: lastViewRef.current?.zoom ?? PICK_FLYTO_ZOOM });
  };

  // §P4 D3′ — 이 노트의 모든 장소를 핀 + 경로선으로(RegionPreview.tsx 와 같은 buildRegionPath →
  // markers/pathLines 조립). 여기 마커는 보기 전용이라(팝오버 지도가 작아 드래그는 혼란만
  // 준다) interactive:false 로 고정하고 onMarkerMove 를 넘기지 않는다.
  //
  // RegionPreview 와 달리 **메모한다.** WorldMapGL 의 마커 동기화 effect 는 `markers` 참조가
  // 바뀔 때마다 DOM 마커를 전부 지우고 다시 만든다(WorldMapGL.tsx "마커 동기화" — 상태가 DOM 에
  // 박혀 있어 재생성이 가장 단순하다는 이유). RegionPreview 는 거의 리렌더되지 않아 문제가 없지만
  // 이 컴포넌트는 검색 입력(searchQuery state)을 직접 들고 있어 **글자 하나마다** 리렌더된다 —
  // 메모 없이는 타이핑할 때마다 핀 전부와 경로 소스가 재생성된다. 의존성은 `primary` 객체가 아니라
  // 그 원시 필드다(호출부가 매 렌더 새 객체를 넘겨도 값이 같으면 참조를 지킨다).
  const regionPath = useMemo(
    () => buildRegionPath(primary, noteId, waypoints),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- primary 는 원시 필드로 풀어서 본다(위 주석).
    [primary.region, primary.lat, primary.lng, noteId, waypoints],
  );
  const mapMarkers: MapMarker[] = useMemo(
    () => buildRegionMarkers(regionPath, primary.region, waypoints),
    [regionPath, primary.region, waypoints],
  );
  const mapPathLines: MapPathLine[] = useMemo(
    () => buildPathLines(regionPath, noteId),
    [regionPath, noteId],
  );
  const firstLat = regionPath[0]?.lat;
  const firstLng = regionPath[0]?.lng;
  // 카메라: cameraSeed(검색 픽/지도 클릭/행 펼침이 세팅) ?? 첫 핀@SINGLE_NOTE_FOCUS_ZOOM ??
  // 지도 탭 기본 위치. defaultMapLocation 은 스토어에 항상 값이 있다(팩토리 기본 서울)므로
  // undefined 로 떨어지지 않는다. homeLocation(아래 WorldMapAuto)은 이 seed 와 별개로 항상
  // 설정 홈을 가리켜야 하므로 따로 defaultMapLocation 을 넘긴다.
  const cameraLocation: MapLocation = useMemo(
    () =>
      cameraSeed ??
      (firstLat != null && firstLng != null
        ? { lat: firstLat, lng: firstLng, zoom: SINGLE_NOTE_FOCUS_ZOOM }
        : defaultMapLocation),
    [cameraSeed, firstLat, firstLng, defaultMapLocation],
  );

  // §P4 D3′ — 팝오버(!inline)에서 항상 그린다(addTarget 과 무관, 빈 상태 포함). inline 마운트
  // (RegionPreview)는 이미 그 카드 자체가 큰 지도를 갖고 있어(inline prop 헤더 주석) 호출부에서
  // 아예 렌더하지 않는다(아래 return). onMapClick 은 addTarget 이 있을 때만 넘긴다 — 없으면
  // 지도는 보기 전용(패닝만, §P4 D14 "추가 모드가 아닐 땐 onMapClick 을 넘기지 않는다").
  //
  // W2 — 잠금·홈 컨트롤은 지도 위 겹침(WorldMapGL 의 MapControlBar)이 아니라 지도 **아래 한 줄**이다:
  // 지도 안 우상단 겹침은 작은 팝오버 지도에서 핀·저작권 문구를 가렸다. 내장 바는 hideControls 로 끄고
  // 잠금은 isLocked/onToggleLock 으로 여기서 들고, 홈은 cameraSeed 를 새 객체로 갈아 fly-to 한다
  // (WorldMapGL 내부 handleGoHome 과 같은 목적지 = 설정의 기본 위치).
  const mapBlock = (
    <div data-testid="note-region-map-block" style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
      <div data-testid="note-region-map" style={{ height: MAP_HEIGHT }}>
        <WorldMapAuto
          markers={mapMarkers}
          pathLines={mapPathLines}
          defaultLocation={cameraLocation}
          homeLocation={defaultMapLocation}
          onMapClick={addTarget ? (lat, lng) => void handleMapClick(lat, lng) : undefined}
          onViewChange={handleViewChange}
          uiLang={uiLang}
          hideControls
          isLocked={mapLocked}
          onToggleLock={() => setMapLocked((v) => !v)}
        />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          data-testid="note-region-map-lock"
          data-active={mapLocked ? "true" : undefined}
          aria-pressed={mapLocked}
          title={mapLocked ? t("settings.map_unlock") : t("settings.map_lock")}
          aria-label={mapLocked ? t("settings.map_unlock") : t("settings.map_lock")}
          onClick={() => setMapLocked((v) => !v)}
          style={{ ...headerIconBtnStyle, color: "var(--muted)" }}
        >
          {mapLocked ? <IconLock size={12} strokeWidth={2} /> : <IconUnlock size={12} strokeWidth={2} />}
        </button>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          data-testid="note-region-map-home"
          title={t("settings.map_home")}
          aria-label={t("settings.map_home")}
          onClick={() => setCameraSeed({ ...defaultMapLocation })}
          style={{ ...headerIconBtnStyle, color: "var(--muted)" }}
        >
          <IconHome size={12} strokeWidth={2} />
        </button>
        <label style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: "var(--space-2)", fontSize: "var(--text-xs)", color: "var(--faint)" }} title={t("region.auto_detect_hint")}>
          {t("region.auto_detect")}
          <Toggle
            checked={regionNudgeEnabled}
            onChange={(v) => void setRegionNudgeEnabled(v)}
            aria-label={t("region.auto_detect")}
            data-testid="note-region-auto-detect"
          />
        </label>
      </div>
    </div>
  );

  // 인라인 검색 박스 — 흔한 경로(검색으로 고르기)를 지도 없이도 끝낸다. 입력은 날짜 팝오버 입력과
  // 같은 차분함(`field--seamless` — 호버/포커스에서만 밑줄이 accent)으로, 테두리는 바깥 상자가 그린다
  // (`.field:focus` 의 굵은 accent 테두리 + 6px 글로우를 쓰지 않는다). × 는 "검색 닫기"다 — 추가 모드를
  // 접을 뿐 이미 들어간 장소는 건드리지 않는다. 안내문/기본 위치 링크는 서로 다른 줄이다.
  const searchBox = addTarget && (
    <div
      data-testid="note-region-search"
      style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", marginTop: "var(--space-2xs)" }}
    >
      <div
        style={{
          display: "flex",
          gap: "var(--space-1)",
          alignItems: "center",
        }}
      >
        <input
          type="text"
          autoFocus
          data-testid="note-region-search-input"
          className="field field--seamless"
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            setDupNotice(null);
          }}
          placeholder={t("note.address_search_placeholder")}
          aria-label={t("note.address_search_placeholder")}
          {...placeSearch.inputProps}
          style={{ flex: 1, minWidth: 0, ...chipScaleField }}
        />
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          data-testid="note-region-search-close"
          title={t("region.search_close")}
          aria-label={t("region.search_close")}
          onClick={resetAddUI}
          style={{ color: "var(--muted)", width: 22, height: 22, flex: "none" }}
        >
          <IconClose size={11} strokeWidth={2.4} />
        </button>
      </div>
      <PlaceSearchResults binding={placeSearch} query={searchQuery} testIdPrefix="note-region-search-result" />
      {dupNotice && (
        <div
          role="status"
          data-testid="note-region-duplicate-notice"
          style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}
        >
          {dupNotice}
        </div>
      )}
    </div>
  );

  // inline 마운트(RegionPreview)는 지도 검색/클릭이 이미 추가 경로다 — 이 목록 자체는 아무 것도
  // 그리지 않고 안내 문구만 보여준다(§P4 D3′ 이전과 동일, D3 실패와 무관한 분기).
  if (!hasPrimary && visibleWaypoints.length === 0 && inline) {
    return (
      <div data-testid="note-regions-list" style={{ width: "100%", fontSize: "var(--text-xs)", color: "var(--muted)" }}>
        {t("region.map_click_hint")}
      </div>
    );
  }

  const isPrimaryOpen = openRowId === PRIMARY_ROW_ID;
  // 빈 노트에서 처음 누르는 "+ 장소 추가"는 대표를 채운다("first") — 대표든 경유지든 하나라도
  // 있으면 그 다음은 경유지("waypoint")다. 두 갈래(빈 상태/비어있지 않은 상태)를 한 return 으로
  // 합치며 이 판정만 변수로 뽑았다(§P4 D14 "두 return 분기를 하나로").
  const emptyAddTarget: "first" | "waypoint" = !hasPrimary && visibleWaypoints.length === 0 ? "first" : "waypoint";
  const rowsScroll = !inline && (hasPrimary ? 1 : 0) + visibleWaypoints.length > SCROLL_AFTER_ROWS;

  return (
    <div
      data-testid="note-regions-list"
      style={{
        width: "100%",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        opacity: busy ? 0.7 : 1,
        fontSize: "var(--text-sm)",
      }}
    >
      {/* §P4 D3′/D14 — 지도 → 구분선 → 목록(아래 div가 목록+추가 컨트롤을 담는다), 날짜 팝오버
          (DatesPanel.tsx 의 달력 → 구분선 → 목록)와 같은 뼈대. inline 모드는 지도를 그리지 않고
          (헤더 주석) 구분선도 필요 없다 — display:contents 로 같은 JSX 트리를 유지하면서 시각
          효과만 뺀다(두 return 분기를 하나로 합친 것과 같은 이유: 행 렌더링 코드를 중복시키지
          않는다). */}
      {!inline && mapBlock}
      <div
        style={
          inline
            ? { display: "contents" }
            : {
                display: "flex",
                flexDirection: "column",
                gap: 4,
                borderTop: "1px solid var(--divider)",
                paddingTop: "var(--space-3)",
              }
        }
      >
        {/* 행 영역 — 평소엔 display:contents 라 레이아웃에 없는 것과 같다(바깥 flex column 의 gap 을
            그대로 받는다). SCROLL_AFTER_ROWS 를 넘을 때만 자기 높이를 갖고 스크롤한다. */}
        <div
          ref={rowsRef}
          data-testid="note-region-rows"
          data-scrolls={rowsScroll}
          className={rowsScroll ? "scroll" : undefined}
          style={
            rowsScroll
              ? { display: "flex", flexDirection: "column", gap: 4, maxHeight: ROWS_SCROLL_MAX_H, overflowY: "auto" }
              : { display: "contents" }
          }
        >
          {hasPrimary && (
            <div data-row-id={PRIMARY_ROW_ID} style={{ display: "flex", flexDirection: "column", flex: "none" }}>
              <div
                data-testid="note-region-primary"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  color: "var(--text)",
                  fontWeight: 600,
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: "var(--accent)",
                    flex: "none",
                  }}
                />
                {renameDraft !== null ? (
                  <input
                    type="text"
                    data-testid="note-region-primary-rename"
                    className="field"
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitRename();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        setRenameDraft(null);
                      }
                    }}
                    placeholder={t("note.region_placeholder")}
                    style={{ flex: 1, minWidth: 0, height: 24, fontSize: "var(--text-sm)" }}
                  />
                ) : (
                <button
                  type="button"
                  data-testid="note-region-filter-primary"
                  title={t("region.filter_by")}
                  disabled={!primary.region}
                  onClick={() => primary.region && filterByRegion(primary.region)}
                  style={{
                    ...nameButtonStyle,
                    cursor: primary.region ? "pointer" : "default",
                    fontWeight: 600,
                  }}
                >
                  {primary.region || t("region.unnamed")}
                </button>
                )}
                {renameDraft === null && (
                  <span style={{ color: "var(--muted)", fontWeight: 400, fontSize: "var(--text-xs)", flex: 1 }}>
                    {t("region.primary_label")}
                  </span>
                )}
                {/* §P4 D14(D13 짝) — 대표 해제(휴지통)는 펼친 행의 헤더에, 셰브런 바로 왼쪽에 아이콘만
                    으로 둔다. 접힌 8개 행마다 별·휴지통·셰브런이 늘어서면 버튼 밭이 된다는 우려가
                    NoteDatesList.tsx 쪽 §P4 D13 결정과 같다 — 펼친 행에서만 보인다. */}
                {renameDraft === null && isPrimaryOpen && canEditPrimary && primary.region && (
                  <button
                    type="button"
                    className="icon-btn icon-btn--sm"
                    data-testid="note-region-primary-clear"
                    title={t("note.remove_region")}
                    aria-label={t("note.remove_region")}
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      void clearPrimary();
                    }}
                    style={{ ...headerIconBtnStyle, color: "var(--danger)" }}
                  >
                    <IconTrash size={12} strokeWidth={2} />
                  </button>
                )}
                {/* §P2 D4 — 이름 클릭(위)은 filterByRegion 그대로, 펼침은 이 셰브런 전용 클릭이다.
                    stopPropagation은 이 버튼이 훗날 클릭 핸들러가 있는 조상 안에 놓이더라도 이름 클릭과
                    번지지 않게 하는 방어 — 지금 구조에서 이름 버튼은 형제 요소라 버블링 경로 자체가
                    없지만, 그 사실에 기대지 않는다. */}
                {renameDraft === null && (
                  <button
                    type="button"
                    className="icon-btn icon-btn--sm"
                    data-testid="note-region-primary-toggle"
                    title={isPrimaryOpen ? t("region.row_collapse") : t("region.row_expand")}
                    aria-label={isPrimaryOpen ? t("region.row_collapse") : t("region.row_expand")}
                    aria-expanded={isPrimaryOpen}
                    aria-controls={isPrimaryOpen && canEditPrimary ? "note-region-primary-body" : undefined}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleRow(
                        PRIMARY_ROW_ID,
                        primary.lat != null && primary.lng != null ? { lat: primary.lat, lng: primary.lng } : null,
                      );
                    }}
                    style={{ color: "var(--muted)", width: 22, height: 22, flex: "none" }}
                  >
                    <IconCaret dir={isPrimaryOpen ? "up" : "down"} size={12} />
                  </button>
                )}
              </div>
              {/* §P4 D14 — 대표 해제는 위 헤더로 옮겨졌다. 본문엔 편집 버튼만 남는데, 그 버튼은
                  canEditPrimary 게이트뿐이라 !canEditPrimary 면 본문이 통째로 비어 렌더할 이유가
                  없다(빈 role="group" 을 남기지 않는다). */}
              {isPrimaryOpen && renameDraft === null && canEditPrimary && (
                <div
                  id="note-region-primary-body"
                  data-testid="note-region-primary-body"
                  role="group"
                  style={{
                    display: "flex",
                    padding: `0 0 var(--space-2) ${rowBodyIndent}px`,
                  }}
                >
                  <button
                    type="button"
                    className="tag-btn"
                    data-testid="note-region-primary-edit"
                    title={t("region.edit_primary")}
                    aria-label={t("region.edit_primary")}
                    disabled={busy}
                    onClick={() => (inline ? setRenameDraft(primary.region ?? "") : setAddTarget("primary"))}
                    style={{ ...chipScaleField, display: "inline-flex", alignItems: "center", gap: "var(--space-1)" }}
                  >
                    <IconEdit size={11} strokeWidth={2} />
                    {t("region.edit_primary")}
                  </button>
                </div>
              )}
            </div>
          )}
          {addTarget === "primary" && searchBox}

          {visibleWaypoints.map((wp) => {
            const num = waypointPathNumber(primary, waypoints, wp.id);
            const isOpen = openRowId === wp.id;
            return (
              <div key={wp.id} data-row-id={wp.id} style={{ display: "flex", flexDirection: "column", flex: "none" }}>
                <div
                  data-testid={`note-region-waypoint-${wp.id}`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    paddingLeft: hasPrimary ? 12 : 0,
                    color: "var(--text)",
                  }}
                >
                  {hasPrimary && (
                    <span style={{ color: "var(--faint)", fontFamily: "monospace", fontSize: "var(--text-xs)" }}>
                      └
                    </span>
                  )}
                  <span
                    aria-hidden
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      border: "2px solid var(--accent)",
                      background: "transparent",
                      flex: "none",
                    }}
                  />
                  <button
                    type="button"
                    data-testid={`note-region-filter-${wp.id}`}
                    title={t("region.filter_by")}
                    onClick={() => filterByRegion(wp.name)}
                    style={{ ...nameButtonStyle, flex: 1 }}
                  >
                    {wp.name}
                  </button>
                  <span style={{ color: "var(--muted)", fontSize: "var(--text-xs)", fontWeight: 600 }}>
                    {num}
                  </span>
                  {/* §P4 D14(D13 짝) — 대표로 지정 / 삭제는 펼친 행의 헤더에, 셰브런 바로 왼쪽에
                      아이콘만으로. 대표로 지정만 canEditPrimary 게이트(기존 그대로) — 삭제는
                      게이트 없이 유지한다(§P2 "이 비대칭을 새로 만들지도, 없애지도 않는다"). */}
                  {isOpen && canEditPrimary && (
                    <button
                      type="button"
                      className="icon-btn icon-btn--sm"
                      data-testid={`note-region-make-primary-${wp.id}`}
                      title={t("region.set_primary")}
                      aria-label={t("region.set_primary")}
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void makePrimary(wp);
                      }}
                      style={{ ...headerIconBtnStyle, color: "var(--muted)" }}
                    >
                      <IconStar size={12} strokeWidth={2} />
                    </button>
                  )}
                  {isOpen && (
                    <button
                      type="button"
                      className="icon-btn icon-btn--sm"
                      data-testid={`note-region-remove-${wp.id}`}
                      title={t("region.remove_place")}
                      aria-label={t("region.remove_place")}
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void removeWaypoint(wp.id);
                      }}
                      style={{ ...headerIconBtnStyle, color: "var(--danger)" }}
                    >
                      <IconTrash size={12} strokeWidth={2} />
                    </button>
                  )}
                  {/* §P2 D4 — 이름 클릭(위)과 분리된 셰브런 전용 히트존. stopPropagation은
                      note-region-primary-toggle과 같은 방어적 이유. */}
                  <button
                    type="button"
                    className="icon-btn icon-btn--sm"
                    data-testid={`note-region-toggle-${wp.id}`}
                    title={isOpen ? t("region.row_collapse") : t("region.row_expand")}
                    aria-label={isOpen ? t("region.row_collapse") : t("region.row_expand")}
                    aria-expanded={isOpen}
                    aria-controls={isOpen ? `note-region-body-${wp.id}` : undefined}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleRow(wp.id, { lat: wp.lat, lng: wp.lng });
                    }}
                    style={{ color: "var(--muted)", width: 22, height: 22, flex: "none" }}
                  >
                    <IconCaret dir={isOpen ? "up" : "down"} size={12} />
                  </button>
                </div>
                {isOpen && (
                  <div
                    id={`note-region-body-${wp.id}`}
                    data-testid={`note-region-body-${wp.id}`}
                    role="group"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--space-2)",
                      padding: `0 0 var(--space-2) ${hasPrimary ? 12 + rowBodyIndent : rowBodyIndent}px`,
                    }}
                  >
                    {/* §P4 D14 — NoteDatesList.tsx의 FieldRow(52px 회색 라벨 + 컨트롤)와 같은 줄
                        모양. 대표로/삭제가 헤더로 옮겨간 뒤 본문엔 순서(↑/↓)만 남는다. */}
                    <span style={{ width: 52, flex: "none", color: "var(--muted)", fontSize: "var(--text-xs)" }}>
                      {t("region.row_order_label")}
                    </span>
                    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
                      <button
                        type="button"
                        className="icon-btn icon-btn--sm"
                        data-testid={`note-region-move-up-${wp.id}`}
                        title={t("region.move_up")}
                        aria-label={t("region.move_up")}
                        disabled={busy}
                        onClick={() => void moveWaypoint(wp.id, -1)}
                        style={{ ...headerIconBtnStyle, color: "var(--muted)" }}
                      >
                        <IconArrowUp size={12} strokeWidth={2} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn icon-btn--sm"
                        data-testid={`note-region-move-down-${wp.id}`}
                        title={t("region.move_down")}
                        aria-label={t("region.move_down")}
                        disabled={busy}
                        onClick={() => void moveWaypoint(wp.id, 1)}
                        style={{ ...headerIconBtnStyle, color: "var(--muted)" }}
                      >
                        <IconArrowDown size={12} strokeWidth={2} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* §P4 D14 — "+ 장소 추가"는 목록 맨 아래. 누르면 이 자리가 검색 줄로 바뀐다(버튼이 검색
            블록으로 교체 — 둘이 동시에 보이지 않는다). addTarget==="primary" 인 동안엔 위 대표
            행 바로 아래 검색 블록이 이미 떠 있으니 여기는 아무 것도 그리지 않는다. inline
            모드는 추가 컨트롤 자체가 없다(헤더 주석). */}
        {!inline && (
          <div style={{ paddingLeft: hasPrimary ? 12 : 0, marginTop: "var(--space-2xs)" }}>
            {addTarget ? (
              addTarget !== "primary" && searchBox
            ) : (
              <button
                type="button"
                data-testid="note-region-add"
                className="tag-btn"
                onClick={() => setAddTarget(emptyAddTarget)}
                disabled={busy}
                style={{
                  fontSize: "var(--text-xs)",
                  fontWeight: 400,
                  border: "1px dashed var(--divider)",
                  borderRadius: "var(--radius-sm)",
                  padding: "0 var(--space-3)",
                  color: "var(--muted)",
                }}
              >
                {t("region.add_place")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
