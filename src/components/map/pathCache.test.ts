import { describe, it, expect, beforeEach } from "vitest";
import { geoMercator, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import countries110mJson from "world-atlas/countries-110m.json";
import countries10mJson from "world-atlas/countries-10m.json";
import { getCachedPath, clearMapPathCache, featureKey, admin1FeatureKey } from "./pathCache";

const square = {
  type: "Feature",
  properties: {},
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-10, -10],
        [10, -10],
        [10, 10],
        [-10, 10],
        [-10, -10],
      ],
    ],
  },
};

function makePathGen(w: number, h: number) {
  const projection = geoMercator()
    .scale(w / (2 * Math.PI))
    .translate([w / 2, h / 2]);
  return geoPath().projection(projection);
}

describe("map path cache", () => {
  beforeEach(() => {
    clearMapPathCache();
  });

  it("returns a different path string when view size (projection) changes", () => {
    const g1 = makePathGen(600, 400);
    const d1 = getCachedPath("feat-0", g1 as never, square);
    expect(d1).toBeTruthy();

    // Same key, new generator at a different view size — must not reuse the old path.
    const g2 = makePathGen(1200, 800);
    const d2 = getCachedPath("feat-0", g2 as never, square);
    expect(d2).toBeTruthy();
    expect(d2).not.toBe(d1);
  });

  it("hits cache at constant view size (same generator identity)", () => {
    const g = makePathGen(600, 400);
    const d1 = getCachedPath("feat-0", g as never, square);
    const d2 = getCachedPath("feat-0", g as never, square);
    expect(d2).toBe(d1);
  });

  it("Région-tab cost: constant-size re-walk is cache-hit cheap vs cold fill", () => {
    // Approximates MapPaths re-render when switching filter tabs at a fixed window size.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const feats = ((feature as any)(
      countries110mJson,
      (countries110mJson as any).objects.countries
    ) as any).features as unknown[];
    expect(feats.length).toBeGreaterThan(100);

    const gen = makePathGen(900, 600);

    const tCold0 = performance.now();
    for (let i = 0; i < feats.length; i++) {
      getCachedPath(`feat-${(feats[i] as { id?: string | number }).id ?? i}`, gen as never, feats[i]);
    }
    const coldMs = performance.now() - tCold0;

    const tWarm0 = performance.now();
    for (let i = 0; i < feats.length; i++) {
      getCachedPath(`feat-${(feats[i] as { id?: string | number }).id ?? i}`, gen as never, feats[i]);
    }
    const warmMs = performance.now() - tWarm0;

    // Warm walk must be dramatically cheaper; loose bound so CI noise does not flake.
    expect(warmMs).toBeLessThan(coldMs * 0.25);
    expect(warmMs).toBeLessThan(50);

    // Surface numbers for the ship report (vitest captures console).
    // eslint-disable-next-line no-console
    console.log(
      `[pathCache] constant-size 110m features: cold=${coldMs.toFixed(1)}ms warm=${warmMs.toFixed(1)}ms (n=${feats.length})`
    );
  });
});

// Duplicate feature-id fix (flagged by the LOD work): world-atlas's real 10m countries topology
// carries at least one duplicate `id` — plain `feat.id || i` React/cache keys let the second
// feature silently draw the first one's cached geometry. featureKey composes in the array index
// (unique per dataset load — the source arrays are static) and the tier (so a 50m→10m load, which
// does NOT clear pathStringCache since pathGenerator's identity is unchanged, can't collide with
// stale geometry from the previous tier either).
describe("featureKey — duplicate country-id collision fix", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const feats10m = ((feature as any)(
    countries10mJson,
    (countries10mJson as any).objects.countries
  ) as any).features as Array<{ id?: string | number }>;

  it("dataset still carries the real duplicate id this fix targets (pins the hazard)", () => {
    // If a future world-atlas bump removes this, this assertion fails loudly instead of the
    // regression test below silently losing its reason to exist.
    const ids = feats10m.map((f) => f.id);
    expect(ids.filter((id) => id === "036").length).toBe(2);
  });

  it("the old `feat.id || i` scheme collides on the 10m tier; featureKey does not", () => {
    const oldKeys = feats10m.map((f, i) => `feat-${f.id || i}`);
    expect(new Set(oldKeys).size).toBeLessThan(oldKeys.length);

    const newKeys = feats10m.map((f, i) => featureKey("10m", f, i));
    expect(new Set(newKeys).size).toBe(newKeys.length);
  });

  it("keeps 50m/10m tiers separate for the same feature+index (no cross-tier collision)", () => {
    const feat = feats10m[0];
    expect(featureKey("10m", feat, 0)).not.toBe(featureKey("50m", feat, 0));
  });

  it("falls back to 'x' for a feature with no id, still unique via the index", () => {
    expect(featureKey("10m", { id: undefined }, 3)).toBe("10m-x-3");
    expect(featureKey("10m", null, 4)).toBe("10m-x-4");
  });
});

describe("admin1FeatureKey — stable across viewport-culled subsets", () => {
  it("uses name + baked bbox (admin1 has no topology id); ignores array index", () => {
    const f = {
      properties: {
        name: "Seoul",
        b: [
          [126.7, 37.4],
          [127.2, 37.7],
        ] as [[number, number], [number, number]],
      },
    };
    expect(admin1FeatureKey(f)).toBe("admin1:Seoul:126.7:37.4:127.2:37.7");
    // Same feature at a different cull index must still be the same key (no remount churn).
    expect(admin1FeatureKey(f)).toBe(admin1FeatureKey({ ...f }));
  });

  it("falls back to name alone when bbox is missing", () => {
    expect(admin1FeatureKey({ properties: { name: "X" } })).toBe("admin1:X");
    expect(admin1FeatureKey(null)).toBe("admin1:");
  });
});
