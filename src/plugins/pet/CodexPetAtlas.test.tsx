import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_PET_ATLAS,
  CodexPetAtlas,
  framePosition,
  framesForClip,
  framesForState,
  gazeFrame,
  rowsForHeight,
} from "./CodexPetAtlas";

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("CodexPetAtlas", () => {
  it("matches the Codex v2 atlas contract", () => {
    expect(CODEX_PET_ATLAS).toEqual({
      width: 1536,
      height: 2288,
      cellWidth: 192,
      cellHeight: 208,
      columns: 8,
      rows: 11,
    });
    expect(framesForState("idle")).toHaveLength(6);
    expect(framesForState("running-right").slice(0, 8)).toMatchObject([
      { row: 1, column: 0, durationMs: 120 },
      { row: 1, column: 1, durationMs: 120 },
      { row: 1, column: 2, durationMs: 120 },
      { row: 1, column: 3, durationMs: 120 },
      { row: 1, column: 4, durationMs: 120 },
      { row: 1, column: 5, durationMs: 120 },
      { row: 1, column: 6, durationMs: 120 },
      { row: 1, column: 7, durationMs: 220 },
    ]);
    expect(framePosition({ row: 10, column: 7 })).toBe("100% 100%");
  });

  it("advances frames with Codex timing and freezes for reduced motion", () => {
    vi.useFakeTimers();
    const { getByRole, rerender } = render(<CodexPetAtlas dataUrl="data:image/webp;base64,AA==" />);
    const sprite = getByRole("img");
    expect(sprite.style.backgroundPosition).toBe("0% 0%");
    vi.advanceTimersByTime(280);
    expect(sprite.style.backgroundPosition).toBe(framePosition({ row: 0, column: 1 }));

    rerender(<CodexPetAtlas dataUrl="data:image/webp;base64,AA==" state="jumping" reducedMotion />);
    expect(sprite.style.backgroundPosition).toBe("0% 40%");
    vi.advanceTimersByTime(5_000);
    expect(sprite.style.backgroundPosition).toBe("0% 40%");
    vi.useRealTimers();
  });

  afterEach(() => {
    setVisibility("visible");
  });

  it("loop 모드는 idle(row 0) 프레임을 이어붙이지 않는다", () => {
    for (const state of ["waiting", "review", "running", "running-right", "running-left"] as const) {
      const frames = framesForState(state);
      expect(frames.every((frame) => frame.row !== 0)).toBe(true);
    }
  });

  it("reaction 모드는 반응 3회 + 느린 idle을 이어붙인다", () => {
    const frames = framesForState("waving");
    const reactionLen = 4; // waving durations 길이
    expect(frames.slice(0, reactionLen * 3).every((frame) => frame.row === 3)).toBe(true);
    expect(frames.slice(reactionLen * 3).every((frame) => frame.row === 0)).toBe(true);
  });

  it("gazeFrame이 각도를 16방향으로 정규화한다", () => {
    expect(gazeFrame(0)).toMatchObject({ row: 9, column: 0, durationMs: 0 });
    expect(gazeFrame(359)).toMatchObject({ row: 9, column: 0 });
    expect(gazeFrame(-90)).toMatchObject({ row: 10, column: 4 });
    expect(gazeFrame(90)).toMatchObject({ row: 9, column: 4 });
    expect(gazeFrame(11.24)).toMatchObject({ row: 9, column: 0 });
    expect(gazeFrame(11.26)).toMatchObject({ row: 9, column: 1 });
    expect(gazeFrame(360)).toMatchObject({ row: 9, column: 0 });
  });

  it("gazeFrame은 항상 row 9~10, column 0~7 범위다", () => {
    for (let angle = 0; angle < 360; angle += 7) {
      const frame = gazeFrame(angle);
      expect([9, 10]).toContain(frame.row);
      expect(frame.column).toBeGreaterThanOrEqual(0);
      expect(frame.column).toBeLessThanOrEqual(7);
    }
  });

  // PLAN-2026-09-15 P1: 8×9 배포본에는 시선 행(9·10)이 없다 — idle 첫 프레임으로 폴백한다.
  it("9행 아틀라스에서는 시선이 idle 프레임으로 폴백한다", () => {
    for (const angle of [0, 45, 90, 180, 270]) {
      expect(gazeFrame(angle, 9)).toMatchObject({ row: 0, column: 0 });
    }
    expect(gazeFrame(90, 11)).toMatchObject({ row: 9, column: 4 });
    expect(rowsForHeight(1872)).toBe(9);
    expect(rowsForHeight(2288)).toBe(11);
    // 마지막 행이 100% 가 되도록 rows 로 나눈다 — 9행에서 11행 분모를 쓰면 프레임이 밀린다.
    expect(framePosition({ row: 8, column: 7 }, 9)).toBe("100% 100%");
    expect(framePosition({ row: 8, column: 7 })).not.toBe("100% 100%");
  });

  it("clips에 look-a/look-b가 없으면 시선은 idle 첫 프레임이다", () => {
    const clips = [{ name: "idle", row: 0, frames: 2 }];
    for (const angle of [0, 90, 180]) {
      expect(gazeFrame(angle, 11, clips)).toMatchObject({ row: 0, column: 0 });
    }
  });

  it("clips 표의 프레임 수가 하드코드 행을 이긴다", () => {
    const idleOnly = [{ name: "idle", row: 0, frames: 2 }];
    const waving = framesForClip("waving", idleOnly);
    expect(waving).toHaveLength(2);
    expect(waving.every((frame) => frame.row === 0)).toBe(true);

    const jumping = framesForClip("jumping", idleOnly);
    expect(jumping.every((frame) => frame.row === 0)).toBe(true);
    expect(jumping).toHaveLength(2);

    const withWave = [
      { name: "idle", row: 0, frames: 6 },
      { name: "waving", row: 3, frames: 4 },
    ];
    expect(framesForClip("waving", withWave).slice(0, 4).every((frame) => frame.row === 3)).toBe(true);
  });

  it("clips가 idle 2프레임뿐이면 waving 행을 읽지 않는다", () => {
    vi.useFakeTimers();
    const clips = [{ name: "idle", row: 0, frames: 2 }];
    const { getByRole } = render(
      <CodexPetAtlas dataUrl="data:image/webp;base64,AA==" state="waving" clips={clips} />,
    );
    const sprite = getByRole("img");
    expect(sprite.getAttribute("data-codex-pet-state")).toBe("waving");
    expect(sprite.style.backgroundPosition).toBe("0% 0%");
    vi.advanceTimersByTime(280);
    expect(sprite.style.backgroundPosition).toBe(framePosition({ row: 0, column: 1 }));
    expect(sprite.style.backgroundPosition).not.toBe(framePosition({ row: 3, column: 1 }));
    vi.useRealTimers();
  });

  it("9행 패키지는 rows prop 으로 배경 크기가 9배가 된다", () => {
    const { getByRole } = render(
      <CodexPetAtlas dataUrl="data:image/webp;base64,AA==" rows={9} facing={90} />,
    );
    const sprite = getByRole("img");
    expect(sprite.style.backgroundSize).toBe("800% 900%");
    expect(sprite.style.backgroundPosition).toBe("0% 0%");
  });

  it("facing prop이 있으면 타이머 없이 정적 프레임만 표시한다", () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    const { getByRole } = render(<CodexPetAtlas dataUrl="data:image/webp;base64,AA==" facing={90} />);
    const sprite = getByRole("img");
    expect(sprite.style.backgroundPosition).toBe(framePosition(gazeFrame(90)));
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(sprite.style.backgroundPosition).toBe(framePosition(gazeFrame(90)));
    setTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });

  it("reducedMotion + loop 모드는 첫 프레임 1장만 표시한다", () => {
    expect(framesForState("waiting", true)).toHaveLength(1);
    expect(framesForState("running", true)).toHaveLength(1);
  });

  it("visibilitychange로 hidden이 되면 타이머가 멈춘다", () => {
    vi.useFakeTimers();
    const { getByRole } = render(<CodexPetAtlas dataUrl="data:image/webp;base64,AA==" state="waiting" />);
    const sprite = getByRole("img");
    const frameAtHidden = sprite.style.backgroundPosition;

    setVisibility("hidden");
    vi.advanceTimersByTime(5_000);
    expect(sprite.style.backgroundPosition).toBe(frameAtHidden);

    setVisibility("visible");
    vi.advanceTimersByTime(150);
    expect(sprite.style.backgroundPosition).not.toBe(frameAtHidden);
    vi.useRealTimers();
  });
});
