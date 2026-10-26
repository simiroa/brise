import { describe, it, expect } from "vitest";
import admin1B0 from "../../assets/admin1-10m-b0.json";
import admin1B1 from "../../assets/admin1-10m-b1.json";
import admin1B2 from "../../assets/admin1-10m-b2.json";
import admin1B3 from "../../assets/admin1-10m-b3.json";
import admin1B4 from "../../assets/admin1-10m-b4.json";
import admin1B5 from "../../assets/admin1-10m-b5.json";
import citiesJson from "../../assets/cities-10m.json";
import {
  viewportBounds,
  cullByBbox,
  cullPoints,
  topByRank,
  estimateLabelWidth,
  placeLabels,
  compareLabelPriority,
  tierOpacities,
  zoomRamp,
  type MapLabelCandidate,
} from "./lod";
import { admin1BandsForViewport, ADMIN1_BANDS } from "./admin1Bands";
import { admin1FeatureKey } from "./pathCache";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin1Geom = { properties: { b: [[number, number], [number, number]]; name: string; ko?: string } };

// Union of all longitude-band pieces (deduped by name+bbox — spanning features land in 2+ bands).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const allBandTopos: any[] = [admin1B0, admin1B1, admin1B2, admin1B3, admin1B4, admin1B5];
const admin1Geometries: Admin1Geom[] = (() => {
  const seen = new Set<string>();
  const out: Admin1Geom[] = [];
  for (const topo of allBandTopos) {
    for (const g of topo.objects.admin1.geometries as Admin1Geom[]) {
      const key = admin1FeatureKey({ properties: g.properties });
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(g);
    }
  }
  return out;
})();
const TOTAL_ADMIN1 = admin1Geometries.length;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cityFeatures = (citiesJson as any).features as Array<{
  properties: { name: string; rank: number };
  geometry: { coordinates: [number, number] };
}>;

describe("admin1 viewport culling (real bbox data, flagged LOD gap)", () => {
  it("matches the full dataset shape (sanity on the fixture itself)", () => {
    expect(TOTAL_ADMIN1).toBe(4596);
  });

  it("keeps only the provinces overlapping a small fixed viewport — far below the 4596 total", () => {
    // Zoomed into South Korea at a moderate provincial-detail zoom.
    const bounds = viewportBounds(800, 600, { k: 15, x: -1400, y: -650 });
    expect(bounds).not.toBeNull();

    const entries = admin1Geometries.map((g) => ({ b: g.properties.b, name: g.properties.name }));
    const visible = cullByBbox(entries, bounds!);

    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThan(200); // one country's worth, not the world
    expect(visible.length).toBeLessThan(TOTAL_ADMIN1 * 0.05);
  });

  it("returns nothing for a viewport bounds far from every feature", () => {
    const entries = admin1Geometries.map((g) => ({ b: g.properties.b, name: g.properties.name }));
    // Mid-Pacific, no admin-1 land at all.
    const bounds = { tl: { lat: 1, lng: -160 }, br: { lat: -1, lng: -158 } };
    expect(cullByBbox(entries, bounds)).toEqual([]);
  });
});

describe("admin1 longitude-band piece load (split of former admin1-10m.json)", () => {
  it("selects only bands that intersect the viewport, and each piece keeps b/ko fields", () => {
    // Seoul-ish window — should hit band b4 [60,120) only (Korea ~127°E is b5 actually).
    // Korea lng ~126–129 → band b5 [120,180).
    const seoulBounds = { tl: { lat: 38.5, lng: 126 }, br: { lat: 37, lng: 128 } };
    const bands = admin1BandsForViewport(seoulBounds);
    expect(bands.map((b) => b.id)).toEqual(["b5"]);
    expect(bands.length).toBeLessThan(ADMIN1_BANDS.length);

    // Western Europe window → b2 + maybe b3 edge.
    const europeBands = admin1BandsForViewport({
      tl: { lat: 55, lng: -5 },
      br: { lat: 45, lng: 10 },
    });
    expect(europeBands.some((b) => b.id === "b2")).toBe(true);
    expect(europeBands.some((b) => b.id === "b3")).toBe(true);

    // Piece shape: topojson with admin1 geometries carrying baked b + ko (same as pre-split).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sample = (admin1B5 as any).objects.admin1.geometries[0];
    expect(sample.properties.b).toBeDefined();
    expect(Array.isArray(sample.properties.b)).toBe(true);
    expect(sample.properties.name).toBeTruthy();
    // At least some features in the East Asia band carry a Korean label.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withKo = (admin1B5 as any).objects.admin1.geometries.some(
      (g: { properties?: { ko?: string } }) => g.properties?.ko,
    );
    expect(withKo).toBe(true);

    // No single piece is the whole world — the point of the split.
    for (const topo of allBandTopos) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((topo as any).objects.admin1.geometries.length).toBeLessThan(TOTAL_ADMIN1);
    }
  });
});

