import { describe, it, expect } from "vitest";
import { isPhoneUnavailableMode, PHONE_EXCLUDED_MODES } from "./phoneRoster";

describe("phoneRoster", () => {
  it("excludes nothing since 2026-10-06; chat is unavailable only while AI is off (desktop parity)", () => {
    expect([...PHONE_EXCLUDED_MODES]).toEqual([]);
    expect(isPhoneUnavailableMode("chat")).toBe(false);
    expect(isPhoneUnavailableMode("chat", false)).toBe(true);
    expect(isPhoneUnavailableMode("region")).toBe(false);
    expect(isPhoneUnavailableMode("timeline")).toBe(false);
    expect(isPhoneUnavailableMode("gallery")).toBe(false);
    expect(isPhoneUnavailableMode("calendar")).toBe(false);
    expect(isPhoneUnavailableMode("tree")).toBe(false);
  });
});
