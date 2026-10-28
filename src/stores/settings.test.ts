import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const callMock = vi.fn();

vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
}));

import {
  useSettingsStore,
  normalizeFilterRoster,
  normalizeDashboardTabs,
  FACTORY_DEFAULT_MAP_LOCATION,
  FACTORY_DEFAULT_MAP_ZOOM,
  dateNudgeModeOf,
  regionNudgeModeOf,
} from "./settings";
import {
  APPEARANCE_SEED_STORAGE_KEY,
  DEFAULT_APPEARANCE_SEED,
  loadAppearanceSeed,
  saveAppearanceSeed,
  applyCssVars,
  applySavedAppearanceSeed,
  type AppearanceSeed,
} from "../lib/appearance";
import { ACCENT_L, hexToOklch, onAccentFor, renderAccent } from "../lib/accentPalette";

// QA8 1D: new installs / factory fallback use city-scale zoom (not country-wide k=50).
describe("FACTORY_DEFAULT_MAP_LOCATION", () => {
  it("is Seoul at city-scale zoom 150", () => {
    expect(FACTORY_DEFAULT_MAP_ZOOM).toBe(150);
    expect(FACTORY_DEFAULT_MAP_LOCATION).toEqual({
      lat: 37.5665,
      lng: 126.978,
      zoom: 150,
    });
  });
});

describe("settings store — load() legacy surface preset mapping (mica→acrylic rename, 2026-07-24)", () => {
  beforeEach(() => {
    callMock.mockReset();
    // load() no longer calls window_set_effect (that waits until show()). Extra
    // resolved values are only for settings_get_all.
    callMock.mockResolvedValue({ ok: true });
    useSettingsStore.setState({ loaded: false });
  });

  it("maps legacy surface_style='mica' + mica_alpha to acrylic/sheetAlpha when sheet_alpha is absent", async () => {
    callMock.mockResolvedValueOnce({
      settings: { theme: "dark", surface_style: "mica", mica_alpha: 0.6 },
    });

    await useSettingsStore.getState().load();

    expect(useSettingsStore.getState().surfaceStyle).toBe("acrylic");
    expect(useSettingsStore.getState().sheetAlpha).toBe(0.6);
  });

  it("prefers sheet_alpha over mica_alpha even when sheet_alpha is a stored 0 (?? semantics, not ||)", async () => {
    callMock.mockResolvedValueOnce({
      settings: { theme: "dark", surface_style: "acrylic", sheet_alpha: 0, mica_alpha: 0.9 },
    });

    await useSettingsStore.getState().load();

    expect(useSettingsStore.getState().sheetAlpha).toBe(0);
  });

  it("falls back legacy surface_style='glass' to flat", async () => {
    callMock.mockResolvedValueOnce({
      settings: { theme: "dark", surface_style: "glass" },
    });

    await useSettingsStore.getState().load();

    expect(useSettingsStore.getState().surfaceStyle).toBe("flat");
  });

  it("defaults sheetAlpha to 0.85 when neither sheet_alpha nor mica_alpha is present", async () => {
    callMock.mockResolvedValueOnce({
      settings: { theme: "dark" },
    });

    await useSettingsStore.getState().load();

    expect(useSettingsStore.getState().sheetAlpha).toBe(0.85);
  });

  it("passes through current surface_style='acrylic' + sheet_alpha unchanged", async () => {
    callMock.mockResolvedValueOnce({
      settings: { theme: "dark", surface_style: "acrylic", sheet_alpha: 0.3 },
    });

    await useSettingsStore.getState().load();

    expect(useSettingsStore.getState().surfaceStyle).toBe("acrylic");
    expect(useSettingsStore.getState().sheetAlpha).toBe(0.3);
  });

  it("does not apply acrylic while the window is still hidden", async () => {
    callMock.mockResolvedValueOnce({
      settings: { theme: "dark", surface_style: "acrylic" },
    });

    await useSettingsStore.getState().load();

    expect(callMock).not.toHaveBeenCalledWith("window_set_effect", expect.anything());
    expect(useSettingsStore.getState().surfaceEffectApplied).toBe(false);
  });
});

describe("settings store — load() browser-mode guard (window_set_effect has no HTTP route, QA 2026-07-31)", () => {
  const TOKEN_KEY = "brise_sync_token";

  beforeEach(() => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true });
    sessionStorage.setItem(TOKEN_KEY, "tok-test");
    useSettingsStore.setState({ loaded: false });
  });

  afterEach(() => {
    sessionStorage.removeItem(TOKEN_KEY);
  });

  it("with a browser-mode token present, load() never calls window_set_effect even for a persisted acrylic style", async () => {
    callMock.mockResolvedValueOnce({
      settings: { theme: "dark", surface_style: "acrylic" },
    });

    await useSettingsStore.getState().load();

    expect(callMock).not.toHaveBeenCalledWith("window_set_effect", expect.anything());
    // false, not true — must route applyCssVars to the flat fallback (no OS material exists
    // behind a browser tab to justify a transparent --bg).
    expect(useSettingsStore.getState().surfaceEffectApplied).toBe(false);
  });
});

describe("normalizeFilterRoster (§2.4 HANDOFF-calendar-onboarding.md)", () => {
  it("[] (never saved) becomes the canonical order, all enabled", () => {
    expect(normalizeFilterRoster([])).toEqual([
      { mode: "region", enabled: true },
      { mode: "timeline", enabled: true },
      { mode: "calendar", enabled: true },
      { mode: "gallery", enabled: true },
      { mode: "chat", enabled: true },
    ]);
  });

  it("preserves a saved order and disabled flags", () => {
    const saved = [
      { mode: "calendar", enabled: false },
      { mode: "region", enabled: true },
      { mode: "timeline", enabled: false },
      { mode: "chat", enabled: true },
      { mode: "gallery", enabled: true },
    ] as const;
    expect(normalizeFilterRoster([...saved])).toEqual([...saved]);
  });

  it('maps legacy roster mode "advanced" to "chat"', () => {
    expect(
      normalizeFilterRoster([
        { mode: "region", enabled: true },
        { mode: "advanced", enabled: false },
        { mode: "gallery", enabled: true },
      ]),
    ).toEqual([
      { mode: "region", enabled: true },
      { mode: "chat", enabled: false },
      { mode: "gallery", enabled: true },
      { mode: "timeline", enabled: true },
      { mode: "calendar", enabled: true },
    ]);
  });

  it("appends a mode missing from a saved roster (new capability), enabled, without duplicating", () => {
    const saved = [
      { mode: "region", enabled: false },
      { mode: "gallery", enabled: true },
    ];
    expect(normalizeFilterRoster(saved)).toEqual([
      { mode: "region", enabled: false },
      { mode: "gallery", enabled: true },
      { mode: "timeline", enabled: true },
      { mode: "calendar", enabled: true },
      { mode: "chat", enabled: true },
    ]);
  });

  it("W7 §7.0: preserves custom order even if it matches legacy factory sequence", () => {
    const legacyOrder = [
      { mode: "region", enabled: true },
      { mode: "timeline", enabled: false },
      { mode: "chat", enabled: true },
      { mode: "gallery", enabled: false },
      { mode: "calendar", enabled: true },
    ] as const;
    expect(normalizeFilterRoster([...legacyOrder])).toEqual([...legacyOrder]);
  });

  it("drops garbage entries (unknown mode, missing enabled, non-array) instead of throwing", () => {
    expect(normalizeFilterRoster("not an array")).toEqual(normalizeFilterRoster([]));
    expect(normalizeFilterRoster([{ mode: "tree", enabled: true }, { mode: "region" }])).toEqual(
      normalizeFilterRoster([])
    );
  });

  it("W23-a: all-disabled roster re-enables the first entry", () => {
    const allOff = [
      { mode: "region" as const, enabled: false },
      { mode: "timeline" as const, enabled: false },
      { mode: "calendar" as const, enabled: false },
      { mode: "gallery" as const, enabled: false },
      { mode: "chat" as const, enabled: false },
    ];
    const next = normalizeFilterRoster(allOff);
    expect(next[0]).toEqual({ mode: "region", enabled: true });
    expect(next.slice(1).every((e) => e.enabled === false)).toBe(true);
  });
});

describe("normalizeDashboardTabs (W7 §7.3)", () => {
  it("[] (never saved) becomes the canonical dashboard tabs order, all enabled", () => {
    expect(normalizeDashboardTabs([])).toEqual([
      { id: "board", enabled: true },
      { id: "calendar", enabled: true },
      { id: "timeline", enabled: true },
      { id: "map", enabled: true },
      { id: "graph", enabled: true },
    ]);
  });

  it("preserves saved custom order and appends missing tabs enabled", () => {
    const saved = [
      { id: "timeline", enabled: true },
      { id: "calendar", enabled: true },
    ];
    expect(normalizeDashboardTabs(saved)).toEqual([
      { id: "timeline", enabled: true },
      { id: "calendar", enabled: true },
      { id: "board", enabled: true },
      { id: "map", enabled: true },
      { id: "graph", enabled: true },
    ]);
  });

  it("W23-a: all-disabled dashboard tabs re-enable the first entry", () => {
    const next = normalizeDashboardTabs([
      { id: "board", enabled: false },
      { id: "calendar", enabled: false },
      { id: "timeline", enabled: false },
      { id: "map", enabled: false },
      { id: "graph", enabled: false },
    ]);
    expect(next[0].enabled).toBe(true);
    expect(next.slice(1).every((e) => e.enabled === false)).toBe(true);
  });

  it("W23-a: preserves a mix of enabled/disabled dashboard tabs", () => {
    const saved = [
      { id: "timeline", enabled: true },
      { id: "board", enabled: false },
      { id: "calendar", enabled: true },
      { id: "map", enabled: true },
      { id: "graph", enabled: true },
    ];
    expect(normalizeDashboardTabs(saved)).toEqual(saved);
  });
});

