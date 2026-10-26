import type { Folder, NoteSummary } from "../../../lib/commands.gen";

/** Visible tree/search rows flattened for react-window (docs/SCALABILITY.md Phase 1 B5). */
export type TreeRow =
  | { kind: "inbox_hdr" }                                // Wave 2: "미분류" pinned header
  | { kind: "favorites_hdr" }
  | { kind: "note"; note: NoteSummary; indented: boolean; folderLabel?: string }
  // 아직 note_create 전인 드래프트("+"를 눌러 연 새 노트) 자리표시 행. 실제 노트가 아니므로
  // 제목을 구독하지 않는다 — 타이핑마다 트리 전체를 다시 평탄화하지 않기 위함.
  | { kind: "draft" }
  | { kind: "trash" }
  | { kind: "archive" }                                  // W7-f: same pattern as "trash"
  | { kind: "divider" }
  | { kind: "folder"; folder: Folder }
  | { kind: "empty_filter" }
  | { kind: "empty_workspace" }
  | { kind: "search_empty"; keyword: boolean }
  | { kind: "search_pending" }
  | { kind: "skeleton"; index: number };

// Tree chrome rows (~menu-item density). Search result rows are taller (title + folder·year [+ snippet]).
const ROW_TREE = 34;
const ROW_SEARCH = 48;
const ROW_SEARCH_SNIPPET = 66;
const ROW_EMPTY = 72;
const ROW_DIVIDER = 12;

export function rowHeightOf(row: TreeRow, searchMode: boolean): number {
  switch (row.kind) {
    case "note":
      if (searchMode && !row.indented) {
        return row.note.snippet ? ROW_SEARCH_SNIPPET : ROW_SEARCH;
      }
      return ROW_TREE;
    case "empty_filter":
    case "empty_workspace":
    case "search_empty":
    case "search_pending":
      return ROW_EMPTY;
    case "divider":
      return ROW_DIVIDER;
    default:
      return ROW_TREE;
  }
}

/**
 * W7-g: 평탄화된 행 배열과 **인덱스가 그대로 대응하는** 노트 id 배열. 노트가 아닌 행(폴더 헤더·
 * 미분류 헤더·휴지통·아카이브·divider·드래프트·스켈레톤…)의 자리는 `null` 로 채운다 — 건너뛰지
 * 않는다. `rows[i]` 와 `rowNoteIds(rows)[i]` 가 항상 같은 행을 가리키므로, 이 배열의 인덱스는
 * react-window 가 TreeListRow 에 내려주는 `index` prop과 그대로 같은 좌표계다.
 *
 * 버그 픽스(재설계): 즐겨찾기 노트는 flattenRows 가 즐겨찾기 섹션과 소속 폴더 두 곳에 동시에
 * 그린다(favoriteNotes 와 filteredByFolder 가 서로를 배제하지 않음) — 화면에 실제로 서로 다른
 * 두 행이 존재한다. 처음엔 이 배열에서 중복 id 를 압축해 하나만 남기려 했지만, 그러면 "즐겨찾기
 * 섹션에서 클릭했는지 폴더 안에서 클릭했는지"를 구분할 방법이 사라진다 — id 하나만으로는 어느
 * 쪽 행이 클릭됐는지 원천적으로 알 수 없다(첫 등장을 남기면 폴더 쪽 클릭이, 마지막 등장을
 * 남기면 즐겨찾기 쪽 클릭이 깨진다. 실제로 마지막-등장 버전을 시도했다가 후자로 회귀만 옮겨
 * 재현했다). 그래서 이 함수는 **압축하지 않는다** — 중복도 그대로 두고 대신 인덱스를 보존해,
 * 클릭이 일어난 실제 행 위치(TreeListRow 의 `index`)를 stores/selection.ts 의 rangeSelection 에
 * 같이 실어보낸다. `id` 가 아니라 "그 클릭이 일어난 자리"가 anchor/target 좌표가 되므로 두 자리
 * 모두 자기 문맥에서 올바르게 동작한다(anchorIndex 설계 참고).
 */
export function rowNoteIds(rows: readonly TreeRow[]): (string | null)[] {
  return rows.map((r) => (r.kind === "note" ? r.note.id : null));
}

