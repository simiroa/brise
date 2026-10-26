import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";

// NoteIconControl (rendered inside the note row) calls invoke's `call` on interaction — not on a
// plain render, but mocked anyway to keep this test isolated from the Tauri bridge.
vi.mock("../../../lib/invoke", () => ({
  call: vi.fn(async () => ({})),
  callSilent: vi.fn(),
  flushAll: vi.fn(async () => {}),
  registerFlush: vi.fn(() => () => {}),
  emitNotice: vi.fn(),
}));

import { TreeListRow, type ListRowProps } from "./TreeListRow";
import type { TreeRow } from "./rows";
import type { Folder, NoteSummary } from "../../../lib/commands.gen";
import { useUiStore } from "../../../stores/ui";
import { cancelLongPress } from "../../../lib/longPress";
import { t } from "../../../i18n/t";

// W5: 노트 행 롱프레스 취소는 startNoteDrag(lib/noteDrag.ts) 와 같은 pointerdown 안에서 같은
// window pointermove/4px 임계를 나란히 쓴다 — 그 임계를 넘기는 테스트는 noteDrag.ts 자신의
// 드롭 대상 탐색(elementFromPoint)도 함께 건드린다. jsdom 은 이 DOM API 를 구현하지 않는다
// (noteDrag.ts 의 14개 호출부 전부 "no covering tests found"였던 이유 — 이 파일이 처음 건드린다).
// null(드롭 대상 없음)로 채워 넣어 통과시킨다 — 실제 드롭 판정은 이 테스트의 관심사가 아니다.
if (typeof document.elementFromPoint !== "function") {
  document.elementFromPoint = () => null;
}

function makeNote(partial: Partial<NoteSummary> & { id: string }): NoteSummary {
  return {
    folder_id: "f1",
    title: partial.title ?? partial.id,
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
    ...partial,
  };
}

function makeFolder(partial: Partial<Folder> & { id: string; name: string }): Folder {
  return {
    workspace_id: "ws",
    position: 0,
    is_open: false,
    note_count: 0,
    color_hue: null,
    icon: null,
    rules: null,
    search_excluded: false,
    ai_excluded: false,
    ...partial,
  };
}

