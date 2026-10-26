import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MapSection } from "./MapSection";
import { useSettingsStore } from "../../stores/settings";

// WorldMap pulls in canvas/measurement machinery this test doesn't care about. `call` resolves
// so pin moves persist (setDefaultMapLocation catches a rejection itself and rolls back).
// Two probe buttons drive the real RegionPickerFields wiring: a map click (pin move → location
// change) and a wheel-zoom report (onViewChange → MapSection's live-zoom capture).
vi.mock("../map/WorldMapAuto", () => ({
  WorldMapAuto: (props: {
    onMapClick?: (lat: number, lng: number) => void;
    onViewChange?: (v: { lat: number; lng: number; zoom: number }) => void;
  }) => (
    <div>
      <button type="button" data-testid="mock-map-click" onClick={() => props.onMapClick?.(48.8, 2.3)}>
        map-click
      </button>
      <button
        type="button"
        data-testid="mock-map-zoom"
        onClick={() => props.onViewChange?.({ lat: 48.8, lng: 2.3, zoom: 333 })}
      >
        map-zoom
      </button>
    </div>
  ),
}));
vi.mock("../../lib/invoke", () => ({
  call: vi.fn().mockResolvedValue({}),
  callSilent: vi.fn().mockResolvedValue({}),
}));

describe("MapSection", () => {
  it("has no numeric lat/lng/zoom inputs (replaced by the map+search picker)", () => {
    render(<MapSection />);
    expect(document.querySelectorAll('input[type="number"]').length).toBe(0);
  });

  it("Reset does not write settings — it just re-seeds the picker to the saved default", async () => {
    // Move the saved default away from the factory value first, so a wrongful write back to
    // factory would be visible.
    await useSettingsStore.getState().setDefaultMapLocation({ lat: 10, lng: 20, zoom: 80 });
    render(<MapSection />);
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(useSettingsStore.getState().defaultMapLocation).toEqual({ lat: 10, lng: 20, zoom: 80 });
  });

  // Owner QA 2026-08-10: 저장된 홈 = 미리보기에 보이던 뷰. The picker map's live zoom rides along
  // when the pin moves, instead of pinning the stored (factory 150) zoom forever.
  it("saving a new pin location captures the preview map's live zoom", async () => {
    await useSettingsStore.getState().setDefaultMapLocation({ lat: 10, lng: 20, zoom: 80 });
    render(<MapSection />);
    fireEvent.click(screen.getByTestId("mock-map-zoom"));
    fireEvent.click(screen.getByTestId("mock-map-click"));
    expect(useSettingsStore.getState().defaultMapLocation).toEqual({ lat: 48.8, lng: 2.3, zoom: 333 });
  });

  // 카드는 호출자(ViewSection)가 소유한다 — MapSection 은 자기 카드를 그리지 않는다.
  it("renders content only, never its own card", () => {
    const { container } = render(<MapSection />);
    expect(container.querySelector(".card")).toBeNull();
    expect(screen.getByTestId("settings-map")).toBeTruthy();
  });

  it("Reset moved out of the section header into the picker's right column", () => {
    render(<MapSection />);
    // The header row is just the label now — no button sits next to it anymore.
    expect(screen.queryByText("Default Location")).toBeNull();
    expect(screen.getByRole("button", { name: "Reset" })).toBeTruthy();
  });
});
