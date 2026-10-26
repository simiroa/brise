import { describe, it, expect } from "vitest";
import {
  buildPathLines,
  buildRegionMarkers,
  buildRegionPath,
  buildWaypointPins,
  clickedPlaceName,
  dedupeWaypoints,
  nextWaypointPosition,
  sameCoords,
  sameRegionName,
  toWaypointRegions,
  waypointDuplicatesPrimary,
  waypointPathNumber,
  type PrimaryRegion,
  type WaypointRegion,
} from "./regionDisplay";

const primary: PrimaryRegion = {
  region: "서울",
  lat: 37.5665,
  lng: 126.978,
};

const gyeongju: WaypointRegion = {
  id: "wp1",
  name: "경주",
  lat: 35.8562,
  lng: 129.2247,
  position: 0,
};

const busan: WaypointRegion = {
  id: "wp2",
  name: "부산",
  lat: 35.1796,
  lng: 129.0756,
  position: 1,
};

describe("regionDisplay dedup", () => {
  it("sameRegionName is case/trim insensitive", () => {
    expect(sameRegionName("서울", " 서울 ")).toBe(true);
    expect(sameRegionName("Seoul", "seoul")).toBe(true);
    expect(sameRegionName("서울", "경주")).toBe(false);
    expect(sameRegionName(null, "서울")).toBe(false);
  });

  it("sameCoords uses epsilon", () => {
    expect(sameCoords(37.5665, 126.978, 37.56651, 126.97801)).toBe(true);
    expect(sameCoords(37.5665, 126.978, 35.0, 129.0)).toBe(false);
    expect(sameCoords(null, null, 37.5, 127.0)).toBe(false);
  });

  it("drops waypoint that duplicates primary by name", () => {
    const dup: WaypointRegion = {
      id: "dup",
      name: "서울",
      lat: 0,
      lng: 0,
      position: 0,
    };
    expect(waypointDuplicatesPrimary(primary, dup)).toBe(true);
    expect(dedupeWaypoints(primary, [dup, gyeongju])).toEqual([gyeongju]);
  });

  it("drops waypoint that duplicates primary by coords", () => {
    const dup: WaypointRegion = {
      id: "dup",
      name: "Seoul City",
      lat: 37.5665,
      lng: 126.978,
      position: 0,
    };
    expect(waypointDuplicatesPrimary(primary, dup)).toBe(true);
    expect(dedupeWaypoints(primary, [dup, busan])).toEqual([busan]);
  });

  it("keeps distinct waypoints", () => {
    expect(dedupeWaypoints(primary, [gyeongju, busan])).toEqual([gyeongju, busan]);
  });
});

describe("regionDisplay path", () => {
  it("buildRegionPath: primary then waypoints", () => {
    const path = buildRegionPath(primary, "note-1", [gyeongju, busan]);
    expect(path.map((p) => p.kind)).toEqual(["primary", "waypoint", "waypoint"]);
    expect(path[0].id).toBe("note-1");
    expect(path[1].id).toBe("wp1");
    expect(path[2].id).toBe("wp2");
  });

  it("buildRegionPath skips primary without coords and still dedupes", () => {
    const bare: PrimaryRegion = { region: "서울", lat: null, lng: null };
    const dup: WaypointRegion = {
      id: "dup",
      name: "서울",
      lat: 37.5,
      lng: 127.0,
      position: 0,
    };
    const path = buildRegionPath(bare, "note-1", [dup, gyeongju]);
    // name-dup of primary is dropped; only 경주 remains
    expect(path).toHaveLength(1);
    expect(path[0].id).toBe("wp1");
  });

  it("waypointPathNumber is 1-based with primary occupying slot 1", () => {
    expect(waypointPathNumber(primary, [gyeongju, busan], "wp1")).toBe(2);
    expect(waypointPathNumber(primary, [gyeongju, busan], "wp2")).toBe(3);
  });
});

