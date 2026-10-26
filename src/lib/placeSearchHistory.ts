/**
 * Device-local history for the home map's place search (MapPlaceSearch.tsx) — recent picks +
 * frequent picks. localStorage, not the synced settings kv: this is search history, not a
 * workspace-wide setting (same rationale as mobile/mobilePrefs.ts's per-device prefs).
 */
export interface PlaceSearchEntry {
  label: string;
  lat: number;
  lng: number;
  count: number;
  lastUsedAt: number;
}

const KEY = "brise.placeSearchHistory.v1";
const MAX_ENTRIES = 30;
const MAX_SECTION = 5;

function isEntry(v: unknown): v is PlaceSearchEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.label === "string" &&
    typeof e.lat === "number" &&
    typeof e.lng === "number" &&
    typeof e.count === "number" &&
    typeof e.lastUsedAt === "number"
  );
}

export function readPlaceSearchHistory(): PlaceSearchEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry);
  } catch {
    // ponytail: corrupt JSON just means "no history" — not worth a repair path.
    return [];
  }
}

function sameSpot(a: { lat: number; lng: number }, b: { lat: number; lng: number }): boolean {
  return Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lng - b.lng) < 1e-6;
}

/** Record a pick, bumping count/lastUsedAt if the spot already exists. */
export function recordPlaceSearchPick(pick: { label: string; lat: number; lng: number }): void {
  const list = readPlaceSearchHistory();
  const existing = list.find((e) => sameSpot(e, pick));
  const now = Date.now();
  let next: PlaceSearchEntry[];
  if (existing) {
    existing.count += 1;
    existing.lastUsedAt = now;
    existing.label = pick.label;
    next = list;
  } else {
    next = [...list, { ...pick, count: 1, lastUsedAt: now }];
  }
  next.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  if (next.length > MAX_ENTRIES) next = next.slice(0, MAX_ENTRIES);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // ponytail: quota/private-mode write failure — history is a nice-to-have, drop silently.
  }
}

export function clearPlaceSearchHistory(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

/** Recent picks (most recent first, max 5) and frequent picks (highest count first, max 5) —
 *  frequent wins any overlap, recent excludes anything already in frequent. */
export function derivePlaceSearchSections(list: PlaceSearchEntry[]): {
  frequent: PlaceSearchEntry[];
  recent: PlaceSearchEntry[];
} {
  const frequent = [...list]
    .sort((a, b) => b.count - a.count || b.lastUsedAt - a.lastUsedAt)
    .slice(0, MAX_SECTION);
  const frequentKeys = new Set(frequent.map((e) => `${e.lat},${e.lng}`));
  const recent = [...list]
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .filter((e) => !frequentKeys.has(`${e.lat},${e.lng}`))
    .slice(0, MAX_SECTION);
  return { frequent, recent };
}
