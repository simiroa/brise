import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const callMock = vi.fn();
const emitNoticeMock = vi.fn();

vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  flushAll: vi.fn(async () => {}),
  registerFlush: () => () => {},
  emitNotice: (...args: unknown[]) => emitNoticeMock(...args),
}));

const dialogOpenMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => dialogOpenMock(...args),
}));

import { ContextMenu } from "./ContextMenu";
import { FolderOrganizeModal } from "./FolderOrganizeModal";
import { useUiStore } from "../stores/ui";
import { useNotesStore } from "../stores/notes";
import { useTaxonomyStore } from "../stores/taxonomy";
import { useSettingsStore } from "../stores/settings";
import { useAiStore } from "../stores/ai";
import { useExportModalStore } from "../stores/exportModal";
import type { Folder, NoteSummary } from "../lib/commands.gen";
import { AskAiModal as LazyAskAiModal } from "../lazySurfaces";

// 이 화면들은 지연 청크다(lazySurfaces) — 앱이 유휴 시간에 미리 받듯 여기서 미리 받아 클릭 직후 바로 그려지게 한다.
beforeAll(async () => {
  await LazyAskAiModal.preload();
}, 30_000);

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
    region_names: [],
    status: partial.status ?? null,
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

function openCtxForNote(noteId: string) {
  useUiStore.getState().openCtx(noteId, 100, 100);
}

function setUpNoteState(notes: NoteSummary[], folders: Folder[] = []) {
  const noteIndex = new Map<string, NoteSummary>(notes.map((n) => [n.id, n]));
  useNotesStore.setState({
    folders,
    noteIndex,
    notesByFolder: {},
    activeNote: null,
    inboxId: null,
  });
}

