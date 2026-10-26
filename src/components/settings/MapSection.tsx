import { useRef, useState } from "react";
import { useSettingsStore } from "../../stores/settings";
import { RegionPickerFields } from "../map/RegionPickerDialog";

const noop = () => {};

/** 설정 > 지역 및 날씨의 기준 지역 지도·검색. 카드는 호출자(ViewSection)가 소유한다 — 여기는 내용만. */
export function MapSection() {
  const defaultMapLocation = useSettingsStore((s) => s.defaultMapLocation);
  const setDefaultMapLocation = useSettingsStore((s) => s.setDefaultMapLocation);
  // Bumped on Reset to force-remount RegionPickerFields — its selectedLocation/regionText are
  // seeded from initialLat/initialLng only on mount (see RegionPickerDialog.tsx), so without a
  // fresh instance the picker's marker/readout would keep showing whatever the user last picked
  // (e.g. after Clear, which drops the pin without writing settings — see handleReset below).
  const [resetNonce, setResetNonce] = useState(0);

  // Owner QA 2026-08-10: 저장되는 홈 = 미리보기에 보이던 뷰. 픽커 지도의 라이브 줌을 받아뒀다가
  // 위치가 바뀔 때 함께 저장한다 (예전엔 줌이 노출되지 않아 팩토리 150 광역 줌이 영구히 남았고,
  // 대시보드 첫 진입이 "명동"이 아니라 수도권 전체로 열렸다).
  // ponytail: 줌만 바꾸고 핀을 안 움직이면 저장 안 됨 — 위치 변경이 유일한 커밋 트리거. 줌만
  // 저장하고 싶다는 요구가 실제로 생기면 디바운스 쓰기를 여기 추가.
  const liveZoomRef = useRef(defaultMapLocation.zoom);

  const handleLocationChange = (_region: string | null, lat: number | null, lng: number | null) => {
    // Clearing has no meaning for a "default" location, and this also fires once on every
    // mount with the current value (RegionPickerFields pushes its initial draft up too) — skip
    // both so opening this section doesn't fire a redundant settings write.
    if (lat === null || lng === null) return;
    if (lat === defaultMapLocation.lat && lng === defaultMapLocation.lng) return;
    void setDefaultMapLocation({ lat, lng, zoom: liveZoomRef.current });
  };

  const handleReset = () => {
    // Same target as the map's home button (WorldMap.handleGoHome): the currently saved
    // defaultMapLocation, not a hardcoded factory default. This does not write settings — it
    // only re-seeds the picker (remount via resetNonce), since `initialLat`/`initialLng` below
    // already track the live store value.
    setResetNonce((n) => n + 1);
  };

  return (
    <div data-testid="settings-map">
      <RegionPickerFields
        key={resetNonce}
        initialRegion={null}
        initialLat={defaultMapLocation.lat}
        initialLng={defaultMapLocation.lng}
        hideFooter
        onLocationChange={handleLocationChange}
        onViewChange={(v) => {
          liveZoomRef.current = v.zoom;
        }}
        onReset={handleReset}
        onCancel={noop}
        onSubmit={noop}
      />
    </div>
  );
}

