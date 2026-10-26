import { describe, it, expect } from "vitest";
import { DASHBOARD_TABS, orderedVisibleTabs } from "./dashboardTabs";

describe("orderedVisibleTabs", () => {
  it("저장값이 없으면 기본 순서 그대로 전부", () => {
    expect(orderedVisibleTabs(undefined).map((t) => t.id)).toEqual(DASHBOARD_TABS.map((t) => t.id));
    expect(orderedVisibleTabs([]).map((t) => t.id)).toEqual(DASHBOARD_TABS.map((t) => t.id));
  });

  it("저장 순서를 따르고 꺼진 탭은 빼며, 저장값에 없는 탭은 끝에 켜진 채로 붙인다", () => {
    const ids = orderedVisibleTabs([
      { id: "map", enabled: true },
      { id: "board", enabled: false },
      { id: "calendar", enabled: true },
    ]).map((t) => t.id);
    expect(ids).toEqual(["map", "calendar", "timeline", "graph"]);
  });

  it("모르는 id 는 버린다", () => {
    const ids = orderedVisibleTabs([{ id: "space" as never, enabled: true }, { id: "graph", enabled: true }]).map(
      (t) => t.id,
    );
    expect(ids[0]).toBe("graph");
    expect(ids).not.toContain("space");
  });
});