function baseProps(rows: TreeRow[], overrides: Partial<ListRowProps> = {}): ListRowProps {
  return {
    rows,
    searchActive: false,
    favoritesOpen: false,
    favoriteCount: 0,
    trashCount: 0,
    archiveCount: 0,
    activeId: null,
    selectedIds: new Set<string>(),
    matchCursorNoteId: null,
    folderNameById: new Map(),
    editingId: null,
    editingDraft: "",
    onEditingDraftChange: vi.fn(),
    onStartEdit: vi.fn(),
    onCommitEdit: vi.fn(),
    onEditBlur: vi.fn(),
    onCancelEdit: vi.fn(),
    inboxOpen: false,
    inboxCount: 0,
    inboxId: null,
    searchQuery: "",
    onToggleFavorites: vi.fn(),
    onToggleInbox: vi.fn(),
    onToggleFolder: vi.fn(),
    onOpenTrash: vi.fn(),
    onOpenArchive: vi.fn(),
    onOpenCtx: vi.fn(),
    onSelectNote: vi.fn(),
    onNewNoteInFolder: vi.fn(),
    onMoveNote: vi.fn(),
    loadTree: vi.fn(async () => {}),
    selectNote: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("TreeListRow — note inline rename (double-click / F2)", () => {
  const note = makeNote({ id: "n1", title: "Trip to Kyoto" });
  const rows: TreeRow[] = [{ kind: "note", note, indented: false }];

  beforeEach(() => vi.clearAllMocks());

  it("single click still just selects — does not enter edit mode", () => {
    const onSelectNote = vi.fn();
    const onStartEdit = vi.fn();
    render(
      <TreeListRow
        index={0}
        style={{}}
        ariaAttributes={{ role: "listitem", "aria-posinset": 1, "aria-setsize": 1 }}
        {...baseProps(rows, { onSelectNote, onStartEdit })}
      />
    );
    fireEvent.click(screen.getByText("Trip to Kyoto"));
    // W7-g: 수식키 없는 클릭 = 기존 단일선택. 다중선택 판단은 index.tsx 가 하므로 여기서는
    // 수식키 플래그가 둘 다 false 로 실려 나가는 것까지가 계약이다.
    // 세 번째 인자는 클릭된 행의 실제 인덱스(react-window `index`) — 즐겨찾기 노트가 두 곳에
    // 그려질 때 Shift 범위가 이 값으로 어느 쪽 행인지 구분한다(selection.ts anchorIndex 참고).
    expect(onSelectNote).toHaveBeenCalledWith("n1", { toggle: false, range: false }, 0);
    expect(onStartEdit).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  // W3(PLAN-2026-09-10): 섹션 탭을 노트 행에 놓아 옮기는 경로. 행은 대상 표시만 하고 처리는
  // 에디터의 useSectionActions 핸들러가 한다 — 여기서 계약은 이 속성 하나다.
  it("노트 행이 note:<id> 드롭 대상이다", () => {
    render(<TreeListRow index={0} style={{}} ariaAttributes={{ role: "listitem", "aria-posinset": 1, "aria-setsize": 1 }} {...baseProps(rows)} />);
    expect(
      screen.getByText("Trip to Kyoto").closest("button")!.getAttribute("data-note-drop-target")
    ).toBe("note:n1");
  });

  it("double-click starts edit mode: input appears, pre-filled and focused", () => {
    const onStartEdit = vi.fn();
    render(<TreeListRow index={0} style={{}} ariaAttributes={{ role: "listitem", "aria-posinset": 1, "aria-setsize": 1 }} {...baseProps(rows, { onStartEdit })} />);
    fireEvent.doubleClick(screen.getByText("Trip to Kyoto"));
    expect(onStartEdit).toHaveBeenCalledWith("n1", false, "Trip to Kyoto");
  });

  it("while editing, renders a pre-filled input reflecting editingId/editingDraft", () => {
    render(
      <TreeListRow
        index={0}
        style={{}}
        ariaAttributes={{ role: "listitem", "aria-posinset": 1, "aria-setsize": 1 }}
        {...baseProps(rows, { editingId: "n1", editingDraft: "Trip to Kyoto" })}
      />
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("Trip to Kyoto");
    expect(document.activeElement).toBe(input);
  });

  it("Enter commits via onCommitEdit with the current draft", () => {
    const onCommitEdit = vi.fn();
    render(
      <TreeListRow
        index={0}
        style={{}}
        ariaAttributes={{ role: "listitem", "aria-posinset": 1, "aria-setsize": 1 }}
        {...baseProps(rows, { editingId: "n1", editingDraft: "Kyoto Trip", onCommitEdit })}
      />
    );
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onCommitEdit).toHaveBeenCalledWith("n1", false, "Kyoto Trip");
  });

  it("Escape cancels without committing", () => {
    const onCommitEdit = vi.fn();
    const onCancelEdit = vi.fn();
    render(
      <TreeListRow
        index={0}
        style={{}}
        ariaAttributes={{ role: "listitem", "aria-posinset": 1, "aria-setsize": 1 }}
        {...baseProps(rows, { editingId: "n1", editingDraft: "Kyoto Trip", onCommitEdit, onCancelEdit })}
      />
    );
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(onCancelEdit).toHaveBeenCalled();
    expect(onCommitEdit).not.toHaveBeenCalled();
  });

  it("F2 while the row is focused starts edit mode, same as double-click", () => {
    const onStartEdit = vi.fn();
    render(<TreeListRow index={0} style={{}} ariaAttributes={{ role: "listitem", "aria-posinset": 1, "aria-setsize": 1 }} {...baseProps(rows, { onStartEdit })} />);
    fireEvent.keyDown(screen.getByText("Trip to Kyoto").closest("button")!, { key: "F2" });
    expect(onStartEdit).toHaveBeenCalledWith("n1", false, "Trip to Kyoto");
  });
});

describe("TreeListRow — folder inline rename (double-click / F2)", () => {
  const folder = makeFolder({ id: "fol1", name: "Archive" });
  const rows: TreeRow[] = [{ kind: "folder", folder }];

  beforeEach(() => vi.clearAllMocks());

  it("single click still just toggles — does not enter edit mode", () => {
    const onToggleFolder = vi.fn();
    const onStartEdit = vi.fn();
    render(
      <TreeListRow
        index={0}
        style={{}}
        ariaAttributes={{ role: "listitem", "aria-posinset": 1, "aria-setsize": 1 }}
        {...baseProps(rows, { onToggleFolder, onStartEdit })}
      />
    );
    fireEvent.click(screen.getByText("Archive"));
    expect(onToggleFolder).toHaveBeenCalledWith(folder);
    expect(onStartEdit).not.toHaveBeenCalled();
  });

  // 글리프를 누르면 색 프리셋 팝오버가 뜨던 동작은 사라졌다 — 색은 폴더 설정 모달(우클릭)이
  // 전담하고, 글리프는 표시 전용이라 클릭이 행으로 그대로 올라간다.
  it("clicking the folder glyph toggles the folder — no color popover any more", () => {
    const onToggleFolder = vi.fn();
    render(
      <TreeListRow
        index={0}
        style={{}}
        ariaAttributes={{ role: "listitem", "aria-posinset": 1, "aria-setsize": 1 }}
        {...baseProps(rows, { onToggleFolder })}
      />
    );
    expect(screen.queryByTestId("folder-color-btn")).toBeNull();
    fireEvent.click(screen.getByText("Archive").closest('[role="button"]')!);
    expect(onToggleFolder).toHaveBeenCalledWith(folder);
    expect(screen.queryByTestId("folder-color-presets")).toBeNull();
  });

  it("double-click starts edit mode pre-filled with the folder name", () => {
    const onStartEdit = vi.fn();
    render(<TreeListRow index={0} style={{}} ariaAttributes={{ role: "listitem", "aria-posinset": 1, "aria-setsize": 1 }} {...baseProps(rows, { onStartEdit })} />);
    fireEvent.doubleClick(screen.getByText("Archive"));
    expect(onStartEdit).toHaveBeenCalledWith("fol1", true, "Archive");
  });

  it("Enter commits via onCommitEdit with isFolder=true", () => {
    const onCommitEdit = vi.fn();
    render(
      <TreeListRow
        index={0}
        style={{}}
        ariaAttributes={{ role: "listitem", "aria-posinset": 1, "aria-setsize": 1 }}
        {...baseProps(rows, { editingId: "fol1", editingDraft: "Archived", onCommitEdit })}
      />
    );
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onCommitEdit).toHaveBeenCalledWith("fol1", true, "Archived");
  });

  it("Escape cancels without committing", () => {
    const onCommitEdit = vi.fn();
    const onCancelEdit = vi.fn();
    render(
      <TreeListRow
        index={0}
        style={{}}
        ariaAttributes={{ role: "listitem", "aria-posinset": 1, "aria-setsize": 1 }}
        {...baseProps(rows, { editingId: "fol1", editingDraft: "Archived", onCommitEdit, onCancelEdit })}
      />
    );
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(onCancelEdit).toHaveBeenCalled();
    expect(onCommitEdit).not.toHaveBeenCalled();
  });

  it("renders data-revealed attribute when note id matches revealedNoteId", () => {
    const noteRows: TreeRow[] = [{ kind: "note", note: makeNote({ id: "n-rev", title: "Target Note" }), indented: false }];
    const { getByRole } = render(
      <TreeListRow
        index={0}
        style={{}}
        ariaAttributes={{ role: "listitem", "aria-posinset": 1, "aria-setsize": 1 }}
        {...baseProps(noteRows, { revealedNoteId: "n-rev" })}
      />
    );
    const btn = getByRole("button");
    expect(btn.getAttribute("data-revealed")).toBe("true");
  });
});

describe("TreeListRow — folder search/AI exclusion marker", () => {
  beforeEach(() => vi.clearAllMocks());

  // 이 테스트 환경에서 t() 는 영어 폴백으로 떨어진다(설정 스토어가 hydrate 되지 않아 uiLang 이
  // 비어 있다 — 같은 파일의 "Folder color…"/"New note in this folder" 도 영어로 나온다).
  // 리터럴로 단언해야 툴팁이 세 상태를 실제로 구분하는지 검사가 된다 — t() 로 기대값을 만들면
  // 키가 셋 다 같은 문구여도 통과한다.
  function renderFolder(partial: Partial<Folder>) {
    const folder = makeFolder({ id: "fol1", name: "Journal", ...partial });
    return render(
      <TreeListRow
        index={0}
        style={{}}
        ariaAttributes={{ role: "listitem", "aria-posinset": 1, "aria-setsize": 1 }}
        {...baseProps([{ kind: "folder", folder }])}
      />
    );
  }

  it("a normal folder renders no exclusion marker", () => {
    renderFolder({});
    expect(screen.queryAllByRole("img")).toHaveLength(0);
  });

  it("ai_excluded folder renders the marker with the AI-only tooltip", () => {
    renderFolder({ ai_excluded: true });
    const marker = screen.getByRole("img", { name: "AI reading blocked" });
    expect(marker.getAttribute("title")).toBe("AI reading blocked");
  });

  it("search_excluded folder renders the marker with the search-only tooltip", () => {
    renderFolder({ search_excluded: true });
    expect(screen.getByRole("img", { name: "Excluded from search" })).toBeTruthy();
  });

  it("both flags collapse into one marker with the combined tooltip", () => {
    renderFolder({ search_excluded: true, ai_excluded: true });
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(
      screen.getByRole("img", { name: "Excluded from search · AI reading blocked" })
    ).toBeTruthy();
  });

  it("clicking the marker still toggles the folder (no handler of its own)", () => {
    const folder = makeFolder({ id: "fol1", name: "Journal", ai_excluded: true });
    const onToggleFolder = vi.fn();
    render(
      <TreeListRow
        index={0}
        style={{}}
        ariaAttributes={{ role: "listitem", "aria-posinset": 1, "aria-setsize": 1 }}
        {...baseProps([{ kind: "folder", folder }], { onToggleFolder })}
      />
    );
    fireEvent.click(screen.getByRole("img", { name: "AI reading blocked" }));
    expect(onToggleFolder).toHaveBeenCalledWith(folder);
  });
});

// 길게 누르기 = 폴더 설정 모달로 가는 두 번째 문(첫 번째는 우클릭 메뉴). 임계값 전에 손을 떼면
// 평소대로 폴더가 열리고 닫혀야 하고, 넘겼으면 뒤따르는 click 이 그 토글을 하면 안 된다.
describe("TreeListRow — folder long-press opens folder settings", () => {
  const folder = makeFolder({ id: "fol1", name: "Journal" });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // lib/longPress 는 모듈 전역 상태다 — 앞 테스트가 armed 를 남기면 다음 begin 이 무시된다.
    cancelLongPress();
    useUiStore.setState({ folderFilesOpen: null });
  });
  afterEach(() => vi.useRealTimers());

  function renderRow(overrides: Partial<ListRowProps> = {}) {
    render(
      <TreeListRow
        index={0}
        style={{}}
        ariaAttributes={{ role: "listitem", "aria-posinset": 1, "aria-setsize": 1 }}
        {...baseProps([{ kind: "folder", folder }], overrides)}
      />
    );
    return screen.getByText("Journal").closest('[role="button"]') as HTMLElement;
  }

  it("holding past the threshold opens the modal and swallows the trailing click", () => {
    const onToggleFolder = vi.fn();
    const row = renderRow({ onToggleFolder });

    fireEvent.pointerDown(row, { button: 0 });
    expect(row.className).toContain("folder-longpress");
    act(() => void vi.advanceTimersByTime(500));

    expect(useUiStore.getState().folderFilesOpen).toBe("fol1");
    expect(row.className).not.toContain("folder-longpress");

    fireEvent.pointerUp(row);
    fireEvent.click(row);
    expect(onToggleFolder).not.toHaveBeenCalled();
  });

  it("releasing early cancels — the folder just toggles", () => {
    const onToggleFolder = vi.fn();
    const row = renderRow({ onToggleFolder });

    fireEvent.pointerDown(row, { button: 0 });
    act(() => void vi.advanceTimersByTime(200));
    fireEvent.pointerUp(row);
    act(() => void vi.advanceTimersByTime(500));

    expect(useUiStore.getState().folderFilesOpen).toBeNull();
    fireEvent.click(row);
    expect(onToggleFolder).toHaveBeenCalledWith(folder);
  });

  it("right-click never starts the hold — that is the context menu's job", () => {
    const row = renderRow();
    fireEvent.pointerDown(row, { button: 2 });
    act(() => void vi.advanceTimersByTime(500));
    expect(useUiStore.getState().folderFilesOpen).toBeNull();
  });

  // "+"(이 폴더에 새 노트) 를 오래 눌러도 폴더 설정이 열리면 안 된다 — click 만
  // stopPropagation 하고 pointerdown 은 행까지 올라오기 때문에 실제로 났던 실수다.
  it("holding the in-row + button does not open the modal", () => {
    const row = renderRow();
    fireEvent.pointerDown(screen.getByLabelText("New note in this folder"), { button: 0 });
    act(() => void vi.advanceTimersByTime(500));
    expect(useUiStore.getState().folderFilesOpen).toBeNull();
    expect(row.className).not.toContain("folder-longpress");
  });
});

// W5 (WORKORDER-2026-09-02 §4): 터치는 우클릭이 없다 — 노트 행을 길게 누르면 우클릭과 같은
// 컨텍스트 메뉴가 열린다. startNoteDrag 가 같은 pointerdown 을 이미 쓰고 있으므로(4px 임계까지
// 대기) 그 임계를 넘기면 롱프레스가 취소돼야 한다(동시에 둘 다 발동하면 안 된다).
describe("TreeListRow — note row long-press opens the context menu", () => {
  const note = makeNote({ id: "n1", title: "Trip to Kyoto" });
  const rows: TreeRow[] = [{ kind: "note", note, indented: false }];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // lib/longPress 는 모듈 전역 상태다 — 앞 테스트가 armed 를 남기면 다음 begin 이 무시된다.
    cancelLongPress();
  });
  afterEach(() => vi.useRealTimers());

  function renderRow(overrides: Partial<ListRowProps> = {}) {
    render(
      <TreeListRow
        index={0}
        style={{}}
        ariaAttributes={{ role: "listitem", "aria-posinset": 1, "aria-setsize": 1 }}
        {...baseProps(rows, overrides)}
      />
    );
    return screen.getByText("Trip to Kyoto").closest("button") as HTMLElement;
  }

  it("holding past the threshold calls onOpenCtx with the same (id, x, y) a right-click would, and swallows the trailing click", () => {
    const onOpenCtx = vi.fn();
    const onSelectNote = vi.fn();
    const row = renderRow({ onOpenCtx, onSelectNote });

    fireEvent.pointerDown(row, { button: 0, clientX: 50, clientY: 60 });
    act(() => void vi.advanceTimersByTime(500));
    expect(onOpenCtx).toHaveBeenCalledWith("n1", 50, 60);

    fireEvent.pointerUp(row);
    fireEvent.click(row);
    expect(onSelectNote).not.toHaveBeenCalled();
  });

  it("right-click opens the same menu directly, unchanged", () => {
    const onOpenCtx = vi.fn();
    const row = renderRow({ onOpenCtx });
    fireEvent.contextMenu(row, { clientX: 12, clientY: 34 });
    expect(onOpenCtx).toHaveBeenCalledWith("n1", 12, 34);
  });

  it("releasing early cancels — a normal click still selects the note", () => {
    const onOpenCtx = vi.fn();
    const onSelectNote = vi.fn();
    const row = renderRow({ onOpenCtx, onSelectNote });

    fireEvent.pointerDown(row, { button: 0, clientX: 50, clientY: 60 });
    act(() => void vi.advanceTimersByTime(200));
    fireEvent.pointerUp(row);
    act(() => void vi.advanceTimersByTime(500));

    expect(onOpenCtx).not.toHaveBeenCalled();
    fireEvent.click(row);
    expect(onSelectNote).toHaveBeenCalledWith("n1", { toggle: false, range: false }, 0);
  });

  it("crossing the drag threshold (4px, same as startNoteDrag) cancels the pending long-press", () => {
    const onOpenCtx = vi.fn();
    const row = renderRow({ onOpenCtx });

    fireEvent.pointerDown(row, { button: 0, clientX: 50, clientY: 60 });
    act(() => void vi.advanceTimersByTime(100));
    fireEvent.pointerMove(window, { clientX: 60, clientY: 60 });
    act(() => void vi.advanceTimersByTime(500));

    expect(onOpenCtx).not.toHaveBeenCalled();

    // startNoteDrag registered its own window pointermove/up/cancel listeners on the same
    // pointerdown (it also crossed its 4px threshold above) — release the gesture so its ghost
    // element and listeners are cleaned up (noteDrag.ts's finish()) instead of leaking into the
    // next test via a stray global "Trip to Kyoto" ghost node.
    fireEvent.pointerCancel(window, { clientX: 60, clientY: 60 });
  });

  it("Ctrl/Shift-click never starts the hold — that's the multi-select gesture", () => {
    const onOpenCtx = vi.fn();
    const row = renderRow({ onOpenCtx });
    fireEvent.pointerDown(row, { button: 0, ctrlKey: true, clientX: 1, clientY: 1 });
    act(() => void vi.advanceTimersByTime(500));
    expect(onOpenCtx).not.toHaveBeenCalled();
  });
});

