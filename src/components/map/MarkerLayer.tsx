import React from 'react';
import { lngLatToScreen } from './geometry';

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  active?: boolean;
  region?: string | null;
  /** D4: primary pin is larger; waypoint pins are smaller path stops. Default = note pin. */
  pinSize?: "primary" | "waypoint" | "note";
  /** When false, pin is display-only (path waypoints — not draggable / not click-selectable notes). */
  interactive?: boolean;
  /** Fill override for waypoint pins (e.g. home map's note-region markers use --info instead of
   *  the sidebar map's default hollow accent ring). Ignored for primary/note pins. */
  color?: string;
  /** Home map dashboard search (HomeMapPane): true fades the marker instead of removing it —
   *  same dim-in-place treatment as the board/calendar panes. Never set on the temp create pin. */
  dim?: boolean;
}

/** D4 multi-region itinerary path (position order). */
export interface MapPathLine {
  id: string;
  points: { lat: number; lng: number }[];
}

interface MarkerLayerProps {
  markers: MapMarker[];
  viewSize: { width: number; height: number };
  transform: { k: number; x: number; y: number };
  movingMarkerId: string | null;
  // Refs, not values: a pan mutates these without re-rendering, so a snapshotted
  // prop would still read `true` on the next click and swallow it.
  hasMovedRef: React.MutableRefObject<boolean>;
  markerMovedRef: React.MutableRefObject<boolean>;
  onMarkerClick?: (id: string) => void;
  /** 마커 더블클릭 = 그 장소로 fly-to (WorldMap 이 카메라 이동을 소유). */
  onMarkerDoubleClick?: (lat: number, lng: number) => void;
  onMarkerPointerDown: (e: React.PointerEvent, id: string) => void;
}

export const MarkerLayer: React.FC<MarkerLayerProps> = React.memo(
  ({
    markers,
    viewSize,
    transform,
    movingMarkerId,
    hasMovedRef,
    markerMovedRef,
    onMarkerClick,
    onMarkerDoubleClick,
    onMarkerPointerDown,
  }) => {
    return (
      <>
        {/* Active pin pulse circle */}
        {markers.map((m) => {
          if (!m.active) return null;
          const screenPt = lngLatToScreen(m.lat, m.lng, viewSize.width, viewSize.height, { k: 1, x: 0, y: 0 });
          if (!screenPt) return null;

          return (
            <circle
              key={`pulse-${m.id}`}
              cx={screenPt.x}
              cy={screenPt.y}
              r={18 / transform.k}
              fill="var(--accent)"
              stroke="var(--accent)"
              strokeWidth={1 / transform.k}
              className="map-pulse-circle"
              pointerEvents="none"
            />
          );
        })}

        {/* Markers — primary (large) / waypoint (small) / note (default) */}
        {markers.map((m) => {
          const screenPt = lngLatToScreen(m.lat, m.lng, viewSize.width, viewSize.height, { k: 1, x: 0, y: 0 });
          if (!screenPt) return null;
          const cx = screenPt.x;
          const cy = screenPt.y;
          const isActive = m.active;
          const pinSize = m.pinSize ?? "note";
          // D4: primary = large pin, waypoints = small pins; active note pin stays emphasized.
          const sizePx =
            pinSize === "primary" ? (isActive ? 8 : 7) : pinSize === "waypoint" ? 3.5 : isActive ? 6 : 4;
          const baseRadius = sizePx / transform.k;
          const strokeW = (isActive || pinSize === "primary" ? 2 : 1) / transform.k;
          const dragging = movingMarkerId === m.id;
          const interactive = m.interactive !== false;

          return (
            <g
              key={m.id}
              onPointerDown={interactive ? (e) => onMarkerPointerDown(e, m.id) : undefined}
              onClick={(e) => {
                if (!interactive) return;
                e.stopPropagation();
                if (!hasMovedRef.current && !markerMovedRef.current && onMarkerClick) {
                  onMarkerClick(m.id);
                }
              }}
              onDoubleClick={(e) => {
                if (!interactive || !onMarkerDoubleClick) return;
                e.stopPropagation();
                onMarkerDoubleClick(m.lat, m.lng);
              }}
              style={{
                cursor: interactive ? (dragging ? "grabbing" : "pointer") : "default",
                // Dashboard search dim (owner decision, home map): same 0.35 fade the board/
                // calendar panes use — dragging still wins (mid-drag feedback beats the dim).
                opacity: dragging ? 0.6 : m.dim ? 0.35 : 1,
              }}
              pointerEvents={interactive ? "auto" : "none"}
            >
              {isActive && pinSize !== "waypoint" && (
                <circle
                  cx={cx}
                  cy={cy}
                  r={baseRadius * 1.8}
                  fill="var(--accent)"
                  opacity={0.3}
                />
              )}
              <circle
                cx={cx}
                cy={cy}
                r={baseRadius}
                fill={
                  pinSize === "waypoint"
                    ? (m.color ?? "var(--surface-base)")
                    : isActive || pinSize === "primary"
                      ? "var(--accent)"
                      : "var(--text)"
                }
                opacity={pinSize === "waypoint" ? 1 : isActive ? 1 : 0.65}
                stroke={pinSize === "waypoint" ? (m.color ? "var(--surface-base)" : "var(--accent)") : "var(--surface-base)"}
                strokeWidth={strokeW}
              />
            </g>
          );
        })}
      </>
    );
  }
);

MarkerLayer.displayName = 'MarkerLayer';
