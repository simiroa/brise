import { describe, it, expect, vi } from "vitest";

// re-export 계약 테스트가 stores/settings 를 끌어오므로 invoke 는 막아 둔다(callSilent 포함 — check:surface ⓓ).
vi.mock("./invoke", () => ({
  call: vi.fn(),
  callSilent: vi.fn(),
}));

import {
  CANONICAL_ROSTER,
  CANONICAL_DASHBOARD_TABS,
  ensureOneEnabled,
  normalizeFilterRoster,
  normalizeDashboardTabs,
} from "./settingsNormalize";
import * as settingsStoreModule from "../stores/settings";

describe("정규 순서 상수", () => {
  it("로스터는 지역·타임라인·달력·갤러리·챗, 대시보드 탭은 칸반·달력·타임라인·지도·관계도", () => {
    expect(CANONICAL_ROSTER).toEqual(["region", "timeline", "calendar", "gallery", "chat"]);
    expect(CANONICAL_DASHBOARD_TABS).toEqual(["board", "calendar", "timeline", "map", "graph"]);
  });
});

describe("normalizeFilterRoster", () => {
  it("배열이 아니거나 null/undefined 면 정규 순서 전부 활성", () => {
    const canonical = CANONICAL_ROSTER.map((mode) => ({ mode, enabled: true }));
    expect(normalizeFilterRoster(undefined)).toEqual(canonical);
    expect(normalizeFilterRoster(null)).toEqual(canonical);
    expect(normalizeFilterRoster(42)).toEqual(canonical);
    expect(normalizeFilterRoster({ mode: "region", enabled: false })).toEqual(canonical);
  });

  it('legacy "advanced" 는 "chat" 으로 이관되고 enabled 는 유지된다', () => {
    expect(normalizeFilterRoster([{ mode: "advanced", enabled: false }])).toEqual([
      { mode: "chat", enabled: false },
      { mode: "region", enabled: true },
      { mode: "timeline", enabled: true },
      { mode: "calendar", enabled: true },
      { mode: "gallery", enabled: true },
    ]);
  });

  it('"advanced" 와 "chat" 이 같이 저장돼 있으면 먼저 나온 것 하나만 남는다(중복 제거)', () => {
    expect(
      normalizeFilterRoster([
        { mode: "advanced", enabled: false },
        { mode: "chat", enabled: true },
      ]),
    ).toEqual([
      { mode: "chat", enabled: false },
      { mode: "region", enabled: true },
      { mode: "timeline", enabled: true },
      { mode: "calendar", enabled: true },
      { mode: "gallery", enabled: true },
    ]);
  });

  it("같은 모드가 두 번 나오면 첫 항목의 enabled 가 이긴다", () => {
    const next = normalizeFilterRoster([
      { mode: "gallery", enabled: false },
      { mode: "gallery", enabled: true },
    ]);
    expect(next.filter((e) => e.mode === "gallery")).toEqual([{ mode: "gallery", enabled: false }]);
    expect(next).toHaveLength(CANONICAL_ROSTER.length);
  });

  it("enabled 가 boolean 이 아니면 켜짐으로 읽는다", () => {
    const next = normalizeFilterRoster([
      { mode: "region", enabled: "no" },
      { mode: "timeline", enabled: 0 },
      { mode: "calendar" },
    ]);
    expect(next.slice(0, 3)).toEqual([
      { mode: "region", enabled: true },
      { mode: "timeline", enabled: true },
      { mode: "calendar", enabled: true },
    ]);
  });

  it("알 수 없는 모드·tree·null 항목은 버리고, 빠진 정규 모드는 뒤에 활성으로 보강한다", () => {
    expect(
      normalizeFilterRoster([
        null,
        "chat",
        { mode: "tree", enabled: false },
        { mode: 7, enabled: false },
        { mode: "gallery", enabled: false },
      ]),
    ).toEqual([
      { mode: "gallery", enabled: false },
      { mode: "region", enabled: true },
      { mode: "timeline", enabled: true },
      { mode: "calendar", enabled: true },
      { mode: "chat", enabled: true },
    ]);
  });

  it("저장본이 정규 모드를 전부 담고 전부 꺼져 있으면 첫 항목만 켠다(최소 1개 활성)", () => {
    expect(
      normalizeFilterRoster([
        { mode: "chat", enabled: false },
        { mode: "region", enabled: false },
        { mode: "timeline", enabled: false },
        { mode: "calendar", enabled: false },
        { mode: "gallery", enabled: false },
      ]),
    ).toEqual([
      { mode: "chat", enabled: true },
      { mode: "region", enabled: false },
      { mode: "timeline", enabled: false },
      { mode: "calendar", enabled: false },
      { mode: "gallery", enabled: false },
    ]);
  });

  it("꺼진 채 저장된 항목만 있어도 빠진 모드가 활성으로 보강되므로 첫 항목은 그대로 꺼져 있다", () => {
    expect(normalizeFilterRoster([{ mode: "region", enabled: false }])).toEqual([
      { mode: "region", enabled: false },
      { mode: "timeline", enabled: true },
      { mode: "calendar", enabled: true },
      { mode: "gallery", enabled: true },
      { mode: "chat", enabled: true },
    ]);
  });
});

