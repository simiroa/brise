/**
 * Shared location-resolution hook for the home weather feature — the header's WeatherSlot and
 * the calendar's forecast icons both need the same priority chain (Map-settings default >
 * note-cluster heuristic, see lib/weather.ts::resolveWeatherLocation). Extracted out of
 * WeatherSlot's original useMemo so the two call sites can't drift apart.
 *
 * 2026-08-05: dropped the separate manual "weather city" input (settings.weatherLocation) —
 * one location input now (Settings→Map / onboarding), weather just follows it.
 */
import { useMemo } from "react";
import { FACTORY_DEFAULT_MAP_LOCATION, useSettingsStore } from "../../stores/settings";
import { useNotesStore } from "../../stores/notes";
import { useNoteQueryVersion } from "../../lib/noteQuery";
import {
  resolveWeatherLocation,
  type LatLng,
  type ResolvedWeatherLocation,
} from "../../lib/weather";

export function useWeatherLocation(): ResolvedWeatherLocation | null {
  const defaultMapLocation = useSettingsStore((s) => s.defaultMapLocation);
  const defaultMapLocationCustomized = useSettingsStore((s) => s.defaultMapLocationCustomized);
  const regionEnabled = useSettingsStore((s) => s.regionEnabled);
  const noteQueryVersion = useNoteQueryVersion();

  return useMemo(() => {
    // PLAN-2026-09-15 R3 — 기준 지역 마스터가 꺼지면 **여기 한 지점**에서 위치가 사라진다.
    // 날씨(met.no 요청)·현지 시간·장소명 역조회가 전부 이 훅을 지나므로 소비처는 이미
    // 가지고 있는 "위치 없음" 분기를 그대로 타고 조용히 꺼진다 — 각자 이 키를 다시 보지 않는다.
    // (훅이 아닌 AI 컨텍스트 경로는 lib/weather.ts::savedWeatherLocation 이 같은 판정을 한다.)
    if (!regionEnabled) return null;
    // ponytail: useNoteQueryVersion 은 노트북 단위의 거친 250ms 코얼레싱 신호라 좌표와 무관한
    // 변경(태그/제목 등)에도 재계산이 걸린다. 대규모 코퍼스(100k+)에서 추가 최적화가 필요해지면
    // 좌표 전용 인덱스/신호를 두는 것이 업그레이드 경로다.
    const notesByFolder = useNotesStore.getState().notesByFolder;
    // "커스텀 기본위치 있음"은 좌표가 FACTORY 서울 좌표와 다른지가 아니라 settings 하이드레이션이
    // kv 의 default_map_location 키 존재 여부로 세팅한 명시적 플래그로 판정한다(오너 분석#5) —
    // 좌표 비교는 사용자가 실제로 서울 좌표를 홈으로 저장한 경우를 "미설정"으로 오탐했다.
    const workspaceDefault: LatLng | null = defaultMapLocationCustomized ? defaultMapLocation : null;
    const noteCoords: LatLng[] = [];
    for (const notes of Object.values(notesByFolder)) {
      for (const n of notes) {
        if (typeof n.lat === "number" && typeof n.lng === "number") {
          noteCoords.push({ lat: n.lat, lng: n.lng });
        }
      }
    }
    const resolved = resolveWeatherLocation(workspaceDefault, noteCoords);
    // W8 오너 피드백 "지도 기본위치에 따라 알아서 날씨도": 위 체인이 전부 비면(커스텀 기본위치
    // 없음, 좌표 노트 없음) 공장기본 지도 위치를 최종 폴백으로 쓴다 — 예전엔 여기서 null 을
    // 돌려 날씨 박스 자체가 안 떴다. 공장값을 체인 *위쪽*에 넣지 않는 이유는 그대로다(노트
    // 위치가 이겨야 하므로 "커스텀 아님"으로 건너뜀) — 맨 끝 폴백으로만 쓴다.
    return (
      resolved ?? {
        lat: FACTORY_DEFAULT_MAP_LOCATION.lat,
        lng: FACTORY_DEFAULT_MAP_LOCATION.lng,
        source: "workspace" as const,
      }
    );
  }, [defaultMapLocation, defaultMapLocationCustomized, noteQueryVersion, regionEnabled]);
}
