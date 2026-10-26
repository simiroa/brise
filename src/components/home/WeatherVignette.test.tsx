import { describe, it, expect, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { WeatherVignette, sceneFor } from "./WeatherVignette";

// jsdom has no matchMedia — usePrefersReducedMotion (used inside the Meteocons icon components
// now, not WeatherVignette itself) reads it on mount. Flip `mediaMatches` per test to simulate
// the OS reduced-motion pref.
let mediaMatches = false;
beforeEach(() => {
  mediaMatches = false;
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: mediaMatches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

describe("sceneFor", () => {
  it("maps representative WMO codes to the same buckets as weatherLabelKey", () => {
    expect(sceneFor(0)).toBe("clear");
    expect(sceneFor(1)).toBe("partly_cloudy");
    expect(sceneFor(2)).toBe("partly_cloudy");
    expect(sceneFor(3)).toBe("overcast");
    expect(sceneFor(45)).toBe("fog");
    expect(sceneFor(61)).toBe("rain");
    expect(sceneFor(67)).toBe("rain"); // heavy-rain sub-variant stays in the rain bucket/scene
    expect(sceneFor(71)).toBe("snow");
    expect(sceneFor(80)).toBe("showers");
    expect(sceneFor(95)).toBe("thunder");
    expect(sceneFor(99)).toBe("thunder");
    expect(sceneFor(12345)).toBe("unknown");
  });
});

// Meteocons icons (assets/weather/icons.tsx) bake their own motion into SMIL <animate>/
// <animateTransform> tags — sun rays turning, clouds drifting, rain/snow actually falling. That
// replaced WeatherVignette's old wx-* CSS animation classes and its separate falling-streak/dot
// decoration layer entirely, so there's nothing left here to assert per-scene beyond "the right
// icon rendered, no leftover decoration markup".
describe("WeatherVignette", () => {
  it.each([
    ["clear", 0],
    ["partly_cloudy", 1],
    ["overcast", 3],
    ["fog", 45],
    ["rain", 61],
    ["showers", 80],
    ["snow", 71],
    ["thunder", 95],
    ["unknown", 12345],
  ] as const)("%s (code %i) renders the icon, no wx-* decoration layer", (scene, code) => {
    const { getByTestId } = render(<WeatherVignette weatherCode={code} tempC={20} />);
    const box = getByTestId("weather-vignette");
    expect(box.getAttribute("data-scene")).toBe(scene);
    expect(box.querySelector("svg")).toBeTruthy();
    expect(box.querySelectorAll(".wx-streak, .wx-streak-dense, .wx-dot").length).toBe(0);
  });

  it("renders modern vector weather SVG with micro-animation classes", () => {
    const { getByTestId } = render(<WeatherVignette weatherCode={61} tempC={18} />);
    const svg = getByTestId("weather-vignette").querySelector("svg");
    expect(svg?.getAttribute("class")).toContain("wx-icon");
    expect(svg?.querySelector(".wx-drop")).toBeTruthy();
  });
});

describe("WeatherVignette modern line icons", () => {
  it("renders crisp vector paths matching line aesthetic", () => {
    const { getByTestId } = render(<WeatherVignette weatherCode={95} tempC={22} />);
    const svg = getByTestId("weather-vignette").querySelector("svg");
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute("class")).toContain("wx-thunder");
  });
});