describe("normalizeDashboardTabs", () => {
  it("배열이 아니면 정규 순서 전부 활성", () => {
    const canonical = CANONICAL_DASHBOARD_TABS.map((id) => ({ id, enabled: true }));
    expect(normalizeDashboardTabs(undefined)).toEqual(canonical);
    expect(normalizeDashboardTabs("board")).toEqual(canonical);
  });

  it("알 수 없는 id(구 공간 탭 등)·숫자 id 는 버리고 빠진 탭을 뒤에 활성으로 보강한다", () => {
    expect(
      normalizeDashboardTabs([
        { id: "space", enabled: true },
        { id: 3, enabled: true },
        { id: "map", enabled: false },
      ]),
    ).toEqual([
      { id: "map", enabled: false },
      { id: "board", enabled: true },
      { id: "calendar", enabled: true },
      { id: "timeline", enabled: true },
      { id: "graph", enabled: true },
    ]);
  });

  it("같은 id 는 첫 항목만 남고, enabled 가 boolean 이 아니면 켜짐", () => {
    expect(
      normalizeDashboardTabs([
        { id: "graph", enabled: "off" },
        { id: "graph", enabled: false },
        { id: "board", enabled: false },
      ]),
    ).toEqual([
      { id: "graph", enabled: true },
      { id: "board", enabled: false },
      { id: "calendar", enabled: true },
      { id: "timeline", enabled: true },
      { id: "map", enabled: true },
    ]);
  });

  it("전부 꺼져 있으면 첫 항목만 켠다", () => {
    expect(
      normalizeDashboardTabs(
        CANONICAL_DASHBOARD_TABS.map((id) => ({ id, enabled: false })),
      ),
    ).toEqual([
      { id: "board", enabled: true },
      { id: "calendar", enabled: false },
      { id: "timeline", enabled: false },
      { id: "map", enabled: false },
      { id: "graph", enabled: false },
    ]);
  });
});

describe("ensureOneEnabled (저장 경로의 최소 1개 활성 가드)", () => {
  it("빈 배열은 그대로 돌려준다", () => {
    const empty: { enabled: boolean }[] = [];
    expect(ensureOneEnabled(empty)).toBe(empty);
  });

  it("이미 하나라도 켜져 있으면 같은 배열을 돌려준다", () => {
    const entries = [
      { mode: "region", enabled: false },
      { mode: "chat", enabled: true },
    ];
    expect(ensureOneEnabled(entries)).toBe(entries);
  });

  it("전부 꺼져 있으면 첫 항목만 켠 새 배열을 돌려주고 원본은 건드리지 않는다", () => {
    const entries = [
      { id: "board", enabled: false, extra: 1 },
      { id: "map", enabled: false, extra: 2 },
    ];
    const next = ensureOneEnabled(entries);
    expect(next).toEqual([
      { id: "board", enabled: true, extra: 1 },
      { id: "map", enabled: false, extra: 2 },
    ]);
    expect(next).not.toBe(entries);
    expect(entries[0].enabled).toBe(false);
    // 첫 항목 외에는 같은 객체 참조를 유지한다.
    expect(next[1]).toBe(entries[1]);
  });

  it("정규 모드를 다시 붙이지 않는다(로드 경로의 normalize* 와 다른 점)", () => {
    expect(ensureOneEnabled([{ mode: "chat", enabled: false }])).toEqual([
      { mode: "chat", enabled: true },
    ]);
  });
});

describe("stores/settings 의 re-export 계약", () => {
  it("기존 이름이 같은 함수·상수 참조로 그대로 나간다(import 지점 무변경)", () => {
    expect(settingsStoreModule.CANONICAL_ROSTER).toBe(CANONICAL_ROSTER);
    expect(settingsStoreModule.CANONICAL_DASHBOARD_TABS).toBe(CANONICAL_DASHBOARD_TABS);
    expect(settingsStoreModule.ensureOneEnabled).toBe(ensureOneEnabled);
    expect(settingsStoreModule.normalizeFilterRoster).toBe(normalizeFilterRoster);
    expect(settingsStoreModule.normalizeDashboardTabs).toBe(normalizeDashboardTabs);
  });
});
