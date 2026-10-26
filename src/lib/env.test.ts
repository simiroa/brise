import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isTauri, isBrowser, initBrowserToken, getBrowserToken, isMobileViewport } from "./env";

describe("env.ts — Tauri vs. browser-mode detection", () => {
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    sessionStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("isTauri() is false with no __TAURI_INTERNALS__ (jsdom/plain browser)", () => {
    expect(isTauri()).toBe(false);
  });

  it("isTauri() is true once __TAURI_INTERNALS__ is present", () => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    expect(isTauri()).toBe(true);
  });

  it("isBrowser() is false outside Tauri with no token — every existing test keeps exercising the Tauri invoke path untouched", () => {
    expect(isBrowser()).toBe(false);
  });

  it("isBrowser() is true only once both non-Tauri AND a token are present", () => {
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    sessionStorage.setItem("brise_sync_token", "tok");
    expect(isBrowser()).toBe(false); // still Tauri — token alone isn't enough

    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    expect(isBrowser()).toBe(true);
  });
});

describe("initBrowserToken — ?token= capture on boot", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });
  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("stashes ?token= into sessionStorage and strips it from the address bar", () => {
    window.history.replaceState(null, "", "/app/?token=abc123&foo=bar");

    initBrowserToken();

    expect(getBrowserToken()).toBe("abc123");
    expect(window.location.search).toBe("?foo=bar");
  });

  it("does nothing when there is no ?token= in the URL", () => {
    window.history.replaceState(null, "", "/app/");
    initBrowserToken();
    expect(getBrowserToken()).toBeNull();
  });
});

// Moved here from mobile/MobileApp.test.tsx (W2b, mobile rework integration) — isMobileViewport()
// itself moved from mobile/MobileApp.tsx to this file, see env.ts's header comment on the export.
describe("isMobileViewport", () => {
  it("reads window.matchMedia's max-width:767px query", () => {
    const matchMediaMock = vi.fn().mockReturnValue({ matches: true });
    window.matchMedia = matchMediaMock as unknown as typeof window.matchMedia;
    expect(isMobileViewport()).toBe(true);
    expect(matchMediaMock).toHaveBeenCalledWith("(max-width: 767px)");
  });
});
