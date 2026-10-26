import { describe, it, expect, vi, beforeEach } from "vitest";

// Tracks call ordering across the mocked seams so deleteNote's flush-before-delete guarantee
// (the actual bug this flow was written to avoid — see noteActions.ts) can be pinned precisely,
// not just asserted as "both were called".
let order: string[] = [];

const callMock = vi.fn(async (cmd: string, _args?: Record<string, unknown>): Promise<any> => {
  order.push(`call:${cmd}`);
  return undefined;
});
const flushAllMock = vi.fn(async () => {
  order.push("flushAll");
});
const loadTreeMock = vi.fn(async () => {
  order.push("loadTree");
});
const selectNoteMock = vi.fn(async (id: string) => {
  order.push(`selectNote:${id}`);
});
const discardDraftMock = vi.fn(() => {
  order.push("discardDraft");
});
const closeTabMock = vi.fn((id: string) => {
  order.push(`closeTab:${id}`);
});
const reloadActiveMock = vi.fn(async () => {
  order.push("reloadActive");
});
const patchNoteSummaryMock = vi.fn((id: string, _patch: Record<string, unknown>) => {
  order.push(`patchNoteSummary:${id}`);
});
const removeNoteSummaryMock = vi.fn((id: string) => {
  order.push(`removeNoteSummary:${id}`);
});
const patchFolderMock = vi.fn((id: string, _patch: Record<string, unknown>) => {
  order.push(`patchFolder:${id}`);
});
const saveMock = vi.fn();
const dialogOpenMock = vi.fn();

let notesActiveNoteId: string | null = null;
let settingsActiveTabId: string | null = null;
// attachFile 테스트용 — useAttachmentActions.test.tsx와 같은 이유로 실제 stores/settings를 그대로
// 두지 않고 모킹한다(lib/appearance 등 무거운 부작용 임포트를 끌고 온다).
let sourceOriginalPolicy = "discard";
// moveNote 내용잠금 가드 테스트용 — 실제 isNoteContentLocked는 activeNote/noteIndex를 보지만,
// 이 파일은 stores/notes 전체를 모킹하므로 여기서도 같은 이름의 간단한 함수로 대신한다.
let notesContentLockedIds = new Set<string>();

const emitNoticeMock = vi.fn();
// callSilent 도 callMock 으로 흘려 보내되(기존 테스트가 한 곳만 보게) 별도로도 기록한다 — 서식형 가져오기의
// doc_import_html 이 "토스트 없는" 경로로 불렸는지(call 이 아니라) 가르는 데 쓴다.
const callSilentMock = vi.fn((...args: [string, Record<string, unknown>?]) => callMock(...args));
vi.mock("../lib/invoke", () => ({
  call: (...args: [string, Record<string, unknown>?]) => callMock(...args),
  callSilent: (...args: [string, Record<string, unknown>?]) => callSilentMock(...args),
  flushAll: () => flushAllMock(),
  emitNotice: (...args: unknown[]) => emitNoticeMock(...args),
}));

const reportFallbackMock = vi.fn();
vi.mock("../lib/diag", () => ({
  reportFallback: (...args: unknown[]) => reportFallbackMock(...args),
}));

// 직렬화 규칙 자체는 docImportHtmlContract.test.ts 가 진짜 함수로 지킨다 — 여기서는 "무엇을 어떤 순서로
// 부르나" 만 보므로 결정적인 가짜로 바꿔 직렬화 예외·빈 결과 갈래도 만든다.
const mdSerializeHtmlMock = vi.fn((html: string) => `md:${html}`);
vi.mock("../lib/mdSerialize", () => ({
  mdSerializeHtml: (html: string) => mdSerializeHtmlMock(html),
}));

const showUndoToastMock = vi.fn();
vi.mock("../lib/undo", () => ({
  showUndoToast: (...args: unknown[]) => showUndoToastMock(...args),
}));

const emitProgressMock = vi.fn();
const announceSavedMock = vi.fn();
vi.mock("../components/export/exportSave", () => ({
  announceSaved: (...args: unknown[]) => announceSavedMock(...args),
}));

vi.mock("../lib/progressToast", () => ({
  emitProgress: (...args: unknown[]) => emitProgressMock(...args),
}));

vi.mock("../stores/notes", () => {
  let tagColorsState: any = {};
  return {
    isNoteContentLocked: (id: string) => notesContentLockedIds.has(id),
    useNotesStore: {
      getState: () => ({
        activeNote: notesActiveNoteId ? { note: { id: notesActiveNoteId } } : null,
        loadTree: loadTreeMock,
        selectNote: selectNoteMock,
        discardDraft: discardDraftMock,
        reloadActive: reloadActiveMock,
        patchNoteSummary: patchNoteSummaryMock,
        removeNoteSummary: removeNoteSummaryMock,
        patchFolder: patchFolderMock,
        tagColors: tagColorsState,
      }),
      setState: (patch: Record<string, unknown> | ((s: any) => any)) => {
        if (typeof patch === "function") {
          const res = patch({ tagColors: tagColorsState });
          if (res && res.tagColors !== undefined) tagColorsState = res.tagColors;
        } else if (patch && patch.tagColors !== undefined) {
          tagColorsState = patch.tagColors;
        }
        if (typeof patch === "object" && patch && "activeNote" in patch) {
          notesActiveNoteId = (patch.activeNote as { note?: { id?: string } } | null)?.note?.id ?? null;
        }
      },
    },
  };
});

vi.mock("../stores/settings", () => ({
  useSettingsStore: { getState: () => ({ sourceOriginalPolicy }) },
}));

