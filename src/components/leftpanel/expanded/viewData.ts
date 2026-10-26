/**
 * Pure grouping helpers for the expanded "크게 보기" views.
 * Server windows (note_query) feed these; they do not scan a resident corpus.
 */
import type { NoteSummary } from "../../../lib/commands.gen";

export interface GroupSection {
  id: string;
  label: string;
  /** CSS color for the header accent — already resolved by the caller. */
  color?: string;
  notes: NoteSummary[];
}

/** Client: located iff both lat and lng are finite numbers. */
export function noteHasCoords(n: NoteSummary): boolean {
  return (
    n.lat !== null &&
    n.lng !== null &&
    !Number.isNaN(n.lat) &&
    !Number.isNaN(n.lng)
  );
}

export function noteInBbox(
  n: NoteSummary,
  minLat: number,
  maxLat: number,
  minLng: number,
  maxLng: number
): boolean {
  if (!noteHasCoords(n)) return false;
  const lat = n.lat!;
  const lng = n.lng!;
  if (lat < minLat || lat > maxLat) return false;
  if (minLng <= maxLng) return lng >= minLng && lng <= maxLng;
  return lng >= minLng || lng <= maxLng;
}

export function splitLocated(notes: NoteSummary[]): {
  located: NoteSummary[];
  unlocated: NoteSummary[];
} {
  const located: NoteSummary[] = [];
  const unlocated: NoteSummary[] = [];
  for (const n of notes) {
    if (noteHasCoords(n)) located.push(n);
    else unlocated.push(n);
  }
  return { located, unlocated };
}

/** Nearby notes by squared equirectangular distance (same as RegionExpanded). */
export function sortNearby(
  located: NoteSummary[],
  lat: number,
  lng: number
): NoteSummary[] {
  const cosLat = Math.cos((lat * Math.PI) / 180) || 1;
  return located
    .map((n) => {
      const dLat = (n.lat ?? 0) - lat;
      const dLng = ((n.lng ?? 0) - lng) * cosLat;
      return { n, d: dLat * dLat + dLng * dLng };
    })
    .sort((a, b) => a.d - b.d)
    .map((x) => x.n);
}

/** Group located notes by exact coordinate key (overlapping pins). */
export function groupByCoordinate(
  located: NoteSummary[]
): Map<string, NoteSummary[]> {
  const map = new Map<string, NoteSummary[]>();
  for (const n of located) {
    const key = `${n.lat},${n.lng}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(n);
  }
  return map;
}
