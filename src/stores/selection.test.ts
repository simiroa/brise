import { describe, it, expect, beforeEach } from "vitest";
import {
  EMPTY_SELECTION,
  applyClick,
  pruneSelection,
  rangeSelection,
  selectSingle,
  toggleSelection,
  useSelectionStore,
} from "./selection";
import { rowNoteIds } from "../components/leftpanel/notetree/rows";
import type { TreeRow } from "../components/leftpanel/notetree/rows";
import type { Folder, NoteSummary } from "../lib/commands.gen";

function note(id: string): NoteSummary {
  return {
    id,
    folder_id: "f1",
    title: id,
    year: 2024,
    is_favorite: false,
    exported_at: null,
    has_image: false,
    tag_names: [],
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
}

function folder(id: string): Folder {
  return { id, name: id, workspace_id: "ws", position: 0, is_open: true, note_count: 0, color_hue: null, icon: null, rules: null, search_excluded: false, ai_excluded: false };
}

describe("selection reducer — toggle", () => {
  it("adds then removes, keeping click order", () => {
    let sel = toggleSelection(EMPTY_SELECTION, "a");
    sel = toggleSelection(sel, "c");
    sel = toggleSelection(sel, "b");
    expect(sel.ids).toEqual(["a", "c", "b"]);
    sel = toggleSelection(sel, "c");
    expect(sel.ids).toEqual(["a", "b"]);
    // anchor 는 항상 마지막으로 만진 항목 — 다음 Shift 범위의 기준이 된다.
    expect(sel.anchor).toBe("c");
  });

  it("plain click selects just that row (selection of one), not empty", () => {
    const sel = selectSingle("b");
    // atIndex 를 안 넘기면 anchorIndex 는 null — rangeSelection 이 indexOf 로 폴백한다.
    expect(sel).toEqual({ ids: ["b"], anchor: "b", anchorIndex: null });
  });
});

describe("selection reducer — W8-c: Ctrl-click after a plain click (explorer parity)", () => {
  it("click A then Ctrl+click B selects both", () => {
    let sel = selectSingle("a", 0);
    sel = toggleSelection(sel, "b", 1);
    expect(sel.ids).toEqual(["a", "b"]);
  });

  it("Ctrl+click on an already-selected row removes it", () => {
    let sel = selectSingle("a", 0);
    sel = toggleSelection(sel, "b", 1);
    sel = toggleSelection(sel, "a", 0);
    expect(sel.ids).toEqual(["b"]);
  });

  it("a plain click after a multi-selection collapses back to a selection of one", () => {
    let sel = selectSingle("a", 0);
    sel = toggleSelection(sel, "b", 1);
    sel = toggleSelection(sel, "c", 2);
    expect(sel.ids).toEqual(["a", "b", "c"]);
    sel = selectSingle("b", 1);
    expect(sel.ids).toEqual(["b"]);
  });
});

describe("selection reducer — Shift range across non-note rows", () => {
  // 폴더 헤더 / 미분류 헤더 / 휴지통 / 아카이브 / divider 가 사이사이에 낀 실제 트리 모양.
  const rows: TreeRow[] = [
    { kind: "inbox_hdr" },
    { kind: "note", note: note("n1"), indented: true },
    { kind: "favorites_hdr" },
    { kind: "note", note: note("n2"), indented: true },
    { kind: "trash" },
    { kind: "archive" },
    { kind: "divider" },
    { kind: "folder", folder: folder("f1") },
    { kind: "note", note: note("n3"), indented: true },
    { kind: "draft" },
    { kind: "note", note: note("n4"), indented: true },
  ];

  it("rowNoteIds is index-aligned with rows — null for chrome rows, id for note rows", () => {
    expect(rowNoteIds(rows)).toEqual([
      null, "n1", null, "n2", null, null, null, null, "n3", null, "n4",
    ]);
  });

  it("selects every note between anchor and target, skipping the chrome rows", () => {
    const ordered = rowNoteIds(rows);
    const sel = rangeSelection({ ids: [], anchor: "n1", anchorIndex: null }, ordered, "n3");
    expect(sel.ids).toEqual(["n1", "n2", "n3"]);
    expect(sel.anchor).toBe("n1");
  });

  it("works backwards (target above the anchor)", () => {
    const ordered = rowNoteIds(rows);
    const sel = rangeSelection({ ids: [], anchor: "n4", anchorIndex: null }, ordered, "n2");
    expect(sel.ids).toEqual(["n2", "n3", "n4"]);
  });

  it("replaces the previous selection rather than unioning with it", () => {
    const ordered = rowNoteIds(rows);
    const sel = rangeSelection({ ids: ["n4"], anchor: "n1", anchorIndex: null }, ordered, "n2");
    expect(sel.ids).toEqual(["n1", "n2"]);
  });

  it("falls back to the target alone when the anchor is gone or absent", () => {
    const ordered = rowNoteIds(rows);
    // n3 가 실제로 있는 인덱스(8)가 새 anchorIndex 로 기록된다.
    expect(rangeSelection(EMPTY_SELECTION, ordered, "n3")).toEqual({ ids: ["n3"], anchor: "n3", anchorIndex: 8 });
    expect(rangeSelection({ ids: [], anchor: "gone", anchorIndex: null }, ordered, "n3")).toEqual({
      ids: ["n3"],
      anchor: "n3",
      anchorIndex: 8,
    });
  });

  it("ignores a target that is not selectable (chrome row / stale id)", () => {
    const before = { ids: ["n1"], anchor: "n1", anchorIndex: 1 };
    expect(rangeSelection(before, rowNoteIds(rows), "trash")).toBe(before);
  });
});

describe("selection reducer — a favorited note rendered twice (favorites section + its folder)", () => {
  // flattenRows 는 즐겨찾기 노트를 즐겨찾기 섹션과 소속 폴더 두 곳에 모두 그린다(favoriteNotes 와
  // filteredByFolder 가 서로를 배제하지 않는다). F1 과 F3 가 그런 노트 — 즐겨찾기 섹션에도, 자기
  // 폴더 안에도 각각 한 번씩 더 나타난다. id 만으로는 "어느 쪽 행을 클릭했는지" 구분할 수 없으므로
  // (rows.ts::rowNoteIds 상단 주석 참고) 아래 테스트들은 전부 실제 클릭 위치(atIndex)를 함께 넘긴다
  // — TreeListRow 가 항상 그렇게 하듯이.
  const rows: TreeRow[] = [
    { kind: "favorites_hdr" },                            // 0
    { kind: "note", note: note("F1"), indented: true },   // 1  즐겨찾기 섹션의 F1
    { kind: "note", note: note("F2"), indented: true },   // 2  즐겨찾기 전용(폴더 미오픈)
    { kind: "note", note: note("F3"), indented: true },   // 3  즐겨찾기 섹션의 F3
    { kind: "divider" },                                  // 4
    { kind: "folder", folder: folder("fA") },             // 5
    { kind: "note", note: note("A1"), indented: true },   // 6
    { kind: "note", note: note("F1"), indented: true },   // 7  fA 안의 F1 (같은 id, 다른 행)
    { kind: "folder", folder: folder("fB") },             // 8
    { kind: "note", note: note("B1"), indented: true },   // 9
    { kind: "note", note: note("F3"), indented: true },   // 10 fB 안의 F3 (같은 id, 다른 행)
    { kind: "note", note: note("B2"), indented: true },   // 11
  ];
  const ordered = rowNoteIds(rows);

  it("Shift-range anchored+targeted inside the favorites section stays inside it", () => {
    // F1(1) 을 앵커로, F3(3) 을 Shift+클릭 — 둘 다 즐겨찾기 섹션 안. 폴더 쪽 중복 등장(7, 10)이
    // 끼어들면 버그다.
    let sel = selectSingle("F1", 1);
    sel = rangeSelection(sel, ordered, "F3", 3);
    expect(sel.ids).toEqual(["F1", "F2", "F3"]);
  });

  it("Shift-range anchored+targeted inside a folder stays inside that folder, not favorites", () => {
    // A1(6) 을 앵커로, 폴더 fA 안의 F1(7) 을 Shift+클릭 — 즐겨찾기 섹션의 F1(index 1)로 튀면 버그.
    let sel = selectSingle("A1", 6);
    sel = rangeSelection(sel, ordered, "F1", 7);
    expect(sel.ids).toEqual(["A1", "F1"]);
  });

  it("a range that spans both occurrences of F1 lists it exactly once", () => {
    // 즐겨찾기 섹션의 F1(1) 을 앵커로, fB 안의 B1(9) 을 Shift+클릭 — 그 사이에 F1 의 폴더 쪽
    // 등장(7)도 끼어 있다. 두 행 다 같은 노트이므로 결과 목록엔 F1 이 한 번만 있어야 한다
    // (중복이 남으면 runBatch 가 그 노트에 커맨드를 두 번 쏜다).
    let sel = selectSingle("F1", 1);
    sel = rangeSelection(sel, ordered, "B1", 9);
    expect(sel.ids).toEqual(["F1", "F2", "F3", "A1", "B1"]);
    expect(sel.ids.filter((id) => id === "F1")).toHaveLength(1);
  });

  it("a stale anchorIndex (rows changed between the two clicks) falls back to indexOf instead of selecting garbage", () => {
    // A1 을 앵커로 잡은 뒤(index 6), 즐겨찾기에서 F2 가 사라지는 등 rows 가 바뀌어 모든 폴더 쪽
    // 인덱스가 하나씩 당겨졌다고 하자 — anchorIndex=6 은 더 이상 A1 을 가리키지 않는다.
    const rows2: TreeRow[] = [
      { kind: "favorites_hdr" },                          // 0
      { kind: "note", note: note("F1"), indented: true }, // 1
      { kind: "note", note: note("F3"), indented: true }, // 2  (F2 는 즐겨찾기 해제됨)
      { kind: "divider" },                                // 3
      { kind: "folder", folder: folder("fA") },           // 4
      { kind: "note", note: note("A1"), indented: true }, // 5  ← A1 은 이제 6 이 아니라 5
      { kind: "note", note: note("F1"), indented: true }, // 6
      { kind: "folder", folder: folder("fB") },           // 7
      { kind: "note", note: note("B1"), indented: true }, // 8
      { kind: "note", note: note("F3"), indented: true }, // 9
      { kind: "note", note: note("B2"), indented: true }, // 10
    ];
    const ordered2 = rowNoteIds(rows2);
    const staleSel = { ids: [], anchor: "A1", anchorIndex: 6 }; // 여전히 옛 인덱스를 들고 있다
    const sel = rangeSelection(staleSel, ordered2, "B1", 8);
    // stale index(6) 를 그대로 썼다면 lo=6 이 돼 A1 을 놓친 채 ["F1","B1"] 만 나왔을 것이다.
    // orderedIds[6] !== "A1" 이므로 indexOf("A1")=5 로 폴백해 A1 부터 정확히 잡는다.
    expect(sel.ids).toEqual(["A1", "F1", "B1"]);
  });
});

describe("selection reducer — prune on row change", () => {
  it("drops ids whose rows are gone and clears a dangling anchor (and its anchorIndex)", () => {
    const sel = pruneSelection({ ids: ["n1", "n2", "n3"], anchor: "n2", anchorIndex: 3 }, ["n1", "n3"]);
    expect(sel.ids).toEqual(["n1", "n3"]);
    expect(sel.anchor).toBeNull();
    expect(sel.anchorIndex).toBeNull();
  });

  it("returns the SAME object when nothing changed (no re-render / no effect loop)", () => {
    const before = { ids: ["n1"], anchor: "n1", anchorIndex: 5 };
    expect(pruneSelection(before, ["n1", "n2"])).toBe(before);
  });

  it("wipes everything when the rows change wholesale (notebook switch)", () => {
    expect(pruneSelection({ ids: ["n1", "n2"], anchor: "n1", anchorIndex: 2 }, [])).toEqual({
      ids: [],
      anchor: null,
      anchorIndex: null,
    });
  });
});

describe("applyClick", () => {
  const ordered = ["a", "b", "c", "d"];
  it("routes on the modifier keys", () => {
    expect(applyClick(EMPTY_SELECTION, "b", { toggle: false, range: false }, ordered).ids).toEqual(["b"]);
    expect(applyClick(EMPTY_SELECTION, "b", { toggle: true, range: false }, ordered).ids).toEqual(["b"]);
    expect(
      applyClick({ ids: [], anchor: "a", anchorIndex: null }, "c", { toggle: false, range: true }, ordered).ids,
    ).toEqual(["a", "b", "c"]);
  });

  it("with no explicit atIndex, defaults to indexOf(id) — duplicate-free callers (e.g. AttachmentsBar) need no change", () => {
    const sel = applyClick(EMPTY_SELECTION, "c", { toggle: false, range: false }, ordered);
    expect(sel.anchorIndex).toBe(2);
  });
});

describe("selection store — notes and attachments stay independent", () => {
  beforeEach(() => {
    useSelectionStore.setState({ notes: EMPTY_SELECTION, attachments: EMPTY_SELECTION });
  });

  it("selecting notes does not touch the attachment selection (and vice versa)", () => {
    const s = useSelectionStore.getState();
    s.toggleNote("n1");
    s.toggleAttachment("a1");
    expect(useSelectionStore.getState().notes.ids).toEqual(["n1"]);
    expect(useSelectionStore.getState().attachments.ids).toEqual(["a1"]);

    useSelectionStore.getState().clearNotes();
    expect(useSelectionStore.getState().notes.ids).toEqual([]);
    expect(useSelectionStore.getState().attachments.ids).toEqual(["a1"]);
  });

  it("keepNotes leaves only the failed ids selected after a batch", () => {
    const s = useSelectionStore.getState();
    s.toggleNote("n1");
    s.toggleNote("n2");
    s.toggleNote("n3");
    useSelectionStore.getState().keepNotes(["n2"]);
    expect(useSelectionStore.getState().notes.ids).toEqual(["n2"]);
  });
});
