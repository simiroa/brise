import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const callSilent = vi.fn();
vi.mock("../lib/invoke", () => ({
  call: vi.fn(),
  callSilent: (...a: unknown[]) => callSilent(...a),
  emitNotice: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(() => () => {}),
}));
const reportFallback = vi.fn();
vi.mock("../lib/diag", () => ({ reportFallback: (...a: unknown[]) => reportFallback(...a) }));
const getCurrentPosition = vi.fn();
vi.mock("../lib/currentPosition", async (orig) => ({
  ...(await orig<typeof import("../lib/currentPosition")>()),
  getCurrentPosition: () => getCurrentPosition(),
}));

import { useSettingsStore } from "../stores/settings";
import { MobileRegionSheet } from "./MobileRegionSheet";
import { resetLocationDenied, isLocationDenied } from "./useCurrentLocationApply";
import { CurrentPositionError } from "../lib/currentPosition";

function setup() {
  const props = { region: null, uiLang: "ko", setRegion: vi.fn(), setLocation: vi.fn(), onClose: vi.fn() };
  render(<MobileRegionSheet {...props} />);
  return props;
}
const tap = () => fireEvent.click(screen.getByRole("button", { name: /현재 위치/ }));

describe("MobileRegionSheet 현재 위치 행", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLocationDenied();
    useSettingsStore.setState({ uiLang: "ko" });
  });

  it("탭 → 좌표 → geocode_reverse → setRegion/setLocation 후 닫힘", async () => {
    getCurrentPosition.mockResolvedValue({ lat: 37.5665, lng: 126.978 });
    callSilent.mockResolvedValue({ label: "서울특별시, 대한민국" });
    const p = setup();
    tap();
    await waitFor(() => expect(p.onClose).toHaveBeenCalled());
    expect(callSilent).toHaveBeenCalledWith("geocode_reverse", { lat: 37.5665, lng: 126.978, lang: "ko" });
    expect(p.setRegion).toHaveBeenCalledWith("서울특별시");
    expect(p.setLocation).toHaveBeenCalledWith(37.5665, 126.978);
  });

  it("이름 변환 실패는 'lat, lng' 로 폴백하고 기록한다", async () => {
    getCurrentPosition.mockResolvedValue({ lat: 37.56654, lng: 126.97801 });
    callSilent.mockRejectedValue(new Error("offline"));
    const p = setup();
    tap();
    await waitFor(() => expect(p.setRegion).toHaveBeenCalledWith("37.5665, 126.9780"));
    expect(reportFallback).toHaveBeenCalledWith("location", "geocode_failed");
  });

  it("권한 거부: 사용자 말로 표시, 닫히지 않음, denied 기억", async () => {
    getCurrentPosition.mockRejectedValue(new CurrentPositionError("no_permission"));
    const p = setup();
    tap();
    expect(await screen.findByText(/위치 권한이 꺼져/)).toBeTruthy();
    expect(p.onClose).not.toHaveBeenCalled();
    expect(p.setRegion).not.toHaveBeenCalled();
    expect(isLocationDenied()).toBe(true);
    expect(callSilent).not.toHaveBeenCalled();
  });

  it("타임아웃도 사용자 말로 표시", async () => {
    getCurrentPosition.mockRejectedValue(new CurrentPositionError("timeout"));
    setup();
    tap();
    expect(await screen.findByText(/위치를 확인하지 못했습니다\. 잠시/)).toBeTruthy();
  });
});
