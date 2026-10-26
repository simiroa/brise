import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import { useState } from "react";
import { RegionPickerFields } from "./RegionPickerDialog";

const callMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
}));
// WorldMap pulls in canvas/measurement machinery this test doesn't care about — only the
// hideFooter/onLocationChange wiring above it is under test here.
let lastMapProps: { defaultLocation?: { lat: number; lng: number; zoom: number } } = {};
vi.mock("./WorldMapAuto", () => ({
  WorldMapAuto: (props: {
    onMapClick?: (lat: number, lng: number) => void;
    defaultLocation?: { lat: number; lng: number; zoom: number };
  }) => {
    lastMapProps = props;
    return (
      <button type="button" data-testid="mock-map-click" onClick={() => props.onMapClick?.(48.8, 2.3)}>
        mock-world-map
      </button>
    );
  },
}));

beforeEach(() => {
  callMock.mockReset();
  // Default: reverse-geocode fails (exercises the non-silent catch path). Forward search unused.
  callMock.mockRejectedValue(new Error("no backend in test"));
});

// Mimics OnboardingWizard's real usage: an inline arrow (new identity every render) passed as
// onLocationChange, lifted into the harness's own state.
function Harness() {
  const [, setDraft] = useState<{ region: string | null; lat: number | null; lng: number | null }>({
    region: null,
    lat: 37.5,
    lng: 127,
  });
  return (
    <RegionPickerFields
      initialRegion={null}
      initialLat={37.5}
      initialLng={127}
      hideFooter
      onCancel={() => {}}
      onSubmit={() => {}}
      onLocationChange={(region, lat, lng) => setDraft({ region, lat, lng })}
    />
  );
}

describe("RegionPickerFields preview camera", () => {
  // Owner QA 2026-08-10: 저장 줌(팩토리 150 ≈ 광역 2.4°)으로 열면 "명동"을 저장했는데 인천
  // 앞바다까지 보이는 뷰가 뜬다 — 초기 카메라는 핀을 도시 스케일(≥320) 이상으로 확대해 연다.
  it("seeds the camera on the pin at city-scale zoom, not the stored wide zoom", () => {
    render(<Harness />);
    expect(lastMapProps.defaultLocation).toEqual({ lat: 37.5, lng: 127, zoom: 320 });
  });
});

describe("RegionPickerFields hideFooter + onLocationChange", () => {
  // Regression: an earlier version keyed the push-up effect on `onLocationChange` itself. A caller
  // (the onboarding wizard) passing a fresh inline arrow every render turned that into an infinite
  // effect -> setState -> re-render -> new arrow -> effect loop, which React reports as "Maximum
  // update depth exceeded". The fix reads the callback through a ref instead of a dependency.
  it("does not loop when the caller passes a fresh inline callback every render", () => {
    expect(() => render(<Harness />)).not.toThrow();
  });
});

describe("RegionPickerFields layout", () => {
  it("splits map/right-column ~6:4 via flex-basis, not fixed pixel widths", () => {
    const { container } = render(
      <RegionPickerFields
        initialRegion={null}
        initialLat={null}
        initialLng={null}
        hideFooter
        onCancel={() => {}}
        onSubmit={() => {}}
      />
    );
    const [left, right] = Array.from(container.querySelectorAll<HTMLElement>(":scope > div > div > div"));
    expect(left.style.flex).toBe("6 6 0%");
    expect(right.style.flex).toBe("4 4 0%");
    expect(left.style.width).toBe("");
    expect(right.style.width).toBe("");
  });

  it("hideFooter + onReset (settings mode) renders Reset next to Clear in the right column", () => {
    render(
      <RegionPickerFields
        initialRegion={null}
        initialLat={null}
        initialLng={null}
        hideFooter
        onReset={() => {}}
        onCancel={() => {}}
        onSubmit={() => {}}
      />
    );
    // Placement, not just presence: Reset must live inside the ~40% right column
    // (flex: '4 4 0%'), not the old MapSection header position.
    // 아이콘 버튼이라 글자 노드가 없다 — testid 에서 DOM 을 거슬러 오른다.
    expect(screen.getByTestId("region-picker-reset").closest('div[style*="4 4 0%"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Reset" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear coordinates" })).toBeTruthy();
    // No duplicated Apply/Cancel footer in hideFooter mode.
    expect(screen.queryByText("Apply")).toBeNull();
  });

  it("hideFooter without onReset (onboarding mode) shows Clear only, no Reset", () => {
    render(
      <RegionPickerFields
        initialRegion={null}
        initialLat={null}
        initialLng={null}
        hideFooter
        onCancel={() => {}}
        onSubmit={() => {}}
      />
    );
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
    expect(screen.getByRole("button", { name: "Clear coordinates" })).toBeTruthy();
  });

  it("non-hideFooter mode (RegionEditor usage) keeps the Cancel/Apply footer, no Reset button", () => {
    render(
      <RegionPickerFields
        initialRegion={null}
        initialLat={null}
        initialLng={null}
        onCancel={() => {}}
        onSubmit={() => {}}
      />
    );
    expect(screen.getByText("Apply")).toBeTruthy();
    expect(screen.getByText("Cancel")).toBeTruthy();
    // RegionEditor 바닥은 설정 창 밖이라 글자 버튼 그대로다.
    expect(screen.getByText("Clear coordinates")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
  });
});

// QA8 1D: reverse-geocode failure must clear a stale label and surface unavailability (no silent catch).
describe("RegionPickerFields reverse-geocode failure", () => {
  it("clears the region label and shows unavailable when reverse geocode rejects", async () => {
    render(
      <RegionPickerFields
        initialRegion="Seoul"
        initialLat={37.5665}
        initialLng={126.978}
        onCancel={() => {}}
        onSubmit={() => {}}
      />
    );

    // Initial mount triggers reverse for initial coords — already rejecting.
    await waitFor(() => {
      expect(screen.getByTestId("region-reverse-unavailable")).toBeTruthy();
    });
    const regionInput = screen.getByPlaceholderText("Region name") as HTMLInputElement;
    expect(regionInput.value).toBe("");

    // Map click to a new pin: still failing reverse must not resurrect the old label.
    await act(async () => {
      screen.getByTestId("mock-map-click").click();
    });
    await waitFor(() => {
      expect(screen.getByTestId("region-reverse-unavailable")).toBeTruthy();
    });
    expect(regionInput.value).toBe("");
  });
});
