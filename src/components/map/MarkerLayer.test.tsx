import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MarkerLayer, type MapMarker } from "./MarkerLayer";

// Regression guard: MarkerLayer is shared by the sidebar map (RegionExpanded) and the home map
// tab. Home map's note-region waypoints render with an explicit `color` override (--info);
// the sidebar map never sets it and must keep its original hollow-ring look.
function renderMarkers(markers: MapMarker[]) {
  return render(
    <svg>
      <MarkerLayer
        markers={markers}
        viewSize={{ width: 600, height: 400 }}
        transform={{ k: 1, x: 0, y: 0 }}
        movingMarkerId={null}
        hasMovedRef={{ current: false }}
        markerMovedRef={{ current: false }}
        onMarkerPointerDown={() => {}}
      />
    </svg>
  );
}

describe("MarkerLayer waypoint styling", () => {
  it("defaults to the sidebar map's hollow ring (surface-base fill / accent stroke) without a color override", () => {
    const { container } = renderMarkers([
      { id: "wp:1", lat: 10, lng: 20, pinSize: "waypoint", interactive: false },
    ]);
    const circle = container.querySelector("g circle");
    expect(circle?.getAttribute("fill")).toBe("var(--surface-base)");
    expect(circle?.getAttribute("stroke")).toBe("var(--accent)");
  });

  it("uses the color override as a solid fill when provided (home map waypoint accent)", () => {
    const { container } = renderMarkers([
      {
        id: "wp:1",
        lat: 10,
        lng: 20,
        pinSize: "waypoint",
        interactive: false,
        color: "var(--info)",
      },
    ]);
    const circle = container.querySelector("g circle");
    expect(circle?.getAttribute("fill")).toBe("var(--info)");
    expect(circle?.getAttribute("stroke")).toBe("var(--surface-base)");
  });
});
