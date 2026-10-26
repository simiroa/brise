/**
 * 지오코딩 결과 라벨(Nominatim display_name: "12, Main Street, Seoul, 04340, South Korea")을
 * 이름 + 부가 주소로 가르고, 같은 장소 중복을 판정하는 순수 함수 모음.
 *
 * NoteRegionsList(지역 팝오버)와 RegionEntryPopover(슬래시 /지역)가 똑같이 `label.split(",")[0]`
 * 을 복제해 쓰고 있었고, 번지수로 시작하는 주소("12, Main Street, Seoul")가 "12" 라는 이름이 되는
 * 버그가 양쪽에 있었다 — 한 곳에서 고친다.
 */

export interface SplitPlaceLabel {
  /** 장소 이름으로 저장·표시할 조각. 라벨이 비었으면 "". */
  name: string;
  /** 이름을 뺀 나머지 주소(이름 뒤 조각들, 쉼표로 이은 것). 없으면 "". */
  detail: string;
}

/** 번지수/우편번호처럼 "이름"이 될 수 없는 조각: 숫자·공백·하이픈·슬래시만(+선택적 영문 한 글자),
 *  또는 한국식 "12번지"/"3층"/"101호" 꼴. */
const NUMBER_ONLY = /^[\d\s\-–/.]+[A-Za-z]?$/;
const KOREAN_NUMBERED = /^\d+[\d\s\-–/]*(번지|번|호|층|동|가)?$/;

export function isNumberLikePiece(piece: string): boolean {
  const p = piece.trim();
  if (!p) return true;
  return NUMBER_ONLY.test(p) || KOREAN_NUMBERED.test(p);
}

export function splitPlaceLabel(label: string | null | undefined): SplitPlaceLabel {
  const pieces = (label ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (pieces.length === 0) return { name: "", detail: "" };
  const idx = pieces.findIndex((p) => !isNumberLikePiece(p));
  if (idx < 0) {
    // 전부 숫자 조각 — 쪼개면 의미가 사라지니 라벨 전체를 이름으로 둔다.
    return { name: pieces.join(", "), detail: "" };
  }
  return { name: pieces[idx], detail: pieces.slice(idx + 1).join(", ") };
}

/** 같은 장소로 보는 반경(미터). 약 50m — 같은 건물/같은 지점을 두 번 누른 것을 걸러내되, 같은
 *  동네의 다른 가게는 막지 않는다. */
export const DUPLICATE_PLACE_RADIUS_M = 50;

const EARTH_RADIUS_M = 6_371_000;

/** 두 좌표 사이 거리(미터, haversine). */
export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** `existing` 중 (lat,lng) 와 DUPLICATE_PLACE_RADIUS_M 이내인 첫 장소. 좌표가 없는 항목은 건너뛴다. */
export function findDuplicatePlace<T extends { lat: number | null; lng: number | null }>(
  lat: number,
  lng: number,
  existing: readonly T[],
  radiusM: number = DUPLICATE_PLACE_RADIUS_M,
): T | null {
  for (const e of existing) {
    if (e.lat == null || e.lng == null) continue;
    if (distanceMeters({ lat, lng }, { lat: e.lat, lng: e.lng }) <= radiusM) return e;
  }
  return null;
}