// N1-3 후속(owner 2026-07-31): 지도 클릭으로 장소를 추가하는 경로가 생기면서, 목록의
// "+ 장소 추가"와 지도 클릭이 같은 순서 규칙·같은 이름 규칙을 써야 한다.
describe("nextWaypointPosition", () => {
  it("빈 목록은 0에서 시작한다", () => {
    expect(nextWaypointPosition([])).toBe(0);
  });

  it("현재 최댓값 다음 자리를 준다 — 중간이 비어 있어도 뒤에 붙는다", () => {
    expect(nextWaypointPosition([{ position: 0 }, { position: 5 }])).toBe(6);
  });
});

describe("clickedPlaceName", () => {
  it("역지오코딩 라벨이 있으면 그대로 쓴다", () => {
    expect(clickedPlaceName("  경주시 ", 35.8, 129.2)).toBe("경주시");
  });

  it("라벨이 없거나 비면 좌표를 이름으로 남긴다 — 이름 없는 행이나 조용한 실패보다 낫다", () => {
    expect(clickedPlaceName(null, 35.8567, 129.2247)).toBe("35.857, 129.225");
    expect(clickedPlaceName("   ", 0, 0)).toBe("0.000, 0.000");
  });
});

// 지도 조립(핀·경로선) — RegionExpanded/HomeMapPane/RegionPreview/NoteRegionsList 가 인라인으로
// 만들던 모양을 한 곳으로 모았다. 여기서 모양(id 규칙·핀 크기·활성 여부)이 굳는다.
describe("toWaypointRegions", () => {
  it("DB 행에서 표시용 5필드만 복사한다 — note_id 등은 버린다", () => {
    const rows = [
      { id: "r1", note_id: "n1", name: "경주", lat: 35.8, lng: 129.2, position: 3 },
      { id: "r2", note_id: "n1", name: "부산", lat: 35.1, lng: 129.0, position: 4 },
    ];
    expect(toWaypointRegions(rows)).toStrictEqual([
      { id: "r1", name: "경주", lat: 35.8, lng: 129.2, position: 3 },
      { id: "r2", name: "부산", lat: 35.1, lng: 129.0, position: 4 },
    ]);
  });

  it("빈 목록은 빈 목록", () => {
    expect(toWaypointRegions([])).toEqual([]);
  });
});

describe("buildWaypointPins", () => {
  it("경유지가 없으면 핀도 없다", () => {
    expect(buildWaypointPins(primary, "note-1", [])).toEqual([]);
  });

  it("경유지 하나 = id `wp:<id>` 의 보기 전용 작은 핀, 색 키는 아예 없다", () => {
    const pins = buildWaypointPins(primary, "note-1", [gyeongju]);
    expect(pins).toStrictEqual([
      {
        id: "wp:wp1",
        lat: 35.8562,
        lng: 129.2247,
        active: false,
        region: "경주",
        pinSize: "waypoint",
        interactive: false,
      },
    ]);
  });

  it("여러 경유지는 position 순서 그대로, 대표 핀은 포함하지 않는다", () => {
    const pins = buildWaypointPins(primary, "note-1", [gyeongju, busan]);
    expect(pins.map((p) => p.id)).toEqual(["wp:wp1", "wp:wp2"]);
    expect(pins.every((p) => p.pinSize === "waypoint")).toBe(true);
  });

  it("대표와 같은 장소(이름 또는 좌표)인 경유지는 핀으로 만들지 않는다", () => {
    const dupByName: WaypointRegion = { id: "d1", name: "서울", lat: 0, lng: 0, position: 0 };
    const dupByCoords: WaypointRegion = { id: "d2", name: "Seoul City", lat: 37.5665, lng: 126.978, position: 1 };
    const pins = buildWaypointPins(primary, "note-1", [dupByName, dupByCoords, busan]);
    expect(pins.map((p) => p.id)).toEqual(["wp:wp2"]);
  });

  it("대표 좌표가 없어도 경유지 핀은 나온다(대표 핀은 여기서 만들지 않으므로)", () => {
    const bare: PrimaryRegion = { region: null, lat: null, lng: null };
    expect(buildWaypointPins(bare, "note-1", [gyeongju]).map((p) => p.id)).toEqual(["wp:wp1"]);
  });

  it("color 옵션은 경유지 핀에만 붙는다 — 홈 지도의 var(--info)", () => {
    const pins = buildWaypointPins(primary, "note-1", [gyeongju, busan], { color: "var(--info)" });
    expect(pins.map((p) => p.color)).toEqual(["var(--info)", "var(--info)"]);
    expect(pins.every((p) => p.interactive === false)).toBe(true);
  });

  it("interactive 옵션이면 경유지 핀을 끌어 옮길 수 있다", () => {
    const pins = buildWaypointPins(primary, "note-1", [gyeongju], { interactive: true });
    expect(pins[0].interactive).toBe(true);
    expect(pins[0]).not.toHaveProperty("color");
  });
});

