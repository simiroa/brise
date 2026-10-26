import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { NoteDetail, Folder } from "../lib/commands.gen";

// PLAN 가져오기 확장: 더보기 메뉴 "가져오기"가 문서류(SECTION_IMPORT_EXTS)/비문서(이미지 등)
// 파일을 골라 섹션 가져오기 vs 첨부 라우팅을 선택하게 한다 — TitleBar.tsx::runImportSections,
// attachFilesToNote 참고. 이 파일은 그 라우팅을 검증한다. TitleBar.meta.test.tsx와 달리
// PromptDialog는 목킹하지 않는다(실제로 렌더해 선택지를 클릭해야 하므로).

const emitNoticeMock = vi.fn();
vi.mock("../lib/invoke", () => ({
  call: vi.fn(async () => ({})),
  callSilent: vi.fn(async () => ({})),
  flushAll: vi.fn(async () => {}),
  registerFlush: () => () => {},
  emitNotice: (...args: unknown[]) => emitNoticeMock(...args),
}));

// exportNote/deleteNote는 이 흐름과 무관 — 존재만 하면 된다. importFilesAsSections/attachFile은
// 라우팅 검증의 핵심이라 스파이로 남긴다.
const importFilesAsSectionsMock = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
const attachFileMock = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("../lib/noteActions", () => ({
  exportNote: vi.fn(async () => {}),
  deleteNote: vi.fn(async () => {}),
  importFilesAsSections: (...args: unknown[]) => importFilesAsSectionsMock(...args),
  attachFile: (...args: unknown[]) => attachFileMock(...args),
}));

const openDialogMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openDialogMock(...args),
}));

vi.mock("./titlebar/AiActionsMenu", () => ({
  AiActionsMenu: () => null,
}));
vi.mock("./map/RegionPickerDialog", () => ({
  RegionPickerDialog: () => null,
}));

import { TitleBar } from "./TitleBar";
import { useNotesStore } from "../stores/notes";
import { useUiStore } from "../stores/ui";
import { useTaxonomyStore } from "../stores/taxonomy";
import { useSettingsStore } from "../stores/settings";
import { useAiStore } from "../stores/ai";

function makeFolders(): Folder[] {
  return [];
}

function makeActiveNote(): NoteDetail {
  return {
    note: {
      id: "n1",
      folder_id: "",
      title: "Note with attachments",
      year: 2026,
      is_favorite: false,
      content_locked: false,
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
    },
    sections: [],
    sources: [],
    attachments: [],
  };
}

function openMoreMenu() {
  fireEvent.click(screen.getByRole("button", { name: "More" }));
}

function clickImport() {
  fireEvent.click(screen.getByTestId("titlebar-menu-import"));
}

describe("TitleBar 가져오기 — 문서류/비문서 라우팅 (PLAN 가져오기 확장)", () => {
  const reloadActiveMock = vi.fn(async () => {});

  beforeEach(() => {
    vi.clearAllMocks();
    openDialogMock.mockReset();
    importFilesAsSectionsMock.mockClear();
    attachFileMock.mockClear();
    reloadActiveMock.mockClear();

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
      reloadActive: reloadActiveMock,
      setTitle: () => {},
      setNoteYear: () => {},
      setTags: async () => {},
      setRegion: async () => {},
      setStatus: async () => {},
      toggleFavorite: async () => {},
      toggleContentLock: async () => {},
    } as never);
  });

  it("(a) 문서류만 선택하면 선택 다이얼로그가 뜨고, '섹션으로 가져오기'는 importFilesAsSections로만 간다", async () => {
    openDialogMock.mockResolvedValue(["C:/docs/report.pdf", "C:/docs/notes.docx"]);
    render(<TitleBar />);
    openMoreMenu();
    clickImport();

    await screen.findByText("Choose how to import");
    // 비문서 파일이 없으니 "섞임" 안내 문구는 없다.
    expect(screen.queryByText("Non-document files (images, etc.) are added as attachments either way.")).toBeNull();

    fireEvent.click(screen.getByText("Import as sections"));

    await waitFor(() => {
      expect(importFilesAsSectionsMock).toHaveBeenCalledWith("n1", [
        "C:/docs/report.pdf",
        "C:/docs/notes.docx",
      ]);
    });
    expect(attachFileMock).not.toHaveBeenCalled();
  });

  it("(a) 문서류만 선택하고 '첨부로만 추가'를 고르면 attachFile로만 간다(섹션 가져오기 없음)", async () => {
    openDialogMock.mockResolvedValue(["C:/docs/report.pdf", "C:/docs/notes.docx"]);
    render(<TitleBar />);
    openMoreMenu();
    clickImport();

    await screen.findByText("Choose how to import");
    fireEvent.click(screen.getByText("Add as attachments only"));

    await waitFor(() => {
      expect(attachFileMock).toHaveBeenCalledTimes(2);
    });
    expect(attachFileMock.mock.calls.map((c) => c[1])).toEqual(["C:/docs/report.pdf", "C:/docs/notes.docx"]);
    expect(importFilesAsSectionsMock).not.toHaveBeenCalled();
  });

  it("(b) 이미지 등 비문서 파일만 선택하면 다이얼로그 없이 바로 첨부로 간다", async () => {
    openDialogMock.mockResolvedValue(["C:/pics/photo.png", "C:/pics/pic.jpg"]);
    render(<TitleBar />);
    openMoreMenu();
    clickImport();

    await waitFor(() => {
      expect(attachFileMock).toHaveBeenCalledTimes(2);
    });
    expect(attachFileMock.mock.calls.map((c) => c[1])).toEqual(["C:/pics/photo.png", "C:/pics/pic.jpg"]);
    expect(importFilesAsSectionsMock).not.toHaveBeenCalled();
    expect(screen.queryByText("Choose how to import")).toBeNull();
  });

  it("(c) 문서류+이미지 혼합 — '섹션으로'는 문서류만 섹션으로, 이미지는 항상 첨부로 간다", async () => {
    openDialogMock.mockResolvedValue(["C:/docs/report.pdf", "C:/pics/photo.png"]);
    render(<TitleBar />);
    openMoreMenu();
    clickImport();

    await screen.findByText("Choose how to import");
    // 비문서 파일이 섞여 있으니 안내 문구가 보인다.
    expect(screen.getByText("Non-document files (images, etc.) are added as attachments either way.")).toBeTruthy();

    fireEvent.click(screen.getByText("Import as sections"));

    await waitFor(() => {
      expect(importFilesAsSectionsMock).toHaveBeenCalledWith("n1", ["C:/docs/report.pdf"]);
    });
    await waitFor(() => {
      expect(attachFileMock).toHaveBeenCalledTimes(1);
    });
    expect(attachFileMock.mock.calls[0][1]).toBe("C:/pics/photo.png");
  });

  it("(c) 문서류+이미지 혼합 — '첨부로만 추가'는 문서류/이미지 전부 attachFile로 간다", async () => {
    openDialogMock.mockResolvedValue(["C:/docs/report.pdf", "C:/pics/photo.png"]);
    render(<TitleBar />);
    openMoreMenu();
    clickImport();

    await screen.findByText("Choose how to import");
    fireEvent.click(screen.getByText("Add as attachments only"));

    await waitFor(() => {
      expect(attachFileMock).toHaveBeenCalledTimes(2);
    });
    expect(attachFileMock.mock.calls.map((c) => c[1])).toEqual(["C:/docs/report.pdf", "C:/pics/photo.png"]);
    expect(importFilesAsSectionsMock).not.toHaveBeenCalled();
  });
});
