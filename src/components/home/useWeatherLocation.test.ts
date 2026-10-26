import { describe, it, expect, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useWeatherLocation } from "./useWeatherLocation";
import { useSettingsStore, FACTORY_DEFAULT_MAP_LOCATION } from "../../stores/settings";
import { useNotesStore } from "../../stores/notes";
import type { NoteSummary } from "../../lib/commands.gen";

// 오너 승인 분석#5: FACTORY 서울 좌표와 우연히 같은 값을 홈으로 저장한 사용자도 "커스텀 있음"으로
// 취급해야 한다 — 좌표 비교 sentinel 대신 defaultMapLocationCustomized 플래그로 판정.
const note = (lat: number, lng: number): NoteSummary => ({
  id: `n-${lat}-${lng}`,
  folder_id: "f1",
  title: "n",
  year: 2024,
  is_favorite: false,
  exported_at: null,
  has_image: false,
  tag_names: [],
  region: null,
  status: null,
  icon: null,
  lat,
  lng,
  created_at: "2024-01-01T00:00:00Z",
  updated_at: "2024-01-01T00:00:00Z",
  month: null,
  day: null,
});

describe("useWeatherLocation", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      defaultMapLocation: FACTORY_DEFAULT_MAP_LOCATION,
      defaultMapLocationCustomized: false,
      regionEnabled: true,
    });
    useNotesStore.setState({ notesByFolder: {} });
  });

  // PLAN-2026-09-15 R3 — 기준 지역 마스터의 **유일한** 판정 지점. 여기서 null 이 나오면 날씨
  // (met.no 요청)·현지 시간·장소명 역조회·AI 컨텍스트가 소비처의 기존 "위치 없음" 분기로 함께
  // 꺼진다. 저장된 커스텀 좌표가 있어도 이긴다.
  it("returns no location at all when region_enabled is off", () => {
    useSettingsStore.setState({
      defaultMapLocation: { ...FACTORY_DEFAULT_MAP_LOCATION },
      defaultMapLocationCustomized: true,
      regionEnabled: false,
    });
    useNotesStore.setState({ notesByFolder: { f1: [note(10, 20)] } });

    const { result } = renderHook(() => useWeatherLocation());

    expect(result.current).toBeNull();
  });

  it("uses the workspace default even at the FACTORY Seoul coords when customized=true", () => {
    useSettingsStore.setState({
      defaultMapLocation: { ...FACTORY_DEFAULT_MAP_LOCATION },
      defaultMapLocationCustomized: true,
    });
    useNotesStore.setState({ notesByFolder: { f1: [note(10, 20)] } });

    const { result } = renderHook(() => useWeatherLocation());

    expect(result.current).toEqual({
      ...FACTORY_DEFAULT_MAP_LOCATION,
      source: "workspace",
    });
  });

  it("falls through to note-cluster coords when customized=false, even at the FACTORY coords", () => {
    useSettingsStore.setState({
      defaultMapLocation: { ...FACTORY_DEFAULT_MAP_LOCATION },
      defaultMapLocationCustomized: false,
    });
    useNotesStore.setState({ notesByFolder: { f1: [note(10, 20), note(10, 20)] } });

    const { result } = renderHook(() => useWeatherLocation());

    expect(result.current).toEqual({ lat: 10, lng: 20, source: "notes" });
  });

  it("falls back to the FACTORY coords as a last resort when customized=false and no note coords exist", () => {
    useSettingsStore.setState({
      defaultMapLocation: { ...FACTORY_DEFAULT_MAP_LOCATION },
      defaultMapLocationCustomized: false,
    });
    useNotesStore.setState({ notesByFolder: {} });

    const { result } = renderHook(() => useWeatherLocation());

    expect(result.current).toEqual({
      lat: FACTORY_DEFAULT_MAP_LOCATION.lat,
      lng: FACTORY_DEFAULT_MAP_LOCATION.lng,
      source: "workspace",
    });
  });
});
