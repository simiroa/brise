import { describe, it, expect, beforeEach } from "vitest";
import { getLocMode, setLocMode } from "./mobilePrefs";

describe("locMode", () => {
  beforeEach(() => localStorage.clear());

  it("기본은 ask", () => expect(getLocMode()).toBe("ask"));

  it("off/auto 왕복, 쓰레기 값은 ask", () => {
    setLocMode("auto");
    expect(getLocMode()).toBe("auto");
    setLocMode("off");
    expect(getLocMode()).toBe("off");
    localStorage.setItem("brise_mobile_loc_mode", "bogus");
    expect(getLocMode()).toBe("ask");
  });
});