describe("cities viewport culling + label rank cap (real dataset, flagged LOD gap)", () => {
  it("dataset stays within the size/count budget the task specified", () => {
    expect(cityFeatures.length).toBeGreaterThan(1500);
    expect(cityFeatures.length).toBeLessThan(2500);
  });

  it("culls to a small regional subset, far below the full ~2200-city dataset", () => {
    const points = cityFeatures.map((f, i) => ({
      id: i,
      lng: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      rank: f.properties.rank,
    }));
    // A moderately dense window over Western Europe.
    const bounds = { tl: { lat: 52, lng: 0 }, br: { lat: 45, lng: 12 } };
    const visible = cullPoints(points, bounds);

    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThan(cityFeatures.length * 0.3);
  });

  it("caps labels to the best-rank N and leaves smaller sets untouched", () => {
    const points = cityFeatures.map((f, i) => ({
      id: i,
      lng: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      rank: f.properties.rank,
    }));
    // Central/eastern China — dense enough that the cap actually has to trim something.
    const bounds = { tl: { lat: 35.633685, lng: 109.375 }, br: { lat: 28.216428, lng: 120.625 } };
    const visible = cullPoints(points, bounds);
    expect(visible.length).toBeGreaterThan(40); // cap must actually bind for this to be a real test

    const capped = topByRank(visible, 40);
    expect(capped.length).toBe(40);
    // Every kept point must be at least as prominent (lower or equal rank) as every dropped one.
    const keptIds = new Set(capped.map((p) => p.id));
    const worstKeptRank = Math.max(...capped.map((p) => p.rank));
    const droppedRanks = visible.filter((p) => !keptIds.has(p.id)).map((p) => p.rank);
    expect(droppedRanks.every((r) => r >= worstKeptRank)).toBe(true);

    const small = capped.slice(0, 5);
    expect(topByRank(small, 40)).toEqual(small);
  });
});

describe("estimateLabelWidth", () => {
  it("treats CJK as ~1em and Latin as ~0.55em", () => {
    expect(estimateLabelWidth("서울", 10)).toBeCloseTo(20, 5);
    expect(estimateLabelWidth("AB", 10)).toBeCloseTo(11, 5);
    expect(estimateLabelWidth("서울A", 10)).toBeCloseTo(25.5, 5);
  });
});

