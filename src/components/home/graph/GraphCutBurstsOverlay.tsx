export interface CutBurstItem {
  id: string;
  x: number;
  y: number;
}

export interface GraphCutBurstsOverlayProps {
  cutBursts: CutBurstItem[];
}

export function GraphCutBurstsOverlay({ cutBursts }: GraphCutBurstsOverlayProps) {
  if (!cutBursts || cutBursts.length === 0) return null;

  return (
    <svg className="graph-cut-bursts-overlay" data-testid="graph-cut-bursts-overlay">
      {cutBursts.map((b) => (
        <g key={b.id} transform={`translate(${b.x}, ${b.y})`} className="graph-cut-burst" data-testid="graph-cut-burst">
          <circle r="16" className="graph-cut-shockwave" />
          <circle r="3.5" className="graph-cut-core" />
          <line x1="-12" y1="-12" x2="12" y2="12" className="graph-cut-spark-line l1" />
          <line x1="12" y1="-12" x2="-12" y2="12" className="graph-cut-spark-line l2" />
          <line x1="-14" y1="0" x2="14" y2="0" className="graph-cut-spark-line l3" />
        </g>
      ))}
    </svg>
  );
}