export type FlattenRowsInput = {
  searchActive: boolean;
  filteredSearchResults: NoteSummary[];
  favoritesOpen: boolean;
  favoriteNotes: NoteSummary[];
  trashCount: number;
  /** 휴지통에 든 **섹션** 수. 배지 숫자에는 합치지 않지만(PLAN-2026-09-10 §6) 행 노출에는
   *  세어야 한다 — 섹션만 있고 노트가 0이면 행이 안 떠서 모달로 갈 길이 사라진다.
   *  "배지에 안 합친다"와 "행이 안 보인다"는 다른 얘기다. */
  sectionTrashCount: number;
  // W7-f: 아카이브 행 노출 여부(0이면 렌더 안 함) — trashCount와 동일 패턴.
  archiveCount: number;
  folders: Folder[];
  filteredByFolder: Record<string, NoteSummary[]>;
  tagRegionFilterActive: boolean;
  visibleTreeCount: number;
  // Wave 2: inbox(미분류) 섹션. inboxId 가 null 이거나 비어 있으면 빈 섹션조차 그리지 않는다
  // — 사용자 spec("Empty inbox: render nothing"). inboxOpen 은 favorites 와 같은 패턴.
  inboxId: string | null;
  inboxOpen: boolean;
  inboxNotes: NoteSummary[];
  // 드래프트가 향하는 폴더 id (없으면 null). 그 폴더 안에 자리표시 행 하나를 끼워 "+"를
  // 누른 즉시 노트가 생긴 것처럼 보이게 한다 — 실제 note_create 는 첫 타이핑 때.
  draftFolderId: string | null;
  isBooting?: boolean;
  /** search_notes 응답 대기 중(L-4). 빈 결과를 "0건" 대신 "검색 중" 으로 그린다. */
  searching?: boolean;
  /** 키워드가 있는가 — 0건 문구를 키워드/연도범위로 가른다. */
  keywordActive?: boolean;
};

// Flatten visible rows once — List only mounts the viewport slice (Phase 1 B5).
export function flattenRows(input: FlattenRowsInput): TreeRow[] {
  const {
    searchActive,
    filteredSearchResults,
    favoritesOpen,
    favoriteNotes,
    trashCount,
    sectionTrashCount,
    archiveCount,
    folders,
    filteredByFolder,
    tagRegionFilterActive,
    visibleTreeCount,
    inboxId,
    inboxOpen,
    inboxNotes,
    draftFolderId,
    isBooting,
    searching,
    keywordActive,
  } = input;

  if (isBooting && folders.length === 0) {
    return Array.from({ length: 7 }, (_, i) => ({ kind: "skeleton", index: i }));
  }

  if (searchActive) {
    const out: TreeRow[] = [];
    if (filteredSearchResults.length === 0) {
      out.push(searching ? { kind: "search_pending" } : { kind: "search_empty", keyword: keywordActive ?? false });
    } else {
      for (const n of filteredSearchResults) {
        out.push({ kind: "note", note: n, indented: false });
      }
    }
    return out;
  }

  // Wave 2: pinned "미분류" 섹션 — inboxId 가 살아있고 노트가 있을 때만 그린다. inbox 폴더는
  // 일반 폴더 리스트(아래 divider 이후)에서 이미 제외돼야 하며, 그래야 트리 안에서 두 번
  // 나오지 않는다(필터링은 notetree/index.tsx 에서 처리).
  const out: TreeRow[] = [];
  // 드래프트가 미분류를 향하면 섹션이 비어 있어도 그린다 — 아니면 "+"를 눌러도 아무것도
  // 안 보이는 첫 노트 케이스가 생긴다.
  if (inboxId && (inboxNotes.length > 0 || draftFolderId === inboxId)) {
    out.push({ kind: "inbox_hdr" });
    if (inboxOpen) {
      for (const n of inboxNotes) {
        out.push({ kind: "note", note: n, indented: true });
      }
      if (draftFolderId === inboxId) out.push({ kind: "draft" });
    }
  }
  out.push({ kind: "favorites_hdr" });
  if (favoritesOpen) {
    for (const n of favoriteNotes) {
      out.push({ kind: "note", note: n, indented: true });
    }
  }
  if (trashCount > 0 || sectionTrashCount > 0) out.push({ kind: "trash" });
  if (archiveCount > 0) out.push({ kind: "archive" });
  if (folders.length > 0) out.push({ kind: "divider" });
  for (const f of folders) {
    out.push({ kind: "folder", folder: f });
    if (f.is_open) {
      for (const n of filteredByFolder[f.id] ?? []) {
        out.push({ kind: "note", note: n, indented: true });
      }
      if (draftFolderId === f.id) out.push({ kind: "draft" });
    }
  }
  if (tagRegionFilterActive && visibleTreeCount === 0) {
    out.push({ kind: "empty_filter" });
  } else if (!tagRegionFilterActive && folders.length === 0) {
    out.push({ kind: "empty_workspace" });
  }
  return out;
}