describe("settings store — editor full-width toggle (item 3)", () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true });
    useSettingsStore.setState({ editorFullWidth: false });
  });

  it("defaults to false (comfortable mode)", () => {
    expect(useSettingsStore.getState().editorFullWidth).toBe(false);
  });

  it("setEditorFullWidth(true) persists via settings_set", async () => {
    await useSettingsStore.getState().setEditorFullWidth(true);

    expect(useSettingsStore.getState().editorFullWidth).toBe(true);
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { editor_full_width: true } });
  });

  it("setEditorFullWidth(false) persists too (toggling back off)", async () => {
    useSettingsStore.setState({ editorFullWidth: true });
    await useSettingsStore.getState().setEditorFullWidth(false);

    expect(useSettingsStore.getState().editorFullWidth).toBe(false);
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { editor_full_width: false } });
  });

  it("load() hydrates editorFullWidth from settings_get_all", async () => {
    callMock.mockResolvedValueOnce({
      settings: { theme: "dark", editor_full_width: true },
    });

    await useSettingsStore.getState().load();

    expect(useSettingsStore.getState().editorFullWidth).toBe(true);
  });

  it("load() defaults editorFullWidth to false when unset", async () => {
    callMock.mockResolvedValueOnce({ settings: { theme: "dark" } });

    await useSettingsStore.getState().load();

    expect(useSettingsStore.getState().editorFullWidth).toBe(false);
  });
});

// FINDING 1: 삭제된 stores/chatWrite.ts 가 쓰던 로컬스토리지 키 -> DB chat_write_enabled 마이그레이션.
describe("settings store — load() legacy chatWriteEnabled localStorage migration", () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true });
    useSettingsStore.setState({ loaded: false });
    localStorage.removeItem("brise.chatWriteEnabled");
  });

  afterEach(() => {
    localStorage.removeItem("brise.chatWriteEnabled");
  });

  it("migrates legacy '0' to chatWriteEnabled=false, persists it, and removes the key", async () => {
    localStorage.setItem("brise.chatWriteEnabled", "0");
    callMock.mockResolvedValueOnce({ settings: { theme: "dark", chat_write_enabled: true } });

    await useSettingsStore.getState().load();

    expect(useSettingsStore.getState().chatWriteEnabled).toBe(false);
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { chat_write_enabled: false } });
    expect(localStorage.getItem("brise.chatWriteEnabled")).toBeNull();
  });

  it("migrates legacy '1' to chatWriteEnabled=true and persists it", async () => {
    localStorage.setItem("brise.chatWriteEnabled", "1");
    callMock.mockResolvedValueOnce({ settings: { theme: "dark" } });

    await useSettingsStore.getState().load();

    expect(useSettingsStore.getState().chatWriteEnabled).toBe(true);
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { chat_write_enabled: true } });
  });

  it("treats legacy 'false' the same as '0'", async () => {
    localStorage.setItem("brise.chatWriteEnabled", "false");
    callMock.mockResolvedValueOnce({ settings: { theme: "dark" } });

    await useSettingsStore.getState().load();

    expect(useSettingsStore.getState().chatWriteEnabled).toBe(false);
  });

  it("does nothing when the legacy key is absent (no extra settings_set call, DB value wins)", async () => {
    callMock.mockResolvedValueOnce({ settings: { theme: "dark", chat_write_enabled: false } });

    await useSettingsStore.getState().load();

    expect(useSettingsStore.getState().chatWriteEnabled).toBe(false);
    expect(callMock).not.toHaveBeenCalledWith("settings_set", { entries: { chat_write_enabled: expect.anything() } });
  });
});

// 오너 승인 분석#5: "홈 위치 미설정" 판정은 좌표 비교가 아니라 kv 키 존재 여부의 명시적 플래그로.
describe("settings store — defaultMapLocationCustomized (owner analysis #5)", () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true });
    useSettingsStore.setState({ loaded: false, defaultMapLocationCustomized: false });
  });

  it("load() sets customized=true when default_map_location key is present, even at the FACTORY Seoul coords", async () => {
    callMock.mockResolvedValueOnce({
      settings: { theme: "dark", default_map_location: { lat: 37.5665, lng: 126.978, zoom: 150 } },
    });

    await useSettingsStore.getState().load();

    expect(useSettingsStore.getState().defaultMapLocationCustomized).toBe(true);
  });

  it("load() sets customized=false when default_map_location key is absent", async () => {
    callMock.mockResolvedValueOnce({ settings: { theme: "dark" } });

    await useSettingsStore.getState().load();

    expect(useSettingsStore.getState().defaultMapLocationCustomized).toBe(false);
  });

  it("setDefaultMapLocation() flips customized to true and persists the coords", async () => {
    await useSettingsStore.getState().setDefaultMapLocation({ lat: 10, lng: 20, zoom: 80 });

    expect(useSettingsStore.getState().defaultMapLocationCustomized).toBe(true);
    expect(useSettingsStore.getState().defaultMapLocation).toEqual({ lat: 10, lng: 20, zoom: 80 });
    expect(callMock).toHaveBeenCalledWith("settings_set", {
      entries: { default_map_location: { lat: 10, lng: 20, zoom: 80 } },
    });
  });
});

describe("settings store — filter roster (§2.4)", () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true });
  });

  it("setFilterRoster() persists the full entry list via settings_set", async () => {
    const next = [
      { mode: "gallery" as const, enabled: false },
      { mode: "region" as const, enabled: true },
    ];
    await useSettingsStore.getState().setFilterRoster(next);

    expect(useSettingsStore.getState().filterRoster).toEqual(next);
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { filter_roster: next } });
  });

  it("load() hydrates filterRoster from settings_get_all via normalizeFilterRoster", async () => {
    callMock.mockResolvedValueOnce({
      settings: { theme: "dark", filter_roster: [{ mode: "calendar", enabled: false }] },
    });

    await useSettingsStore.getState().load();

    expect(useSettingsStore.getState().filterRoster[0]).toEqual({ mode: "calendar", enabled: false });
    expect(useSettingsStore.getState().filterRoster).toHaveLength(5);
  });

  it("setFilterRoster() refuses to persist an all-disabled roster", async () => {
    const allOff = [
      { mode: "region" as const, enabled: false },
      { mode: "timeline" as const, enabled: false },
    ];
    await useSettingsStore.getState().setFilterRoster(allOff);
    const saved = useSettingsStore.getState().filterRoster;
    expect(saved[0]).toEqual({ mode: "region", enabled: true });
    expect(saved[1]).toEqual({ mode: "timeline", enabled: false });
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { filter_roster: saved } });
  });
});

