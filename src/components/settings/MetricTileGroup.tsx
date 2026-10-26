import type { CSSProperties, ReactNode } from "react";
import { IconChip } from "./IconChip";

export interface MetricTileItem {
  id: string;
  icon: ReactNode;
  value: string | number;
  label: string;
  subtext?: string;
  testId?: string;
}

export interface MetricTileProps {
  tile: MetricTileItem;
}

/**
 * Individual metric tile with tinted icon, bold value, label, and optional subtext.
 */
export function MetricTile({ tile }: MetricTileProps) {
  const tileStyle: CSSProperties = {
    background: "var(--surface-sunken)",
    border: "1px solid var(--divider)",
    borderRadius: "var(--radius-md)",
    padding: "var(--space-6) var(--space-7)",
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    gap: "var(--space-4)",
    minWidth: 0,
  };

  return (
    <div
      data-testid={tile.testId ?? `metric-tile-${tile.id}`}
      style={tileStyle}
    >
      <IconChip size={32}>{tile.icon}</IconChip>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          flex: 1,
        }}
      >
        <div
          style={{
            fontSize: "var(--text-xl)",
            fontWeight: 600,
            color: "var(--text)",
            lineHeight: "var(--lh-tight)",
          }}
        >
          {tile.value}
        </div>
        <div
          style={{
            fontSize: "var(--text-sm)",
            color: "var(--muted)",
            fontWeight: 400,
            lineHeight: "var(--lh-ui)",
          }}
        >
          {tile.label}
        </div>
        {tile.subtext && (
          <div
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--muted)",
              fontWeight: 400,
              marginTop: "var(--space-2xs)",
              lineHeight: "var(--lh-ui)",
            }}
          >
            {tile.subtext}
          </div>
        )}
      </div>
    </div>
  );
}

export interface MetricTileGroupProps {
  tiles: MetricTileItem[];
  columns?: number; // default 3
  testId?: string;
}

/**
 * 3-column metric summary tile group for settings.
 */
export function MetricTileGroup({
  tiles,
  columns = 3,
  testId,
}: MetricTileGroupProps) {
  const gridStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
    gap: "var(--space-5)",
    width: "100%",
    boxSizing: "border-box",
  };

  return (
    <div
      data-testid={testId ?? "metric-tile-group"}
      style={gridStyle}
    >
      {tiles.map((tile) => (
        <MetricTile key={tile.id} tile={tile} />
      ))}
    </div>
  );
}
