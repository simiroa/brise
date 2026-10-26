import { describe, it, expect } from "vitest";
import {
  computeFieldDiffs,
  computeTagZones,
  computeFinalTagNames,
  tagNamesForApply,
  buildApplyPayload,
  buildRevertPayload,
  appliedValuesStillMatch,
  defaultSelectedFieldKeys,
  TAG_APPLY_SOFT_CAP,
  type OrganizeProposalLike,
} from "./aiProposalDiff";
import type { NoteSummary } from "./commands.gen";

function note(overrides: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id: "n1",
    folder_id: "root",
    title: "",
    year: 0,
    is_favorite: false,
    exported_at: null,
    has_image: false,
    tag_names: [],
    region: null,
    status: null,
    icon: null,
    lat: null,
    lng: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    month: null,
    day: null,
    ...overrides,
  } as NoteSummary;
}

describe("computeFieldDiffs — 채움/덮어씀/동일", () => {
  it("empty current + proposed value → fill, default selected", () => {
    const diffs = computeFieldDiffs(note({ title: "" }), { title: "훈민정음 반포" });
    expect(diffs).toEqual([
      { key: "title", state: "fill", current: "", proposed: "훈민정음 반포", defaultSelected: true },
    ]);
  });

  it("whitespace-only current counts as empty (trim)", () => {
    const diffs = computeFieldDiffs(note({ title: "   " }), { title: "제목" });
    expect(diffs[0].state).toBe("fill");
    expect(diffs[0].defaultSelected).toBe(true);
  });

  it("non-empty current + different proposal → overwrite, default unselected", () => {
    const diffs = computeFieldDiffs(note({ title: "옛 제목" }), { title: "새 제목" });
    expect(diffs).toEqual([
      { key: "title", state: "overwrite", current: "옛 제목", proposed: "새 제목", defaultSelected: false },
    ]);
  });

  it("current == proposed → no row at all (규칙: 행 숨김)", () => {
    const diffs = computeFieldDiffs(note({ title: "같음" }), { title: "같음" });
    expect(diffs).toEqual([]);
  });

  it("year 0 counts as empty; nonzero differing year is overwrite", () => {
    const filled = computeFieldDiffs(note({ year: 0 }), { year: 1443 });
    expect(filled[0]).toMatchObject({ key: "year", state: "fill", defaultSelected: true });

    const overwritten = computeFieldDiffs(note({ year: 1900 }), { year: 1443 });
    expect(overwritten[0]).toMatchObject({ key: "year", state: "overwrite", defaultSelected: false });

    const same = computeFieldDiffs(note({ year: 1443 }), { year: 1443 });
    expect(same).toEqual([]);
  });

  it("region null/blank is empty; region row separate from location", () => {
    const diffs = computeFieldDiffs(note({ region: null }), { region: "한양" });
    expect(diffs).toEqual([
      { key: "region", state: "fill", current: "", proposed: "한양", defaultSelected: true },
    ]);
  });

  it("location: lat/lng bundled as one row, current null counts as empty", () => {
    const diffs = computeFieldDiffs(note({ lat: null, lng: null }), { lat: 37.5, lng: 127.0 });
    expect(diffs).toEqual([
      { key: "location", state: "fill", current: null, proposed: { lat: 37.5, lng: 127.0 }, defaultSelected: true },
    ]);
  });

  it("location: existing coords differing from proposal → overwrite", () => {
    const diffs = computeFieldDiffs(note({ lat: 1, lng: 1 }), { lat: 2, lng: 2 });
    expect(diffs).toEqual([
      { key: "location", state: "overwrite", current: { lat: 1, lng: 1 }, proposed: { lat: 2, lng: 2 }, defaultSelected: false },
    ]);
  });

  it("location: identical coords produce no row", () => {
    const diffs = computeFieldDiffs(note({ lat: 1, lng: 1 }), { lat: 1, lng: 1 });
    expect(diffs).toEqual([]);
  });

  it("location: proposal missing either half produces no row (backend requires both)", () => {
    const diffs = computeFieldDiffs(note({ lat: null, lng: null }), { lat: 1 } as OrganizeProposalLike);
    expect(diffs.find((d) => d.key === "location")).toBeUndefined();
  });

  it("folder is always overwrite (every note already has one), default unselected", () => {
    const diffs = computeFieldDiffs(note({ folder_id: "misc" }), { folder_id: "f-1", folder_name: "Archive" });
    expect(diffs).toEqual([
      { key: "folder_id", state: "overwrite", current: "misc", proposed: "f-1", proposedName: "Archive", defaultSelected: false },
    ]);
  });

  it("folder same as current produces no row", () => {
    const diffs = computeFieldDiffs(note({ folder_id: "f-1" }), { folder_id: "f-1" });
    expect(diffs).toEqual([]);
  });

  it("source_urls always shows as add, default selected (no current value to diff)", () => {
    const diffs = computeFieldDiffs(note(), { source_urls: ["https://example.com"] });
    expect(diffs).toEqual([
      { key: "source_urls", state: "add", proposed: ["https://example.com"], defaultSelected: true },
    ]);
  });

  it("fields absent from the proposal produce no row", () => {
    const diffs = computeFieldDiffs(note({ title: "x" }), {});
    expect(diffs).toEqual([]);
  });

  it("defaultSelectedFieldKeys collects only defaultSelected rows", () => {
    const diffs = computeFieldDiffs(note({ title: "", year: 1900 }), { title: "새 제목", year: 1443 });
    expect(defaultSelectedFieldKeys(diffs)).toEqual(new Set(["title"]));
  });
});