describe("WAVE K — appearance seed (first-paint delay fix)", () => {
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

  it("APPEARANCE_SEED_STORAGE_KEY matches specification", () => {
    expect(APPEARANCE_SEED_STORAGE_KEY).toBe("brise_appearance_seed_v1");
  });

  describe("loadAppearanceSeed", () => {
    it("returns DEFAULT_APPEARANCE_SEED when localStorage is empty", () => {
      expect(loadAppearanceSeed()).toEqual(DEFAULT_APPEARANCE_SEED);
    });

    it("returns DEFAULT_APPEARANCE_SEED when localStorage has malformed JSON", () => {
      localStorage.setItem(APPEARANCE_SEED_STORAGE_KEY, "invalid-json{");
      expect(loadAppearanceSeed()).toEqual(DEFAULT_APPEARANCE_SEED);
    });

    // E5-a: 신규 설치 기본값이 "시스템 따름"이라, 시드가 없는 첫 실행의 첫 페인트는 OS 밝기를
    // 읽어야 한다. 상수를 그대로 퍼뜨리면 라이트 모드 OS 에서 dark 로 칠한 뒤 load() 가 뒤늦게
    // 뒤집어 번쩍인다. jsdom 엔 matchMedia 가 없으므로(폴리필 없음) 여기서만 심어 확인한다.
    it("resolves the default 'system' pref against the OS when no seed is stored", () => {
      expect(DEFAULT_APPEARANCE_SEED.themePref).toBe("system");
      const stub = (query: string) =>
        ({ matches: query.includes("dark") ? false : true }) as MediaQueryList;
      Object.defineProperty(window, "matchMedia", { value: stub, configurable: true, writable: true });
      try {
        const loaded = loadAppearanceSeed();
        expect(loaded.themePref).toBe("system");
        expect(loaded.theme).toBe("light");
      } finally {
        Reflect.deleteProperty(window, "matchMedia");
      }
    });

    it("returns valid seed with fallbacks for partial or invalid values", () => {
      localStorage.setItem(
        APPEARANCE_SEED_STORAGE_KEY,
        JSON.stringify({
          theme: "light",
          accent: "#invalid_accent",
          fontScale: -5,
          bgDim: 150,
          bgTone: 99,
          bgSat: 0,
          surfaceStyle: "acrylic",
          sheetAlpha: 2.5,
        }),
      );

      const loaded = loadAppearanceSeed();
      expect(loaded.theme).toBe("light");
      expect(loaded.accent).toBe(DEFAULT_APPEARANCE_SEED.accent);
      expect(loaded.fontScale).toBe(DEFAULT_APPEARANCE_SEED.fontScale);
      expect(loaded.bgDim).toBe(100); // clamped to 100
      expect(loaded.bgTone).toBe(10); // clamped to BG_TONE_MAX (10)
      expect(loaded.surfaceStyle).toBe("acrylic");
      expect(loaded.sheetAlpha).toBe(1.0); // clamped to SHEET_ALPHA_MAX (1.0)
      // W15 Part 3: a seed saved before this field existed (or with a malformed value) falls
      // back to the same default the fresh-install path uses (true) — the very next
      // applySurfaceEffectAfterShow() call corrects it to the real result, no regression.
      expect(loaded.surfaceEffectApplied).toBe(DEFAULT_APPEARANCE_SEED.surfaceEffectApplied);
    });

    it("correctly loads a completely valid seed", () => {
      const validSeed: AppearanceSeed = {
        themePref: "light",
        theme: "light",
        accent: "#ace1af",
        fontScale: 1.2,
        fontFamily: "serif",
        fontEditor: "",
        fontMono: "source-code-pro",
        bgDim: 15,
        bgTone: -5,
        bgSat: 0,
        surfaceStyle: "acrylic",
        sheetAlpha: 0.65,
        surfaceEffectApplied: true,
      };
      localStorage.setItem(APPEARANCE_SEED_STORAGE_KEY, JSON.stringify(validSeed));

      expect(loadAppearanceSeed()).toEqual(validSeed);
    });

    it("correctly loads a system theme seed and resolves theme", () => {
      const systemSeed = {
        themePref: "system",
        accent: "#ace1af",
        fontScale: 1,
        fontFamily: "serif",
        bgDim: 0,
        bgTone: 0,
        surfaceStyle: "flat",
        sheetAlpha: 0.85,
        surfaceEffectApplied: true,
      };
      localStorage.setItem(APPEARANCE_SEED_STORAGE_KEY, JSON.stringify(systemSeed));

      const loaded = loadAppearanceSeed();
      expect(loaded.themePref).toBe("system");
      expect(loaded.theme === "dark" || loaded.theme === "light").toBe(true);
    });

    it("rejects a non-boolean surfaceEffectApplied and falls back to the default", () => {
      localStorage.setItem(
        APPEARANCE_SEED_STORAGE_KEY,
        JSON.stringify({ surfaceStyle: "acrylic", surfaceEffectApplied: "yes" }),
      );
      expect(loadAppearanceSeed().surfaceEffectApplied).toBe(DEFAULT_APPEARANCE_SEED.surfaceEffectApplied);
    });
  });

  describe("saveAppearanceSeed", () => {
    it("persists the appearance subset into localStorage", () => {
      const seed: AppearanceSeed = {
        themePref: "light",
        theme: "light",
        accent: "#7da98c",
        fontScale: 1.1,
        fontFamily: "serif",
        fontEditor: "",
        fontMono: "source-code-pro",
        bgDim: 20,
        bgTone: 4,
        bgSat: 0,
        surfaceStyle: "acrylic",
        sheetAlpha: 0.75,
        surfaceEffectApplied: false,
      };

      saveAppearanceSeed(seed);

      const stored = JSON.parse(localStorage.getItem(APPEARANCE_SEED_STORAGE_KEY)!);
      // themeHex 는 저장 시 계산해 덧붙인다(index.html 부팅 색이 강조색에서 나온 실제 --theme 을 쓰도록).
      const { themeHex, ...rest } = stored;
      expect(rest).toEqual(seed);
      expect(themeHex).toMatch(/^#[0-9a-f]{6}$/i);
    });

    // W15 Part 3 round trip: the actual OS-verified result (not a guess) must survive a
    // save -> load cycle exactly, since applySavedAppearanceSeed() reads it back on next boot.
    it("round-trips surfaceEffectApplied: true and false without loss", () => {
      saveAppearanceSeed({ ...DEFAULT_APPEARANCE_SEED, surfaceStyle: "acrylic", surfaceEffectApplied: true });
      expect(loadAppearanceSeed().surfaceEffectApplied).toBe(true);

      saveAppearanceSeed({ ...DEFAULT_APPEARANCE_SEED, surfaceStyle: "acrylic", surfaceEffectApplied: false });
      expect(loadAppearanceSeed().surfaceEffectApplied).toBe(false);
    });
  });

  describe("applyCssVars", () => {
    it("applies theme, accent, fontScale, canvas, surface, alpha, and bgDim to documentElement", () => {
      applyCssVars({
        theme: "light",
        accent: "#5d8a6e",
        fontScale: 1.15,
        fontFamily: "serif",
        bgDim: 30,
        bgTone: 2,
        surfaceStyle: "flat",
        surfaceEffectApplied: true,
        sheetAlpha: 0.9,
      });

      const root = document.documentElement;
      expect(root.getAttribute("data-theme")).toBe("light");
      expect(root.getAttribute("data-surface")).toBe("flat");
      // PLAN-2026-09-12 §4: --accent 는 저장 hex 를 **그대로** 박지 않는다 — 색상·채도는
      // 사용자의 것이고 명도는 테마가 정하므로, 현재 테마의 L 로 다시 그린 값이 들어간다.
      expect(root.style.getPropertyValue("--accent")).toBe(renderAccent("#5d8a6e", "light"));
      expect(hexToOklch(root.style.getPropertyValue("--accent")).L).toBeCloseTo(ACCENT_L.light, 2);
      // 강조색 위 글자색도 표가 아니라 그 색에서 계산된다.
      expect(root.style.getPropertyValue("--on-accent")).toBe(
        onAccentFor(renderAccent("#5d8a6e", "light")),
      );
      expect(root.style.getPropertyValue("--fs")).toBe("1.15");
      expect(root.style.getPropertyValue("--sheet-alpha")).toBe("0.9");
      expect(root.style.getPropertyValue("--bg-dim")).toBe("30%");
      expect(root.style.getPropertyValue("--app-canvas")).toBeTruthy();
    });

    it("falls back data-surface to flat if acrylic is requested but OS effect was not applied", () => {
      applyCssVars({
        theme: "dark",
        accent: "#9cc5a4",
        fontScale: 1,
        fontFamily: "serif",
        bgDim: 0,
        bgTone: 0,
        bgSat: 0,
        surfaceStyle: "acrylic",
        surfaceEffectApplied: false,
        sheetAlpha: 0.85,
      });

      expect(document.documentElement.getAttribute("data-surface")).toBe("flat");
    });
  });

  describe("applySavedAppearanceSeed", () => {
    it("applies default appearance when no seed is in localStorage", () => {
      const applied = applySavedAppearanceSeed();
      expect(applied).toEqual(DEFAULT_APPEARANCE_SEED);

      const root = document.documentElement;
      expect(root.getAttribute("data-theme")).toBe("dark");
      expect(root.getAttribute("data-surface")).toBe("flat");
      expect(root.style.getPropertyValue("--accent")).toBe("#9cc5a4");
      expect(root.style.getPropertyValue("--fs")).toBe("1");
    });

    it("synchronously applies saved seed from localStorage, including acrylic when last boot's real result was applied=true", () => {
      const seed: AppearanceSeed = {
        themePref: "light",
        theme: "light",
        accent: "#c7e0cd",
        fontScale: 1.05,
        fontFamily: "serif",
        fontEditor: "",
        fontMono: "source-code-pro",
        bgDim: 12,
        bgTone: -3,
        bgSat: 0,
        surfaceStyle: "acrylic",
        sheetAlpha: 0.7,
        surfaceEffectApplied: true,
      };
      localStorage.setItem(APPEARANCE_SEED_STORAGE_KEY, JSON.stringify(seed));

      const applied = applySavedAppearanceSeed();
      expect(applied).toEqual(seed);

      const root = document.documentElement;
      expect(root.getAttribute("data-theme")).toBe("light");
      // W15 Part 3: this is the *real* last-known result, not a guess from surfaceStyle alone.
      expect(root.getAttribute("data-surface")).toBe("acrylic");
      // 저장 hex 를 라이트 테마의 고정 명도로 다시 그린 값(§4) — 시드 단계에서도 같은 규칙이다.
      expect(root.style.getPropertyValue("--accent")).toBe(renderAccent("#c7e0cd", "light"));
      expect(root.style.getPropertyValue("--fs")).toBe("1.05");
      expect(root.style.getPropertyValue("--sheet-alpha")).toBe("0.7");
      expect(root.style.getPropertyValue("--bg-dim")).toBe("12%");
    });

    // W15 Part 3 — this is the exact bug the wave removes: previously applySavedAppearanceSeed
    // *guessed* surfaceEffectApplied from surfaceStyle alone (true whenever surfaceStyle ===
    // "acrylic"), so a user whose last boot's real OS acrylic call FAILED would still see the
    // seed phase render data-surface="acrylic" (transparent --bg), then get visibly corrected
    // back to flat once applySurfaceEffectAfterShow() ran for real — the Stage 3 flip described
    // in the wave brief. Now the seed carries the real last result, so the seed phase itself
    // already renders flat and there is nothing left for Stage 3 to correct.
    it("renders flat immediately (no Stage-3 flip) when last boot's real result was applied=false", () => {
      const seed: AppearanceSeed = {
        ...DEFAULT_APPEARANCE_SEED,
        surfaceStyle: "acrylic",
        surfaceEffectApplied: false,
      };
      localStorage.setItem(APPEARANCE_SEED_STORAGE_KEY, JSON.stringify(seed));

      applySavedAppearanceSeed();

      expect(document.documentElement.getAttribute("data-surface")).toBe("flat");
    });
  });

  describe("store actions update appearance seed", () => {
    it("setTheme updates localStorage seed", async () => {
      await useSettingsStore.getState().setTheme("light");
      expect(loadAppearanceSeed().theme).toBe("light");
    });

    // 아래 셋은 setBgTone/setContentTint/setSheetAlpha 와 같은 "슬라이더로 끄는 값" 부류라
    // void 를 돌려준다(await 할 것이 없다) — 화면 갱신과 시드 저장은 IPC 전에 동기로 끝난다.
    it("setAccent updates localStorage seed", () => {
      useSettingsStore.getState().setAccent("#ace1af");
      expect(loadAppearanceSeed().accent).toBe("#ace1af");
    });

    it("setFontScale updates localStorage seed", () => {
      useSettingsStore.getState().setFontScale(1.25);
      expect(loadAppearanceSeed().fontScale).toBe(1.25);
    });

    it("setBgDim updates localStorage seed", () => {
      useSettingsStore.getState().setBgDim(25);
      expect(loadAppearanceSeed().bgDim).toBe(25);
    });

    it("setBgTone updates localStorage seed", () => {
      useSettingsStore.getState().setBgTone(6);
      expect(loadAppearanceSeed().bgTone).toBe(6);
    });

    it("setBgTone/setBgDim(live) 는 칠하고 조용히 저장, 확정(옵션 없음)은 call() — 실패해도 rejection 이 새지 않는다", async () => {
      callMock.mockClear();
      useSettingsStore.getState().setBgTone(4, { live: true });
      useSettingsStore.getState().setBgDim(12, { live: true });
      expect(useSettingsStore.getState().bgTone).toBe(4);
      expect(loadAppearanceSeed().bgDim).toBe(12);
      expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { bg_tone: 4 } });
      expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { bg_dim: 12 } });

      callMock.mockClear();
      callMock.mockRejectedValueOnce(new Error("db locked"));
      useSettingsStore.getState().setBgTone(4);
      await Promise.resolve();
      expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { bg_tone: 4 } });
      expect(useSettingsStore.getState().bgTone).toBe(4);
    });

    it("setSurfaceStyle updates localStorage seed", async () => {
      await useSettingsStore.getState().setSurfaceStyle("acrylic");
      expect(loadAppearanceSeed().surfaceStyle).toBe("acrylic");
    });

    // W15 Part 3: setSurfaceStyle is one of the three call sites where a *real* OS-verified
    // window_set_effect result becomes known — it must persist that exact result (not a guess)
    // into the seed so next boot's applySavedAppearanceSeed() starts from the truth.
    it("setSurfaceStyle persists the real window_set_effect result into the seed", async () => {
      callMock.mockResolvedValueOnce({ applied: true });
      await useSettingsStore.getState().setSurfaceStyle("acrylic");
      expect(loadAppearanceSeed().surfaceEffectApplied).toBe(true);

      callMock.mockResolvedValueOnce({ applied: false });
      await useSettingsStore.getState().setSurfaceStyle("acrylic");
      expect(loadAppearanceSeed().surfaceEffectApplied).toBe(false);
    });

    // setTheme re-syncs the OS acrylic tint (theme-dependent) when surfaceStyle isn't flat — that
    // second real result must reach the seed too (it used to only save *before* the retint ran).
    it("setTheme persists the retinted window_set_effect result into the seed when surface isn't flat", async () => {
      await useSettingsStore.getState().setSurfaceStyle("acrylic");
      callMock.mockResolvedValueOnce({ applied: true });
      await useSettingsStore.getState().setTheme("light");
      expect(loadAppearanceSeed().surfaceEffectApplied).toBe(true);

      callMock.mockResolvedValueOnce({ applied: false });
      await useSettingsStore.getState().setTheme("dark");
      expect(loadAppearanceSeed().surfaceEffectApplied).toBe(false);
    });

    // applySurfaceEffectAfterShow is the one function every window (App.tsx post-show,
    // AuxWindowChrome for settings/activity/ai-history) routes through to learn the real result.
    it("applySurfaceEffectAfterShow persists the real result into the seed", async () => {
      await useSettingsStore.getState().setSurfaceStyle("acrylic");

      callMock.mockResolvedValueOnce({ applied: true });
      await useSettingsStore.getState().applySurfaceEffectAfterShow();
      expect(loadAppearanceSeed().surfaceEffectApplied).toBe(true);

      callMock.mockResolvedValueOnce({ applied: false });
      await useSettingsStore.getState().applySurfaceEffectAfterShow();
      expect(loadAppearanceSeed().surfaceEffectApplied).toBe(false);
    });

    it("setSheetAlpha updates localStorage seed", () => {
      useSettingsStore.getState().setSheetAlpha(0.6);
      expect(loadAppearanceSeed().sheetAlpha).toBe(0.6);
    });

    // 회귀 고정(W3 레인 A) — 슬라이더로 끄는 외형 setter 는 **하나도 빠짐없이** settings_set 에
    // `.catch` 를 붙인다. 강조색 hue 슬라이더는 한 번의 드래그로 최대 361회 쏘는데 setAccent 만
    // `await call()` 이었다: 실패하면 토스트가 361개 뜨고, 호출부(`void setAccent(...)`)에 .catch
    // 가 없어 rejection 이 그대로 샜다(함정 8 — call() 도 callSilent() 도 다시 throw 한다).
    //
    // 이 테스트가 유일한 그물이다. check:surface (f) 는 `function NAME(` 만 파싱해서 스토어
    // 객체 리터럴 메서드(`setAccent: (a) =>`)를 "정의 못 찾음"으로 조용히 건너뛴다
    // (scripts/check-surface-contract.mjs 의 해당 주석 참고).
    //
    // 방법: callSilent 자리에 **.catch 가 붙었는지 기록하는 thenable** 을 끼운다. 미처리
    // rejection 에 기대지 않는 이유는 vitest 가 그걸 이 파일의 실패로 올려주지 않아서다(실측).
    it("slider-driven appearance setters attach .catch to every settings_set", () => {
      const caught: string[] = [];
      callMock.mockReset().mockImplementation((_cmd: unknown, args: unknown) => {
        const key = Object.keys((args as { entries: Record<string, unknown> }).entries)[0] ?? "?";
        const rejected = Promise.reject(new Error("settings_set failed"));
        // 관찰용 핸들러 — 스토어가 .catch 를 붙였는지와 무관하게 노드 경고를 막는다.
        void rejected.catch(() => {});
        return {
          then: (ok?: never, err?: never) => rejected.then(ok, err),
          catch: (fn: (e: unknown) => void) => {
            caught.push(key);
            return rejected.catch(fn);
          },
        };
      });

      const s = useSettingsStore.getState();
      // 강조색은 **드래그 틱(live)** 일 때만 이 계약에 속한다 — 옵션 없이 부르는 경로(채도 칩·
      // 초기화 버튼)는 클릭 한 번이라 반대로 토스트 + 롤백이 맞다(바로 아래 테스트).
      void s.setAccent("#d9817a", { live: true });
      s.setFontScale(1.1);
      // 배경 밝기(bg_dim·bg_tone)도 live/commit 분리 — 드래그 틱만 이 계약에 속한다.
      s.setBgDim(10, { live: true });
      s.setBgTone(4, { live: true });
      // 배경 채도도 강조색과 같은 live/commit 분리다 — 드래그 틱만 이 계약에 속한다.
      void s.setBgSat(30, { live: true });
      s.setContentTint(3);
      s.setSheetAlpha(0.7);

      expect([...caught].sort()).toEqual(
        ["accent", "bg_dim", "bg_sat", "bg_tone", "content_tint", "font_scale", "sheet_alpha"].sort(),
      );
      // 낙관적 갱신은 되돌리지 않는다 — 드래그 중 손잡이가 튀는 쪽이 더 나쁘고 다음 부팅에 DB
      // 값이 이긴다. setSimplePref 의 롤백 계약(파일 아래 describe)과 의도적으로 다르다.
      expect(useSettingsStore.getState().accent).toBe("#d9817a");
    });

    // 짝 테스트 — 위 계약의 **반대편**. 강조색의 클릭 경로(채도 5칩 · 초기화)는 조용히 실패하면
    // 안 된다: 사용자가 방금 누른 행동이고, 화면이 저장되지 않은 색을 계속 보여주면 데이터에
    // 대해 거짓말을 한다(함정 9). 2026-09-12 에 setter 를 통째로 callSilent 로 내렸다가
    // 일곱 컨트롤 중 여섯이 말없이 실패하게 된 것을 되돌리며 못 박는다.
    it("클릭 경로의 setAccent 은 실패하면 이전 색으로 되돌린다", async () => {
      const before = useSettingsStore.getState().accent;
      callMock.mockReset().mockRejectedValue(new Error("settings_set failed"));

      await useSettingsStore.getState().setAccent("#d9817a");

      expect(useSettingsStore.getState().accent).toBe(before);
    });

    it("load() reconciles and updates localStorage seed with DB values", async () => {
      callMock.mockResolvedValueOnce({
        settings: {
          theme: "light",
          accent: "#5d8a6e",
          font_scale: 1.1,
          bg_dim: 10,
          bg_tone: -4,
          surface_style: "acrylic",
          sheet_alpha: 0.8,
        },
      });

      await useSettingsStore.getState().load();

      const seed = loadAppearanceSeed();
      expect(seed.theme).toBe("light");
      expect(seed.accent).toBe("#5d8a6e");
      expect(seed.fontScale).toBe(1.1);
      expect(seed.bgDim).toBe(10);
      expect(seed.bgTone).toBe(-4);
      expect(seed.surfaceStyle).toBe("acrylic");
      expect(seed.sheetAlpha).toBe(0.8);
    });
  });

  // PLAN-2026-09-12 §4 — hue 슬라이더가 열리면서 accent 의 값 공간이 5색 열거에서 hex 전체로
  // 넓어졌다. 옛 화이트리스트가 살아 있으면 사용자가 고른 색이 부팅 때마다 기본값으로 되감긴다.
  describe("accent — 5색 화이트리스트 폐기 (§4)", () => {
    beforeEach(() => {
      localStorage.clear();
      callMock.mockReset().mockResolvedValue({ settings: {} });
    });

    it("load() 가 옛 5색 밖의 hex 도 그대로 받는다", async () => {
      callMock.mockResolvedValueOnce({ settings: { accent: "#d9817a" } });
      await useSettingsStore.getState().load();
      expect(useSettingsStore.getState().accent).toBe("#d9817a");
    });

    it("hex 가 아닌 값은 기본 청자색으로 되돌린다(백엔드 is_hex_color 와 같은 판정)", async () => {
      callMock.mockResolvedValueOnce({ settings: { accent: "chartreuse" } });
      await useSettingsStore.getState().load();
      expect(useSettingsStore.getState().accent).toBe("#9cc5a4");
    });

    it("시드도 같은 판정을 쓴다 — 옛 5색 밖의 hex 가 살아남는다", () => {
      saveAppearanceSeed({ ...DEFAULT_APPEARANCE_SEED, accent: "#d9817a" });
      expect(loadAppearanceSeed().accent).toBe("#d9817a");
    });
  });

  // PLAN-2026-09-12 §5 / D6 — 본문 전용 틴트. 전역 bg_tone/bg_dim 과 **다른 키**이고, 부호가
  // 색을 표현한다(음수 = 흰색으로 뒤집혀 본문이 사이드바보다 밝아진다).
  describe("contentTint (§5)", () => {
    beforeEach(() => {
      localStorage.clear();
      callMock.mockReset().mockResolvedValue({ settings: {} });
      // themePref 까지 고정해야 한다 — load() 는 DB 에 theme 키가 없으면 저장된 선호에서
      // 다시 푼다(앞선 describe 가 라이트로 바꿔 두면 기준값이 7 이 된다).
      useSettingsStore.setState({ themePref: "dark", theme: "dark", contentTint: 0 });
    });

    it("키가 없는 설치는 0 으로 읽는다 — 업데이트만으로 본문 밝기가 바뀌면 안 된다", async () => {
      callMock.mockResolvedValueOnce({ settings: {} });
      await useSettingsStore.getState().load();
      expect(useSettingsStore.getState().contentTint).toBe(0);
      expect(document.documentElement.style.getPropertyValue("--content-tint-amount")).toBe("16%");
      expect(document.documentElement.style.getPropertyValue("--content-tint-color")).toBe("#000");
    });

    it("범위 밖 값과 소수는 정수로 클램프해 저장한다(백엔드 as_i64 / -30..=40)", () => {
      useSettingsStore.getState().setContentTint(99);
      expect(useSettingsStore.getState().contentTint).toBe(40);
      expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { content_tint: 40 } });

      useSettingsStore.getState().setContentTint(-99);
      expect(useSettingsStore.getState().contentTint).toBe(-30);

      useSettingsStore.getState().setContentTint(12.4);
      expect(useSettingsStore.getState().contentTint).toBe(12);
    });

    it("실효값의 부호가 색을, 절댓값이 세기를 정한다 — 세기에는 반드시 % 가 붙는다", () => {
      const root = document.documentElement;

      useSettingsStore.getState().setContentTint(10); // 다크 기준 16 + 10 = 26
      expect(root.style.getPropertyValue("--content-tint-color")).toBe("#000");
      expect(root.style.getPropertyValue("--content-tint-amount")).toBe("26%");

      useSettingsStore.getState().setContentTint(-25); // 16 - 25 = -9 → 흰색 9%
      expect(root.style.getPropertyValue("--content-tint-color")).toBe("#fff");
      expect(root.style.getPropertyValue("--content-tint-amount")).toBe("9%");
    });

    it("라이트 테마는 기준값이 7 이다", async () => {
      useSettingsStore.setState({ theme: "light" });
      useSettingsStore.getState().setContentTint(0);
      expect(document.documentElement.style.getPropertyValue("--content-tint-amount")).toBe("7%");
    });
  });

  // PLAN-2026-09-12 §3/E3 — 배경 채도. bg_tone/bg_dim 과 **다른 축**이고(밝기가 아니라 색),
  // 강조색 hue 슬라이더와 같은 live/commit 분리를 쓴다. 확정에만 OS 아크릴 재틴트가 붙는다.
  describe("bgSat (§3/E3)", () => {
    beforeEach(() => {
      localStorage.clear();
      callMock.mockReset().mockResolvedValue({ settings: {} });
      useSettingsStore.setState({
        themePref: "dark",
        theme: "dark",
        bgSat: 0,
        surfaceStyle: "flat",
        surfaceEffectApplied: true,
      });
    });

    it("키가 없는 설치는 0 으로 읽는다 — 업데이트만으로 배경이 물들면 안 된다", async () => {
      callMock.mockResolvedValueOnce({ settings: {} });
      await useSettingsStore.getState().load();
      expect(useSettingsStore.getState().bgSat).toBe(0);
      // 채도 0 의 --app-canvas 는 테마 기준 캔버스 그대로다.
      expect(document.documentElement.style.getPropertyValue("--app-canvas")).toBe("#171b1a");
    });

    it("DB 값을 클램프해 읽는다(백엔드 0..=100 과 같은 범위)", async () => {
      callMock.mockResolvedValueOnce({ settings: { bg_sat: 999 } });
      await useSettingsStore.getState().load();
      expect(useSettingsStore.getState().bgSat).toBe(100);
    });

    it("드래그 틱(live)은 조용히 저장하고 OS 를 부르지 않는다", async () => {
      await useSettingsStore.getState().setBgSat(40, { live: true });

      expect(useSettingsStore.getState().bgSat).toBe(40);
      expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { bg_sat: 40 } });
      expect(callMock).not.toHaveBeenCalledWith("window_set_effect", expect.anything());
      // 캔버스는 즉시 물든다 — 드래그 중 보이는 것이 CSS 쪽이다.
      expect(document.documentElement.style.getPropertyValue("--app-canvas")).not.toBe("#171b1a");
    });

    it("소수는 정수로 반올림한다(백엔드 as_i64 가 소수를 통째로 거부한다)", async () => {
      await useSettingsStore.getState().setBgSat(12.6, { live: true });
      expect(useSettingsStore.getState().bgSat).toBe(13);
      expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { bg_sat: 13 } });
    });

    it("확정(손 뗌)은 아크릴일 때만 OS 틴트를 **한 번** 다시 보낸다", async () => {
      useSettingsStore.setState({ surfaceStyle: "acrylic", surfaceEffectApplied: true });
      callMock.mockResolvedValue({ applied: true });

      await useSettingsStore.getState().setBgSat(60);

      const osCalls = callMock.mock.calls.filter((c) => c[0] === "window_set_effect");
      expect(osCalls).toHaveLength(1);
      // 보내는 틴트는 채도가 얹힌 색이다 — 안 얹으면 CSS 만 물들고 아크릴이 따로 논다(§4).
      const tint = (osCalls[0][1] as { tint: [number, number, number, number] }).tint;
      expect(tint).not.toEqual([23, 27, 26, 90]);
      expect(tint[3]).toBe(90);
    });

    it("flat 에서는 확정해도 OS 를 부르지 않는다(보낼 효과가 없다)", async () => {
      await useSettingsStore.getState().setBgSat(60);
      expect(callMock).not.toHaveBeenCalledWith("window_set_effect", expect.anything());
      expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { bg_sat: 60 } });
    });

    it("확정이 실패하면 이전 값으로 되돌린다(클릭 경로의 규칙 — 함정 9)", async () => {
      useSettingsStore.setState({ bgSat: 20 });
      callMock.mockReset().mockRejectedValue(new Error("settings_set failed"));

      await useSettingsStore.getState().setBgSat(70);

      expect(useSettingsStore.getState().bgSat).toBe(20);
    });

    it("시드에 담긴다 — 다음 부팅의 첫 페인트가 채도를 안다", async () => {
      await useSettingsStore.getState().setBgSat(45, { live: true });
      expect(loadAppearanceSeed().bgSat).toBe(45);
    });
  });

  describe("userName setting (W10)", () => {
    it("loads and persists userName", async () => {
      callMock.mockResolvedValueOnce({
        settings: { user_name: "홍길동" },
      });

      await useSettingsStore.getState().load();
      expect(useSettingsStore.getState().userName).toBe("홍길동");

      await useSettingsStore.getState().setUserName("이순신");
      expect(useSettingsStore.getState().userName).toBe("이순신");
      expect(callMock).toHaveBeenCalledWith("settings_set", {
        entries: { user_name: "이순신" },
      });
    });
  });

  describe("pet reaction and chat memory settings (W13/W18)", () => {
    it("loads and persists pet reactions and chat memory", async () => {
      callMock.mockResolvedValueOnce({
        settings: {
          pet_dblclick_action: "chat",
          chat_memory: [{ id: "m1", text: "Likes coffee", created_at: "2026-08-21T00:00:00Z" }],
        },
      });

      await useSettingsStore.getState().load();
      expect(useSettingsStore.getState().petDblclickAction).toBe("chat");
      expect(useSettingsStore.getState().chatMemory).toEqual([
        { id: "m1", text: "Likes coffee", created_at: "2026-08-21T00:00:00Z" },
      ]);

      await useSettingsStore.getState().setPetDblclickAction("off");
      expect(callMock).toHaveBeenCalledWith("settings_set", {
        entries: { pet_dblclick_action: "off" },
      });

      await useSettingsStore.getState().addChatMemory("Has 2 cats");
      expect(useSettingsStore.getState().chatMemory).toHaveLength(2);
      expect(callMock).toHaveBeenCalledWith("settings_set", expect.objectContaining({
        entries: expect.objectContaining({
          chat_memory: expect.arrayContaining([
            expect.objectContaining({ text: "Has 2 cats" }),
          ]),
        }),
      }));

      await useSettingsStore.getState().removeChatMemory("m1");
      expect(useSettingsStore.getState().chatMemory).toHaveLength(1);
      expect(useSettingsStore.getState().chatMemory[0].text).toBe("Has 2 cats");
    });

    it("addChatMemory returns true on success and false on duplicate/failure", async () => {
      useSettingsStore.setState({ chatMemory: [] });
      const ok = await useSettingsStore.getState().addChatMemory("Unique memory");
      expect(ok).toBe(true);

      const dup = await useSettingsStore.getState().addChatMemory("Unique memory");
      expect(dup).toBe(false);

      const empty = await useSettingsStore.getState().addChatMemory("   ");
      expect(empty).toBe(false);
    });

    it("setCollectExcludedDomains writes mirror on success and skips mirror on rollback", async () => {
      useSettingsStore.setState({ collectExcludedDomains: [] });
      callMock.mockResolvedValue({});

      await useSettingsStore.getState().setCollectExcludedDomains(["example.com"]);
      expect(useSettingsStore.getState().collectExcludedDomains).toEqual(["example.com"]);
      expect(callMock).toHaveBeenCalledWith("settings_set", {
        entries: { collect_excluded_domains: ["example.com"] },
      });
      expect(callMock).toHaveBeenCalledWith("settings_set", {
        entries: { capture_visit_excluded_domains: ["example.com"] },
      });

      // Failure case: setSimplePref fails and rolls back
      callMock.mockReset();
      callMock.mockRejectedValueOnce(new Error("db error"));
      await useSettingsStore.getState().setCollectExcludedDomains(["failed.com"]);
      expect(useSettingsStore.getState().collectExcludedDomains).toEqual(["example.com"]);
      // Legacy mirror must NOT have been written
      expect(callMock).not.toHaveBeenCalledWith("settings_set", {
        entries: { capture_visit_excluded_domains: ["failed.com"] },
      });
    });
  });
});