describe("ContextMenu — change status", () => {
  beforeEach(() => {
    callMock.mockReset();
    emitNoticeMock.mockReset();
    useUiStore.setState({ ctxOpen: null });
    useTaxonomyStore.setState({ statuses: [] });
    callMock.mockImplementation(async (cmd: string, args: any) => {
      if (cmd === "note_set_status") {
        // Echo the requested status — same shape the backend would return.
        return {
          ...args,
          folder_id: "f1",
          title: "Note",
          year: 2024,
          is_favorite: false,
          exported_at: null,
          has_image: false,
          tag_names: [],
          region: null,
          icon: null,
          lat: null,
          lng: null,
        };
      }
      return {};
    });
  });

  it("renders the 'Change status' menu item for a note (not for a folder)", () => {
    setUpNoteState([makeNote({ id: "n1" })]);
    openCtxForNote("n1");
    render(<ContextMenu />);
    expect(screen.getByText(/Change status/i)).toBeTruthy();
  });

  // Icon-change removed from this menu (owner decision) — the long-press picker on the tree
  // row's own icon (NoteIconControl.tsx) is the surviving entry point. Rename is ALSO gone now:
  // double-click (or F2) on the row itself is the inline replacement (TreeListRow.tsx), so the
  // menu item and its dialog were dead weight.
  it("does NOT render a 'Change icon' or 'Rename' menu item", () => {
    setUpNoteState([makeNote({ id: "n1" })]);
    openCtxForNote("n1");
    render(<ContextMenu />);
    expect(screen.queryByText(/Change icon/i)).toBeNull();
    expect(screen.queryByText(/^Rename$/i)).toBeNull();
  });

  it("does NOT render a 'Rename' menu item for a folder row either", () => {
    const folder: Folder = {
      id: "f1",
      workspace_id: "ws",
      name: "Archive",
      position: 0,
      is_open: false,
      note_count: 0,
      color_hue: null,
      icon: null,
      rules: null,
      search_excluded: false,
      ai_excluded: false,
    };
    setUpNoteState([], [folder]);
    openCtxForNote("f1");
    render(<ContextMenu />);
    expect(screen.queryByText(/^Rename$/i)).toBeNull();
  });

  it("does NOT render 'Change status' for a folder row", () => {
    const folder: Folder = {
      id: "f1",
      workspace_id: "ws",
      name: "Archive",
      position: 0,
      is_open: false,
      note_count: 0,
      color_hue: null,
      icon: null,
      rules: null,
      search_excluded: false,
      ai_excluded: false,
    };
    setUpNoteState([], [folder]);
    openCtxForNote("f1");
    render(<ContextMenu />);
    expect(screen.queryByText(/Change status/i)).toBeNull();
  });

  it("picking a built-in status calls note_set_status with the right id and the chosen key", async () => {
    setUpNoteState([makeNote({ id: "n1", status: null })]);
    openCtxForNote("n1");
    render(<ContextMenu />);

    fireEvent.click(screen.getByText(/Change status/i));

    // Choice dialog: built-in labels come from status.* via t() — in en.json these are
    // "In progress" / "Exported" / "Done". No need to mock i18n — uiLang defaults to "en".
    const inProgress = await screen.findByText(/In progress/i);
    fireEvent.click(inProgress);

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "note_set_status",
        expect.objectContaining({ id: "n1", status: "in_progress" }),
      );
    });
    const call = callMock.mock.calls.find((c) => c[0] === "note_set_status");
    expect(call).toBeDefined();
    // Strict: status is the built-in key, not null/""/undefined.
    expect(call?.[1].status).toBe("in_progress");
  });

  it("picking 'No status' sends null (not '' or undefined)", async () => {
    setUpNoteState([makeNote({ id: "n1", status: "in_progress" })]);
    openCtxForNote("n1");
    render(<ContextMenu />);

    fireEvent.click(screen.getByText(/Change status/i));

    const noStatus = await screen.findByText(/No status/i);
    fireEvent.click(noStatus);

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "note_set_status",
        expect.objectContaining({ id: "n1", status: null }),
      );
    });
    const call = callMock.mock.calls.find((c) => c[0] === "note_set_status");
    // Sentinel discipline — the backend treats null as an explicit clear and "" as malformed.
    expect(call?.[1].status).toBeNull();
    expect(call?.[1].status).not.toBe("");
    expect(call?.[1].status).not.toBeUndefined();
  });

  it("picking a custom status calls note_set_status with that custom id", async () => {
    useTaxonomyStore.setState({
      statuses: [{ id: "cs-1", workspace_id: "ws", name: "Archived", position: 0 }],
    });
    setUpNoteState([makeNote({ id: "n1", status: null })]);
    openCtxForNote("n1");
    render(<ContextMenu />);

    fireEvent.click(screen.getByText(/Change status/i));

    const custom = await screen.findByText(/^Archived$/);
    fireEvent.click(custom);

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "note_set_status",
        expect.objectContaining({ id: "n1", status: "cs-1" }),
      );
    });
  });

  it("rejected note_set_status rolls the note's summary status back to its previous value", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "note_set_status") {
        return Promise.reject(new Error("boom"));
      }
      return Promise.resolve({});
    });
    setUpNoteState([makeNote({ id: "n1", status: "in_progress" })]);
    openCtxForNote("n1");
    render(<ContextMenu />);

    fireEvent.click(screen.getByText(/Change status/i));
    fireEvent.click(await screen.findByText(/^Done$/));

    // runChangeStatus patches optimistically first, then rolls back when call() rejects.
    await waitFor(() => {
      expect(useNotesStore.getState().noteIndex.get("n1")?.status).toBe("in_progress");
    });
    expect(callMock).toHaveBeenCalledWith(
      "note_set_status",
      expect.objectContaining({ id: "n1", status: "done" }),
    );
  });
});

// 우클릭 → "폴더 설정" 이 실제로 모달을 띄우는지는 어느 테스트도 보지 않았다 — 메뉴는 메뉴만,
// 모달은 모달만 렌더해 왔기 때문에 그 사이 배선이 끊겨도 둘 다 초록이었다. 두 컴포넌트를 함께
// 올려 사용자가 실제로 밟는 경로를 통째로 건다.
describe("ContextMenu — folder settings opens the modal", () => {
  const folder: Folder = {
    id: "f1",
    workspace_id: "ws",
    name: "Archive",
    position: 0,
    is_open: false,
    note_count: 0,
    color_hue: null,
    icon: null,
    rules: null,
    search_excluded: false,
    ai_excluded: false,
  };

  beforeEach(() => {
    callMock.mockReset();
    emitNoticeMock.mockReset();
    callMock.mockImplementation((cmd: string) =>
      cmd === "note_query" ? Promise.resolve({ notes: [], total: 0 }) : Promise.resolve({})
    );
    useUiStore.setState({ ctxOpen: null, folderFilesOpen: null });
  });

  it("right-clicking a folder and picking 폴더 설정 renders the settings modal", async () => {
    setUpNoteState([], [folder]);
    useNotesStore.setState({ loadTree: vi.fn() } as never);
    render(
      <>
        <ContextMenu />
        <FolderOrganizeModal />
      </>
    );
    openCtxForNote("f1");

    fireEvent.click(await screen.findByText(/Folder settings|폴더 설정/i));

    // 스토어만 보면 "열라고 시켰다"까지밖에 모른다 — 모달이 실제로 그려졌는지까지 본다.
    expect(useUiStore.getState().folderFilesOpen).toBe("f1");
    await waitFor(() => {
      expect(screen.getByTestId("modal-shell")).toBeTruthy();
    });
    expect(screen.getByTestId("folder-icon-toggle")).toBeTruthy();
  });
});