describe("computeTagZones / computeFinalTagNames — 태그 교체 시맨틱 (A-0)", () => {
  it("① 회귀: 12개 그대로 제안 → 아무것도 안 만져도 하나도 안 사라진다", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `t${i + 1}`);
    const zones = computeTagZones(twelve, twelve);
    expect(zones.kept).toEqual(twelve);
    expect(zones.added).toEqual([]);
    expect(zones.removed).toEqual([]);

    // 사용자가 아무 것도 체크하지 않은 기본 상태(추가/제거 선택 모두 비어 있음)로 적용해도:
    const final = computeFinalTagNames(twelve, new Set(), new Set());
    expect(final.sort()).toEqual(twelve.sort());
    expect(tagNamesForApply(twelve, final)).toBeUndefined();
  });

  it("소프트캡: added가 캡을 넘으면 초과분만 기본 미선택 (kept는 캡과 무관)", () => {
    const current = ["a", "b"];
    const addedTags = Array.from({ length: TAG_APPLY_SOFT_CAP + 3 }, (_, i) => `new${i + 1}`);
    const proposed = [...current, ...addedTags];
    const zones = computeTagZones(current, proposed);
    expect(zones.kept).toEqual(current);
    expect(zones.added).toEqual(addedTags);
    expect(zones.defaultSelectedAdded).toEqual(addedTags.slice(0, TAG_APPLY_SOFT_CAP));
  });

  it("⑤ 제거 태그는 체크한 것만 빠진다", () => {
    const current = ["조선", "세종", "훈민정음", "임시"];
    const proposed = ["조선", "세종", "한글"];
    const zones = computeTagZones(current, proposed);
    expect(zones.kept.sort()).toEqual(["세종", "조선"]);
    expect(zones.removed.sort()).toEqual(["임시", "훈민정음"]);
    expect(zones.added).toEqual(["한글"]);

    // 기본(아무 것도 체크 안 함): 제거 후보는 살아남고, 추가는 기본 선택된다.
    const defaultFinal = computeFinalTagNames(current, new Set(zones.defaultSelectedAdded), new Set());
    expect(defaultFinal.sort()).toEqual(["세종", "조선", "임시", "한글", "훈민정음"].sort());

    // "임시"만 제거 체크 → 그것만 빠진다.
    const afterRemovingOne = computeFinalTagNames(current, new Set(["한글"]), new Set(["임시"]));
    expect(afterRemovingOne.sort()).toEqual(["세종", "조선", "한글", "훈민정음"].sort());
  });

  it("scenario 1 from the audit doc: 3 tags → model proposes only 1 → default keeps all 3 plus the new one", () => {
    const current = ["조선", "세종", "훈민정음"];
    const proposed = ["한글"];
    const zones = computeTagZones(current, proposed);
    const final = computeFinalTagNames(current, new Set(zones.defaultSelectedAdded), new Set());
    expect(final.sort()).toEqual(["세종", "조선", "한글", "훈민정음"].sort());
  });

  it("no proposed tags at all → zones are empty/kept-only, no forced change", () => {
    const current = ["a"];
    const zones = computeTagZones(current, undefined);
    expect(zones).toEqual({ kept: [], added: [], removed: ["a"], defaultSelectedAdded: [] });
  });
});

