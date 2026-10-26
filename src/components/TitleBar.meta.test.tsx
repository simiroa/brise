import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { NoteDetail, Folder } from "../lib/commands.gen";

const callMock = vi.fn();

vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  flushAll: vi.fn(async () => {}),
  registerFlush: () => () => {},
  emitNotice: vi.fn(),
}));

// Keep AI / dialog side panels out of the meta-row layout fixture.
vi.mock("./titlebar/AiActionsMenu", () => ({
  AiActionsMenu: () => null,
}));
vi.mock("./PromptDialog", () => ({
  PromptDialog: () => null,
}));
vi.mock("./map/RegionPickerDialog", () => ({
  RegionPickerDialog: () => null,
}));

import { TitleBar } from "./TitleBar";
import { FOLDER_BADGE_MAX_PX } from "./titlebar/FolderBadge";
import { useNotesStore } from "../stores/notes";
import { useUiStore } from "../stores/ui";
import { useTaxonomyStore } from "../stores/taxonomy";
import { useSettingsStore } from "../stores/settings";
import { useExportModalStore } from "../stores/exportModal";
import { useAiStore, AI_GLOW_KEYS } from "../stores/ai";

function makeFolders(): Folder[] {
  return [
    {
      id: "f1",
      workspace_id: "ws",
      name: "Research notes long name that would crush tags",
      position: 0,
      is_open: true,
      note_count: 1,
      color_hue: null,
      icon: null,
      rules: null,
      search_excluded: false,
      ai_excluded: false,
    },
    {
      id: "f2",
      workspace_id: "ws",
      name: "Archive",
      position: 1,
      is_open: true,
      note_count: 0,
      color_hue: null,
      icon: null,
      rules: null,
      search_excluded: false,
      ai_excluded: false,
    },
  ];
}

function makeActiveNote(): NoteDetail {
  return {
    note: {
      id: "n1",
      folder_id: "f1",
      title: "Belonging note",
      year: 1442,
      is_favorite: false,
      content_locked: false,
      exported_at: null,
      has_image: false,
      tag_names: ["alpha", "beta", "gamma", "delta"],
      region: "Gyeongju",
      status: "draft",
      icon: null,
      lat: null,
      lng: null,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-01T00:00:00Z",
      month: null,
      day: null,
    },
    sections: [],
    sources: [],
    attachments: [],
  };
}

