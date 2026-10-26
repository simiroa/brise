import React, { useCallback, useEffect, useRef, useState } from 'react';
import { WorldMap, type WorldMapProps } from './WorldMap';
// glErrorClassify.ts 에서 가져온다(WorldMapGL.tsx 가 아니라) — 그 파일은 최상단에서 maplibre-gl 을
// 정적 import 하므로, 이 함수 하나만 쓰려고 거기서 import 하면 바로 아래 React.lazy 분리가
// 무효화되어 maplibre-gl(947KB, docs/PLAN-2026-08-16-performance.md)이 이 컴포넌트를 마운트하는
// 순간 항상 함께 번들된다(2026-09-19 확인: 실제로 dist/assets/WorldMapAuto-*.js 에 포함돼 있었다).
import { isFatalGlError } from './glErrorClassify';
import { reportFallback } from '../../lib/diag';
import { WorldMapGL } from "../../lazySurfaces";

// GL 폴백 진단 메시지용 — isFatalGlError 와 같은 얕은 message/type 추출이지만, webglcontextlost
// 실제 이벤트({type, originalEvent})는 message 가 없어 String() 하면 "[object Object]"가 된다
// (glErrorClassify.test.ts D4 회귀). diag 로그에는 적어도 이벤트 종류(type)라도 남긴다.
function glErrorDetail(e: unknown): string {
  if (e && typeof e === 'object') {
    const anyE = e as Record<string, unknown>;
    if (typeof anyE.message === 'string') return anyE.message;
    if (typeof anyE.type === 'string') return anyE.type;
  }
  return String(e);
}


export type { MapMarker, MapPathLine, MapViewportBbox, MapLocation, WorldMapProps } from './WorldMap';

/**
 * 온라인이면 MapLibre GL(온라인 타일), 아니면 기존 SVG 지도.
 *
 * 폴백 트리거:
 *   1) 오프라인 상태 (`navigator.onLine === false` 또는 세션 중 offline 이벤트)
 *   2) WebGL 미지원 또는 스타일 로드 불가 등 치명적 GL 오류
 * 단순 타일 404나 일시적 리소스 지연 등은 MapLibre 내부에서 자체 처리되므로
 * 지도 전체가 비상 SVG 로 강제 전환되지 않습니다.
 * 네트워크가 다시 온라인으로 복구되면(온라인 이벤트) 자동으로 GL 시도를 재개합니다.
 *
 * props 는 WorldMapProps 그대로 — 호스트는 어느 쪽이 렌더되는지 알 필요가 없다.
 */
export const WorldMapAuto: React.FC<WorldMapProps> = (props) => {
  const [fallback, setFallback] = useState(() => typeof navigator !== 'undefined' && navigator.onLine === false);
  const glFatalFailedRef = useRef(false);

  useEffect(() => {
    // 마운트 시점에 이미 온라인이거나, 이후 online 이벤트가 발생했을 때 GL 시도
    if (fallback && typeof navigator !== 'undefined' && navigator.onLine && !glFatalFailedRef.current) {
      setFallback(false);
    }
    const onOffline = () => setFallback(true);
    const onOnline = () => {
      if (!glFatalFailedRef.current) {
        setFallback(false);
      }
    };
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, [fallback]);

  const onGlError = useCallback((e: unknown) => {
    if (!isFatalGlError(e)) {
      console.warn('[map] 비치명적 GL 경고 (폴백 무시):', e);
      return;
    }
    glFatalFailedRef.current = true;
    setFallback((cur) => {
      if (!cur) {
        console.warn('[map] GL 치명적 실패 — SVG 지도로 폴백합니다.', e);
        reportFallback('map', 'gl_fatal_error', glErrorDetail(e));
      }
      return true;
    });
  }, []);

  // D4(AUDIT-2026-09-26): WorldMapGL 이 이미 "복구 불가"라고 판단을 마치고 넘기는 신호
  // (Map 생성 실패·초기 타일 8회 연속 실패·webglcontextlost) — isFatalGlError 로 다시 판별하지
  // 않는다. 그 함수는 8연속 타일 실패라는 도메인 판단을 재현할 수 없고, webglcontextlost
  // 이벤트는 String() 하면 "[object Object]"가 돼 늘 비치명으로 오판해 지도가 빈 채로 남았다
  // (onGlError 하나로 두 신호를 같이 보내던 시절의 버그 — 이제 신호를 분리해 재분류를 건너뛴다).
  const onGlFatal = useCallback((e: unknown) => {
    glFatalFailedRef.current = true;
    setFallback((cur) => {
      if (!cur) {
        console.warn('[map] GL 치명적 실패(재분류 없음) — SVG 지도로 폴백합니다.', e);
        reportFallback('map', 'gl_fatal_error', glErrorDetail(e));
      }
      return true;
    });
  }, []);

  if (fallback || props.live === false) return <WorldMap {...props} />;
  return (
    <React.Suspense fallback={<WorldMap {...props} />}>
      <WorldMapGL {...props} onGlError={onGlError} onGlFatal={onGlFatal} />
    </React.Suspense>
  );
};

