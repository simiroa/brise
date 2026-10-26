// Path strings keyed by feature/dataset id. Invalidated whenever the
// pathGenerator identity changes (it is rebuilt when viewSize → projection changes) — NOT when
// the underlying feature dataset changes (e.g. 50m → 10m tier load at a fixed viewSize), so keys
// must stay collision-proof across that transition too, not just within one dataset.
const pathStringCache = new Map<string, string>();

/** Collision-proof key for a country/tier feature — both the React `key` (WorldMap.tsx's
 *  MapPaths) and this module's cache key (getCachedPath below) use it. `feat.id` alone is not
 *  unique: world-atlas's 10m/50m countries topology carries at least one real duplicate id (e.g.
 *  '036' appears twice — two disjoint polygons sharing an ISO code) plus several features with no
 *  id at all. Composing in the array index `i` makes the key unique within one dataset load (the
 *  source arrays are static per load, so index stays stable); composing in `tier` additionally
 *  prevents a stale-geometry collision across a 50m→10m tier swap, since pathGenerator's identity
 *  (the cache's own invalidation signal) doesn't change just because the tier did. */
export function featureKey(tier: string, feat: { id?: string | number } | null | undefined, i: number): string {
  return `${tier}-${feat?.id ?? "x"}-${i}`;
}

/**
 * Stable React/path-cache key for an admin-1 province. Admin-1 features have no topology id
 * (only name + baked bbox `b`), and the visible subset is viewport-culled — so an array index
 * remounts every pan. Compose name + bbox corners instead.
 */
export function admin1FeatureKey(feat: {
  properties?: {
    name?: string | null;
    b?: [[number, number], [number, number]];
  } | null;
} | null | undefined): string {
  const name = feat?.properties?.name ?? "";
  const b = feat?.properties?.b;
  if (b) {
    return `admin1:${name}:${b[0][0]}:${b[0][1]}:${b[1][0]}:${b[1][1]}`;
  }
  return `admin1:${name}`;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cacheGenerator: ((feat: any) => string | null) | null = null;

export function getCachedPath(
  key: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  generator: (feat: any) => string | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  feat: any
): string | null {
  if (generator !== cacheGenerator) {
    pathStringCache.clear();
    cacheGenerator = generator;
  }
  if (pathStringCache.has(key)) {
    return pathStringCache.get(key)!;
  }
  const d = generator(feat);
  if (d) {
    pathStringCache.set(key, d);
  }
  return d;
}

export function clearMapPathCache() {
  pathStringCache.clear();
  cacheGenerator = null;
}