// 결함: setSimplePref 는 settings_set 실패 시에도 낙관적 set() 을 되돌리지 않았다 — 화면은
// 새 값인데 DB 는 옛 값인 채로 남아, 재시작하면 조용히 되돌아갔다(GalleryExpanded 첨부 삭제와
// 같은 결함 계열). 아래는 그 롤백과, 롤백을 삼키는(재던지지 않는) 설계, 연타 레이스를 고정한다.
describe("settings store — setSimplePref rollback on settings_set failure (reliability fix)", () => {
  beforeEach(() => {
    callMock.mockReset();
    useSettingsStore.setState({ weekStart: "sunday", closeToTray: true, userName: "" });
  });

  it("rolls back to the previous value when settings_set rejects", async () => {
    callMock.mockRejectedValueOnce(new Error("db locked"));

    await useSettingsStore.getState().setWeekStart("monday");

    expect(useSettingsStore.getState().weekStart).toBe("sunday");
  });

  it("swallows the rejection — call() 이 이미 토스트를 띄우므로 setSimplePref 는 재던지지 않는다", async () => {
    callMock.mockRejectedValueOnce(new Error("db locked"));

    await expect(useSettingsStore.getState().setWeekStart("monday")).resolves.toBeUndefined();
  });

  it("a bare `void setX(...)` call site (MobileSettings.tsx 등 실제 형태) never produces an unhandled rejection", async () => {
    callMock.mockRejectedValueOnce(new Error("db locked"));

    // .catch 없이 그냥 버리는 실제 호출부와 같은 형태. 이 테스트가 죽지 않고(vitest 는
    // 미처리 rejection 을 실패로 잡는다) 끝까지 도달하면 통과.
    void useSettingsStore.getState().setCloseToTray(false);
    await Promise.resolve();
    await Promise.resolve();

    expect(useSettingsStore.getState().closeToTray).toBe(true);
  });

  it("race: a stale failing request does not clobber a newer, already-succeeded value", async () => {
    let rejectFirst!: (e: Error) => void;
    callMock.mockImplementationOnce(
      () => new Promise((_resolve, reject) => { rejectFirst = reject; }),
    );
    callMock.mockImplementationOnce(() => Promise.resolve({ ok: true }));

    // 연타: 첫 요청("Alice")이 아직 안 끝난 사이 두 번째("Bob")를 쏜다.
    const first = useSettingsStore.getState().setUserName("Alice");
    await useSettingsStore.getState().setUserName("Bob");
    expect(useSettingsStore.getState().userName).toBe("Bob");

    // 이제서야 첫 요청이 실패로 확정된다 — prev("")로 무조건 롤백하면 "Bob"을 덮어쓴다.
    rejectFirst(new Error("stale failure"));
    await first;
    expect(useSettingsStore.getState().userName).toBe("Bob");
  });
});