describe("ContextMenu — note export opens the export modal", () => {
  beforeEach(() => {
    callMock.mockReset();
    emitNoticeMock.mockReset();
    useUiStore.setState({ ctxOpen: null });
    useExportModalStore.setState({ request: null });
  });

  it("'Export note…' asks for the same export modal as the section tab, scoped to the whole note (no md/html choice dialog)", () => {
    setUpNoteState([makeNote({ id: "n1", title: "My Note" })]);
    openCtxForNote("n1");
    render(<ContextMenu />);

    fireEvent.click(screen.getByText(/Export note…/i));

    expect(useExportModalStore.getState().request).toEqual({
      noteId: "n1",
      noteTitle: "My Note",
      sectionId: null,
    });
    // 예전의 md/html 선택 대화상자는 더 이상 뜨지 않는다.
    expect(screen.queryByText(/Markdown \(\.md\)/i)).toBeNull();
    // 메뉴는 닫힌다.
    expect(useUiStore.getState().ctxOpen).toBeNull();
  });
});

describe("ContextMenu — consolidated folder export dialog", () => {
  const folder: Folder = {
    id: "f1",
    workspace_id: "ws",
    name: "Archive",
    position: 0,
    is_open: false,
    note_count: 0,
    color_hue: null,
    icon: null,
    rules: null,
    search_excluded: false,
    ai_excluded: false,
  };

  beforeEach(() => {
    callMock.mockReset();
    emitNoticeMock.mockReset();
    dialogOpenMock.mockReset();
    useUiStore.setState({ ctxOpen: null });
  });

  it("renders a single 'Export folder…' item for a folder row (no separate bundle item)", () => {
    setUpNoteState([], [folder]);
    openCtxForNote("f1");
    render(<ContextMenu />);
    expect(screen.getAllByText(/Export folder…/i)).toHaveLength(1);
    expect(screen.queryByText(/Export folder as bundle/i)).toBeNull();
  });

  it("opening it shows Markdown and bundle only — folder-level HTML was removed (W6, owner 2026-10-08)", () => {
    setUpNoteState([], [folder]);
    openCtxForNote("f1");
    render(<ContextMenu />);

    fireEvent.click(screen.getByText(/Export folder…/i));

    expect(screen.getByText(/Markdown \(\.md\)/i)).toBeTruthy();
    expect(screen.queryByText(/HTML \(\.html\)/i)).toBeNull();
    expect(screen.getByText(/Bundle \(\.json\)/i)).toBeTruthy();
  });

  it("picking Bundle opens a directory dialog and calls export_folder_bundle with the folder id and chosen dir", async () => {
    dialogOpenMock.mockResolvedValue("C:\\out");
    callMock.mockResolvedValue({ note_count: 3, bundle_path: "C:\\out\\brise-bundle.json" });
    setUpNoteState([], [folder]);
    openCtxForNote("f1");
    render(<ContextMenu />);

    fireEvent.click(screen.getByText(/Export folder…/i));
    fireEvent.click(screen.getByText(/Bundle \(\.json\)/i));

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith(
        "export_folder_bundle",
        expect.objectContaining({ id: "f1", dest_dir: "C:\\out" }),
      );
    });
    expect(dialogOpenMock).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
  });

  it("cancelling the directory dialog after picking Bundle does not call export_folder_bundle", async () => {
    dialogOpenMock.mockResolvedValue(null);
    setUpNoteState([], [folder]);
    openCtxForNote("f1");
    render(<ContextMenu />);

    fireEvent.click(screen.getByText(/Export folder…/i));
    fireEvent.click(screen.getByText(/Bundle \(\.json\)/i));

    await waitFor(() => expect(dialogOpenMock).toHaveBeenCalled());
    expect(callMock).not.toHaveBeenCalledWith("export_folder_bundle", expect.anything());
  });

  it("picking Markdown opens a directory dialog and calls export_folder with exactly {id, dest_path} (no format)", async () => {
    dialogOpenMock.mockResolvedValue("C:\\out");
    callMock.mockResolvedValue({ exported_count: 2, written_dir: "C:\\out" });
    setUpNoteState([], [folder]);
    openCtxForNote("f1");
    render(<ContextMenu />);

    fireEvent.click(screen.getByText(/Export folder…/i));
    fireEvent.click(screen.getByText(/Markdown \(\.md\)/i));

    await waitFor(() => expect(callMock.mock.calls.some((c) => c[0] === "export_folder")).toBe(true));
    expect(callMock.mock.calls.find((c) => c[0] === "export_folder")![1]).toEqual({ id: "f1", dest_path: "C:\\out" });
  });
});