describe("TreeListRow — inbox header long-press opens the context menu (W5)", () => {
  const rows: TreeRow[] = [{ kind: "inbox_hdr" }];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    cancelLongPress();
  });
  afterEach(() => vi.useRealTimers());

  function renderRow(overrides: Partial<ListRowProps> = {}) {
    render(
      <TreeListRow
        index={0}
        style={{}}
        ariaAttributes={{ role: "listitem", "aria-posinset": 1, "aria-setsize": 1 }}
        {...baseProps(rows, { inboxId: "inbox-1", ...overrides })}
      />
    );
    return screen.getByText(t("tree.inbox")).closest("button") as HTMLElement;
  }

  it("holding past the threshold calls onOpenCtx with (inboxId, x, y), and swallows the trailing click", () => {
    const onOpenCtx = vi.fn();
    const onToggleInbox = vi.fn();
    const row = renderRow({ onOpenCtx, onToggleInbox });

    fireEvent.pointerDown(row, { button: 0, clientX: 20, clientY: 30 });
    act(() => void vi.advanceTimersByTime(500));
    expect(onOpenCtx).toHaveBeenCalledWith("inbox-1", 20, 30);

    fireEvent.pointerUp(row);
    fireEvent.click(row);
    expect(onToggleInbox).not.toHaveBeenCalled();
  });

  it("releasing early cancels — a normal click still toggles the inbox section", () => {
    const onOpenCtx = vi.fn();
    const onToggleInbox = vi.fn();
    const row = renderRow({ onOpenCtx, onToggleInbox });

    fireEvent.pointerDown(row, { button: 0, clientX: 20, clientY: 30 });
    act(() => void vi.advanceTimersByTime(200));
    fireEvent.pointerUp(row);
    act(() => void vi.advanceTimersByTime(500));

    expect(onOpenCtx).not.toHaveBeenCalled();
    fireEvent.click(row);
    expect(onToggleInbox).toHaveBeenCalled();
  });
});

