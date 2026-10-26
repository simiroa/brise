import { Suspense } from "react";
import { RegionExpanded } from "../lazySurfaces";

// 지도(maplibre-gl ≈ 947KB)는 지역 탭이 열릴 때만 받는다 — 모바일 메인 청크에 정적으로 들어오면 안 된다.
// RegionExpanded 는 WorldMapAuto 를 통해 WorldMapGL 을 다시 lazy 로 끌어오므로 이 경계 하나로 충분하다.


interface MobileRegionViewProps {
  onOpenNote: (id: string) => void;
}

/**
 * `region` 모드 — 데스크톱 RegionExpanded 를 보기 전용(readOnly)으로 재사용한다. 핀 이동·지도 탭 생성·
 * 드롭·우클릭 메뉴를 끄고(오터치로 위치가 바뀌는 사고 방지), 핀/목록 탭은 노트를 연다. 장소 검색은 보이되
 * 고르면 지도 **이동만** 한다(데스크톱의 "검색 핀 → 노트 만들기"는 readOnly 에서 꺼진다, geocode_search 는 HTTP 노출).
 * 지도 실패(WebGL 없음·타일)는 WorldMapAuto 가 SVG 지도로 폴백하며 reportFallback('map', …) 로 남긴다.
 *
 * ponytail: 위치 편집은 폰에서 아직 없다 — 열려면 readOnly 를 풀지 말고 별도 편집 모드(확인 단계)를 둘 것.
 */
export function MobileRegionView({ onOpenNote }: MobileRegionViewProps) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }} data-testid="mobile-region-view">
      <Suspense fallback={null}>
        <RegionExpanded readOnly onOpenNote={onOpenNote} />
      </Suspense>
    </div>
  );
}