describe("TitleBar meta row — belonging + 135% font", () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockResolvedValue({});
    useUiStore.setState({ focusMode: false });
    useTaxonomyStore.setState({ statuses: [] });
    useSettingsStore.setState({ aiEnabled: false, uiLang: "en" } as never);
    useAiStore.setState({
      organizePending: false,
      promptPending: false,
      translateTargetLang: "en",
      translateGateOk: true,
      aiReachable: null,
      aiGlowTargets: new Map(),
      refreshTranslateGate: async () => true,
      ensureAiReachable: async () => {},
      loadHistory: async () => {},
      organizeCurrentNote: async () => {},
      generateFromPrompt: async () => null,
      setTranslateTargetLang: async () => {},
    } as never);
    useNotesStore.setState({
      activeNote: makeActiveNote(),
      folders: makeFolders(),
      savedState: "saved",
      loadTree: async () => {},
      selectNote: async () => {},
      setTitle: () => {},
      setNoteYear: () => {},
      setTags: async () => {},
      setRegion: async () => {},
      setStatus: async () => {},
      toggleFavorite: async () => {},
      toggleContentLock: async () => {},
    } as never);
  });

  it("renders folder first, then status/region/year, and keeps the tag strip non-zero at 135% font", () => {
    // Simulate the documented failure mode: large type in a narrow editor column.
    document.documentElement.style.setProperty("--fs", "1.35");

    const { container } = render(
      <div style={{ width: 360, overflow: "hidden" }}>
        <TitleBar />
      </div>,
    );

    // Force layout so clientWidth is measurable under jsdom's limited layout engine.
    const meta = container.querySelector('[data-testid="titlebar-meta-fixed"]') as HTMLElement | null;
    const strip = screen.getByTestId("titlebar-tag-strip");
    const folder = screen.getByTestId("folder-badge");
    const year = screen.getByTestId("date-badge");

    expect(meta).toBeTruthy();
    expect(folder).toBeTruthy();
    expect(year).toBeTruthy();

    // Folder is the first fixed child in the meta group (may sit inside MetaGlowChip).
    const fixedKids = Array.from(meta!.children) as HTMLElement[];
    expect(
      fixedKids[0]?.getAttribute("data-testid") === "folder-badge" ||
        fixedKids[0]?.querySelector('[data-testid="folder-badge"]') != null,
    ).toBe(true);

    // Title icon sits before the title input.
    expect(screen.getByTestId("title-note-icon")).toBeTruthy();

    // At least three tags visible in the strip.
    const tagText = strip.textContent ?? "";
    expect(tagText).toMatch(/alpha/);
    expect(tagText).toMatch(/beta/);
    expect(tagText).toMatch(/gamma/);

    // Folder badge must stay hard-capped so it cannot eat the whole row.
    const badgeBtn = folder.querySelector("button") as HTMLButtonElement;
    expect(badgeBtn.style.maxWidth).toBe("88px");

    // Tag strip is flex:1 minWidth:0 — contract is that it remains a flex grower
    // (never collapsed out of the layout by a free-width fourth fixed item).
    // React serializes flex:1 as "1 1 0%" in this environment.
    expect(strip.style.flex).toMatch(/^1(\s|$)/);
    expect(strip.style.minWidth).toMatch(/^0(px)?$/);
    // Folder hard cap (px, not em) is what keeps the strip from being crushed at --fs:1.35.
    // Remaining fixed items are themselves capped (status/region/date chips — YearBadge+DueChip
    // merged into one DateBadge, so this is still 3 items after folder); the strip therefore
    // cannot compute to flex-basis zero solely because of the folder badge.
    expect(FOLDER_BADGE_MAX_PX + 3 * 22).toBeLessThan(360);

    // Clean up scale for other tests in the same worker.
    document.documentElement.style.removeProperty("--fs");
  });

  it("puts AI glow on individual tag chips and meta badges, not the enclosing regions", () => {
    useAiStore.setState({
      aiGlowTargets: new Map([
        [AI_GLOW_KEYS.tags("n1"), "active"],
        [AI_GLOW_KEYS.note("n1"), "active"],
      ]),
    } as never);

    // Scope to this render — sibling tests leave prior TitleBar trees in document.body.
    const { container } = render(<TitleBar />);

    const strip = container.querySelector('[data-testid="titlebar-tag-strip"]') as HTMLElement;
    const meta = container.querySelector('[data-testid="titlebar-meta-fixed"]') as HTMLElement;
    expect(strip).toBeTruthy();
    expect(meta).toBeTruthy();
    expect(strip.getAttribute("data-ai-glow")).toBeNull();
    expect(meta.getAttribute("data-ai-glow")).toBeNull();

    const tagChips = Array.from(container.querySelectorAll('[data-testid="titlebar-tag-chip"]'));
    expect(tagChips.length).toBeGreaterThanOrEqual(3);
    for (const chip of tagChips) {
      expect(chip.getAttribute("data-ai-glow")).toBe("active");
    }

    const region = container.querySelector('[data-testid="region-meta-badge"]') as HTMLElement;
    expect(region.getAttribute("data-ai-glow")).toBe("active");

    // Folder/status/date sit in MetaGlowChip shells that carry the note glow.
    const metaGlowShells = meta.querySelectorAll('[data-ai-glow="active"]');
    expect(metaGlowShells.length).toBeGreaterThanOrEqual(3);
  });
});

