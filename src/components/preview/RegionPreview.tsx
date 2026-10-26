import { useEffect, useMemo, useRef, useState } from "react";
import { useSettingsStore } from "../../stores/settings";
import { useNotesStore } from "../../stores/notes";
import type { NoteRegion } from "../../lib/commands.gen";
import { call, emitNotice } from "../../lib/invoke";
import { t } from "../../i18n/t";
import { WorldMapAuto, type MapMarker, type MapPathLine, type MapLocation } from "../map/WorldMapAuto";
import { SINGLE_NOTE_FOCUS_ZOOM, PICK_FLYTO_ZOOM } from "../map/mapZoomScale";
import { NoteRegionsList } from "../attachments/NoteRegionsList";
import { MapPlaceSearch } from "../home/MapPlaceSearch";
import {
  buildPathLines,
  buildRegionMarkers,
  buildRegionPath,
  clickedPlaceName,
  nextWaypointPosition,
  toWaypointRegions,
  type PrimaryRegion,
} from "../attachments/regionDisplay";
import { IconCaret } from "../icons";
import { centeredHintStyle } from "./shared";

export function RegionPreview({ noteId, primary }: { noteId: string; primary: PrimaryRegion }) {
  const uiLang = useSettingsStore((s) => s.uiLang);
  const defaultMapLocation = useSettingsStore((s) => s.defaultMapLocation);
  const attachmentRevision = useNotesStore((s) => s.attachmentRevision);
  const [regions, setRegions] = useState<NoteRegion[]>([]);
  const [listOpen, setListOpen] = useState(true);
  const [adding, setAdding] = useState(false);
  // 검색 픽은 카메라를 그 지점으로 날린다(RegionPickerFields 의 cameraSeed 와 같은 규칙 —
  // defaultLocation 레퍼런스 변경 = fly-to 의도). 이후엔 핀 목록이 바뀌어도 사용자가 보던 곳을
  // 뺏지 않도록 seed 를 유지한다.
  const [cameraSeed, setCameraSeed] = useState<MapLocation | null>(null);
  const addingRef = useRef(false);
  const lastMoveAtRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await call<{ regions: NoteRegion[] }>("note_regions_list", { note_id: noteId });
        if (!cancelled) setRegions(res?.regions ?? []);
      } catch {
        if (!cancelled) setRegions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [noteId, attachmentRevision]);

  const waypoints = toWaypointRegions(regions);
  const path = buildRegionPath(primary, noteId, waypoints);
  // 대표 핀은 보기 전용, 경유지 핀은 끌어 옮길 수 있다(onMarkerMove).
  const markers: MapMarker[] = buildRegionMarkers(path, primary.region, waypoints, { interactive: true });
  const pathLines: MapPathLine[] = buildPathLines(path, noteId);
  const firstLat = path[0]?.lat;
  const firstLng = path[0]?.lng;
  // 오너 결정: 핀이 있으면 핀 중심(기존 그대로 SINGLE_NOTE_FOCUS_ZOOM), 없으면 홈(설정의
  // defaultMapLocation) 중심 — defaultMapLocation은 스토어에 항상 값이 있으니(팩토리 기본 서울)
  // 여기선 undefined가 나오지 않는다. 홈 버튼(WorldMap의 homeLocation)은 이 seed와 별개로 항상
  // 설정 홈을 가리켜야 하므로 아래 WorldMap에 따로 넘긴다(WorldMap.tsx의 homeLocation 폴백 참고).
  const defaultLocation = useMemo(
    () =>
      cameraSeed ??
      (firstLat != null && firstLng != null
        ? { lat: firstLat, lng: firstLng, zoom: SINGLE_NOTE_FOCUS_ZOOM }
        : defaultMapLocation),
    [cameraSeed, firstLat, firstLng, defaultMapLocation],
  );

  const commitWaypoint = async (name: string, lat: number, lng: number) => {
    try {
      await call("note_region_add", {
        note_id: noteId,
        name,
        lat,
        lng,
        position: nextWaypointPosition(regions),
      });
      useNotesStore.getState().bumpAttachmentRevision();
    } catch (e) {
      emitNotice(e instanceof Error ? e.message : String(e));
    } finally {
      addingRef.current = false;
      setAdding(false);
    }
  };

  const addAtPoint = async (lat: number, lng: number) => {
    if (addingRef.current) return;
    if (Date.now() - lastMoveAtRef.current < 300) return;
    addingRef.current = true;
    setAdding(true);
    let label: string | null = null;
    try {
      const rev = await call<{ label: string | null }>("geocode_reverse", { lat, lng, lang: uiLang || "ko" });
      label = rev.label;
    } catch {
      // geocode fallback
    }
    await commitWaypoint(clickedPlaceName(label, lat, lng), lat, lng);
  };

  // 검색 결과 픽 = 그 좌표로 fly-to + 즉시 장소 추가(라벨 = 결과 지명). 모달 없음.
  const addFromSearch = (item: { label: string; lat: number; lng: number }) => {
    setCameraSeed({ lat: item.lat, lng: item.lng, zoom: PICK_FLYTO_ZOOM });
    if (addingRef.current) return;
    addingRef.current = true;
    setAdding(true);
    void commitWaypoint(item.label.split(",")[0].trim() || item.label, item.lat, item.lng);
  };

  const onMarkerMove = (markerId: string, lat: number, lng: number) => {
    if (!markerId.startsWith("wp:")) return;
    lastMoveAtRef.current = Date.now();
    const id = markerId.slice(3);
    const prevRegions = regions;
    if (!prevRegions.some((r) => r.id === id)) return;
    setRegions((rs) => rs.map((r) => (r.id === id ? { ...r, lat, lng } : r)));
    void (async () => {
      try {
        await call("note_region_move", { id, lat, lng });
        useNotesStore.getState().bumpAttachmentRevision();
      } catch (e) {
        setRegions(prevRegions);
        emitNotice(e instanceof Error ? e.message : String(e));
      }
    })();
  };

  return (
    <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
      {defaultLocation ? (
        <WorldMapAuto
          markers={markers}
          pathLines={pathLines}
          defaultLocation={defaultLocation}
          homeLocation={defaultMapLocation}
          onMapClick={(lat, lng) => void addAtPoint(lat, lng)}
          onMarkerMove={onMarkerMove}
          uiLang={uiLang}
          frameless
        />
      ) : (
        <div style={centeredHintStyle}>{t("region.map_click_hint")}</div>
      )}

      {/* 인라인 검색 — 모달(RegionPickerDialog) 대신 이 창 안에서 바로 추가. 최근/자주 이력은
          MapPlaceSearch 안에 들어 있어 대시보드 지도와 자동으로 공유된다.
          좌상단 배치 — 우상단은 WorldMap 내장 잠금/홈 버튼이 쓴다(세 지도 공통 규약). */}
      <div style={{ position: "absolute", top: "var(--space-4)", left: "var(--space-4)", zIndex: 2, maxWidth: "min(220px, calc(100% - var(--space-7)))" }}>
        <MapPlaceSearch compact onPick={(item) => addFromSearch(item)} />
      </div>

      <div
        className="overlay"
        data-testid="region-overlay-panel"
        style={{
          position: "absolute",
          left: "var(--space-4)",
          bottom: 16, // 저작자표시 텍스트 스트립(맨 아래 ~14px)과 안 겹치게.
          maxWidth: "min(280px, calc(100% - var(--space-7)))",
          maxHeight: "58%",
          display: "flex",
          flexDirection: "column",
          borderRadius: "var(--radius-md)",
          border: "1px solid var(--divider)",
          boxShadow: "var(--shadow-lg)",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <button
            type="button"
            data-testid="region-overlay-toggle"
            onClick={() => setListOpen((v) => !v)}
            aria-expanded={listOpen}
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              padding: "var(--space-2) var(--space-3)",
              border: "none",
              background: "transparent",
              color: "var(--muted)",
              font: "inherit",
              fontSize: "var(--text-xs)",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {/* Was rotate(90)=left when open vs rotate(0)=down closed — the opposite of every other
                fold/unfold site in the codebase (closed=right, open=down). Corrected to match. */}
            <IconCaret
              dir={listOpen ? "down" : "right"}
              size={12}
              style={{ transition: "transform var(--dur-fast)" }}
            />
            <span>{t("region.places_n", { n: 1 + waypoints.length })}</span>
          </button>
        </div>
        {listOpen && (
          <div className="scroll" style={{ overflow: "auto", padding: "0 var(--space-3) var(--space-3)" }}>
            <NoteRegionsList noteId={noteId} primary={primary} refreshKey={attachmentRevision} inline />
          </div>
        )}
      </div>

      {adding && (
        <div
          className="overlay"
          style={{
            position: "absolute",
            bottom: 16, // 좌상단은 이제 검색창 차지 — 장소 추가 중 표시는 우하단(저작자표시 위)으로.
            right: "var(--space-4)",
            padding: "var(--space-1) var(--space-3)",
            borderRadius: "var(--radius-sm)",
            fontSize: "var(--text-xs)",
            color: "var(--muted)",
          }}
        >
          {t("region.adding")}
        </div>
      )}
    </div>
  );
}
