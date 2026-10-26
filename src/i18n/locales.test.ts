import { describe, it, expect, beforeEach, vi } from "vitest";

const reportFallback = vi.fn();
vi.mock("../lib/diag", () => ({ reportFallback: (...a: unknown[]) => reportFallback(...a) }));
vi.mock("../lib/invoke", () => ({ call: vi.fn().mockResolvedValue(undefined), callSilent: vi.fn().mockResolvedValue(undefined) }));

import { ensureLocale, getDict, normalizeLang, rememberLocaleHint } from "./locales";
import { useSettingsStore } from "../stores/settings";

beforeEach(() => {
  reportFallback.mockClear();
  localStorage.clear();
});

describe("locales", () => {
  it("모르는 언어 값은 영어로 본다", () => {
    expect(normalizeLang("de")).toBe("en");
    expect(normalizeLang(undefined)).toBe("en");
    expect(normalizeLang("fr")).toBe("fr");
  });

  it("사전을 언어별로 한 덩어리씩 받는다 — 네임스페이스가 최상위 키", async () => {
    await ensureLocale("ko");
    const ko = getDict("ko") as Record<string, unknown>;
    expect(ko.common).toBeTypeOf("object");
    expect(ko.settings).toBeTypeOf("object");
  });

  it("다음 부팅이 먼저 받을 언어를 기억한다", () => {
    rememberLocaleHint("fr");
    expect(localStorage.getItem("brise_ui_lang_hint")).toBe("fr");
    rememberLocaleHint("xx");
    expect(localStorage.getItem("brise_ui_lang_hint")).toBe("en");
  });

  it("setUiLang 은 사전을 받은 뒤 언어를 바꾸고 다음 부팅용 힌트를 남긴다", async () => {
    await useSettingsStore.getState().setUiLang("fr");
    expect(useSettingsStore.getState().uiLang).toBe("fr");
    expect(getDict("fr")).toBeTruthy();
    expect(localStorage.getItem("brise_ui_lang_hint")).toBe("fr");
  });
});