// W7-g: 다중선택은 활성/커서/공개와 같은 배경-계열 축을 쓰지 않는다 — 아이콘 자리를
// 체크마크로 바꿔 다른 축으로 신호한다(TreeListRow.tsx 의 IconCheckMark 분기).
describe("TreeListRow — multi-select swaps the note icon for a check glyph", () => {
  const note = makeNote({ id: "n1", title: "Trip to Kyoto" });
  const rows: TreeRow[] = [{ kind: "note", note, indented: false }];

  it("renders the check glyph in place of the note icon when the note is multi-selected", () => {
    render(
      <TreeListRow
        index={0}
        style={{}}
        ariaAttributes={{ role: "listitem", "aria-posinset": 1, "aria-setsize": 1 }}
        {...baseProps(rows, { selectedIds: new Set(["n1"]) })}
      />
    );
    expect(screen.getByTestId("note-multiselect-check")).toBeTruthy();
  });

  it("renders the normal note icon (no check glyph) when the note is not multi-selected", () => {
    render(
      <TreeListRow
        index={0}
        style={{}}
        ariaAttributes={{ role: "listitem", "aria-posinset": 1, "aria-setsize": 1 }}
        {...baseProps(rows)}
      />
    );
    expect(screen.queryByTestId("note-multiselect-check")).toBeNull();
  });
});

