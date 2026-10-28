import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ callSilent: vi.fn(), reportFallback: vi.fn() }));
vi.mock("../invoke", () => ({ callSilent: h.callSilent, call: vi.fn() }));
vi.mock("../diag", () => ({ reportFallback: h.reportFallback }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => `asset://${p}` }));

let installed: string[] = [];
const loadSpy = vi.fn();
const addSpy = vi.fn();
const faces: Array<{ family: string }> = [];

class FakeFontFace {
  constructor(
    public family: string,
    public src: string,
    public descriptors: unknown,
  ) {
    faces.push(this);
  }
  load() {
    loadSpy(this.family);
    return Promise.resolve(this);
  }
}

type Loader = typeof import("./loader");
let loader: Loader;

beforeEach(async () => {
  installed = [];
  faces.length = 0;
  loadSpy.mockClear();
  addSpy.mockClear();
  h.callSilent.mockReset().mockImplementation(async (cmd: string) => {
    if (cmd === "font_status") return { installed };
    if (cmd === "fonts_base_dir") return { base: "/data/fonts" };
    return {};
  });
  h.reportFallback.mockClear();
  vi.stubGlobal("FontFace", FakeFontFace);
  Object.defineProperty(document, "fonts", { value: { add: addSpy }, configurable: true });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-28T00:00:00Z"));
  // 모듈 상태(registered·음성 캐시)를 테스트마다 새로.
  vi.resetModules();
  loader = await import("./loader");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Object.defineProperty(document, "fonts", { value: undefined, configurable: true });
});

const statusCalls = () => h.callSilent.mock.calls.filter((c) => c[0] === "font_status").length;
const reportedCodes = () => h.reportFallback.mock.calls.map((c) => c[1]);

describe("글꼴 로더 — 받지 않은 카탈로그 글꼴", () => {
  it("미설치는 등록 기억에 남지 않는다: 나중에 받아 forgetFont 한 뒤 다시 부르면 등록된다", async () => {
    await loader.loadFonts(["catalog:gaegu"]);
    expect(statusCalls()).toBe(1);
    expect(faces).toHaveLength(0);
    expect(addSpy).not.toHaveBeenCalled();

    // 설정에서 받기 완료 — 같은 창이 forgetFont 를 부른다(음성 캐시도 같이 지워진다).
    installed = ["gaegu"];
    loader.forgetFont("catalog:gaegu");
    await loader.loadFonts(["catalog:gaegu"]);
    expect(statusCalls()).toBe(2);
    expect(faces.length).toBeGreaterThan(0);
    expect(faces.every((f) => f.family === "brise-gaegu")).toBe(true);
    expect(addSpy).toHaveBeenCalled();
  });

  it("음성 캐시: 5초 안엔 font_status 를 다시 묻지 않고, 지나면 다시 묻는다(다른 창이 받은 글꼴도 결국 등록된다)", async () => {
    await loader.loadFonts(["catalog:gaegu"]);
    await loader.loadFonts(["catalog:gaegu"]); // 슬라이더 틱처럼 연달아
    await loader.loadFonts(["catalog:gaegu"]);
    expect(statusCalls()).toBe(1);

    installed = ["gaegu"]; // forgetFont 없이 — 이 창이 모르는 사이에 받아졌다
    await loader.loadFonts(["catalog:gaegu"]);
    expect(statusCalls()).toBe(1); // 아직 TTL 안
    expect(faces).toHaveLength(0);

    vi.setSystemTime(Date.now() + 5001);
    await loader.loadFonts(["catalog:gaegu"]);
    expect(statusCalls()).toBe(2);
    expect(faces.length).toBeGreaterThan(0);
  });

  it("미설치 진단은 id 당 한 번만 남고 register_failed 로 세지 않는다", async () => {
    await loader.loadFonts(["catalog:gaegu"]);
    vi.setSystemTime(Date.now() + 5001);
    await loader.loadFonts(["catalog:gaegu"]);
    vi.setSystemTime(Date.now() + 5001);
    await loader.loadFonts(["catalog:gaegu", "catalog:jua"]);
    expect(statusCalls()).toBe(4); // gaegu 3번 + jua 1번 — 시간이 지났으면 다시 확인한다
    const notInstalled = h.reportFallback.mock.calls.filter((c) => c[1] === "not_installed").map((c) => c[2]);
    expect(notInstalled.sort()).toEqual(["gaegu", "jua"]);
    expect(reportedCodes()).not.toContain("register_failed");
  });
});

describe("글꼴 로더 — 미리보기 등록", () => {
  it("미리보기는 등록만 하고 .load() 를 강제하지 않는다 — 실제 글꼴 등록은 그대로 .load() 한다", async () => {
    await loader.loadPreviews(["gaegu", "do-hyeon"]);
    expect(addSpy).toHaveBeenCalled();
    expect(faces.map((f) => f.family).sort()).toEqual(expect.arrayContaining(["brise-preview-do-hyeon", "brise-preview-gaegu"]));
    expect(loadSpy).not.toHaveBeenCalled();

    installed = ["gaegu"];
    await loader.loadFonts(["catalog:gaegu"]);
    expect(loadSpy).toHaveBeenCalledWith("brise-gaegu");
  });
});
