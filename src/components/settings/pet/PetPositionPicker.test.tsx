import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  PetPositionPicker,
  anchorPositions,
  boundsOf,
  isCurrentAnchor,
  toLogicalRect,
  toMapMonitor,
  toMapPoint,
} from "./PetPositionPicker";
import { useSettingsStore } from "../../../stores/settings";

const callMock = vi.fn();
vi.mock("../../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  availableMonitors: async () => [
    { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 },
    // 보조 모니터: 물리 2560x1440 @1.25 → 논리 2048x1152, 주 모니터 왼쪽.
    { position: { x: -2560, y: 0 }, size: { width: 2560, height: 1440 }, scaleFactor: 1.25 },
  ],
  getCurrentWindow: () => ({ label: "main" }),
}));

describe("PetPositionPicker (PLAN-2026-09-15 P7)", () => {
  beforeEach(() => {
    callMock.mockReset().mockImplementation((cmd: string) => {
      if (cmd === "pet_position_reset") return Promise.resolve({ x: 1744, y: 884 });
      return Promise.resolve({ ok: true });
    });
    useSettingsStore.setState({ uiLang: "en" } as never);
  });

  it("모니터 API 의 물리 px + scaleFactor 를 논리 px 로 정규화한다", () => {
    expect(toLogicalRect({ position: { x: -2560, y: 0 }, size: { width: 2560, height: 1440 }, scaleFactor: 1.25 })).toEqual({
      x: -2048,
      y: 0,
      width: 2048,
      height: 1152,
    });
    // 작업영역이 있으면 그쪽이 이긴다 — 우하단 앵커가 Rust default_position(work_area)과 같아야 한다.
    expect(
      toLogicalRect({
        position: { x: 0, y: 0 },
        size: { width: 1920, height: 1080 },
        workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1032 } },
        scaleFactor: 1,
      }),
    ).toEqual({ x: 0, y: 0, width: 1920, height: 1032 });
    expect(boundsOf([
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: -2048, y: 0, width: 2048, height: 1152 },
    ])).toEqual({ x: -2048, y: 0, width: 3968, height: 1152 });
  });

  // 배율이 다른 모니터를 섞으면 "모니터마다 자기 배율로 나눈" 논리 사각형은 겹친다(1920@1 오른쪽의
  // 물리 x=1920 @1.5 모니터 → 논리 x=1280). 미니맵 그림은 물리 공간에 놓아 실제 배치대로 붙인다.
  it("배율이 섞인 모니터도 미니맵에선 하나의 물리 좌표계로 겹치지 않게 놓인다", () => {
    const primary = toMapMonitor({ position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 }, scaleFactor: 1 });
    const right = toMapMonitor({ position: { x: 1920, y: 0 }, size: { width: 3840, height: 2160 }, scaleFactor: 1.5 });
    expect(right.logical.x).toBe(1280); // 저장 규약(Rust 와 같음)에선 주 모니터와 겹친다
    expect(right.physical.x).toBe(primary.physical.x + primary.physical.width); // 그림에선 바로 옆
    // 오른쪽 모니터의 펫(논리 좌표) → 그 모니터 배율로 물리 공간에 옮겨진다.
    const p = toMapPoint({ x: right.logical.x + 100, y: 50 }, [right, primary]);
    expect(p).toEqual({ x: 1920 + 150, y: 75, scale: 1.5 });
  });

  it("3×3 앵커는 펫 창 크기·여백을 반영한 창 좌상단 좌표다", () => {
    const anchors = anchorPositions({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(anchors).toHaveLength(9);
    expect(anchors[0]).toMatchObject({ col: 0, row: 0, x: 16, y: 16 });
    expect(anchors[8]).toMatchObject({ col: 2, row: 2, x: 1744, y: 884 });
    expect(anchors[4]).toMatchObject({ col: 1, row: 1, x: 880, y: 450 });
    expect(isCurrentAnchor({ x: 1744, y: 884 }, { x: 1750, y: 880 })).toBe(true);
    expect(isCurrentAnchor({ x: 1744, y: 884 }, { x: 16, y: 16 })).toBe(false);
    expect(isCurrentAnchor({ x: 16, y: 16 }, null)).toBe(false);
  });

  it("앵커 클릭이 pet_set_position 을 부르고, 현재 위치 점은 채워져 있다", async () => {
    const onChange = vi.fn();
    render(<PetPositionPicker current={{ x: 1744, y: 884 }} onCurrentChange={onChange} />);
    const current = await screen.findByTestId("settings-pet-anchor-0-2-2");
    await waitFor(() => expect(current.getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByTestId("settings-pet-anchor-0-0-0").getAttribute("aria-label")).toBe("Top left");
    expect(current.getAttribute("aria-label")).toBe("Bottom right");

    await userEvent.click(screen.getByTestId("settings-pet-anchor-0-0-0"));
    expect(callMock).toHaveBeenCalledWith("pet_set_position", { x: 16, y: 16 });
    expect(onChange).toHaveBeenCalledWith({ x: 16, y: 16 });
  });

  it("앵커가 아닌 자유 위치도 펫 창 크기의 사각형으로 그린다, 이동 실패는 되돌린다", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<PetPositionPicker current={null} onCurrentChange={onChange} />);
    await screen.findByTestId("settings-pet-monitor-0");
    // 저장값 없음 = 기본 위치(우하단 앵커)에 떠 있다 — 비워 두지 않는다
    expect(screen.getByTestId("settings-pet-anchor-0-2-2").getAttribute("aria-pressed")).toBe("true");
    rerender(<PetPositionPicker current={{ x: 500, y: 300 }} onCurrentChange={onChange} />);
    expect(screen.getByTestId("settings-pet-position-current")).toBeTruthy();
    // 자유 위치라 어떤 앵커도 채워지지 않는다
    expect(screen.getByTestId("settings-pet-anchor-0-0-0").getAttribute("aria-pressed")).toBe("false");

    callMock.mockRejectedValueOnce(new Error("boom"));
    await userEvent.click(screen.getByTestId("settings-pet-anchor-0-0-0"));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ x: 500, y: 300 }));
  });

  it("두 모니터가 실제 배치대로 그려지고 기본 위치 버튼은 pet_position_reset 을 부른다", async () => {
    const onChange = vi.fn();
    render(<PetPositionPicker current={null} onCurrentChange={onChange} />);
    expect(await screen.findByTestId("settings-pet-monitor-0")).toBeTruthy();
    expect(screen.getByTestId("settings-pet-monitor-1")).toBeTruthy();
    // 보조 모니터가 왼쪽(논리 x=-2048)이므로 미니맵에서도 주 모니터보다 왼쪽이다.
    const left = (el: HTMLElement) => parseFloat(el.style.left);
    expect(left(screen.getByTestId("settings-pet-monitor-1"))).toBeLessThan(
      left(screen.getByTestId("settings-pet-monitor-0")),
    );

    await userEvent.click(screen.getByTestId("settings-pet-position-reset"));
    expect(callMock).toHaveBeenCalledWith("pet_position_reset", {});
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ x: 1744, y: 884 }));
  });
});
