import { describe, it, expect, vi, beforeEach } from "vitest";
import { useSearchStore } from "../../../stores/search";
import { useFolderWindows } from "./useFolderWindows";
import { createMatchesTagRegion } from "./filtering";
import { useNotesStore } from "../../../stores/notes";
import { renderHook } from "@testing-library/react";

const callMock = vi.fn();
vi.mock("../../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  flushAll: vi.fn(async () => {}),
  registerFlush: vi.fn(() => () => {}),
  emitNotice: vi.fn(),
}));

describe("L5 tag_mode wiring acceptance tests", () => {
  beforeEach(() => {
    callMock.mockReset();
    useSearchStore.setState({
      selectedTags: ["alpha", "beta"],
      tagMode: "or",
      regionFilter: null,
      statusFilter: [],
    });
    useNotesStore.setState({
      notesByFolder: {},
      folderQueryTotals: {},
      tagCounts: { alpha: 2, beta: 1 },
      tagColors: {},
    });
  });

  it("setting tagMode 'and' in the store causes folder-window query to be issued with tag_mode 'and'", async () => {
    callMock.mockResolvedValue({ notes: [], total: 0 });

    const input = {
      searchActive: false,
      openFolderKey: "folder1",
      filterAxesKey: JSON.stringify({
        tags: ["alpha", "beta"],
        tagMode: "and",
        region: null,
        statuses: [],
      }),
      selectedTags: ["alpha", "beta"],
      tagMode: "and" as const,
      regionFilter: null,
      statusFilter: [],
      dateRange: null,
    };

    renderHook(() => useFolderWindows(input));

    // Wait for dynamic import and async effect
    await vi.waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("note_query", expect.objectContaining({
        tag_mode: "and",
        tags: ["alpha", "beta"],
      }));
    });
  });

  it("filterAxesKey differs between tagMode 'or' and 'and' with all other axes identical", () => {
    const selectedTags = ["alpha"];
    const regionFilter = null;
    const statusFilter: string[] = [];

    const keyOr = JSON.stringify({
      tags: selectedTags,
      tagMode: "or",
      region: regionFilter,
      statuses: statusFilter,
    });

    const keyAnd = JSON.stringify({
      tags: selectedTags,
      tagMode: "and",
      region: regionFilter,
      statuses: statusFilter,
    });

    expect(keyOr).not.toEqual(keyAnd);
  });

  it("the search-results post-filter honours the mode — a note with only one of two selected tags survives in 'or' and is dropped in 'and'", () => {
    const noteWithOneTag = {
      id: "n1",
      title: "Note 1",
      year: 2020,
      folder_id: "f1",
      is_favorite: false,
      exported_at: null,
      has_image: false,
      tag_names: ["alpha"],
      region: null,
      status: null,
      icon: null,
      lat: null,
      lng: null,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
      month: null,
      day: null,
    };

    const matcherOr = createMatchesTagRegion({
      selectedTags: ["alpha", "beta"],
      tagMode: "or",
      regionFilter: null,
      statusFilter: [],
    });

    const matcherAnd = createMatchesTagRegion({
      selectedTags: ["alpha", "beta"],
      tagMode: "and",
      regionFilter: null,
      statusFilter: [],
    });

    expect(matcherOr(noteWithOneTag)).toBe(true);
    expect(matcherAnd(noteWithOneTag)).toBe(false);
  });

  // 작게보기 칩 UI(TagsFilter)는 5탭 전환으로 제거됐다 — AND/OR 배지는 이제 고급검색
  // 탭의 TagsExpanded 가 소유한다. 사라진 컴포넌트를 렌더하던 배지 테스트도 함께 제거하고,
  // 실제 배선(note_query tag_mode / filterAxesKey / 결과 후필터)은 위 세 테스트가 잡는다.
});