// 오너 결정(2026-09-20) — 설정 > 에디터 신규 6키(date_nudge_enabled/region_nudge_enabled +
// 붙여넣기 자동 동작 3종 + 마크다운 자동 서식) + 3단 UI 콤보 setter(setDateNudgeMode/
// setRegionNudgeMode). 이 웨이브는 키 등록·스토어 API 만 만든다 — 게이트(에디터 동작)·UI 는
// 다음 두 웨이브가 얹는다.
describe("settings store — new editor keys (2026-09-20): date/region nudge enabled + paste/markdown toggles", () => {
  const SIMPLE_KEYS: Array<{
    camel:
      | "dateNudgeEnabled"
      | "regionNudgeEnabled"
      | "pasteLinkNudge"
      | "pastePathInlineCode"
      | "pasteTableSheetSuggest"
      | "editorMdAutoformat";
    snake: string;
    setter:
      | "setDateNudgeEnabled"
      | "setRegionNudgeEnabled"
      | "setPasteLinkNudge"
      | "setPastePathInlineCode"
      | "setPasteTableSheetSuggest"
      | "setEditorMdAutoformat";
  }> = [
    { camel: "dateNudgeEnabled", snake: "date_nudge_enabled", setter: "setDateNudgeEnabled" },
    { camel: "regionNudgeEnabled", snake: "region_nudge_enabled", setter: "setRegionNudgeEnabled" },
    { camel: "pasteLinkNudge", snake: "paste_link_nudge", setter: "setPasteLinkNudge" },
    { camel: "pastePathInlineCode", snake: "paste_path_inline_code", setter: "setPastePathInlineCode" },
    { camel: "pasteTableSheetSuggest", snake: "paste_table_sheet_suggest", setter: "setPasteTableSheetSuggest" },
    { camel: "editorMdAutoformat", snake: "editor_md_autoformat", setter: "setEditorMdAutoformat" },
  ];

  beforeEach(() => {
    callMock.mockReset();
  });

  it("all six default to true", () => {
    for (const { camel } of SIMPLE_KEYS) {
      expect(useSettingsStore.getState()[camel]).toBe(true);
    }
  });

  it("load() parses a stored false for each key (boolDefaultTrue coercion)", async () => {
    useSettingsStore.setState({ loaded: false });
    // load() 는 firstLoad && !isBrowser() 일 때 settings_get_all 뒤 window_surface_support 도
    // 부른다(callSilent, 다른 load() 테스트들과 같은 이유로 catch-all 기본값이 필요하다).
    callMock.mockResolvedValue({ ok: true });
    callMock.mockResolvedValueOnce({
      settings: Object.fromEntries(SIMPLE_KEYS.map(({ snake }) => [snake, false])),
    });

    await useSettingsStore.getState().load();

    for (const { camel } of SIMPLE_KEYS) {
      expect(useSettingsStore.getState()[camel]).toBe(false);
    }
  });

  it.each(SIMPLE_KEYS)("$setter persists its key via settings_set and updates state", async ({ camel, snake, setter }) => {
    useSettingsStore.setState({ [camel]: true } as never);
    callMock.mockResolvedValue({ ok: true });

    await (useSettingsStore.getState()[setter] as (v: boolean) => Promise<void>)(false);

    expect(useSettingsStore.getState()[camel]).toBe(false);
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { [snake]: false } });
  });

  describe("dateNudgeModeOf / regionNudgeModeOf — pure truth tables", () => {
    it("dateNudgeModeOf: enabled=false is always off regardless of auto", () => {
      expect(dateNudgeModeOf(false, false)).toBe("off");
      expect(dateNudgeModeOf(false, true)).toBe("off");
    });
    it("dateNudgeModeOf: enabled=true maps auto to suggest/auto", () => {
      expect(dateNudgeModeOf(true, false)).toBe("suggest");
      expect(dateNudgeModeOf(true, true)).toBe("auto");
    });
    it("regionNudgeModeOf: enabled=false is always off regardless of strict", () => {
      expect(regionNudgeModeOf(false, false)).toBe("off");
      expect(regionNudgeModeOf(false, true)).toBe("off");
    });
    it("regionNudgeModeOf: enabled=true maps strict to strict/loose", () => {
      expect(regionNudgeModeOf(true, true)).toBe("strict");
      expect(regionNudgeModeOf(true, false)).toBe("loose");
    });
  });

  describe("setDateNudgeMode — combined setter (ONE settings_set call per mode)", () => {
    beforeEach(() => {
      useSettingsStore.setState({ dateNudgeEnabled: true, dateNudgeAuto: false });
      callMock.mockReset().mockResolvedValue({ ok: true });
    });

    it('"off" sends only date_nudge_enabled=false — does not overwrite date_nudge_auto', async () => {
      await useSettingsStore.getState().setDateNudgeMode("off");

      expect(callMock).toHaveBeenCalledTimes(1);
      expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { date_nudge_enabled: false } });
      expect(useSettingsStore.getState().dateNudgeEnabled).toBe(false);
      // 건드리지 않았으니 이전 선택(false=suggest)이 그대로 남는다.
      expect(useSettingsStore.getState().dateNudgeAuto).toBe(false);
    });

    it('"off" preserves a previously-true date_nudge_auto (does not flip it to false)', async () => {
      useSettingsStore.setState({ dateNudgeEnabled: true, dateNudgeAuto: true });

      await useSettingsStore.getState().setDateNudgeMode("off");

      expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { date_nudge_enabled: false } });
      expect(useSettingsStore.getState().dateNudgeAuto).toBe(true);
    });

    it('"suggest" sends both keys in one call: enabled=true, auto=false', async () => {
      await useSettingsStore.getState().setDateNudgeMode("suggest");

      expect(callMock).toHaveBeenCalledTimes(1);
      expect(callMock).toHaveBeenCalledWith("settings_set", {
        entries: { date_nudge_enabled: true, date_nudge_auto: false },
      });
      expect(useSettingsStore.getState().dateNudgeEnabled).toBe(true);
      expect(useSettingsStore.getState().dateNudgeAuto).toBe(false);
    });

    it('"auto" sends both keys in one call: enabled=true, auto=true', async () => {
      await useSettingsStore.getState().setDateNudgeMode("auto");

      expect(callMock).toHaveBeenCalledTimes(1);
      expect(callMock).toHaveBeenCalledWith("settings_set", {
        entries: { date_nudge_enabled: true, date_nudge_auto: true },
      });
      expect(useSettingsStore.getState().dateNudgeEnabled).toBe(true);
      expect(useSettingsStore.getState().dateNudgeAuto).toBe(true);
    });

    it("rejects: BOTH fields roll back together", async () => {
      useSettingsStore.setState({ dateNudgeEnabled: false, dateNudgeAuto: false });
      callMock.mockReset().mockRejectedValueOnce(new Error("db locked"));

      await useSettingsStore.getState().setDateNudgeMode("auto");

      expect(useSettingsStore.getState().dateNudgeEnabled).toBe(false);
      expect(useSettingsStore.getState().dateNudgeAuto).toBe(false);
    });
  });

  describe("setRegionNudgeMode — combined setter (ONE settings_set call per mode)", () => {
    beforeEach(() => {
      useSettingsStore.setState({ regionNudgeEnabled: true, regionNudgeStrict: true });
      callMock.mockReset().mockResolvedValue({ ok: true });
    });

    it('"off" sends only region_nudge_enabled=false — does not overwrite region_nudge_strict', async () => {
      await useSettingsStore.getState().setRegionNudgeMode("off");

      expect(callMock).toHaveBeenCalledTimes(1);
      expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { region_nudge_enabled: false } });
      expect(useSettingsStore.getState().regionNudgeEnabled).toBe(false);
      expect(useSettingsStore.getState().regionNudgeStrict).toBe(true);
    });

    it('"strict" sends both keys in one call: enabled=true, strict=true', async () => {
      await useSettingsStore.getState().setRegionNudgeMode("strict");

      expect(callMock).toHaveBeenCalledTimes(1);
      expect(callMock).toHaveBeenCalledWith("settings_set", {
        entries: { region_nudge_enabled: true, region_nudge_strict: true },
      });
      expect(useSettingsStore.getState().regionNudgeEnabled).toBe(true);
      expect(useSettingsStore.getState().regionNudgeStrict).toBe(true);
    });

    it('"loose" sends both keys in one call: enabled=true, strict=false', async () => {
      await useSettingsStore.getState().setRegionNudgeMode("loose");

      expect(callMock).toHaveBeenCalledTimes(1);
      expect(callMock).toHaveBeenCalledWith("settings_set", {
        entries: { region_nudge_enabled: true, region_nudge_strict: false },
      });
      expect(useSettingsStore.getState().regionNudgeEnabled).toBe(true);
      expect(useSettingsStore.getState().regionNudgeStrict).toBe(false);
    });

    it("rejects: BOTH fields roll back together", async () => {
      useSettingsStore.setState({ regionNudgeEnabled: false, regionNudgeStrict: true });
      callMock.mockReset().mockRejectedValueOnce(new Error("db locked"));

      await useSettingsStore.getState().setRegionNudgeMode("loose");

      expect(useSettingsStore.getState().regionNudgeEnabled).toBe(false);
      expect(useSettingsStore.getState().regionNudgeStrict).toBe(true);
    });
  });
});

