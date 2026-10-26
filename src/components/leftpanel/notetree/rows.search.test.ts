import { describe, expect, it } from "vitest";
import { flattenRows, type FlattenRowsInput } from "./rows";

const base: FlattenRowsInput = {
  searchActive: true,
  filteredSearchResults: [],
  favoritesOpen: false,
  favoriteNotes: [],
  trashCount: 0,
  sectionTrashCount: 0,
  archiveCount: 0,
  folders: [],
  filteredByFolder: {},
  tagRegionFilterActive: false,
  visibleTreeCount: 0,
  inboxId: null,
  inboxOpen: true,
  inboxNotes: [],
  draftFolderId: null,
};

describe("flattenRows — 검색 대기/0건 구분 (L-4)", () => {
  it("응답 대기 중 빈 결과는 search_pending 이지 search_empty 가 아니다", () => {
    expect(flattenRows({ ...base, searching: true }).map((r) => r.kind)).toEqual(["search_pending"]);
  });

  it("응답이 와서 0건이면 search_empty, 키워드 유무를 싣는다", () => {
    expect(flattenRows({ ...base, searching: false, keywordActive: true })).toEqual([{ kind: "search_empty", keyword: true }]);
    expect(flattenRows({ ...base, searching: false })).toEqual([{ kind: "search_empty", keyword: false }]);
  });
});