vi.mock("../stores/tabs", () => ({
  HOME_TAB_ID: "home",
  isHomeTab: (id: string | null | undefined) => id === "home",
  isNoteTabId: (id: string | null | undefined): id is string =>
    typeof id === "string" && id.length > 0 && id !== "home",
  useTabsStore: {
    getState: () => ({
      activeTabId: settingsActiveTabId,
      closeTab: closeTabMock,
    }),
  },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => saveMock(...args),
  open: (...args: unknown[]) => dialogOpenMock(...args),
}));

import {
  exportNote,
  exportFolder,
  renameNote,
  moveNote,
  toggleFavorite,
  deleteNote,
  setTagColor,
  renameTag,
  mergeTags,
  deleteTag,
  importFilesAsSections,
  undoImportedSections,
  attachFile,
} from "./noteActions";
import { t } from "../i18n/t";
import { useNotesStore } from "../stores/notes";

describe("lib/noteActions", () => {
  beforeEach(() => {
    order = [];
    callMock.mockReset();
    callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      order.push(`call:${cmd}`);
      // renameNote/moveNote/toggleFavorite patch the tree with whatever these two commands
      // return — tests that don't care about the exact patch payload still need a defined shape
      // so the destructuring in noteActions.ts doesn't throw.
      if (cmd === "note_update") return { id: args?.id, ...args };
      if (cmd === "note_toggle_favorite") return { is_favorite: true };
      return undefined;
    });
    callSilentMock.mockClear();
    reportFallbackMock.mockClear();
    mdSerializeHtmlMock.mockReset();
    mdSerializeHtmlMock.mockImplementation((html: string) => `md:${html}`);
    flushAllMock.mockClear();
    loadTreeMock.mockClear();
    selectNoteMock.mockClear();
    discardDraftMock.mockClear();
    closeTabMock.mockClear();
    reloadActiveMock.mockClear();
    patchNoteSummaryMock.mockClear();
    removeNoteSummaryMock.mockClear();
    patchFolderMock.mockClear();
    emitNoticeMock.mockClear();
    showUndoToastMock.mockClear();
    emitProgressMock.mockClear();
    saveMock.mockReset();
    dialogOpenMock.mockReset();
    notesActiveNoteId = null;
    settingsActiveTabId = null;
    notesContentLockedIds = new Set();
    sourceOriginalPolicy = "discard";
    useNotesStore.setState({ tagColors: { oldTag: 100 } });
  });

  describe("setTagColor", () => {
    it("issues tag_set_color, then tag_colors, and lands the result in the notes store's tagColors", async () => {
      callMock.mockImplementation(async (cmd: string) => {
        order.push(`call:${cmd}`);
        if (cmd === "tag_colors") {
          return { colors: { testTag: 240 } };
        }
        return undefined;
      });

      await setTagColor("testTag", 240);

      expect(callMock).toHaveBeenCalledWith("tag_set_color", { name: "testTag", color_hue: 240 });
      expect(callMock).toHaveBeenCalledWith("tag_colors");
      expect(useNotesStore.getState().tagColors).toEqual({ testTag: 240 });
    });

    it("a failing tag_set_color does not throw out of setTagColor and leaves tagColors untouched", async () => {
      callMock.mockImplementationOnce(async () => {
        throw new Error("tag_set_color failed");
      });

      await expect(setTagColor("testTag", 240)).resolves.toBeUndefined();

      expect(useNotesStore.getState().tagColors).toEqual({ oldTag: 100 });
    });
  });

  describe("tag CRUD (W23-e)", () => {
    it("renameTag calls tag_rename then loadTree", async () => {
      await renameTag("old", "new");
      expect(callMock).toHaveBeenCalledWith("tag_rename", { from: "old", to: "new" });
      expect(loadTreeMock).toHaveBeenCalled();
    });

    it("mergeTags calls tag_merge then loadTree", async () => {
      await mergeTags(["a", "b"], "c");
      expect(callMock).toHaveBeenCalledWith("tag_merge", { from: ["a", "b"], to: "c" });
      expect(loadTreeMock).toHaveBeenCalled();
    });

    it("deleteTag calls tag_delete then loadTree", async () => {
      await deleteTag("gone");
      expect(callMock).toHaveBeenCalledWith("tag_delete", { name: "gone" });
      expect(loadTreeMock).toHaveBeenCalled();
    });
  });

  describe("exportNote", () => {
    it("calls export_note with exactly {id, dest_path} (Markdown only — no format) from the chosen .md file, then patches exported_at (no full tree reload)", async () => {
      saveMock.mockResolvedValue("C:/exports/My Note.md");
      callMock.mockImplementationOnce(async () => ({ written_path: "C:/exports/My Note.md", exported_at: "2026-10-10T00:00:00Z" }));

      await exportNote("n1", "My Note");

      expect(saveMock).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultPath: "My Note.md",
          filters: [{ name: "Markdown", extensions: ["md"] }],
        }),
      );
      // dest_path 는 고른 파일 경로 그대로 — 폴더로 취급하지 않는다(W6). format 인자는 없어졌다.
      const args = callMock.mock.calls.find((c) => c[0] === "export_note")![1];
      expect(args).toEqual({ id: "n1", dest_path: "C:/exports/My Note.md" });
      expect(patchNoteSummaryMock).toHaveBeenCalledWith("n1", { exported_at: "2026-10-10T00:00:00Z" });
      // L-2/U-5: 트리를 통째로 다시 읽지도, 활성 노트를 다시 select 하지도 않는다. 완료는 열기 버튼이 달린 토스트.
      expect(loadTreeMock).not.toHaveBeenCalled();
      expect(selectNoteMock).not.toHaveBeenCalled();
      expect(announceSavedMock).toHaveBeenCalledWith("C:/exports/My Note.md");
    });

    it("does nothing (no export_note call, no loadTree) when the save dialog is cancelled", async () => {
      saveMock.mockResolvedValue(null);

      await expect(exportNote("n1", "My Note")).resolves.toBe(false);

      expect(callMock).not.toHaveBeenCalled();
      expect(loadTreeMock).not.toHaveBeenCalled();
    });

    it("resolves true once the file is written (the export modal closes on it), false when export_note itself fails", async () => {
      saveMock.mockResolvedValue("C:/exports/My Note.md");
      await expect(exportNote("n1", "My Note")).resolves.toBe(true);

      callMock.mockRejectedValueOnce(new Error("disk full"));
      await expect(exportNote("n1", "My Note")).resolves.toBe(false);
    });

    it("silently swallows a save-dialog failure (e.g. plugin unavailable outside Tauri)", async () => {
      saveMock.mockRejectedValue(new Error("dialog unavailable"));

      await expect(exportNote("n1", "My Note")).resolves.toBe(false);
      expect(callMock).not.toHaveBeenCalled();
    });
  });

  describe("exportFolder", () => {
    it("calls export_folder with exactly {id, dest_path} — Markdown only, no format (folder HTML removed in W6)", async () => {
      dialogOpenMock.mockResolvedValue("C:/exports");
      callMock.mockImplementation(async (cmd: string) => {
        order.push(`call:${cmd}`);
        return cmd === "export_folder" ? { exported_count: 2, skipped_count: 0, written_dir: "C:/exports/Archive" } : undefined;
      });

      await exportFolder("f1");

      expect(dialogOpenMock).toHaveBeenCalledWith(expect.objectContaining({ directory: true }));
      const args = callMock.mock.calls.find((c) => c[0] === "export_folder")![1];
      expect(args).toEqual({ id: "f1", dest_path: "C:/exports" });
      expect(emitNoticeMock).toHaveBeenCalledWith(t("ctx.export_folder_done", { n: 2, dir: "C:/exports/Archive" }));
    });

    it("reports skipped notes, and does not add a second toast when the command fails (call() already toasted)", async () => {
      dialogOpenMock.mockResolvedValue("C:/exports");
      callMock.mockImplementationOnce(async () => ({ exported_count: 2, skipped_count: 1, written_dir: "C:/exports/Archive" }));
      await exportFolder("f1");
      expect(emitNoticeMock).toHaveBeenCalledWith(
        t("ctx.export_folder_done_skipped", { n: 2, skipped: 1, dir: "C:/exports/Archive" }),
      );

      emitNoticeMock.mockClear();
      callMock.mockRejectedValueOnce(new Error("disk full"));
      await exportFolder("f1");
      expect(emitNoticeMock).not.toHaveBeenCalled();
    });

    it("does nothing when the folder dialog is cancelled", async () => {
      dialogOpenMock.mockResolvedValue(null);
      await exportFolder("f1");
      expect(callMock).not.toHaveBeenCalled();
    });
  });

  describe("renameNote", () => {
    it("calls note_update with {id, title}, then patches the tree with the returned row (not a full loadTree reload)", async () => {
      callMock.mockImplementation(async (cmd: string) => {
        order.push(`call:${cmd}`);
        if (cmd === "note_update") return { id: "n1", title: "New Title" };
        return undefined;
      });

      await renameNote("n1", "New Title");

      expect(callMock).toHaveBeenCalledWith("note_update", { id: "n1", title: "New Title" });
      expect(patchNoteSummaryMock).toHaveBeenCalledWith("n1", { id: "n1", title: "New Title" });
      expect(loadTreeMock).not.toHaveBeenCalled();
    });

    it("resyncs the active note via selectNote when the renamed note is the active one", async () => {
      notesActiveNoteId = "n1";

      await renameNote("n1", "New Title");

      expect(selectNoteMock).toHaveBeenCalledWith("n1");
    });

    it("does not resync via selectNote when the renamed note is not the active one", async () => {
      notesActiveNoteId = "other";

      await renameNote("n1", "New Title");

      expect(selectNoteMock).not.toHaveBeenCalled();
    });
  });

  describe("moveNote", () => {
    it("잠긴 노트는 옮기지 않고 잠금 안내를 띄운다", async () => {
      notesContentLockedIds.add("n1");

      await moveNote("n1", "f2");

      expect(callMock).not.toHaveBeenCalled();
      expect(patchNoteSummaryMock).not.toHaveBeenCalled();
      expect(emitNoticeMock).toHaveBeenCalledWith("Content is locked — editing disabled");
    });

    it("잠기지 않은 노트는 note_update({id, folder_id})로 옮긴다", async () => {
      await moveNote("n1", "f2");

      expect(callMock).toHaveBeenCalledWith("note_update", { id: "n1", folder_id: "f2" });
      expect(patchNoteSummaryMock).toHaveBeenCalledWith("n1", { id: "n1", folder_id: "f2" });
    });
  });

  describe("toggleFavorite", () => {
    it("calls note_toggle_favorite with {id}, then patches the tree with the returned favorite state (not a full loadTree reload)", async () => {
      callMock.mockImplementation(async (cmd: string) => {
        order.push(`call:${cmd}`);
        if (cmd === "note_toggle_favorite") return { is_favorite: true };
        return undefined;
      });

      await toggleFavorite("n1");

      expect(callMock).toHaveBeenCalledWith("note_toggle_favorite", { id: "n1" });
      expect(patchNoteSummaryMock).toHaveBeenCalledWith("n1", { is_favorite: true });
      expect(loadTreeMock).not.toHaveBeenCalled();
    });

    it("resyncs the active note via selectNote when the toggled note is the active one", async () => {
      notesActiveNoteId = "n1";

      await toggleFavorite("n1");

      expect(selectNoteMock).toHaveBeenCalledWith("n1");
    });

    it("does not resync via selectNote when the toggled note is not the active one", async () => {
      notesActiveNoteId = "other";

      await toggleFavorite("n1");

      expect(selectNoteMock).not.toHaveBeenCalled();
    });
  });

  describe("deleteNote", () => {
    it("flushes pending saves BEFORE note_delete (ordering pinned to avoid the false 'save failed' toast regression)", async () => {
      await deleteNote("n1");

      const flushIdx = order.indexOf("flushAll");
      const deleteIdx = order.indexOf("call:note_delete");
      expect(flushIdx).toBeGreaterThanOrEqual(0);
      expect(deleteIdx).toBeGreaterThanOrEqual(0);
      expect(flushIdx).toBeLessThan(deleteIdx);
    });

    it("runs the full sequence: flushAll -> note_delete -> closeTab -> removeNoteSummary (not a full loadTree reload)", async () => {
      await deleteNote("n1");

      expect(order.slice(0, 4)).toEqual([
        "flushAll",
        "call:note_delete",
        "closeTab:n1",
        "removeNoteSummary:n1",
      ]);
      expect(callMock).toHaveBeenCalledWith("note_delete", { id: "n1" });
      expect(loadTreeMock).not.toHaveBeenCalled();
    });

    it("selects the next tab when one remains open after the deleted note", async () => {
      settingsActiveTabId = "n2";

      await deleteNote("n1");

      expect(selectNoteMock).toHaveBeenCalledWith("n2");
    });

    it("does not call selectNote when no note tab remains (home sentinel active)", async () => {
      // Wave 2: closeTab of the last note tab activates HOME_TAB_ID, not null.
      settingsActiveTabId = "home";

      await deleteNote("n1");

      expect(selectNoteMock).not.toHaveBeenCalled();
      expect(discardDraftMock).toHaveBeenCalled();
    });

    it("does not call selectNote when the remaining active tab id is still the deleted note's id", async () => {
      // Defensive branch mirrored from the original: next === id should not happen in practice
      // (closeTab should have already switched it), but the guard is part of the exact sequence.
      settingsActiveTabId = "n1";

      await deleteNote("n1");

      expect(selectNoteMock).not.toHaveBeenCalled();
    });

    it("propagates a note_delete failure so each call site's own error handling can react", async () => {
      callMock.mockImplementationOnce(async (cmd: string) => {
        order.push(`call:${cmd}`);
        throw new Error("boom");
      });

      await expect(deleteNote("n1")).rejects.toThrow("boom");
      // closeTab/removeNoteSummary must not run after a failed delete.
      expect(closeTabMock).not.toHaveBeenCalled();
      expect(removeNoteSummaryMock).not.toHaveBeenCalled();
    });
  });

  // useAttachmentActions.ts::addOneFile과 TitleBar.tsx "가져오기" 메뉴의 첨부 갈래가 공유하는
  // 판정+라우팅 — extractable 확장자 판정 자체와 keep-original 콜백 호출 여부만 이 레벨에서 검증
  // 한다(잠금 체크는 이 함수의 책임이 아니다 — 호출자마다 자기 자리에서 확인).
  describe("attachFile", () => {
    it("non-extractable 확장자는 attachment_add_file만 부르고 askKeepOriginal은 부르지 않는다", async () => {
      const askKeepOriginal = vi.fn(async () => true);

      await attachFile("n1", "C:/tmp/photo.png", askKeepOriginal);

      expect(callMock).toHaveBeenCalledWith("attachment_add_file", { note_id: "n1", file_path: "C:/tmp/photo.png" });
      expect(callMock).not.toHaveBeenCalledWith("source_add_file", expect.anything());
      expect(askKeepOriginal).not.toHaveBeenCalled();
    });

    it("EXTRACTABLE_EXTS(pdf/docx/txt/md/pptx)는 source_add_file로 라우팅한다", async () => {
      const askKeepOriginal = vi.fn(async () => true);
      sourceOriginalPolicy = "keep";

      await attachFile("n1", "C:/tmp/report.pdf", askKeepOriginal);

      expect(callMock).toHaveBeenCalledWith("source_add_file", {
        note_id: "n1",
        file_path: "C:/tmp/report.pdf",
        original_policy: "keep",
      });
      expect(callMock).not.toHaveBeenCalledWith("attachment_add_file", expect.anything());
    });

    it('sourceOriginalPolicy가 "keep"/"discard"로 확정돼 있으면 askKeepOriginal을 부르지 않는다', async () => {
      const askKeepOriginal = vi.fn(async () => true);
      sourceOriginalPolicy = "discard";

      await attachFile("n1", "notes.docx", askKeepOriginal);

      expect(askKeepOriginal).not.toHaveBeenCalled();
      expect(callMock).toHaveBeenCalledWith("source_add_file", {
        note_id: "n1",
        file_path: "notes.docx",
        original_policy: "discard",
      });
    });

    it('sourceOriginalPolicy가 "ask"면 askKeepOriginal을 부르고 그 응답으로 original_policy를 정한다(true→keep)', async () => {
      const askKeepOriginal = vi.fn(async () => true);
      sourceOriginalPolicy = "ask";

      await attachFile("n1", "notes.md", askKeepOriginal);

      expect(askKeepOriginal).toHaveBeenCalledTimes(1);
      expect(callMock).toHaveBeenCalledWith("source_add_file", {
        note_id: "n1",
        file_path: "notes.md",
        original_policy: "keep",
      });
    });

    it('sourceOriginalPolicy가 "ask"고 askKeepOriginal이 false를 주면 original_policy는 discard다', async () => {
      const askKeepOriginal = vi.fn(async () => false);
      sourceOriginalPolicy = "ask";

      await attachFile("n1", "notes.txt", askKeepOriginal);

      expect(callMock).toHaveBeenCalledWith("source_add_file", {
        note_id: "n1",
        file_path: "notes.txt",
        original_policy: "discard",
      });
    });
  });

  describe("importFilesAsSections", () => {
    it("keeps going after one file fails, returns the sections that did succeed", async () => {
      callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
        order.push(`call:${cmd}`);
        if (cmd === "section_import_scan") return { files: args?.paths, skipped: 0 };
        if (cmd === "section_import_file") {
          if ((args?.file_path as string).includes("bad")) throw new Error("boom");
          return { sections: [{ id: `sec-${args?.file_path}`, name: String(args?.file_path) }], truncated: false };
        }
        return undefined;
      });

      const sections = await importFilesAsSections("n1", ["a.md", "bad.md", "b.txt"]);

      expect(sections.map((s) => s.id)).toEqual(["sec-a.md", "sec-b.txt"]);
      // At least one section was created, so the summary rides an undo toast (not a plain notice).
      expect(showUndoToastMock).toHaveBeenCalledWith(
        t("editor.section_import_partial", { ok: 2, failed: 1 }),
        expect.any(Function),
      );
      expect(emitNoticeMock).not.toHaveBeenCalledWith(t("editor.section_import_partial", { ok: 2, failed: 1 }));
    });

    it("falls back to a plain notice (nothing to undo) when every file failed", async () => {
      callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "section_import_scan") return { files: args?.paths, skipped: 0 };
        if (cmd === "section_import_file") throw new Error("boom");
        return undefined;
      });

      const sections = await importFilesAsSections("n1", ["bad.md"]);

      expect(sections).toEqual([]);
      expect(showUndoToastMock).not.toHaveBeenCalled();
      expect(emitNoticeMock).toHaveBeenCalledWith(t("editor.section_import_partial", { ok: 0, failed: 1 }));
    });

    it("notices once when any imported file was truncated (CSV/TSV over the sheet limit)", async () => {
      callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "section_import_scan") return { files: args?.paths, skipped: 0 };
        if (cmd === "section_import_file") {
          const truncated = (args?.file_path as string).endsWith(".csv");
          return { sections: [{ id: `sec-${args?.file_path}`, name: String(args?.file_path) }], truncated };
        }
        return undefined;
      });

      await importFilesAsSections("n1", ["big.csv", "note.md"]);

      expect(emitNoticeMock).toHaveBeenCalledWith(t("editor.section_import_truncated"));
    });

    it("calls section_import_scan first and notices the skip count (unsupported extensions, over-cap, folders)", async () => {
      callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
        order.push(`call:${cmd}`);
        if (cmd === "section_import_scan") return { files: ["ok.md"], skipped: 1 };
        if (cmd === "section_import_file") {
          return { sections: [{ id: `sec-${args?.file_path}`, name: String(args?.file_path) }], truncated: false };
        }
        return undefined;
      });

      const sections = await importFilesAsSections("n1", ["ok.md", "archive.zip"]);

      expect(sections.map((s) => s.id)).toEqual(["sec-ok.md"]);
      expect(callMock).not.toHaveBeenCalledWith("section_import_file", expect.objectContaining({ file_path: "archive.zip" }));
      expect(emitNoticeMock).toHaveBeenCalledWith(t("editor.section_import_skipped", { n: 1 }));
    });

    it("scans a dropped folder first and imports only the expanded files it returns (not the raw folder path)", async () => {
      callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
        order.push(`call:${cmd}`);
        if (cmd === "section_import_scan") {
          return { files: ["/notes/folder/a.md", "/notes/folder/b.csv"], skipped: 0 };
        }
        if (cmd === "section_import_file") {
          return { sections: [{ id: `sec-${args?.file_path}`, name: String(args?.file_path) }], truncated: false };
        }
        return undefined;
      });

      const sections = await importFilesAsSections("n1", ["/notes/folder"]);

      // scan runs before any section_import_file, and the raw folder path never reaches it.
      const scanIdx = order.indexOf("call:section_import_scan");
      const firstFileIdx = order.indexOf("call:section_import_file");
      expect(scanIdx).toBeGreaterThanOrEqual(0);
      expect(firstFileIdx).toBeGreaterThan(scanIdx);
      expect(callMock).not.toHaveBeenCalledWith("section_import_file", expect.objectContaining({ file_path: "/notes/folder" }));
      expect(sections.map((s) => s.id)).toEqual(["sec-/notes/folder/a.md", "sec-/notes/folder/b.csv"]);
    });

    it("concatenates a multi-section output (e.g. xlsx workbook → one section per worksheet) in order", async () => {
      callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "section_import_scan") return { files: args?.paths, skipped: 0 };
        if (cmd === "section_import_file") {
          if (args?.file_path === "book.xlsx") {
            return { sections: [{ id: "sheet-1", name: "Sheet1" }, { id: "sheet-2", name: "Sheet2" }], truncated: false };
          }
          return { sections: [{ id: "sec-note.md", name: "note" }], truncated: false };
        }
        return undefined;
      });

      const sections = await importFilesAsSections("n1", ["book.xlsx", "note.md"]);

      expect(sections.map((s) => s.id)).toEqual(["sheet-1", "sheet-2", "sec-note.md"]);
    });

    it("reloads the active note only when it's the note the files were imported into", async () => {
      notesActiveNoteId = "n1";
      callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "section_import_scan") return { files: args?.paths, skipped: 0 };
        if (cmd === "section_import_file") {
          return { sections: [{ id: `sec-${args?.file_path}`, name: String(args?.file_path) }], truncated: false };
        }
        return undefined;
      });

      await importFilesAsSections("n1", ["a.md"]);
      expect(reloadActiveMock).toHaveBeenCalledTimes(1);

      reloadActiveMock.mockClear();
      await importFilesAsSections("other-note", ["a.md"]);
      expect(reloadActiveMock).not.toHaveBeenCalled();
    });

    it("does not emit a progress toast for fewer than 3 files", async () => {
      callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "section_import_scan") return { files: args?.paths, skipped: 0 };
        if (cmd === "section_import_file") {
          return { sections: [{ id: `sec-${args?.file_path}`, name: String(args?.file_path) }], truncated: false };
        }
        return undefined;
      });

      await importFilesAsSections("n1", ["a.md", "b.md"]);

      expect(emitProgressMock).not.toHaveBeenCalled();
    });

    it("emits a progress toast under the same key per file for 3+ files, and clears it (null) when done", async () => {
      callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "section_import_scan") return { files: args?.paths, skipped: 0 };
        if (cmd === "section_import_file") {
          return { sections: [{ id: `sec-${args?.file_path}`, name: String(args?.file_path) }], truncated: false };
        }
        return undefined;
      });

      await importFilesAsSections("n1", ["a.md", "b.md", "c.md"]);

      const keys = new Set(emitProgressMock.mock.calls.map((args) => args[0]));
      expect(keys.size).toBe(1); // every call updates the same key, never a different one
      // 0/3 이 **먼저** 나가야 한다 — runBatch 의 onProgress 는 한 건이 끝난 뒤에야 처음 불리므로,
      // 첫 파일이 느리면(큰 pdf) 그동안 다시 무반응이 된다. 그 구간을 없애는 것이 이 토스트의 목적이다.
      expect(emitProgressMock).toHaveBeenNthCalledWith(1, expect.any(String), t("editor.section_import_progress", { done: 0, total: 3 }));
      expect(emitProgressMock).toHaveBeenNthCalledWith(2, expect.any(String), t("editor.section_import_progress", { done: 1, total: 3 }));
      expect(emitProgressMock).toHaveBeenLastCalledWith(expect.any(String), null); // cleared in the finally
    });

    it("clears the progress toast even when a file throws mid-batch", async () => {
      callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "section_import_scan") return { files: args?.paths, skipped: 0 };
        if (cmd === "section_import_file") {
          if ((args?.file_path as string).includes("bad")) throw new Error("boom");
          return { sections: [{ id: `sec-${args?.file_path}`, name: String(args?.file_path) }], truncated: false };
        }
        return undefined;
      });

      await importFilesAsSections("n1", ["a.md", "bad.md", "c.md"]);

      expect(emitProgressMock).toHaveBeenLastCalledWith(expect.any(String), null);
    });

    it("wires the undo toast's onUndo to undoImportedSections with exactly the created ids", async () => {
      callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "section_import_scan") return { files: args?.paths, skipped: 0 };
        if (cmd === "section_import_file") {
          return { sections: [{ id: `sec-${args?.file_path}`, name: String(args?.file_path) }], truncated: false };
        }
        return undefined;
      });

      await importFilesAsSections("n1", ["a.md", "bad.md"]);

      expect(showUndoToastMock).toHaveBeenCalledTimes(1);
      const onUndo = showUndoToastMock.mock.calls[0][1] as () => void;
      callMock.mockClear();

      onUndo();
      await vi.waitFor(() => {
        expect(callMock).toHaveBeenCalledWith("section_delete", { id: "sec-a.md" });
        expect(callMock).toHaveBeenCalledWith("section_delete", { id: "sec-bad.md" });
      });
      expect(callMock).toHaveBeenCalledTimes(2); // only the two sections this import created
    });
  });

  // PLAN-2026-10-07-doc-import-export W1-F(hwpx) · W4-F(docx) — hwpx·docx 는 doc_import_html → mdSerializeHtml → section_create_with_body
  // (서식형), 못 만들면 section_import_file(텍스트 추출)로 후퇴한다. 호출부(TitleBar·에디터 드롭·첨부 승격)는
  // 전부 importFilesAsSections 를 지나가므로 여기서 한 번 지키면 셋이 같다.
  describe("importFilesAsSections — hwpx 서식형 경로", () => {
    const richOut = (over: Record<string, unknown> = {}) => ({
      name: "report",
      html: "<p>본문</p>",
      image_count: 0,
      dropped: [],
      ...over,
    });
    /** 스캔은 그대로 통과, hwpx 마다 doc_import_html 결과를 돌려주고, section_* 는 이름/경로로 id 를 만든다. */
    const setup = (opts: { rich?: (path: string) => unknown } = {}) => {
      callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
        order.push(`call:${cmd}`);
        if (cmd === "section_import_scan") return { files: args?.paths, skipped: 0 };
        if (cmd === "doc_import_html") return (opts.rich ?? (() => richOut()))(String(args?.file_path));
        if (cmd === "section_create_with_body") {
          return { id: `rich-${args?.name}`, name: args?.name, body_md: args?.body_md };
        }
        if (cmd === "section_import_file") {
          return { sections: [{ id: `text-${args?.file_path}`, name: String(args?.file_path) }], truncated: false };
        }
        return undefined;
      });
    };
    const cmds = () => callMock.mock.calls.map((c) => c[0]);

    it("hwpx: scan → doc_import_html(callSilent) → section_create_with_body(name·body_md) 순서, section_import_file 은 안 부른다", async () => {
      setup({ rich: () => richOut({ name: "회의록", html: "<p>안녕</p>" }) });

      const sections = await importFilesAsSections("n1", ["C:/docs/회의록.hwpx"]);

      expect(cmds()).toEqual(["section_import_scan", "doc_import_html", "section_create_with_body"]);
      expect(callMock).toHaveBeenCalledWith("doc_import_html", { note_id: "n1", file_path: "C:/docs/회의록.hwpx" });
      expect(mdSerializeHtmlMock).toHaveBeenCalledWith("<p>안녕</p>");
      expect(callMock).toHaveBeenCalledWith("section_create_with_body", {
        note_id: "n1",
        name: "회의록",
        body_md: "md:<p>안녕</p>",
      });
      // 시도는 토스트 없는 경로(callSilent)로만 — 섹션 생성은 사용자 행동이므로 call().
      expect(callSilentMock.mock.calls.map((c) => c[0])).toEqual(["doc_import_html"]);
      expect(sections.map((s) => s.id)).toEqual(["rich-회의록"]);
      expect(reportFallbackMock).not.toHaveBeenCalled();
      expect(showUndoToastMock).toHaveBeenCalledWith(t("editor.section_import_done", { n: 1 }), expect.any(Function));
    });

    it("확장자는 대소문자를 가리지 않는다 (REPORT.HWPX)", async () => {
      setup();
      await importFilesAsSections("n1", ["C:/docs/REPORT.HWPX"]);
      expect(cmds()).toContain("doc_import_html");
      expect(cmds()).not.toContain("section_import_file");
    });

    it("docx 도 서식형 경로를 탄다 — doc_import_html 이 먼저, section_import_file 은 안 부른다", async () => {
      setup({ rich: () => richOut({ name: "제안서", html: "<p>Word</p>" }) });
      const sections = await importFilesAsSections("n1", ["C:/docs/제안서.DOCX"]);
      expect(cmds()).toEqual(["section_import_scan", "doc_import_html", "section_create_with_body"]);
      expect(callMock).toHaveBeenCalledWith("doc_import_html", { note_id: "n1", file_path: "C:/docs/제안서.DOCX" });
      expect(sections.map((s) => s.id)).toEqual(["rich-제안서"]);
    });

    it("서식형 대상이 아니면(md·pptx·xlsx) section_import_file 그대로 — doc_import_html 도 callSilent 도 안 건드린다", async () => {
      setup();
      await importFilesAsSections("n1", ["a.md", "b.pptx", "c.xlsx"]);
      expect(cmds()).toEqual(["section_import_scan", "section_import_file", "section_import_file", "section_import_file"]);
      expect(callSilentMock).not.toHaveBeenCalled();
      expect(mdSerializeHtmlMock).not.toHaveBeenCalled();
      expect(reportFallbackMock).not.toHaveBeenCalled();
    });

    it("doc_import_html 이 거절하면 reportFallback(에러 코드만) 뒤 같은 경로로 section_import_file 후퇴", async () => {
      setup({
        rich: () => {
          // 메시지에 경로가 들어 있어도 진단 기록에는 코드만 가야 한다.
          throw { code: "VALIDATION", message: "C:/secret/암호.hwpx: 암호화된 문서" };
        },
      });

      const sections = await importFilesAsSections("n1", ["C:/secret/암호.hwpx"]);

      expect(reportFallbackMock).toHaveBeenCalledTimes(1);
      expect(reportFallbackMock).toHaveBeenCalledWith("doc-import", "hwpx_rich_failed", "ext=hwpx code=VALIDATION");
      expect(callMock).toHaveBeenCalledWith("section_import_file", { note_id: "n1", file_path: "C:/secret/암호.hwpx" });
      expect(cmds()).not.toContain("section_create_with_body");
      expect(sections.map((s) => s.id)).toEqual(["text-C:/secret/암호.hwpx"]);
      // 후퇴해서 성공했으므로 실패로 세지 않는다.
      expect(showUndoToastMock).toHaveBeenCalledWith(t("editor.section_import_done", { n: 1 }), expect.any(Function));
    });

    it("AppError 모양이 아닌 거절(맨 문자열)도 'unknown' 코드로 남기고 후퇴한다", async () => {
      setup({
        rich: () => {
          throw "invalid args `file_path` for command doc_import_html";
        },
      });
      await importFilesAsSections("n1", ["a.hwpx"]);
      expect(reportFallbackMock).toHaveBeenCalledWith("doc-import", "hwpx_rich_failed", "ext=hwpx code=unknown");
      expect(cmds()).toContain("section_import_file");
    });

    it("직렬화가 던지면 <ext>_rich_serialize_failed(확장자·에러 이름만) 뒤 후퇴한다", async () => {
      setup();
      mdSerializeHtmlMock.mockImplementation(() => {
        throw new TypeError("Unexpected <p>본문 조각이 들어 있는 메시지");
      });

      await importFilesAsSections("n1", ["a.hwpx"]);

      expect(reportFallbackMock).toHaveBeenCalledWith("doc-import", "hwpx_rich_serialize_failed", "ext=hwpx error=TypeError");
      expect(cmds()).not.toContain("section_create_with_body");
      expect(cmds()).toContain("section_import_file");
    });

    it("직렬화 결과가 비면 빈 섹션을 만들지 않고 <ext>_rich_empty 뒤 후퇴한다", async () => {
      setup();
      mdSerializeHtmlMock.mockImplementation(() => "  \n");

      await importFilesAsSections("n1", ["a.hwpx"]);

      expect(reportFallbackMock).toHaveBeenCalledWith("doc-import", "hwpx_rich_empty", expect.stringContaining("ext=hwpx"));
      expect(cmds()).not.toContain("section_create_with_body");
      expect(cmds()).toContain("section_import_file");
    });

    it("section_create_with_body 가 실패하면 후퇴하지 않는다 — 그 파일은 실패로 세고 다음 파일은 계속한다", async () => {
      callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "section_import_scan") return { files: args?.paths, skipped: 0 };
        if (cmd === "doc_import_html") return richOut({ name: String(args?.file_path) });
        if (cmd === "section_create_with_body") {
          if (String(args?.name).includes("bad")) throw new Error("create failed");
          return { id: `rich-${args?.name}`, name: args?.name };
        }
        return undefined;
      });

      const sections = await importFilesAsSections("n1", ["bad.hwpx", "ok.hwpx"]);

      expect(cmds()).not.toContain("section_import_file");
      expect(reportFallbackMock).not.toHaveBeenCalled();
      expect(sections.map((s) => s.id)).toEqual(["rich-ok.hwpx"]);
      expect(showUndoToastMock).toHaveBeenCalledWith(
        t("editor.section_import_partial", { ok: 1, failed: 1 }),
        expect.any(Function),
      );
    });

    it("dropped 가 없으면 알림을 하나도 더 띄우지 않는다 (0개 항목은 무시)", async () => {
      setup({ rich: () => richOut({ dropped: [{ kind: "equation", count: 0 }] }) });
      await importFilesAsSections("n1", ["a.hwpx"]);
      expect(emitNoticeMock).not.toHaveBeenCalled();
    });

    it("dropped 는 파일들을 합산해 한 줄로 알린다 — 같은 종류는 더하고, 모르는 종류는 '기타' 하나로 모아 맨 뒤에 둔다", async () => {
      const perFile: Record<string, unknown> = {
        "a.hwpx": richOut({
          dropped: [
            { kind: "header_footer", count: 1 },
            { kind: "equation", count: 2 },
          ],
        }),
        "b.hwpx": richOut({
          dropped: [
            { kind: "weird_kind", count: 1 },
            { kind: "equation", count: 1 },
            { kind: "constructor", count: 2 }, // 객체 프로토타입 이름도 안전하게 '기타'
          ],
        }),
      };
      setup({ rich: (path) => perFile[path] });

      await importFilesAsSections("n1", ["a.hwpx", "b.hwpx"]);

      const detail = [
        `${t("editor.doc_import_kind_header_footer")} 1`,
        `${t("editor.doc_import_kind_equation")} 3`,
        `${t("editor.doc_import_kind_other")} 3`,
      ].join(", ");
      expect(emitNoticeMock).toHaveBeenCalledTimes(1);
      expect(emitNoticeMock).toHaveBeenCalledWith(t("editor.doc_import_dropped", { n: 7, detail }));
      // 결과 토스트(되돌리기)보다 먼저 나간다 — truncated 알림과 같은 자리.
      expect(emitNoticeMock.mock.invocationCallOrder[0]).toBeLessThan(showUndoToastMock.mock.invocationCallOrder[0]);
    });

    it("후퇴한 파일의 dropped 는 없다 — 텍스트 추출로 만든 섹션에는 보고할 누락 정보가 없다", async () => {
      setup({
        rich: (path) => {
          if (path === "bad.hwpx") throw { code: "IO", message: "x" };
          return richOut({ dropped: [{ kind: "shape", count: 2 }] });
        },
      });

      await importFilesAsSections("n1", ["a.hwpx", "bad.hwpx"]);

      expect(emitNoticeMock).toHaveBeenCalledTimes(2);
      expect(emitNoticeMock).toHaveBeenCalledWith(
        t("editor.doc_import_dropped", { n: 2, detail: `${t("editor.doc_import_kind_shape")} 2` }),
      );
      // U-1: 글자만 가져온 파일이 있으면 배치 끝에 한 번 알린다
      expect(emitNoticeMock).toHaveBeenCalledWith(t("export.import_fallback_text", { n: 1 }));
    });

    it("md 와 hwpx 가 섞인 배치 — 파일마다 갈래를 따로 고르고 섹션은 입력 순서로 이어붙는다", async () => {
      setup({ rich: () => richOut({ name: "한글" }) });

      const sections = await importFilesAsSections("n1", ["a.md", "b.hwpx", "c.csv"]);

      expect(sections.map((s) => s.id)).toEqual(["text-a.md", "rich-한글", "text-c.csv"]);
      expect(cmds()).toEqual([
        "section_import_scan",
        "section_import_file",
        "doc_import_html",
        "section_create_with_body",
        "section_import_file",
      ]);
    });

    it("되돌리기는 서식형으로 만든 섹션 id 를 그대로 section_delete 한다 (첨부 그림은 건드리지 않는다)", async () => {
      setup({ rich: () => richOut({ name: "문서", image_count: 3 }) });

      await importFilesAsSections("n1", ["a.hwpx"]);

      const onUndo = showUndoToastMock.mock.calls[0][1] as () => void;
      callMock.mockClear();
      onUndo();
      await vi.waitFor(() => {
        expect(callMock).toHaveBeenCalledWith("section_delete", { id: "rich-문서" });
      });
      expect(callMock.mock.calls.map((c) => c[0])).toEqual(["section_delete"]);
    });
  });

  describe("undoImportedSections", () => {
    it("section_delete's every given id via runBatch, tolerating one failure, then reports ok/failed", async () => {
      callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "section_delete" && args?.id === "sec-2") throw new Error("CONFLICT");
        return undefined;
      });

      await undoImportedSections("n1", ["sec-1", "sec-2", "sec-3"]);

      expect(callMock).toHaveBeenCalledWith("section_delete", { id: "sec-1" });
      expect(callMock).toHaveBeenCalledWith("section_delete", { id: "sec-2" });
      expect(callMock).toHaveBeenCalledWith("section_delete", { id: "sec-3" });
      expect(emitNoticeMock).toHaveBeenCalledWith(t("editor.section_import_undo_partial", { ok: 2, failed: 1 }));
    });

    it("flushes pending saves before deleting, and reloads the active note when it's the target note", async () => {
      notesActiveNoteId = "n1";

      await undoImportedSections("n1", ["sec-1"]);

      const flushIdx = order.indexOf("flushAll");
      const deleteIdx = order.indexOf("call:section_delete");
      expect(flushIdx).toBeGreaterThanOrEqual(0);
      expect(flushIdx).toBeLessThan(deleteIdx);
      expect(reloadActiveMock).toHaveBeenCalled();
      expect(emitNoticeMock).toHaveBeenCalledWith(t("editor.section_import_undo_done", { n: 1 }));
    });

    it("does not reload when the target note isn't the active one", async () => {
      notesActiveNoteId = "other";

      await undoImportedSections("n1", ["sec-1"]);

      expect(reloadActiveMock).not.toHaveBeenCalled();
    });
  });
});
