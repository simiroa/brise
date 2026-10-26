import { describe, it, expect, beforeEach } from "vitest";
import { searchSettings, SETTINGS_SEARCH_MAX } from "./searchSettings";
import { SETTINGS_SEARCH_INDEX, type SettingsSearchEntry } from "./settingsSearchIndex";
import { useSettingsStore } from "../../stores/settings";
import { t } from "../../i18n/t";

const ALL_PAGES = [...new Set(SETTINGS_SEARCH_INDEX.map((e) => e.page))];
const labelOf = (page: string) => t(`settings.page_${page}`);
const base = { pageIds: ALL_PAGES, aiEnabled: true, pageLabel: labelOf };

describe("searchSettings (PLAN-2026-10-24 W4)", () => {
  beforeEach(() => {
    useSettingsStore.setState({ uiLang: "ko" } as never);
  });

  it("빈 질의·공백 질의는 결과가 없다", () => {
    expect(searchSettings("", SETTINGS_SEARCH_INDEX, base)).toEqual([]);
    expect(searchSettings("   ", SETTINGS_SEARCH_INDEX, base)).toEqual([]);
  });

  it("'백업' 은 데이터 페이지의 백업 행들을 낸다", () => {
    const r = searchSettings("백업", SETTINGS_SEARCH_INDEX, base);
    expect(r.length).toBeGreaterThan(0);
    expect(r.some((x) => x.entry.page === "data" && x.entry.anchor === "backup_auto")).toBe(true);
    expect(r.length).toBeLessThanOrEqual(SETTINGS_SEARCH_MAX);
  });

  it("대소문자와 앞뒤 공백을 무시한다 (en)", () => {
    useSettingsStore.setState({ uiLang: "en" } as never);
    const a = searchSettings("  BACKUP ", SETTINGS_SEARCH_INDEX, base);
    const b = searchSettings("backup", SETTINGS_SEARCH_INDEX, base);
    expect(a.map((x) => x.entry)).toEqual(b.map((x) => x.entry));
    expect(a.length).toBeGreaterThan(0);
  });

  const E = (labelKey: string, extra: Partial<SettingsSearchEntry> = {}): SettingsSearchEntry => ({
    page: "data",
    labelKey,
    ...extra,
  });

  it("순위: 라벨 접두 > 라벨 부분 > 그룹·동의어", () => {
    // ko: "백업" — 라벨이 '백업'으로 시작하는 것이 앞, 중간에 들어간 것이 다음, 그룹으로만 맞은 것이 마지막.
    const entries = [
      E("settings.data_location_row", { groupKey: "settings.storage_backup_group" }), // 그룹으로만
      E("settings.backup_auto"), // 라벨 부분(자동 백업)
      E("settings.backup_all"), // 라벨 접두 또는 부분
    ];
    const r = searchSettings("백업", entries, base);
    expect(r[r.length - 1].entry.labelKey).toBe("settings.data_location_row");
    expect(r[r.length - 1].match).toBeNull();
  });

  it("접두 일치가 부분 일치보다 앞선다", () => {
    const entries = [E("settings.backup_auto"), E("settings.backup_now")];
    const q = t("settings.backup_now").slice(0, 2).toLowerCase();
    const r = searchSettings(q, entries, base);
    const starts = r.filter((x) => x.label.toLowerCase().startsWith(q));
    expect(r.slice(0, starts.length)).toEqual(starts);
  });

  it("동의어 키로도 찾는다 (라벨에 없는 말)", () => {
    const r = searchSettings("복구", [E("settings.backup_auto", { keywordKeys: ["settings.search_kw_backup"] })], base);
    expect(r).toHaveLength(1);
    expect(r[0].match).toBeNull();
  });

  it("pageIds 밖의 페이지 항목은 나오지 않는다 (브라우저 모드 필터)", () => {
    const r = searchSettings("백업", SETTINGS_SEARCH_INDEX, { ...base, pageIds: ["editor"] });
    expect(r).toEqual([]);
  });

  it("최대 8개", () => {
    const many = Array.from({ length: 20 }, () => E("settings.backup_auto"));
    expect(searchSettings("백업", many, base)).toHaveLength(SETTINGS_SEARCH_MAX);
  });

  it("requires: AI 꺼짐이면 앵커를 떼고 페이지만 연다, 켜지면 앵커 유지", () => {
    const e = E("settings.model_label", { page: "ai", anchor: "ai_model", requires: "ai" });
    const q = t("settings.model_label").slice(0, 2);
    expect(searchSettings(q, [e], { ...base, aiEnabled: false })[0].anchor).toBeUndefined();
    expect(searchSettings(q, [e], base)[0].anchor).toBe("ai_model");
  });

  it("requires: desktop — 브라우저 모드에선 앵커를 뗀다", () => {
    const e = E("settings.reset_db", { anchor: "reset_db", requires: "desktop" });
    const q = t("settings.reset_db").slice(0, 2);
    expect(searchSettings(q, [e], { ...base, browser: true })[0].anchor).toBeUndefined();
    expect(searchSettings(q, [e], base)[0].anchor).toBe("reset_db");
  });

  it("일치 구간을 돌려준다 (강조용)", () => {
    const [r] = searchSettings("백업", [E("settings.backup_auto")], base);
    expect(r.label.slice(r.match![0], r.match![1])).toBe("백업");
  });
});
