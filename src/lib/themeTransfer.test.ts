import { describe, it, expect, vi, beforeEach } from "vitest";

const callMock = vi.fn();
const noticeMock = vi.fn();
const openMock = vi.fn();

vi.mock("./invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: (m: string) => noticeMock(m),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openMock(...args),
  save: vi.fn(),
}));

import { importThemeFromPicker } from "./themeTransfer";
import { useSettingsStore } from "../stores/settings";
import { t } from "../i18n/t";

describe("importThemeFromPicker (PLAN-2026-09-19)", () => {
  beforeEach(() => {
    callMock.mockReset();
    noticeMock.mockReset();
    openMock.mockReset().mockResolvedValue("C:/themes/mine.brise-theme.json");
    useSettingsStore.setState({ loaded: true, acrylicSupported: false, themePref: "dark", surfaceStyle: "flat" });
  });

  it("applies the file's entries, blocks acrylic on an unsupported device, and says so", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "theme_read")
        return { entries: { theme: "light", surface_style: "acrylic" }, skipped_unknown: 2, source: "theme" };
      if (cmd === "settings_get_all") return { settings: { theme: "light", surface_style: "flat" } };
      if (cmd === "window_set_effect") return { applied: true };
      return { ok: true };
    });

    const prev = await importThemeFromPicker();

    expect(prev).toMatchObject({ theme: "dark", surface_style: "flat" });
    expect(callMock).toHaveBeenCalledWith("theme_read", { path: "C:/themes/mine.brise-theme.json" });
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { theme: "light", surface_style: "flat" } });
    const notice = noticeMock.mock.calls[0][0] as string;
    expect(notice).toContain(t("settings.theme_import_skipped", { n: 2 }));
    expect(notice).toContain(t("settings.theme_acrylic_blocked"));
  });

  it("maps a newer-format rejection to the translated message and writes nothing", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "theme_read") throw { code: "VALIDATION", message: "This theme requires a newer version of Brise (…)" };
      return { ok: true };
    });

    expect(await importThemeFromPicker()).toBeNull();
    expect(callMock).not.toHaveBeenCalledWith("settings_set", expect.anything());
    expect(noticeMock).toHaveBeenCalledTimes(1);
    expect(noticeMock).toHaveBeenCalledWith(t("settings.import_version_newer"));
  });

  it("does nothing when the picker is cancelled", async () => {
    openMock.mockResolvedValue(null);
    expect(await importThemeFromPicker()).toBeNull();
    expect(callMock).not.toHaveBeenCalled();
  });
});