describe("buildApplyPayload — ③④ 선택에 따라 undefined/값", () => {
  it("④ 채움 필드는 기본 선택되어 페이로드에 포함된다", () => {
    const diffs = computeFieldDiffs(note({ title: "" }), { title: "새 제목" });
    const selected = defaultSelectedFieldKeys(diffs);
    const payload = buildApplyPayload(diffs, selected, undefined);
    expect(payload).toEqual({ title: "새 제목" });
  });

  it("③ 덮어쓰기 필드는 기본 미선택 → 선택 집합에서 빼면 페이로드에 없다(undefined)", () => {
    const diffs = computeFieldDiffs(note({ title: "옛 제목" }), { title: "새 제목" });
    const selected = defaultSelectedFieldKeys(diffs); // overwrite는 기본 미선택이므로 비어 있음
    expect(selected.size).toBe(0);
    const payload = buildApplyPayload(diffs, selected, undefined);
    expect(payload.title).toBeUndefined();
  });

  it("location 선택 시 lat/lng 둘 다 페이로드에 실린다", () => {
    const diffs = computeFieldDiffs(note({ lat: null, lng: null }), { lat: 1.5, lng: 2.5 });
    const payload = buildApplyPayload(diffs, new Set(["location"]), undefined);
    expect(payload).toEqual({ lat: 1.5, lng: 2.5 });
  });

  it("tagNames는 선택 여부와 무관하게 그대로 전달된다(태그는 별도 계산)", () => {
    const payload = buildApplyPayload([], new Set(), ["a", "b"]);
    expect(payload).toEqual({ tag_names: ["a", "b"] });
  });
});

describe("buildRevertPayload — A2 되돌리기 (PLAN-2026-09-05 §1 A-2 revert)", () => {
  it("title/year/region/folder는 채움이든 덮어씀이든 현재값으로 되돌릴 수 있다", () => {
    const diffs = computeFieldDiffs(
      note({ title: "", year: 0, region: null, folder_id: "old-folder" }),
      { title: "새 제목", year: 1443, region: "한양", folder_id: "new-folder" },
    );
    const applied = buildApplyPayload(diffs, defaultSelectedFieldKeys(diffs), undefined);
    // folder는 기본 미선택이지만 "실제로 적용된" 시나리오를 보려면 선택했다고 가정한다.
    const appliedWithFolder = { ...applied, folder_id: "new-folder" };
    const { payload, unrevertableKeys } = buildRevertPayload(diffs, appliedWithFolder, []);
    expect(payload).toEqual({ title: "", year: 0, region: "", folder_id: "old-folder" });
    expect(unrevertableKeys).toEqual([]);
  });

  it("적용되지 않은 필드(선택 해제)는 되돌리기 페이로드에도 없다", () => {
    const diffs = computeFieldDiffs(note({ title: "옛 제목" }), { title: "새 제목" });
    // overwrite는 기본 미선택 → 아무것도 적용되지 않았다고 가정(appliedPayload에 title 없음).
    const { payload, unrevertableKeys } = buildRevertPayload(diffs, {}, []);
    expect(payload).toEqual({});
    expect(unrevertableKeys).toEqual([]);
  });

  it("location: 기존이 비어 있었다면(채움) clear_fields:[\"location\"]으로 되돌린다 — 값으로는 '지움'을 표현 못 한다(J3)", () => {
    const diffs = computeFieldDiffs(note({ lat: null, lng: null }), { lat: 37.5, lng: 127.0 });
    const applied = buildApplyPayload(diffs, new Set(["location"]), undefined);
    const { payload, unrevertableKeys } = buildRevertPayload(diffs, applied, []);
    expect(payload).toEqual({ clear_fields: ["location"] });
    expect(unrevertableKeys).toEqual([]);
  });

  it("location: 기존에 값이 있었다면(덮어씀) 그 값으로 정상적으로 되돌릴 수 있다", () => {
    const diffs = computeFieldDiffs(note({ lat: 1, lng: 1 }), { lat: 2, lng: 2 });
    const applied = buildApplyPayload(diffs, new Set(["location"]), undefined);
    const { payload, unrevertableKeys } = buildRevertPayload(diffs, applied, []);
    expect(payload).toEqual({ lat: 1, lng: 1 });
    expect(unrevertableKeys).toEqual([]);
  });

  it("source_urls는 remove_source_urls로 되돌린다 — ai_apply_organize의 추가 전용 경로는 별도 삭제 입력이 짝이다(J3)", () => {
    const diffs = computeFieldDiffs(note(), { source_urls: ["https://example.com"] });
    const applied = buildApplyPayload(diffs, new Set(["source_urls"]), undefined);
    const { payload, unrevertableKeys } = buildRevertPayload(diffs, applied, []);
    expect(payload).toEqual({ remove_source_urls: ["https://example.com"] });
    expect(unrevertableKeys).toEqual([]);
  });

  it("태그: appliedPayload.tag_names가 currentTags와 같으면(무변화) 되돌리기 페이로드에서 빠진다", () => {
    const { payload } = buildRevertPayload([], { tag_names: ["a", "b"] }, ["b", "a"]);
    expect(payload).toEqual({});
  });

  it("태그: 실제로 달라졌으면 되돌리기 페이로드에 원래 태그 집합이 담긴다", () => {
    const { payload } = buildRevertPayload([], { tag_names: ["new"] }, ["old1", "old2"]);
    expect(payload).toEqual({ tag_names: ["old1", "old2"] });
  });

  it("아무것도 적용되지 않았으면 되돌리기 페이로드도 비어 있다(호출자가 토스트를 안 띄우는 신호)", () => {
    const diffs = computeFieldDiffs(note({ title: "" }), { title: "새 제목" });
    const { payload, unrevertableKeys } = buildRevertPayload(diffs, {}, []);
    expect(payload).toEqual({});
    expect(unrevertableKeys).toEqual([]);
  });
});