describe("ContextMenu — Ask-AI note row (AskAiModal.tsx)", () => {
  const folder: Folder = {
    id: "f1",
    workspace_id: "ws",
    name: "Archive",
    position: 0,
    is_open: false,
    note_count: 0,
    color_hue: null,
    icon: null,
    rules: null,
    search_excluded: false,
    ai_excluded: false,
  };

  beforeEach(() => {
    callMock.mockReset();
    emitNoticeMock.mockReset();
    useUiStore.setState({ ctxOpen: null });
    useAiStore.setState({ translateGateOk: null });
  });

  it("does not render for a note when aiEnabled is off", () => {
    useSettingsStore.setState({ aiEnabled: false });
    setUpNoteState([makeNote({ id: "n1" })]);
    openCtxForNote("n1");
    render(<ContextMenu />);
    expect(screen.queryByText(/AI에게 묻기|Ask AI/)).toBeNull();
  });

  it("does not render for a folder row even when aiEnabled is on (folder keeps its own AI plan row)", () => {
    useSettingsStore.setState({ aiEnabled: true });
    setUpNoteState([], [folder]);
    openCtxForNote("f1");
    render(<ContextMenu />);
    expect(screen.queryByText(/^(AI에게 묻기|Ask AI)$/)).toBeNull();
  });

  it("renders for a note when aiEnabled is on, and clicking it (gate open) opens the Ask-AI modal with the note's title", async () => {
    useSettingsStore.setState({ aiEnabled: true });
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({ settings: { ai_enabled: false, ai_provider: "ollama", ai_endpoint: "" } });
      }
      return Promise.resolve({});
    });
    setUpNoteState([makeNote({ id: "n1", title: "My Note" })]);
    openCtxForNote("n1");
    render(<ContextMenu />);

    fireEvent.click(screen.getByText(/AI에게 묻기|Ask AI/));

    await waitFor(() => {
      expect(screen.getByTestId("modal-shell")).toBeTruthy();
    });
    expect(screen.getByTestId("modal-shell").textContent).toContain("My Note");
  });

  it("clicking it while the AI gate is blocked (cloud provider, ai_enabled off) notices instead of opening the modal", async () => {
    useSettingsStore.setState({ aiEnabled: true });
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({ settings: { ai_enabled: false, ai_provider: "openai", ai_endpoint: "https://api.openai.com" } });
      }
      return Promise.resolve({});
    });
    setUpNoteState([makeNote({ id: "n1", title: "My Note" })]);
    openCtxForNote("n1");
    render(<ContextMenu />);

    fireEvent.click(screen.getByText(/AI에게 묻기|Ask AI/));

    await waitFor(() => expect(emitNoticeMock).toHaveBeenCalled());
    expect(screen.queryByTestId("modal-shell")).toBeNull();
  });

  it("renders folder organize and batch organize options when right clicking on inbox with aiEnabled", async () => {
    useSettingsStore.setState({ aiEnabled: true });
    useNotesStore.setState({
      folders: [{ id: "inbox-1", workspace_id: "ws-1", name: "inbox", color_hue: null, icon: null, rules: null, search_excluded: false, ai_excluded: false, is_open: true, position: 0, note_count: 0 }],
      inboxId: "inbox-1",
      noteIndex: new Map(),
      notesByFolder: {},
    });
    openCtxForNote("inbox-1");
    render(<ContextMenu />);

    expect(screen.getByText(/Folder settings|폴더 설정/i)).toBeTruthy();
    expect(screen.getByText(/Organize selected|선택 AI 정리/i)).toBeTruthy();
    expect(screen.getByText(/Organize & merge folder|정리·병합 제안/i)).toBeTruthy();

    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_query") {
        return { notes: [makeNote({ id: "n1", title: "Inbox Note 1" })], total: 1 };
      }
      return {};
    });

    fireEvent.click(screen.getByText(/Organize selected|선택 AI 정리/i));
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("note_query", expect.objectContaining({ folder_ids: ["inbox-1"] }));
    });
  });
});