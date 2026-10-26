import { describe, it, expect, beforeEach } from "vitest";
import { applyCssVars, DEFAULT_APPEARANCE_SEED } from "./appearance";

/**
 * 회귀 가드: 아크릴이 실제로 걸린 창에서 문서 캔버스(html/body)가 불투명하게 남지 않는지.
 *
 * 2026-08-30 `e925d6fb` 가 index.html 에 `html,body{background-color:var(--boot-bg)}` 를 넣어
 * 부팅 첫 페인트 깜빡임을 없앴는데, 그 불투명 칠을 **걷어내는 단계가 없어서** 웹뷰가 매 픽셀
 * 불투명해졌고(Chromium 이 root 배경을 뷰포트 캔버스로 전파) transparent:true 창 뒤의 DWM
 * Acrylic 이 원리상 보이지 않았다. applyCssVars 가 --boot-bg 를 되돌리는 단일 지점이다.
 */
describe("applyCssVars — --boot-bg (acrylic 문서 캔버스)", () => {
  const base = { ...DEFAULT_APPEARANCE_SEED };
  const bootBg = () => document.documentElement.style.getPropertyValue("--boot-bg");

  beforeEach(() => {
    document.documentElement.style.removeProperty("--boot-bg");
  });

  it("아크릴이 실제로 적용된 창에서는 --boot-bg 가 transparent 로 내려간다", () => {
    applyCssVars({ ...base, surfaceStyle: "acrylic", surfaceEffectApplied: true });
    expect(document.documentElement.getAttribute("data-surface")).toBe("acrylic");
    expect(bootBg()).toBe("transparent");
  });

  it("flat 으로 되돌리면 transparent 가 남지 않는다", () => {
    applyCssVars({ ...base, surfaceStyle: "acrylic", surfaceEffectApplied: true });
    applyCssVars({ ...base, surfaceStyle: "flat", surfaceEffectApplied: true });
    expect(document.documentElement.getAttribute("data-surface")).toBe("flat");
    expect(bootBg()).not.toBe("transparent");
  });

  it("아크릴을 골랐어도 OS 효과가 실패했으면(flat 으로 내려앉음) 캔버스를 뚫지 않는다", () => {
    applyCssVars({ ...base, surfaceStyle: "acrylic", surfaceEffectApplied: false });
    expect(document.documentElement.getAttribute("data-surface")).toBe("flat");
    expect(bootBg()).not.toBe("transparent");
  });
});
