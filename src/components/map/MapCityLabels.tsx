export interface CityNode {
  id: string | number;
  name: string;
  x: number;
  y: number;
}

export interface ProvinceLabelNode {
  id: string | number;
  name: string;
  x: number;
  y: number;
}

export interface MapCityLabelsProps {
  cityDotOpacity: number;
  cityLabelOpacity: number;
  capitalOpacity: number;
  provinceLabelOpacity: number;
  cityNodes: CityNode[];
  capitalNodes: CityNode[];
  provinceLabels: ProvinceLabelNode[];
  placedLabelIds: Set<string>;
  transform: { k: number; x: number; y: number };
}

export function MapCityLabels({
  cityDotOpacity,
  cityLabelOpacity,
  capitalOpacity,
  provinceLabelOpacity,
  cityNodes,
  capitalNodes,
  provinceLabels,
  placedLabelIds,
  transform,
}: MapCityLabelsProps) {
  return (
    <>
      {cityDotOpacity > 0 &&
        cityNodes.map((city) => (
          <g key={`city-${city.id}`} data-tier="city-dot" opacity={cityDotOpacity} pointerEvents="none">
            <circle
              cx={city.x}
              cy={city.y}
              r={1.3 / transform.k}
              fill="var(--muted)"
            />
            {cityLabelOpacity > 0 && placedLabelIds.has(`city:${city.id}`) && (
              <text
                data-tier="city-label"
                x={city.x}
                y={city.y + 5 / transform.k}
                fill="var(--muted)"
                fontSize={7.5 / transform.k}
                textAnchor="middle"
                dominantBaseline="hanging"
                opacity={cityLabelOpacity}
                pointerEvents="none"
                style={{ userSelect: "none" }}
              >
                {city.name}
              </text>
            )}
          </g>
        ))}

      {capitalOpacity > 0 &&
        capitalNodes.map((cap) => (
          <g key={`cap-${cap.id}`} data-tier="capital" opacity={capitalOpacity} pointerEvents="none">
            <circle
              cx={cap.x}
              cy={cap.y}
              r={2.2 / transform.k}
              fill="var(--accent)"
              stroke="var(--surface-base)"
              strokeWidth={0.5 / transform.k}
            />
            {placedLabelIds.has(`cap:${cap.id}`) && (
              <text
                x={cap.x}
                y={cap.y + 6 / transform.k}
                fill="var(--text)"
                fontSize={9 / transform.k}
                textAnchor="middle"
                dominantBaseline="hanging"
                opacity={0.85}
                pointerEvents="none"
                style={{ userSelect: "none" }}
              >
                {cap.name}
              </text>
            )}
          </g>
        ))}

      {provinceLabelOpacity > 0 &&
        provinceLabels.map((lbl) =>
          placedLabelIds.has(`prov:${lbl.id}`) ? (
            <text
              key={`lbl-${lbl.id}`}
              x={lbl.x}
              y={lbl.y}
              fill="var(--muted)"
              fontSize={10 / transform.k}
              textAnchor="middle"
              dominantBaseline="central"
              pointerEvents="none"
              opacity={provinceLabelOpacity}
              style={{ userSelect: "none" }}
            >
              {lbl.name}
            </text>
          ) : null
        )}
    </>
  );
}
