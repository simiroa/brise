import { describe, it, expect } from "vitest";
import { splitPlaceLabel, isNumberLikePiece, findDuplicatePlace, distanceMeters, DUPLICATE_PLACE_RADIUS_M } from "./placeLabel";

describe("splitPlaceLabel", () => {
  it("한국어 주소: 첫 조각이 이름, 나머지는 부가 주소", () => {
    expect(splitPlaceLabel("경복궁, 사직로, 종로구, 서울, 03045, 대한민국")).toEqual({
      name: "경복궁",
      detail: "사직로, 종로구, 서울, 03045, 대한민국",
    });
  });

  it("번지수로 시작하면 건너뛰고 의미 있는 조각을 이름으로 쓴다", () => {
    expect(splitPlaceLabel("12, Main Street, Seoul")).toEqual({ name: "Main Street", detail: "Seoul" });
    expect(splitPlaceLabel("105, 남산공원길, 용산구")).toEqual({ name: "남산공원길", detail: "용산구" });
    expect(splitPlaceLabel("12-3, 12번지, 세종대로, 서울")).toEqual({ name: "세종대로", detail: "서울" });
  });

  it("쉼표가 없으면 라벨 전체가 이름", () => {
    expect(splitPlaceLabel("부산")).toEqual({ name: "부산", detail: "" });
  });

  it("빈 문자열/공백/null 은 빈 이름", () => {
    expect(splitPlaceLabel("")).toEqual({ name: "", detail: "" });
    expect(splitPlaceLabel("  ,  , ")).toEqual({ name: "", detail: "" });
    expect(splitPlaceLabel(null)).toEqual({ name: "", detail: "" });
    expect(splitPlaceLabel(undefined)).toEqual({ name: "", detail: "" });
  });

  it("전부 숫자 조각이면 쪼개지 않고 이름으로 둔다", () => {
    expect(splitPlaceLabel("12, 34")).toEqual({ name: "12, 34", detail: "" });
  });

  it("조각 앞뒤 공백을 다듬는다", () => {
    expect(splitPlaceLabel("  서울역 ,  중구 ")).toEqual({ name: "서울역", detail: "중구" });
  });
});

describe("isNumberLikePiece", () => {
  it.each([["12", true], ["12-3", true], ["12A", true], ["3층", true], ["101호", true], ["Main Street", false], ["2호선역", false], ["", true]])(
    "%s -> %s",
    (piece, expected) => {
      expect(isNumberLikePiece(piece as string)).toBe(expected);
    },
  );
});

describe("findDuplicatePlace", () => {
  const seoul = { name: "서울", lat: 37.5665, lng: 126.978 };

  it("반경 안(약 50m)이면 중복으로 찾는다", () => {
    // 위도 0.0002° ≈ 22m
    expect(findDuplicatePlace(37.5667, 126.978, [seoul])).toBe(seoul);
  });

  it("반경 밖이면 null (위도 0.001° ≈ 111m)", () => {
    expect(findDuplicatePlace(37.5675, 126.978, [seoul])).toBeNull();
  });

  it("좌표가 없는 항목은 건너뛴다", () => {
    expect(findDuplicatePlace(37.5665, 126.978, [{ name: "이름만", lat: null, lng: null }])).toBeNull();
  });

  it("빈 목록은 null", () => {
    expect(findDuplicatePlace(1, 2, [])).toBeNull();
  });

  it("반경은 상수(50m)이고 distanceMeters 와 일치한다", () => {
    expect(DUPLICATE_PLACE_RADIUS_M).toBe(50);
    const d = distanceMeters({ lat: 37.5665, lng: 126.978 }, { lat: 37.5667, lng: 126.978 });
    expect(d).toBeGreaterThan(20);
    expect(d).toBeLessThan(25);
  });
});
