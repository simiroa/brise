import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { FolderColorPresets } from "./FolderColorPresets";

// 트리 글리프의 색 팝오버(구 FolderColorControl)는 폴더 설정 모달로 흡수되며 사라졌다 — 남은
// 소비자는 아직 모달이 없는 폴더 생성 다이얼로그 하나뿐이라, 프리셋 줄 자체만 검증한다.
describe("FolderColorPresets", () => {
  it("reports the picked hue and the reset choice", () => {
    const onPick = vi.fn();
    render(<FolderColorPresets value={null} onPick={onPick} />);

    fireEvent.click(screen.getByRole("button", { name: "90°" }));
    expect(onPick).toHaveBeenCalledWith(90);

    fireEvent.click(screen.getByRole("button", { name: /재설정|Reset|Réinitialiser/i }));
    expect(onPick).toHaveBeenCalledWith(null);
  });

  it("marks the active hue so the current colour is visible in the row", () => {
    render(<FolderColorPresets value={90} onPick={vi.fn()} />);
    expect(screen.getByRole("button", { name: "90°" }).getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByRole("button", { name: /재설정|Reset|Réinitialiser/i }).getAttribute("aria-pressed")
    ).toBe("false");
  });
});