// 오너 결정(2026-09-20, "4~7번도 넣어봐, 보고 이상하면 지울게") — **실험적** 설정 4종. 위
// describe 블록(2026-09-20 여섯 키)과 형태는 같지만(defaults · load() coercion · 무효값 →
// 기본값 · setter 영속) 실험적이라는 표시로 별도 블록에 둔다 — 오너가 빼라고 하면 이 블록
// 전체를 지우면 된다(다른 키 테스트와 안 얽혀 있다).
describe("settings store — experimental editor settings (2026-09-20 follow-up): link click, width, word count, new-note defaults", () => {
  beforeEach(() => {
    callMock.mockReset();
  });

  // editorWordCount 만 기본 true — 상태줄 글자 수는 이 키 이전부터 늘 보이던 것이라 "끌 수 있게" 하는
  // 스위치다(false 기본이면 키를 만든 것만으로 기존 화면에서 사라진다).
  it("linkOpenOnClick defaults to false and editorWordCount to TRUE; editorWidth defaults to 'normal'; newNoteDatePrecision defaults to 'day'; newNoteSectionName defaults to ''", () => {
    expect(useSettingsStore.getState().linkOpenOnClick).toBe(false);
    expect(useSettingsStore.getState().editorWordCount).toBe(true);
    expect(useSettingsStore.getState().editorWidth).toBe("normal");
    expect(useSettingsStore.getState().newNoteDatePrecision).toBe("day");
    expect(useSettingsStore.getState().newNoteSectionName).toBe("");
  });

  it("load() parses stored values for the two booleans", async () => {
    useSettingsStore.setState({ loaded: false });
    callMock.mockResolvedValue({ ok: true });
    callMock.mockResolvedValueOnce({
      settings: { link_open_on_click: true, editor_word_count: false },
    });

    await useSettingsStore.getState().load();

    expect(useSettingsStore.getState().linkOpenOnClick).toBe(true);
    // 저장된 false 를 읽어 기본(true)을 덮어쓴다.
    expect(useSettingsStore.getState().editorWordCount).toBe(false);
  });

  it("load() parses a valid stored editor_width/new_note_date_precision and falls back to the default on an invalid one", async () => {
    useSettingsStore.setState({ loaded: false });
    callMock.mockResolvedValue({ ok: true });
    callMock.mockResolvedValueOnce({
      settings: { editor_width: "wide", new_note_date_precision: "year" },
    });
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().editorWidth).toBe("wide");
    expect(useSettingsStore.getState().newNoteDatePrecision).toBe("year");

    useSettingsStore.setState({ loaded: false });
    callMock.mockResolvedValueOnce({
      settings: { editor_width: "huge", new_note_date_precision: "week" },
    });
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().editorWidth).toBe("normal");
    expect(useSettingsStore.getState().newNoteDatePrecision).toBe("day");
  });

  it("load() trims and clamps a stored new_note_section_name to 40 chars, and falls back to '' on a non-string", async () => {
    useSettingsStore.setState({ loaded: false });
    callMock.mockResolvedValue({ ok: true });
    callMock.mockResolvedValueOnce({
      settings: { new_note_section_name: `  ${"가".repeat(45)}  ` },
    });
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().newNoteSectionName).toBe("가".repeat(40));

    useSettingsStore.setState({ loaded: false });
    callMock.mockResolvedValueOnce({ settings: { new_note_section_name: 123 } });
    await useSettingsStore.getState().load();
    expect(useSettingsStore.getState().newNoteSectionName).toBe("");
  });

  it.each([
    { camel: "linkOpenOnClick" as const, snake: "link_open_on_click", setter: "setLinkOpenOnClick" as const, value: true },
    { camel: "editorWordCount" as const, snake: "editor_word_count", setter: "setEditorWordCount" as const, value: true },
    { camel: "editorWidth" as const, snake: "editor_width", setter: "setEditorWidth" as const, value: "wide" },
    { camel: "newNoteDatePrecision" as const, snake: "new_note_date_precision", setter: "setNewNoteDatePrecision" as const, value: "year" },
  ])("$setter persists its key via settings_set and updates state", async ({ camel, snake, setter, value }) => {
    callMock.mockResolvedValue({ ok: true });

    await (useSettingsStore.getState()[setter] as (v: unknown) => Promise<void>)(value);

    expect(useSettingsStore.getState()[camel]).toBe(value);
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { [snake]: value } });
  });

  it("setNewNoteSectionName trims and clamps to 40 chars before persisting", async () => {
    callMock.mockResolvedValue({ ok: true });

    await useSettingsStore.getState().setNewNoteSectionName(`  ${"a".repeat(45)}  `);

    expect(useSettingsStore.getState().newNoteSectionName).toBe("a".repeat(40));
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { new_note_section_name: "a".repeat(40) } });
  });

  it("setNewNoteSectionName persists an empty string (clears back to the built-in default name)", async () => {
    useSettingsStore.setState({ newNoteSectionName: "Log" });
    callMock.mockResolvedValue({ ok: true });

    await useSettingsStore.getState().setNewNoteSectionName("");

    expect(useSettingsStore.getState().newNoteSectionName).toBe("");
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { new_note_section_name: "" } });
  });
});