describe("buildRegionMarkers", () => {
  it("대표점은 큰 활성 보기 전용 핀(id = 노트 id, 이름 라벨), 경유지는 그 뒤에 이어진다", () => {
    const path = buildRegionPath(primary, "note-1", [gyeongju, busan]);
    expect(buildRegionMarkers(path, primary.region, [gyeongju, busan])).toStrictEqual([
      {
        id: "note-1",
        lat: 37.5665,
        lng: 126.978,
        active: true,
        region: "서울",
        pinSize: "primary",
        interactive: false,
      },
      {
        id: "wp:wp1",
        lat: 35.8562,
        lng: 129.2247,
        active: false,
        region: "경주",
        pinSize: "waypoint",
        interactive: false,
      },
      {
        id: "wp:wp2",
        lat: 35.1796,
        lng: 129.0756,
        active: false,
        region: "부산",
        pinSize: "waypoint",
        interactive: false,
      },
    ]);
  });

  it("interactive 옵션은 경유지에만 — 대표 핀은 언제나 보기 전용", () => {
    const path = buildRegionPath(primary, "note-1", [gyeongju]);
    const pins = buildRegionMarkers(path, primary.region, [gyeongju], { interactive: true });
    expect(pins.map((p) => [p.pinSize, p.interactive])).toEqual([
      ["primary", false],
      ["waypoint", true],
    ]);
  });

  it("대표 좌표가 없으면 대표 핀이 없다 — 경유지 핀만", () => {
    const bare: PrimaryRegion = { region: "서울", lat: null, lng: null };
    const path = buildRegionPath(bare, "note-1", [gyeongju]);
    expect(buildRegionMarkers(path, bare.region, [gyeongju]).map((p) => p.id)).toEqual(["wp:wp1"]);
  });

  it("대표 이름이 없으면 라벨은 null, 경로 점에 대응하는 경유지가 없으면 경유지 라벨도 null", () => {
    const noName: PrimaryRegion = { region: null, lat: 37.5, lng: 127.0 };
    const path = buildRegionPath(noName, "note-1", [gyeongju]);
    const pins = buildRegionMarkers(path, noName.region, []);
    expect(pins.map((p) => p.region)).toEqual([null, null]);
  });
});

describe("buildPathLines", () => {
  it("점이 0/1개면 선이 없다", () => {
    expect(buildPathLines([], "note-1")).toEqual([]);
    expect(buildPathLines(buildRegionPath(primary, "note-1", []), "note-1")).toEqual([]);
  });

  it("점이 둘 이상이면 노트 id 로 한 줄 — 대표점부터 경유지 순서", () => {
    const path = buildRegionPath(primary, "note-1", [gyeongju, busan]);
    expect(buildPathLines(path, "note-1")).toStrictEqual([
      {
        id: "note-1",
        points: [
          { lat: 37.5665, lng: 126.978 },
          { lat: 35.8562, lng: 129.2247 },
          { lat: 35.1796, lng: 129.0756 },
        ],
      },
    ]);
  });

  it("대표 좌표가 없고 경유지가 하나면 선이 없다", () => {
    const bare: PrimaryRegion = { region: null, lat: null, lng: null };
    expect(buildPathLines(buildRegionPath(bare, "note-1", [gyeongju]), "note-1")).toEqual([]);
  });
});