describe("placeLabels (cross-layer greedy collision)", () => {
  const k = 50;
  // Projection-space sizes matching WorldMap (screenPx / k).
  const cityFs = 7.5 / k;
  const capFs = 9 / k;
  const provFs = 10 / k;
  /* type-scale-exempt: 지도 프로젝션 공간 좌표계 라벨 충돌 계산 옵션 — CSS padding 아님 */
  const opts = { padding: 2 / k, samePlaceRadius: 12 / k };

  it("drops lower-priority labels that overlap higher-priority ones", () => {
    // Same anchor: capital "서울", province "서울특별시", city "서울" — capital wins.
    const candidates: MapLabelCandidate[] = [
      {
        id: "city:1",
        text: "서울",
        x: 100,
        y: 200 + 5 / k,
        fontSize: cityFs,
        layer: "city",
        rank: 0,
        baseline: "hanging",
      },
      {
        id: "prov:seoul",
        text: "서울특별시",
        x: 100,
        y: 200,
        fontSize: provFs,
        layer: "province",
        baseline: "central",
      },
      {
        id: "cap:0",
        text: "서울",
        x: 100,
        y: 200 + 6 / k,
        fontSize: capFs,
        layer: "capital",
        baseline: "hanging",
      },
    ];

    const kept = placeLabels(candidates, opts);
    expect(kept.has("cap:0")).toBe(true);
    expect(kept.has("city:1")).toBe(false);
    expect(kept.has("prov:seoul")).toBe(false);
  });

  it("keeps non-overlapping labels from different layers", () => {
    const candidates: MapLabelCandidate[] = [
      {
        id: "cap:0",
        text: "서울",
        x: 0,
        y: 0,
        fontSize: capFs,
        layer: "capital",
        baseline: "hanging",
      },
      {
        id: "prov:gg",
        text: "경기도",
        x: 5, // far in projection space at k=50 (~250 screen px)
        y: 5,
        fontSize: provFs,
        layer: "province",
        baseline: "central",
      },
      {
        id: "city:2",
        text: "부산",
        x: -5,
        y: 5,
        fontSize: cityFs,
        layer: "city",
        rank: 1,
        baseline: "hanging",
      },
    ];

    const kept = placeLabels(candidates, opts);
    expect(kept.has("cap:0")).toBe(true);
    expect(kept.has("prov:gg")).toBe(true);
    expect(kept.has("city:2")).toBe(true);
    expect(kept.size).toBe(3);
  });

  it("is deterministic for the same input (order-independent)", () => {
    const a: MapLabelCandidate[] = [
      {
        id: "city:b",
        text: "Busan",
        x: 1,
        y: 1,
        fontSize: cityFs,
        layer: "city",
        rank: 2,
        baseline: "hanging",
      },
      {
        id: "cap:a",
        text: "Seoul",
        x: 1.01,
        y: 1.01,
        fontSize: capFs,
        layer: "capital",
        baseline: "hanging",
      },
      {
        id: "city:c",
        text: "Incheon",
        x: 10,
        y: 10,
        fontSize: cityFs,
        layer: "city",
        rank: 3,
        baseline: "hanging",
      },
    ];
    const b = [...a].reverse();

    const once = placeLabels(a, opts);
    const twice = placeLabels(a, opts);
    const reordered = placeLabels(b, opts);

    expect([...once].sort()).toEqual([...twice].sort());
    expect([...once].sort()).toEqual([...reordered].sort());
    // Capital near city: capital kept, nearby city dropped; far city survives.
    expect(once.has("cap:a")).toBe(true);
    expect(once.has("city:b")).toBe(false);
    expect(once.has("city:c")).toBe(true);
  });

  it("prefers more specific name when same layer/rank at same place", () => {
    const candidates: MapLabelCandidate[] = [
      {
        id: "prov:short",
        text: "서울",
        x: 0,
        y: 0,
        fontSize: provFs,
        layer: "province",
        baseline: "central",
      },
      {
        id: "prov:long",
        text: "서울특별시",
        x: 0.001,
        y: 0,
        fontSize: provFs,
        layer: "province",
        baseline: "central",
      },
    ];
    const kept = placeLabels(candidates, opts);
    expect(kept.has("prov:long")).toBe(true);
    expect(kept.has("prov:short")).toBe(false);
  });

  it("compareLabelPriority: capital before province before city", () => {
    const cap: MapLabelCandidate = {
      id: "cap:0",
      text: "A",
      x: 0,
      y: 0,
      /* type-scale-exempt: 지도 라벨 우선순위 정렬 테스트용 기하 데이터 — CSS 선언이 아님 */
      fontSize: 1,
      layer: "capital",
    };
    const prov: MapLabelCandidate = {
      id: "prov:0",
      text: "B",
      x: 0,
      y: 0,
      /* type-scale-exempt: 지도 라벨 우선순위 정렬 테스트용 기하 데이터 — CSS 선언이 아님 */
      fontSize: 1,
      layer: "province",
    };
    const city: MapLabelCandidate = {
      id: "city:0",
      text: "C",
      x: 0,
      y: 0,
      /* type-scale-exempt: 지도 라벨 우선순위 정렬 테스트용 기하 데이터 — CSS 선언이 아님 */
      fontSize: 1,
      layer: "city",
      rank: 0,
    };
    expect(compareLabelPriority(cap, prov)).toBeLessThan(0);
    expect(compareLabelPriority(prov, city)).toBeLessThan(0);
    expect(compareLabelPriority(cap, city)).toBeLessThan(0);
  });
});

