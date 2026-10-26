import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 외형 setter 들이 set() 뒤에 지나가는 공통 꼬리(repaint = 시드 저장 → CSS 변수 재칠)를 고정한다.
// 두 절반을 **같이** 본다 — settings.test.ts 는 시드 쪽만 보므로 CSS 변수 쪽이 조용히 빠져도 못 잡는다.
const callMock = vi.fn();

vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
}));

import { useSettingsStore } from "./settings";
import { loadAppearanceSeed } from "../lib/appearance";

const rootVar = (name: string) => document.documentElement.style.getPropertyValue(name);

describe("외형 setter 의 repaint 꼬리 — 시드 저장 + CSS 변수 재칠", () => {
  beforeEach(() => {
    localStorage.clear();
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true });
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-surface");
    document.documentElement.style.cssText = "";
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("setFontScale — 시드 fontScale + --fs", () => {
    useSettingsStore.getState().setFontScale(1.25);
    expect(loadAppearanceSeed().fontScale).toBe(1.25);
    expect(rootVar("--fs")).toBe("1.25");
  });

  it("setBgDim — 시드 bgDim + --bg-dim", () => {
    useSettingsStore.getState().setBgDim(25);
    expect(loadAppearanceSeed().bgDim).toBe(25);
    expect(rootVar("--bg-dim")).toBe("25%");
  });

  it("setSheetAlpha — 시드 sheetAlpha + --sheet-alpha", () => {
    useSettingsStore.getState().setSheetAlpha(0.6);
    expect(loadAppearanceSeed().sheetAlpha).toBe(0.6);
    expect(rootVar("--sheet-alpha")).toBe("0.6");
  });

  it("setBgTone — 시드 bgTone + --app-canvas 가 다시 칠해진다", () => {
    useSettingsStore.getState().setBgTone(0);
    const flat = rootVar("--app-canvas");
    expect(flat).not.toBe("");
    useSettingsStore.getState().setBgTone(6);
    expect(loadAppearanceSeed().bgTone).toBe(6);
    expect(rootVar("--app-canvas")).not.toBe(flat);
  });

  it("setAccent(live) — 시드 accent + --accent", () => {
    void useSettingsStore.getState().setAccent("#ace1af", { live: true });
    expect(loadAppearanceSeed().accent).toBe("#ace1af");
    expect(rootVar("--accent")).not.toBe("");
  });

  it("setAccent(클릭) 실패 롤백 — 이전 accent 로 시드와 --accent 가 함께 되돌아간다", async () => {
    const before = useSettingsStore.getState().accent;
    void useSettingsStore.getState().setAccent(before, { live: true });
    const accentBefore = rootVar("--accent");
    expect(accentBefore).not.toBe("");
    callMock.mockRejectedValueOnce(new Error("boom"));
    await useSettingsStore.getState().setAccent("#d9817a");
    expect(useSettingsStore.getState().accent).toBe(before);
    expect(loadAppearanceSeed().accent).toBe(before);
    expect(rootVar("--accent")).toBe(accentBefore);
  });

  it("setBgSat(live) — 시드 bgSat + --app-canvas", () => {
    void useSettingsStore.getState().setBgSat(30, { live: true });
    expect(loadAppearanceSeed().bgSat).toBe(30);
    expect(rootVar("--app-canvas")).not.toBe("");
  });

  it("setFontFamily — 시드 fontFamily + --font-body/--font-editor", () => {
    void useSettingsStore.getState().setFontFamily("sans");
    expect(loadAppearanceSeed().fontFamily).toBe("sans");
    expect(rootVar("--font-body")).not.toBe("");
    expect(rootVar("--font-editor")).toBe(rootVar("--font-body"));
  });
});