describe("appliedValuesStillMatch — WF F2 되돌리기 직전 편집 경합 확인", () => {
  it("적용된 값과 현재값이 그대로면 true", () => {
    const applied = { title: "New Title", year: 2000 };
    const current = note({ title: "New Title", year: 2000 });
    expect(appliedValuesStillMatch(applied, current)).toBe(true);
  });

  it("적용 후 title이 사용자에 의해 바뀌었으면 false", () => {
    const applied = { title: "New Title" };
    const current = note({ title: "User Edited Title" });
    expect(appliedValuesStillMatch(applied, current)).toBe(false);
  });

  it("applied에 없는 키(건드리지 않은 필드)는 현재값이 뭐든 비교하지 않는다", () => {
    const applied = { title: "New Title" };
    const current = note({ title: "New Title", year: 1999, region: "Somewhere" });
    expect(appliedValuesStillMatch(applied, current)).toBe(true);
  });

  it("region: applied가 빈 문자열이고 current.region이 null이면 같다고 본다(computeFieldDiffs와 동일한 정규화)", () => {
    const applied = { region: "" };
    const current = note({ region: null });
    expect(appliedValuesStillMatch(applied, current)).toBe(true);
  });

  it("location(lat/lng)이 둘 중 하나라도 달라지면 false", () => {
    const applied = { lat: 37.5, lng: 127.0 };
    expect(appliedValuesStillMatch(applied, note({ lat: 37.5, lng: 127.0 }))).toBe(true);
    expect(appliedValuesStillMatch(applied, note({ lat: 1, lng: 127.0 }))).toBe(false);
  });

  it("태그: 집합만 같으면(순서 무관) true, 사용자가 태그를 바꿨으면 false", () => {
    const applied = { tag_names: ["a", "b"] };
    expect(appliedValuesStillMatch(applied, note({ tag_names: ["b", "a"] }))).toBe(true);
    expect(appliedValuesStillMatch(applied, note({ tag_names: ["a", "c"] }))).toBe(false);
  });

  it("folder_id가 사용자에 의해 다시 옮겨졌으면 false", () => {
    const applied = { folder_id: "f2" };
    expect(appliedValuesStillMatch(applied, note({ folder_id: "f2" }))).toBe(true);
    expect(appliedValuesStillMatch(applied, note({ folder_id: "f3" }))).toBe(false);
  });
});
