/**
 * 온라인 타일 스타일 SSOT.
 *
 * OpenFreeMap(https://openfreemap.org) — OSM 기반, API 키 없음, 무료. liberty 스타일이 참조하는
 * 호스트는 스타일 JSON 기준 전부 tiles.openfreemap.org 하나뿐이라(타일 planet + natural_earth,
 * sprites, fonts) tauri.conf.json 의 CSP 에도 그 한 호스트만 추가돼 있다. 스타일을 바꾸면 참조
 * 호스트가 늘 수 있으니 CSP 도 같이 확인할 것.
 *
 * 상수로 분리한 이유: 공급자가 죽거나 정책이 바뀌면 여기 한 줄만 갈아끼우면 된다(그 사이엔
 * WorldMapAuto 가 기존 SVG 지도로 폴백한다).
 */
export const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

/**
 * 앱 테마별 스타일. 앱 기본이 다크인데 liberty 는 라이트 톤이라 지도만 하얗게 떠서 이질적이었다.
 * dark 스타일도 참조 호스트가 tiles.openfreemap.org 하나뿐이라(planet + natural_earth, sprites,
 * fonts) CSP 추가는 필요 없다.
 */
export const MAP_STYLE_URLS = {
  dark: 'https://tiles.openfreemap.org/styles/dark',
  light: MAP_STYLE_URL,
} as const;

export function mapStyleUrl(theme: 'dark' | 'light'): string {
  return MAP_STYLE_URLS[theme] ?? MAP_STYLE_URLS.dark;
}

/** CSP 에 등록된 타일 호스트 — 스타일 URL 과 함께 관리되는 값이라 여기 같이 둔다. */
export const MAP_TILE_ORIGIN = 'https://tiles.openfreemap.org';
