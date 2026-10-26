import { describe, it, expect } from "vitest";
import {
  formatHeaderDate,
  formatHeaderTime,
  greetingPeriod,
  localeForUiLang,
} from "./greeting";

describe("greetingPeriod", () => {
  it("partitions hours into morning/afternoon/evening/night", () => {
    const at = (h: number) => {
      const d = new Date(2026, 6, 31, h, 0, 0);
      return greetingPeriod(d);
    };
    expect(at(5)).toBe("morning");
    expect(at(11)).toBe("morning");
    expect(at(12)).toBe("afternoon");
    expect(at(17)).toBe("afternoon");
    expect(at(18)).toBe("evening");
    expect(at(21)).toBe("evening");
    expect(at(22)).toBe("night");
    expect(at(0)).toBe("night");
    expect(at(4)).toBe("night");
  });
});

describe("formatHeaderDate / locale", () => {
  it("maps uiLang to locale tags", () => {
    expect(localeForUiLang("ko")).toBe("ko-KR");
    expect(localeForUiLang("fr")).toBe("fr-FR");
    expect(localeForUiLang("en")).toBe("en-US");
  });

  it("formats a fixed date without year", () => {
    const d = new Date(2026, 6, 31); // July 31 2026
    const en = formatHeaderDate(d, "en");
    expect(en.toLowerCase()).toContain("july");
    expect(en).toMatch(/31/);
    expect(en).not.toMatch(/2026/);
  });
});

describe("formatHeaderTime", () => {
  it("formats HH:MM in 24h regardless of locale (en-US would default to 12h/AM-PM)", () => {
    const d = new Date(2026, 6, 31, 14, 5, 0);
    for (const lang of ["en", "ko", "fr"]) {
      const s = formatHeaderTime(d, lang);
      expect(s).toMatch(/^\d{2}:\d{2}$/);
      expect(s.startsWith("14")).toBe(true);
    }
  });

  it("pads minutes under 10", () => {
    const d = new Date(2026, 6, 31, 9, 3, 0);
    expect(formatHeaderTime(d, "en")).toMatch(/^09:03$/);
  });
});