// 폴더 카운트/"+" — 예전엔 같은 grid 셀을 공유해 hover 시 카운트가 사라졌다(tokens.css
// 806~808줄). 이제 "+"가 카운트 왼쪽의 별도 셀이라 카운트는 항상 DOM/레이아웃 상 살아있다
// (hover 시 실제로 안 사라지는지는 CSS 몫이라 jsdom 으로는 못 본다 — treeRow.css 주석 참고).
describe("TreeListRow — folder count stays alongside the in-row \"+\" button", () => {
  const folder = makeFolder({ id: "fol1", name: "Journal", note_count: 7 });
  const rows: TreeRow[] = [{ kind: "folder", folder }];

  function renderFolderRow(): HTMLElement {
    render(
      <TreeListRow
        index={0}
        style={{}}
        ariaAttributes={{ role: "listitem", "aria-posinset": 1, "aria-setsize": 1 }}
        {...baseProps(rows)}
      />
    );
    return screen.getByText("Journal").closest('[role="button"]') as HTMLElement;
  }

  it("renders the count and \"+\" as separate cells, with \"+\" before the count", () => {
    renderFolderRow();
    const count = screen.getByText("7");
    const addBtn = screen.getByLabelText("New note in this folder");
    expect(count.className).toContain("folder-count");
    expect(addBtn.className).toContain("folder-add-btn");
    // 예전 그리드-겹침 트릭의 흔적(같은 gridArea)이 더 이상 없어야 한다.
    expect((count as HTMLElement).style.gridArea).toBe("");
    expect((addBtn as HTMLElement).style.gridArea).toBe("");
    // "+"가 카운트보다 DOM 상 먼저 나와야(= flex 행에서 왼쪽) 한다.
    const position = addBtn.compareDocumentPosition(count);
    expect(Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it("the folder row carries the treerow class (treeRow.css needs it to out-specify tokens.css)", () => {
    const row = renderFolderRow();
    expect(row.className).toContain("treerow");
  });
});
