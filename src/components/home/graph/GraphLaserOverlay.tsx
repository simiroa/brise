export interface GraphLaserOverlayProps {
  laserPoints: { x: number; y: number }[] | null;
}

export function GraphLaserOverlay({ laserPoints }: GraphLaserOverlayProps) {
  if (!laserPoints || laserPoints.length < 2) return null;

  return (
    <svg className="graph-laser-cut-overlay" data-testid="graph-laser-cut-overlay">
      <path
        d={`M ${laserPoints.map((p) => `${p.x} ${p.y}`).join(" L ")}`}
        className="graph-laser-path"
      />
    </svg>
  );
}
