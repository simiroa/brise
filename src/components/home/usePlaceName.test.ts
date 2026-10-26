import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { usePlaceName } from "./usePlaceName";
import { call } from "../../lib/invoke";

vi.mock("../../lib/invoke", () => ({ call: vi.fn(), callSilent: vi.fn() }));

const mockCall = vi.mocked(call);

describe("usePlaceName", () => {
  beforeEach(() => {
    mockCall.mockReset();
  });

  it("좌표를 실제 지역 이름으로 바꾼다", async () => {
    mockCall.mockResolvedValue({ label: "명동" });

    const { result } = renderHook(() => usePlaceName({ lat: 37.56, lng: 126.98 }));

    await waitFor(() => expect(result.current).toBe("명동"));
    expect(mockCall).toHaveBeenCalledWith(
      "geocode_reverse",
      expect.objectContaining({ lat: 37.56, lng: 126.98 }),
    );
  });

  it("같은 좌표는 두 번 묻지 않는다(모듈 캐시)", async () => {
    mockCall.mockResolvedValue({ label: "Reims" });

    const first = renderHook(() => usePlaceName({ lat: 49.26, lng: 4.03 }));
    await waitFor(() => expect(first.result.current).toBe("Reims"));

    const second = renderHook(() => usePlaceName({ lat: 49.26, lng: 4.03 }));
    expect(second.result.current).toBe("Reims");
    expect(mockCall).toHaveBeenCalledTimes(1);
  });

  it("오프라인/실패면 null — 호출자가 기존 출처 문구로 폴백한다(빈칸이 아니다)", async () => {
    mockCall.mockRejectedValue(new Error("offline"));

    const { result } = renderHook(() => usePlaceName({ lat: 1.11, lng: 2.22 }));

    await waitFor(() => expect(mockCall).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it("이름 없는 지점(바다 등)도 null", async () => {
    mockCall.mockResolvedValue({ label: null });

    const { result } = renderHook(() => usePlaceName({ lat: 3.33, lng: 4.44 }));

    await waitFor(() => expect(mockCall).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it("좌표가 없으면 아예 묻지 않는다", () => {
    const { result } = renderHook(() => usePlaceName(null));
    expect(result.current).toBeNull();
    expect(mockCall).not.toHaveBeenCalled();
  });
});
