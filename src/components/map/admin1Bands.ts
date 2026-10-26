/**
 * Admin-1 (states/provinces) LOD is pre-split into 6 longitude bands so zoom-12 entry only
 * lazy-imports pieces that intersect the viewport — not the full ~3.5MB world file.
 * Each piece keeps the same topojson shape + per-feature `b` / `ko` / `name` fields.
 */
import type { LngLatBounds } from "./lod";

export interface Admin1Band {
  id: string;
  /** Inclusive west, exclusive east (except the last band which is inclusive east). */
  west: number;
  east: number;
  /** Vite dynamic import — same lazy-import pattern as WorldMap's 50m/10m country tiers. */
  load: () => Promise<{ default?: unknown } | unknown>;
}

export const ADMIN1_BANDS: readonly Admin1Band[] = [
  {
    id: "b0",
    west: -180,
    east: -120,
    load: () => import("../../assets/admin1-10m-b0.json"),
  },
  {
    id: "b1",
    west: -120,
    east: -60,
    load: () => import("../../assets/admin1-10m-b1.json"),
  },
  {
    id: "b2",
    west: -60,
    east: 0,
    load: () => import("../../assets/admin1-10m-b2.json"),
  },
  {
    id: "b3",
    west: 0,
    east: 60,
    load: () => import("../../assets/admin1-10m-b3.json"),
  },
  {
    id: "b4",
    west: 60,
    east: 120,
    load: () => import("../../assets/admin1-10m-b4.json"),
  },
  {
    id: "b5",
    west: 120,
    east: 180,
    load: () => import("../../assets/admin1-10m-b5.json"),
  },
] as const;

/** Bands whose longitude range overlaps the viewport (same axis rules as cullByBbox). */
export function admin1BandsForViewport(bounds: LngLatBounds): Admin1Band[] {
  const west = Math.min(bounds.tl.lng, bounds.br.lng);
  const east = Math.max(bounds.tl.lng, bounds.br.lng);
  return ADMIN1_BANDS.filter((band) => band.west < east && band.east > west);
}
