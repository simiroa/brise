import React from "react";

export interface PendingIndicatorProps {
  active: boolean;
  style?: React.CSSProperties;
}

/**
 * Shared, unified pending/working indicator.
 * Displays a 2px top accent shimmer line across the top of the container.
 * Does not render anything if `active` is false.
 */
export function PendingIndicator({ active, style }: PendingIndicatorProps) {
  if (!active) return null;

  return (
    <div
      aria-label="Working..."
      aria-busy="true"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: 2,
        zIndex: "var(--z-dropdown)",
        overflow: "hidden",
        pointerEvents: "none",
        background: "transparent",
        ...style,
      }}
    >
      <div
        className="pending-bar"
        style={{
          height: "100%",
          width: "45%",
          background: "var(--accent)",
          borderRadius: "var(--radius-sm)",
          animation: "pending-sweep 1.2s ease-in-out infinite",
        }}
      />
    </div>
  );
}
