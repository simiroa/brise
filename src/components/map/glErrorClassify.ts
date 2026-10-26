/**
 * `isFatalGlError`(MapLibre 에러 치명도 판별)를 WorldMapGL.tsx에서 빼낸 것 — 그 함수 자체는
 * maplibre-gl 의 어떤 API 도 부르지 않는 순수 문자열 판별이지만, WorldMapGL.tsx 모듈 최상단이
 * `import * as maplibregl from 'maplibre-gl'` 을 정적으로 갖고 있었다. ES 모듈은 import 시
 * 파일 전체를 실행하므로, WorldMapAuto.tsx 가 이 함수 하나만 쓰려고 WorldMapGL.tsx 를 정적
 * import 하면 그 옆 줄의 `React.lazy(() => import('./WorldMapGL'))` 분리가 무효가 되어
 * maplibre-gl(947KB, docs/PLAN-2026-08-16-performance.md 실측)이 항상 함께 번들된다 —
 * 2026-09-19 확인: 실제로 dist/assets/WorldMapAuto-*.js 가 1MB에 maplibre 를 포함하고 있었다.
 * WorldMapGL.tsx 는 이 파일에서 재수출(re-export)해 기존 호출부(applyMapDarkTheme 테스트 등)를
 * 깨지 않는다.
 */
export function isFatalGlError(e: unknown): boolean {
  if (!e) return false;

  const errObj = (e as Record<string, unknown>)?.error ?? e;
  const str = String(
    (e as Record<string, unknown>)?.message ||
    (errObj as Record<string, unknown>)?.message ||
    errObj ||
    e
  );

  // 1. WebGL 컨텍스트 손실 또는 미지원
  if (/webgl|context lost|unsupported/i.test(str)) {
    return true;
  }

  const dataType = (e as Record<string, unknown>)?.dataType;
  const url = String((errObj as Record<string, unknown>)?.url || '');

  // 2. 스타일 로드 실패: 지도 스타일 자체가 없으면 렌더링 불가하므로 치명적
  if (dataType === 'style') return true;
  if (/styles\//i.test(url) || /style\.json/i.test(url)) return true;
  if (/failed to load style|error loading style/i.test(str)) return true;

  // 3. 단순 타일, 글리프, 스프라이트 누락 또는 취소(abort)는 렌더러가 자체 복구 가능한 비치명적 에러
  if ((e as Record<string, unknown>)?.tile) return false;
  if (dataType === 'source' || dataType === 'tile' || dataType === 'glyphs' || dataType === 'sprite') return false;
  if (/tiles\//i.test(url) || /fonts\//i.test(url) || /sprites\//i.test(url)) return false;
  if (/tile|glyph|sprite|abort|canceled/i.test(str)) return false;
  if ((errObj as Record<string, unknown>)?.status === 404 && !/style/i.test(url)) return false;

  return false;
}
