import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getMobileTheme,
  getMobileFontSize,
  setMobileTheme,
  setMobileFontSize,
  applyMobilePrefs,
} from "./mobilePrefs";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.body.innerHTML = '<div class="mobile-app"></div>';
});
afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("mobile theme prefs", () => {
  it("defaults to system and persists an explicit choice", () => {
    expect(getMobileTheme()).toBe("system");
    setMobileTheme("dark");
    expect(getMobileTheme()).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("system resolves against prefers-color-scheme: light", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("light"),
      addEventListener: () => {},
    }));
    setMobileTheme("system");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});

describe("mobile font size prefs", () => {
  it("defaults to medium and applies --fs on .mobile-app only", () => {
    expect(getMobileFontSize()).toBe("medium");
    setMobileFontSize("large");
    expect(getMobileFontSize()).toBe("large");
    const el = document.querySelector(".mobile-app") as HTMLElement;
    expect(el.style.getPropertyValue("--fs")).toBe("1.15");
  });
});

describe("applyMobilePrefs", () => {
  it("applies the persisted theme and font size on call", () => {
    localStorage.setItem("brise_mobile_theme", "light");
    localStorage.setItem("brise_mobile_font_size", "small");
    applyMobilePrefs();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    const el = document.querySelector(".mobile-app") as HTMLElement;
    expect(el.style.getPropertyValue("--fs")).toBe("0.9");
  });
});