// Owner QA 2026-08-10: 줌 4+ 에서 상위 티어 import가 미도착/실패면 육지가 아예 안 그려지던
// "빈 초록 화면" — tierOpacities의 불변식은 "로드된 가장 정밀한 티어는 항상 보인다".
describe("tierOpacities fallback ladder", () => {
  it("keeps 110m fully visible at deep zoom when no finer tier has loaded", () => {
    expect(tierOpacities(150, false, false)).toEqual({ o110m: 1, o50m: 0, o10m: 0 });
    expect(tierOpacities(5, false, false).o110m).toBe(1);
  });

  it("10m loaded at deep zoom: 10m shows, 110m hidden (normal regime unchanged)", () => {
    expect(tierOpacities(150, true, true)).toEqual({ o110m: 0, o50m: 0, o10m: 1 });
  });

  it("only 50m loaded at deep zoom: 50m stays visible instead of fading to nothing", () => {
    const t = tierOpacities(150, true, false);
    expect(t.o50m).toBe(1);
    expect(t.o110m).toBe(0);
  });

  it("only 10m loaded in the 4-6 band (50m failed): 10m covers it", () => {
    const t = tierOpacities(5, false, true);
    expect(t.o10m).toBe(1);
    expect(t.o110m).toBe(0);
  });

  it("normal crossfade bands are unchanged when everything loads", () => {
    const mid = tierOpacities(3.25, true, true); // 110m→50m band midpoint
    expect(mid.o110m).toBeCloseTo(0.5);
    expect(mid.o50m).toBeCloseTo(0.5);
    const hand = tierOpacities(7, true, true); // 50m→10m band midpoint
    expect(hand.o50m).toBeCloseTo(0.5);
    expect(hand.o10m).toBeCloseTo(0.5);
  });
});

// WorldMap.tsx §4-i 오디트: capitalOpacity/admin1Opacity/provinceLabelOpacity/cityDotOpacity/
// cityLabelOpacity가 각자 인라인으로 반복하던 동일한 선형 램프를 이 함수 하나로 통합.
describe("zoomRamp", () => {
  it("is 0 below min", () => {
    expect(zoomRamp(5, 8, 12, 1)).toBe(0);
    expect(zoomRamp(7.999, 8, 12, 1)).toBe(0);
  });

  it("is cap at and above max", () => {
    expect(zoomRamp(12, 8, 12, 1)).toBe(1);
    expect(zoomRamp(100, 8, 12, 1)).toBe(1);
  });

  it("linearly interpolates between min and max", () => {
    expect(zoomRamp(10, 8, 12, 1)).toBeCloseTo(0.5);
    expect(zoomRamp(9, 8, 12, 1)).toBeCloseTo(0.25);
  });

  it("scales the interpolated value by a non-1 cap", () => {
    expect(zoomRamp(15, 12, 18, 0.7)).toBeCloseTo(0.35);
    expect(zoomRamp(80, 70, 90, 0.7)).toBeCloseTo(0.35);
  });

  it("matches WorldMap's five call sites at their own boundaries", () => {
    expect(zoomRamp(8, 8, 12, 1)).toBe(0);
    expect(zoomRamp(12, 12, 18, 0.7)).toBe(0);
    expect(zoomRamp(18, 12, 18, 0.7)).toBe(0.7);
    expect(zoomRamp(70, 70, 90, 0.7)).toBe(0);
    expect(zoomRamp(90, 70, 90, 0.7)).toBe(0.7);
  });
});