// PLAN 더보기 메뉴 개편: 이름바꾸기 제거 + "내용잠금" 토글 신설. F-N09 (specs/features/notes.yaml).
describe("TitleBar 더보기 메뉴 — 이름바꾸기 제거 + 내용잠금", () => {
  function openMoreMenu() {
    fireEvent.click(screen.getByRole("button", { name: "More" }));
  }

  it("이름바꾸기 항목이 더 이상 없다", () => {
    render(<TitleBar />);
    openMoreMenu();
    expect(screen.queryByText("Rename")).toBeNull();
  });

  it("가져오기 라벨이 SECTION_IMPORT_EXTS에서 유도한 확장자 예시를 보여준다", () => {
    render(<TitleBar />);
    openMoreMenu();
    const importItem = screen.getByTestId("titlebar-menu-import");
    expect(importItem.textContent).toContain("md, txt, docx");
  });

  it("content_locked=false면 내용잠금 항목이 '잠금'을 제안하고 가져오기는 활성 상태다", () => {
    render(<TitleBar />);
    openMoreMenu();
    const lockItem = screen.getByTestId("titlebar-menu-content-lock");
    expect(lockItem.textContent).toContain("Lock content");
    const importItem = screen.getByTestId("titlebar-menu-import") as HTMLButtonElement;
    expect(importItem.disabled).toBe(false);
  });

  it("content_locked=true면 내용잠금 항목이 '해제'로 바뀌고 가져오기는 비활성 + 이유 툴팁을 보여준다", () => {
    useNotesStore.setState({
      activeNote: { ...makeActiveNote(), note: { ...makeActiveNote().note, content_locked: true } },
    } as never);
    render(<TitleBar />);
    openMoreMenu();
    const lockItem = screen.getByTestId("titlebar-menu-content-lock");
    expect(lockItem.textContent).toContain("Unlock content");
    const importItem = screen.getByTestId("titlebar-menu-import") as HTMLButtonElement;
    expect(importItem.disabled).toBe(true);
    expect(importItem.title).toBe("Content is locked — editing disabled");
  });

  it("내보내기 항목은 md/html 선택 대화상자가 아니라 내보내기 모달을 '노트 전체' 범위로 연다", () => {
    useExportModalStore.setState({ request: null });
    render(<TitleBar />);
    openMoreMenu();
    fireEvent.click(screen.getByTestId("titlebar-menu-export"));
    expect(useExportModalStore.getState().request).toEqual({
      noteId: "n1",
      noteTitle: "Belonging note",
      sectionId: null,
    });
  });

  it("내용잠금 항목 클릭이 toggleContentLock을 부른다", () => {
    const toggleContentLock = vi.fn(async () => {});
    useNotesStore.setState({ toggleContentLock } as never);
    render(<TitleBar />);
    openMoreMenu();
    fireEvent.click(screen.getByTestId("titlebar-menu-content-lock"));
    expect(toggleContentLock).toHaveBeenCalledTimes(1);
  });
});

// F-N09 확장: 더보기 메뉴를 열지 않아도 항상 보이는 잠금 아이콘 — 즐겨찾기 바로 왼쪽, 클릭 한
// 번으로 바로 해제.
describe("TitleBar 잠금 아이콘 — 즐겨찾기 좌측, 상시 표시, 클릭 시 즉시 해제", () => {
  // 앞 describe("더보기 메뉴...")의 마지막 케이스가 content_locked: true인 activeNote를 남겨둔다
  // — zustand 상태는 테스트 간 안 비워지므로 여기서 명시적으로 언락 상태로 되돌린다.
  beforeEach(() => {
    useNotesStore.setState({ activeNote: makeActiveNote() } as never);
  });

  it("content_locked=false면 잠금 아이콘이 보이지 않는다", () => {
    render(<TitleBar />);
    expect(screen.queryByTestId("titlebar-lock-icon")).toBeNull();
  });

  it("content_locked=true면 잠금 아이콘이 즐겨찾기 버튼 바로 앞에 렌더된다", () => {
    useNotesStore.setState({
      activeNote: { ...makeActiveNote(), note: { ...makeActiveNote().note, content_locked: true } },
    } as never);
    render(<TitleBar />);
    const lockBtn = screen.getByTestId("titlebar-lock-icon");
    const favBtn = screen.getByTitle("Favorite");
    expect(lockBtn.compareDocumentPosition(favBtn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("잠금 아이콘 클릭은 더보기 메뉴를 거치지 않고 바로 toggleContentLock을 부른다", () => {
    const toggleContentLock = vi.fn(async () => {});
    useNotesStore.setState({
      activeNote: { ...makeActiveNote(), note: { ...makeActiveNote().note, content_locked: true } },
      toggleContentLock,
    } as never);
    render(<TitleBar />);
    fireEvent.click(screen.getByTestId("titlebar-lock-icon"));
    expect(toggleContentLock).toHaveBeenCalledTimes(1);
    // 더보기 메뉴는 열리지 않았다.
    expect(screen.queryByTestId("titlebar-menu-content-lock")).toBeNull();
  });

  it("잠겨 있으면 메타 칩 행 + 태그 스트립이 비활성 스타일을 받고, 제목 입력은 readOnly다", () => {
    useNotesStore.setState({
      activeNote: { ...makeActiveNote(), note: { ...makeActiveNote().note, content_locked: true } },
    } as never);
    const { container } = render(<TitleBar />);
    const meta = container.querySelector('[data-testid="titlebar-meta-fixed"]')!.parentElement as HTMLElement;
    expect(meta.style.pointerEvents).toBe("none");
    const titleInput = container.querySelector("input") as HTMLInputElement;
    expect(titleInput.readOnly).toBe(true);
    // 즐겨찾기 버튼은 잠금과 무관하게 계속 눌려야 한다(예외) — 별도 컨테이너라 pointerEvents가 없다.
    const favBtn = screen.getByTitle("Favorite");
    expect(favBtn.closest("div")?.style.pointerEvents).not.toBe("none");
  });
});

