/**
 * D4 multi-region display helpers.
 *
 * Primary = notes.region + notes.lat/lng.
 * Waypoints = note_regions rows ordered by position.
 * When a waypoint points at the same place as the primary, UI must not duplicate it.
 */

// 타입만 가져온다 — map/ 이 이 파일을 되가져오는 순환이 생기면 안 된다(런타임 import 금지).
import type { MapMarker, MapPathLine } from "../map/MarkerLayer";

export type PrimaryRegion = {
  region: string | null;
  lat: number | null;
  lng: number | null;
};

export type WaypointRegion = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  position: number;
};

/** ~11m at equator — enough to treat geocoder jitter as "same place". */
const COORD_EPS = 1e-4;

export function sameCoords(
  aLat: number | null | undefined,
  aLng: number | null | undefined,
  bLat: number | null | undefined,
  bLng: number | null | undefined,
  eps = COORD_EPS,
): boolean {
  if (aLat == null || aLng == null || bLat == null || bLng == null) return false;
  return Math.abs(aLat - bLat) <= eps && Math.abs(aLng - bLng) <= eps;
}

export function sameRegionName(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** 다음 경유지가 들어갈 position. 두 곳(목록의 + 장소 추가, 지도 클릭 추가)이 같은 규칙을
 *  써야 순서가 어긋나지 않는다. 빈 목록은 0, 그 외에는 현재 최댓값 + 1 — 중간이 비어 있어도
 *  (삭제 후) 뒤에 붙는다. */
export function nextWaypointPosition(regions: { position: number }[]): number {
  return regions.length === 0 ? 0 : Math.max(...regions.map((r) => r.position)) + 1;
}

/** 지도에서 찍은 지점의 표시 이름. 역지오코딩이 라벨을 주면 그걸 쓰고, 실패하거나 바다 한가운데
 *  처럼 이름이 없는 곳이면 좌표를 이름으로 남긴다 — 이름 없이 저장하면 목록에서 빈 줄이 되고,
 *  저장을 거부하면 사용자가 찍은 지점이 조용히 사라진다(둘 다 더 나쁘다). */
export function clickedPlaceName(label: string | null | undefined, lat: number, lng: number): string {
  const trimmed = label?.trim();
  if (trimmed) return trimmed;
  return `${lat.toFixed(3)}, ${lng.toFixed(3)}`;
}

/** True when a waypoint is the same place as the primary (name and/or coords). */
export function waypointDuplicatesPrimary(primary: PrimaryRegion, wp: WaypointRegion): boolean {
  const nameHit = sameRegionName(primary.region, wp.name);
  const coordHit = sameCoords(primary.lat, primary.lng, wp.lat, wp.lng);
  // Either strong signal is enough — geocoder labels can differ slightly while coords match,
  // and coords can be missing on primary while the name is set.
  return nameHit || coordHit;
}

/**
 * Waypoints with primary duplicates stripped, stable position order preserved.
 * Primary itself is never returned here — callers render it separately.
 */
export function dedupeWaypoints(
  primary: PrimaryRegion,
  waypoints: WaypointRegion[],
): WaypointRegion[] {
  return waypoints.filter((wp) => !waypointDuplicatesPrimary(primary, wp));
}

export type PathPoint = { lat: number; lng: number; kind: "primary" | "waypoint"; id: string };

/**
 * Ordered path for the map polyline: primary (if coords) then deduped waypoints by position.
 * Path numbers in UI are 1-based over this list (primary = 1 when present).
 */
export function buildRegionPath(
  primary: PrimaryRegion,
  primaryNoteId: string,
  waypoints: WaypointRegion[],
): PathPoint[] {
  const out: PathPoint[] = [];
  if (primary.lat != null && primary.lng != null) {
    out.push({ lat: primary.lat, lng: primary.lng, kind: "primary", id: primaryNoteId });
  }
  for (const wp of dedupeWaypoints(primary, waypoints)) {
    out.push({ lat: wp.lat, lng: wp.lng, kind: "waypoint", id: wp.id });
  }
  return out;
}

/** 1-based path index for a waypoint (primary occupies slot 1 when it has coords or a name). */
export function waypointPathNumber(
  primary: PrimaryRegion,
  waypoints: WaypointRegion[],
  waypointId: string,
): number {
  const hasPrimary = Boolean(primary.region) || (primary.lat != null && primary.lng != null);
  const base = hasPrimary ? 1 : 0;
  const deduped = dedupeWaypoints(primary, waypoints);
  const idx = deduped.findIndex((w) => w.id === waypointId);
  if (idx < 0) return base + 1;
  return base + idx + 1;
}

// ── 지도 조립(핀·경로선) ──────────────────────────────────────────────────────────
// "활성 노트의 대표 핀 + 경유지 핀 + 경로선"을 지도 네 곳(RegionExpanded 사이드바 지도 ·
// HomeMapPane 대시보드 지도 · RegionPreview 미리보기 · NoteRegionsList 팝오버 지도)이 각자
// buildRegionPath 결과로 인라인 조립하고 있었다. 여기 한 곳이 모양(id 규칙 `wp:<id>`, 핀 크기,
// 활성 여부)을 정하고, 호출부는 색·드래그 가능 여부처럼 정말 다른 것만 옵션으로 넘긴다.

/** DB 행(NoteRegion)을 표시용 WaypointRegion 으로. 표시 로직이 아는 5필드만 복사한다(note_id 는 버림). */
export function toWaypointRegions(rows: readonly WaypointRegion[]): WaypointRegion[] {
  return rows.map((r) => ({ id: r.id, name: r.name, lat: r.lat, lng: r.lng, position: r.position }));
}

/** 경유지 핀에만 적용되는 옵션 — 대표 핀은 항상 큰 활성 보기 전용 핀이다. */
export type RegionPinOpts = {
  /** 끌어 옮길 수 있는 경유지 핀(RegionPreview). 기본 false = 보기 전용(경로 정거장). */
  interactive?: boolean;
  /** 경유지 핀 채움색(HomeMapPane 의 var(--info)). 생략하면 사이드바 지도의 속 빈 링. */
  color?: string;
};

/**
 * 경로 점 → 지도 핀. 대표점은 큰 활성 핀(id = 노트 id), 경유지는 작은 비활성 핀(id = `wp:<id>`).
 * `primaryRegion` 은 대표 핀의 이름 라벨용 — 통째 primary 가 아니라 이름만 받아, 호출부 useMemo 가
 * 대표 좌표가 아니라 이름에만 의존하게 둔다(NoteRegionsList 의 원시 필드 deps 규약).
 */
export function buildRegionMarkers(
  path: PathPoint[],
  primaryRegion: string | null,
  waypoints: WaypointRegion[],
  opts: RegionPinOpts = {},
): MapMarker[] {
  return path.map(
    (p): MapMarker =>
      p.kind === "primary"
        ? {
            id: p.id,
            lat: p.lat,
            lng: p.lng,
            active: true,
            region: primaryRegion,
            pinSize: "primary",
            interactive: false,
          }
        : {
            id: `wp:${p.id}`,
            lat: p.lat,
            lng: p.lng,
            active: false,
            region: waypoints.find((w) => w.id === p.id)?.name ?? null,
            pinSize: "waypoint",
            interactive: opts.interactive ?? false,
            ...(opts.color !== undefined ? { color: opts.color } : {}),
          },
  );
}

/**
 * 경유지 핀만(중복 제거된 것) — 대표 핀을 각자 다른 규칙으로 만드는 지도(RegionExpanded 는 노트 핀
 * 목록에서, HomeMapPane 은 선택 노트에서)가 뒤에 덧붙인다.
 */
export function buildWaypointPins(
  primary: PrimaryRegion,
  primaryNoteId: string,
  waypoints: WaypointRegion[],
  opts?: RegionPinOpts,
): MapMarker[] {
  const path = buildRegionPath(primary, primaryNoteId, waypoints).filter((p) => p.kind === "waypoint");
  return buildRegionMarkers(path, primary.region, waypoints, opts);
}

/** 경로선 — 점이 둘 이상일 때만 한 줄(id = 노트 id). 하나 이하면 선이 없다. */
export function buildPathLines(path: PathPoint[], noteId: string): MapPathLine[] {
  return path.length >= 2 ? [{ id: noteId, points: path.map((p) => ({ lat: p.lat, lng: p.lng })) }] : [];
}