// PLAN-2026-09-19 테마 초기화·불러오기 — 적용은 settings_set 한 번 + OS 효과 한 번.
describe("settings store — applyAppearance (theme presets)", () => {
  const cmds = () => callMock.mock.calls.map((c) => c[0]);

  beforeEach(() => {
    callMock.mockReset();
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "settings_get_all") return { settings: { theme: "dark", surface_style: "flat" } };
      if (cmd === "window_set_effect") return { applied: true };
      return { ok: true };
    });
    useSettingsStore.setState({ loaded: true, acrylicSupported: true });
  });

  it("writes every entry in ONE settings_set and sets the OS effect exactly once", async () => {
    const entries = { theme: "light", accent: "#112233", bg_sat: 40, surface_style: "flat" };
    const res = await useSettingsStore.getState().applyAppearance(entries);

    expect(res.blockedAcrylic).toBe(false);
    expect(cmds().filter((c) => c === "settings_set")).toHaveLength(1);
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries });
    expect(cmds().filter((c) => c === "window_set_effect")).toHaveLength(1);
  });

  it("stores flat instead of acrylic on a device that cannot draw acrylic (Windows 10 guard)", async () => {
    useSettingsStore.setState({ acrylicSupported: false });
    const res = await useSettingsStore.getState().applyAppearance({ surface_style: "acrylic", theme: "dark" });

    expect(res.blockedAcrylic).toBe(true);
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { surface_style: "flat", theme: "dark" } });
  });

  it("keeps acrylic when the device supports it", async () => {
    const res = await useSettingsStore.getState().applyAppearance({ surface_style: "acrylic" });
    expect(res.blockedAcrylic).toBe(false);
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { surface_style: "acrylic" } });
  });
});

