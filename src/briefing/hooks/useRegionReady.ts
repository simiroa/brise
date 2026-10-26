import { useSettingsStore } from "../../stores/settings";

/** 날씨·일출일몰을 보여줄 수 있나 — 지역 기능이 켜져 있고 사용자가 지도 기본 위치를 직접 정했을 때만(공장 기본값 위치는 거짓말이 된다). */
export function useRegionReady(): boolean {
  const regionEnabled = useSettingsStore((s) => s.regionEnabled);
  const customized = useSettingsStore((s) => s.defaultMapLocationCustomized);
  return regionEnabled && customized;
}
