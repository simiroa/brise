import { describe, it, expect } from "vitest";
import { isFatalGlError } from "./glErrorClassify";

/**
 * D4(AUDIT-2026-09-26): isFatalGlError 자체엔 버그가 없다 — 문제는 이 분류기가 "잘 모르겠다"고
 * 답해야 정상인 두 입력(연속 타일 실패, webglcontextlost)을 WorldMapAuto 가 재분류에 쓰던
 * 것이었다(WorldMapGL.tsx/WorldMapAuto.tsx 쪽에서 onGlFatal 로 분리해 고쳤다). 여기 테스트는
 * 그 전제 — 이 두 입력에 대해 이 함수가 실제로 false 를 반환한다는 것 — 을 고정한다.
 */
describe("isFatalGlError", () => {
  it("falsy 입력은 비치명", () => {
    expect(isFatalGlError(null)).toBe(false);
    expect(isFatalGlError(undefined)).toBe(false);
  });

  it("메시지에 webgl/context lost/unsupported 가 있으면 치명", () => {
    expect(isFatalGlError({ message: "WebGL context creation failed" })).toBe(true);
    expect(isFatalGlError(new Error("WebGL is unsupported on this device"))).toBe(true);
  });

  it("dataType이 style 이거나 style 관련 URL/메시지면 치명 (지도 자체를 못 그림)", () => {
    expect(isFatalGlError({ dataType: "style" })).toBe(true);
    expect(isFatalGlError({ error: { url: "https://x/styles/dark.json" } })).toBe(true);
    expect(isFatalGlError({ error: { url: "https://x/style.json" } })).toBe(true);
    expect(isFatalGlError({ message: "Failed to load style" })).toBe(true);
  });

  it("단순 타일/글리프/스프라이트 오류는 비치명 (렌더러 자체 복구 가능)", () => {
    expect(isFatalGlError({ tile: {}, message: "tile 404" })).toBe(false);
    expect(isFatalGlError({ dataType: "tile" })).toBe(false);
    expect(isFatalGlError({ dataType: "source" })).toBe(false);
    expect(isFatalGlError({ dataType: "glyphs" })).toBe(false);
    expect(isFatalGlError({ dataType: "sprite" })).toBe(false);
    expect(isFatalGlError({ error: { url: "https://x/tiles/1/2/3.pbf" } })).toBe(false);
    expect(isFatalGlError({ error: { url: "https://x/fonts/Regular/0-255.pbf" } })).toBe(false);
    expect(isFatalGlError({ message: "tile fetch aborted" })).toBe(false);
  });

  it("404는 style 관련이 아니면 비치명", () => {
    expect(isFatalGlError({ error: { status: 404, url: "https://x/tiles/1/2/3.pbf" } })).toBe(false);
  });

  it("D4 회귀 고정 — 초기 타일 연속 실패는 이 분류기가 스스로 못 잡는다 (WorldMapGL이 횟수로 직접 판단해 onGlFatal 로 보내야 하는 이유)", () => {
    // WorldMapGL.tsx 의 8회 연속 카운터가 넘기는 것과 같은 모양(tile:true, message에 'tile') —
    // 이 함수 혼자서는 "8번째"라는 걸 모르므로 항상 false. 그래서 WorldMapGL 자신의 카운터
    // 판단을 onGlFatal 로 분리해 이 재분류를 아예 안 거치게 한 것이다.
    expect(isFatalGlError({ tile: {}, message: "tile load failed" })).toBe(false);
  });

  it("D4 회귀 고정 — webglcontextlost 의 실제 MapLibre 이벤트 모양은 String() 하면 '[object Object]'라 늘 비치명 오판된다", () => {
    // maplibre-gl 의 MapContextEvent 실제 모양: { type: 'webglcontextlost', originalEvent: WebGLContextEvent }.
    // message 필드가 없어 String(errObj) 가 "[object Object]" 로 떨어지고, 그 문자열은 어떤
    // 치명 패턴에도 안 걸린다 — 그래서 WorldMapGL 이 이 이벤트만은 onGlFatal 로 직접 보낸다.
    const originalEvent = { statusMessage: "context lost" }; // 실제론 WebGLContextEvent, 테스트엔 최소 모양만 필요
    const mapLibreShapedEvent = { type: "webglcontextlost", originalEvent };
    expect(isFatalGlError(mapLibreShapedEvent)).toBe(false);
    expect(String((mapLibreShapedEvent as unknown as Record<string, unknown>))).toBe("[object Object]");
  });
});