describe("appearanceEntries ↔ Rust APPEARANCE_KEYS", () => {
  it("snapshots exactly the keys Rust treats as appearance", async () => {
    const { readFileSync } = await import("node:fs");
    const { appearanceEntries } = await import("./settings");
    const rust = readFileSync("src-tauri/src/repo/settings_schema.rs", "utf8");
    const block = rust.match(/APPEARANCE_KEYS: \[&str; \d+\] = \[([\s\S]*?)\];/);
    expect(block).not.toBeNull();
    const rustKeys = [...block![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
    const tsKeys = Object.keys(appearanceEntries(useSettingsStore.getState())).sort();
    expect(tsKeys).toEqual(rustKeys);
  });
});

describe("settings store — setSurfaceStyle acrylic guard (PLAN-2026-09-19 §4)", () => {
  it("refuses to store acrylic on a device without acrylic support", async () => {
    callMock.mockReset().mockResolvedValue({ ok: true });
    useSettingsStore.setState({ acrylicSupported: false, surfaceStyle: "flat" });
    await useSettingsStore.getState().setSurfaceStyle("acrylic");
    expect(useSettingsStore.getState().surfaceStyle).toBe("flat");
    expect(callMock).not.toHaveBeenCalled();
  });
});

// 클릭 한 번으로 끝나는 외형·지도 setter 네 개의 롤백 계약 — 저장이 실패하면 화면 값(과 OS 효과)을
// 이전으로 되돌리고, rejection 은 삼킨다. 그 사이 더 새 요청이 있었다면 옛 실패가 그걸 덮지 않는다.
describe("settings store — click setters roll back on settings_set failure", () => {
  // window_set_effect 는 성공시키고 settings_set 만 실패시킨다(명령 이름으로 갈라 응답).
  const failSettingsSet = (applied = true) =>
    callMock.mockReset().mockImplementation((cmd: string) =>
      cmd === "settings_set" ? Promise.reject(new Error("db locked")) : Promise.resolve({ applied }),
    );
  const deferred = () => {
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  beforeEach(() => {
    localStorage.clear();
    useSettingsStore.setState({
      themePref: "dark",
      theme: "dark",
      surfaceStyle: "flat",
      surfaceEffectApplied: true,
      acrylicSupported: true,
      bgSat: 12,
      fontFamily: "pretendard",
      defaultMapLocation: { lat: 1, lng: 2, zoom: 100 },
      defaultMapLocationCustomized: false,
    });
  });

  it("setTheme: restores themePref/theme and the seed, and resolves instead of rejecting", async () => {
    failSettingsSet();
    await expect(useSettingsStore.getState().setTheme("light")).resolves.toBeUndefined();
    expect(useSettingsStore.getState().themePref).toBe("dark");
    expect(useSettingsStore.getState().theme).toBe("dark");
    expect(loadAppearanceSeed().theme).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("setTheme on acrylic: re-applies the OS effect for the previous theme", async () => {
    useSettingsStore.setState({ surfaceStyle: "acrylic" });
    failSettingsSet();
    await useSettingsStore.getState().setTheme("light");
    const effects = callMock.mock.calls.filter((c) => c[0] === "window_set_effect");
    expect(effects).toHaveLength(2);
    // 마지막 OS 호출 = 되돌린 테마(dark)의 틴트. 앞의 호출(light)과 틴트가 달라야 한다.
    expect(effects[1][1]).toMatchObject({ style: "acrylic" });
    expect(effects[1][1]).not.toEqual(effects[0][1]);
    expect(useSettingsStore.getState().theme).toBe("dark");
  });

  it("setSurfaceStyle: restores flat, re-calls window_set_effect with flat, resolves", async () => {
    failSettingsSet(true);
    await expect(useSettingsStore.getState().setSurfaceStyle("acrylic")).resolves.toBeUndefined();
    expect(useSettingsStore.getState().surfaceStyle).toBe("flat");
    expect(loadAppearanceSeed().surfaceStyle).toBe("flat");
    const effects = callMock.mock.calls.filter((c) => c[0] === "window_set_effect").map((c) => c[1].style);
    // flat 으로 돌아갈 때도 OS 를 부른다 — 그래야 방금 건 아크릴이 실제로 지워진다.
    expect(effects).toEqual(["acrylic", "flat"]);
  });

  it("setFontFamily: restores the previous font and the seed", async () => {
    failSettingsSet();
    await expect(useSettingsStore.getState().setFontFamily("Gulim")).resolves.toBeUndefined();
    expect(useSettingsStore.getState().fontFamily).toBe("pretendard");
    expect(loadAppearanceSeed().fontFamily).toBe("pretendard");
  });

  it("setDefaultMapLocation: restores coords + customized flag and reports false", async () => {
    failSettingsSet();
    await expect(
      useSettingsStore.getState().setDefaultMapLocation({ lat: 9, lng: 9, zoom: 50 }),
    ).resolves.toBe(false);
    expect(useSettingsStore.getState().defaultMapLocation).toEqual({ lat: 1, lng: 2, zoom: 100 });
    expect(useSettingsStore.getState().defaultMapLocationCustomized).toBe(false);
  });

  it("setDefaultMapLocation: reports true on success", async () => {
    callMock.mockReset().mockResolvedValue({ ok: true });
    await expect(
      useSettingsStore.getState().setDefaultMapLocation({ lat: 9, lng: 9, zoom: 50 }),
    ).resolves.toBe(true);
  });

  it("a slow failure of an older request does not revert a newer value (setFontFamily)", async () => {
    const first = deferred();
    const second = deferred();
    callMock.mockReset().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const p1 = useSettingsStore.getState().setFontFamily("Gulim");
    const p2 = useSettingsStore.getState().setFontFamily("Batang");
    second.resolve({ ok: true });
    await p2;
    first.reject(new Error("late failure"));
    await p1;
    expect(useSettingsStore.getState().fontFamily).toBe("Batang");
  });

  it("a slow failure of an older request does not revert a newer value (setTheme)", async () => {
    const first = deferred();
    const second = deferred();
    callMock.mockReset().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const p1 = useSettingsStore.getState().setTheme("light");
    const p2 = useSettingsStore.getState().setTheme("dark");
    // 재질이 flat 이라 OS 호출이 없다 — 위 두 deferred 가 그대로 settings_set 두 번이다.
    second.resolve({ ok: true });
    await p2;
    first.reject(new Error("late failure"));
    await p1;
    expect(useSettingsStore.getState().themePref).toBe("dark");
  });

  it("the latest failing request still rolls back to the value before it", async () => {
    const first = deferred();
    const second = deferred();
    callMock.mockReset().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const p1 = useSettingsStore.getState().setDefaultMapLocation({ lat: 3, lng: 3, zoom: 1 });
    const p2 = useSettingsStore.getState().setDefaultMapLocation({ lat: 4, lng: 4, zoom: 1 });
    first.resolve({ ok: true });
    await p1;
    second.reject(new Error("fail"));
    await p2;
    expect(useSettingsStore.getState().defaultMapLocation).toEqual({ lat: 3, lng: 3, zoom: 1 });
  });
});
