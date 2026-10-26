import React, { useState } from "react";
import { useNotesStore } from "../../stores/notes";
import { call, emitNotice } from "../../lib/invoke";
import { scheduleUndoableDelete } from "../../lib/undo";
import { runBatch, type BatchResult } from "../../lib/batchActions";
import { t } from "../../i18n/t";
import type { Attachment, NoteDetail, Source } from "../../lib/commands.gen";
import { EXTRACTABLE_EXTS } from "../../lib/fileKinds";
import { attachFile } from "../../lib/noteActions";

export { EXTRACTABLE_EXTS };

// Wave 8: Sources + Pièces jointes are unified into a single tile grid. A Tile wraps either
// a text Source (searchable body, no rel_path) or a file/link/note Attachment.
// N1-3: the region tile is derived (no DB row of its own — see AttachmentsBar's regionTile),
// so it carries no payload; AttachmentsBar reads the note's region/lat/lng directly for the label.
export type Tile =
  | { kind: "source"; source: Source }
  | { kind: "attachment"; attachment: Attachment }
  | { kind: "region" }
  | { kind: "footnotes" };

type ActionDialog =
  | { kind: "keepOriginal"; resolve: (keep: boolean) => void }
  | { kind: "confirmDelete"; resolve: (confirm: boolean) => void };

/** Attachment CRUD actions: refresh, the file/link/note/internal add paths (including the
 * extraction-policy routing in addOneFile), removeTile's undo-integrated delete, and the
 * busy/pendingRemovedIds state they all share. `setDialog` is only used by askKeepOriginal, to
 * surface the "keep original file?" PromptDialog owned by AttachmentsBar. */
export function useAttachmentActions(activeNote: NoteDetail | null, setDialog: (dialog: ActionDialog) => void) {
  const [busy, setBusy] = useState(false);
  // Tier 1 undo-on-delete (see src/lib/undo.ts): removeTile below adds a tile's id here BEFORE
  // the real source_delete/attachment_remove call — the tile grid filters it out immediately.
  // The id comes back out either on Undo (restored) or once the delayed commit's refresh() drops
  // it from `attachments`/`sources` for real.
  const [pendingRemovedIds, setPendingRemovedIds] = useState<Set<string>>(new Set());

  const refresh = async () => {
    const id = useNotesStore.getState().activeNote?.note.id;
    if (!id) return;
    await useNotesStore.getState().selectNote(id);
    useNotesStore.getState().bumpAttachmentRevision();
  };

  // Resolves once the "keepOriginal" PromptDialog fires onSubmit(keep)/onCancel(discard).
  const askKeepOriginal = (): Promise<boolean> =>
    new Promise<boolean>((resolve) => setDialog({ kind: "keepOriginal", resolve }));

  const askConfirmDelete = (): Promise<boolean> =>
    new Promise<boolean>((resolve) => setDialog({ kind: "confirmDelete", resolve }));

  /** Routes a single added file to source_add_file (extractable pdf/docx/txt/md/pptx — text
   * becomes searchable) or attachment_add_file (everything else — plain copy, unchanged
   * behavior). Shared by both add paths (drag&drop and the "Fichier" menu's addFile()) so the
   * policy handling lives in exactly one place — now the shared lib/noteActions.ts::attachFile,
   * which TitleBar.tsx's "가져오기" 메뉴도 부른다(비-섹션가져오기 확장자 갈래). This wrapper keeps
   * only the content-lock guard, which stays local to each call site by design (see attachFile's
   * doc comment). */
  const addOneFile = async (noteId: string, path: string) => {
    // 내용잠금: addFile(파일피커)과 useAttachmentsDragDrop(드래그&드롭) 둘 다 이 함수 하나로
    // 모인다 — 여기 하나만 막으면 두 입구가 전부 막힌다. noteId는 activeNote와 같은 노트다(둘
    // 다 ensureMaterialized()로 얻은 값이므로 activeNote 쪽을 그대로 봐도 안전).
    if (activeNote?.note.content_locked) {
      emitNotice(t("editor.content_locked_tooltip"));
      return;
    }
    await attachFile(noteId, path, askKeepOriginal);
  };

  const renameSource = async (id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await call<Source>("source_rename", { id, name: trimmed });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  /** Add file via plugin-dialog open() → source_add_file (extractable pdf/docx/txt/md/pptx, so the
   * text becomes searchable) or attachment_add_file (everything else, unchanged copy-only path). */
  const addFile = async () => {
    if (!activeNote) return;
    // addOneFile also guards (shared by drag&drop) — this early return just skips opening the
    // file picker dialog pointlessly when the note is locked.
    if (activeNote.note.content_locked) {
      emitNotice(t("editor.content_locked_tooltip"));
      return;
    }
    setBusy(true);
    try {
      const id = await useNotesStore.getState().ensureMaterialized();
      if (!id) {
        emitNotice(t("attachments.drop_requires_note"));
        return;
      }
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ multiple: true });
      if (!selected) return;

      const paths = Array.isArray(selected) ? selected : [selected];
      for (const path of paths) {
        await addOneFile(id, path);
      }
      await refresh();
    } catch (e) {
      // call() 의 AppError 는 이미 토스트됨 — 파일피커 자체 실패만 여기서 알린다.
      if (!(e && typeof e === "object" && "code" in e)) {
        emitNotice((e as Error)?.message ?? String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const addLink = async (url: string, name: string) => {
    if (!activeNote || !url.trim()) return;
    if (activeNote.note.content_locked) {
      emitNotice(t("editor.content_locked_tooltip"));
      return;
    }
    setBusy(true);
    try {
      const id = await useNotesStore.getState().ensureMaterialized();
      if (!id) {
        emitNotice(t("attachments.drop_requires_note"));
        return;
      }
      await call("attachment_add_link", {
        note_id: id,
        name: name.trim() || url.trim(),
        url: url.trim(),
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  /** "Note" menu choice → source_add_text, so memos land in the DB and are FTS-searchable
   * (unlike the legacy note-kind attachment, which was just a file on disk). */
  const addNote = async (name: string, text: string) => {
    if (!activeNote || !text.trim()) return;
    if (activeNote.note.content_locked) {
      emitNotice(t("editor.content_locked_tooltip"));
      return;
    }
    setBusy(true);
    try {
      const id = await useNotesStore.getState().ensureMaterialized();
      if (!id) {
        emitNotice(t("attachments.drop_requires_note"));
        return;
      }
      await call<Source>("source_add_text", {
        note_id: id,
        name: name.trim() || "SOURCE.txt",
        body: text.trim(),
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const addInternal = async (target_note_id: string, name: string) => {
    if (!activeNote || !target_note_id) return;
    if (activeNote.note.content_locked) {
      emitNotice(t("editor.content_locked_tooltip"));
      return;
    }
    setBusy(true);
    try {
      const id = await useNotesStore.getState().ensureMaterialized();
      if (!id) {
        emitNotice(t("attachments.drop_requires_note"));
        return;
      }
      await call("attachment_add_internal", {
        note_id: id,
        target_note_id,
        name: name.trim() || "Internal Link",
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  /**
   * 클립보드 붙여넣기 기능:
   * 1. 이미지(image/png, image/jpeg 등) -> attachment_add_bytes (이미지 첨부)
   * 2. URL 링크 -> attachment_add_link (링크 첨부)
   * 3. 코드(code) -> source_add_text (코드 파일 소스)
   * 4. 일반 글자(plain text) -> source_add_text (텍스트 소스)
   */
  const addFromClipboard = async () => {
    if (!activeNote) return;
    if (activeNote.note.content_locked) {
      emitNotice(t("editor.content_locked_tooltip"));
      return;
    }
    setBusy(true);
    try {
      const id = await useNotesStore.getState().ensureMaterialized();
      if (!id) {
        emitNotice(t("attachments.drop_requires_note"));
        return;
      }

      // 1. 클립보드 이미지 바이너리 확인 (Web Clipboard API)
      if (typeof navigator !== "undefined" && navigator.clipboard?.read) {
        try {
          const items = await navigator.clipboard.read();
          for (const item of items) {
            const imgType = item.types.find((t) => t.startsWith("image/"));
            if (imgType) {
              const blob = await item.getType(imgType);
              const ext = imgType.split("/")[1] || "png";
              const dataUrl = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result));
                reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
                reader.readAsDataURL(blob);
              });
              const data_base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
              const name = `clipboard_${Date.now()}.${ext}`;
              await call<Attachment>("attachment_add_bytes", {
                note_id: id,
                name,
                data_base64,
              });
              await refresh();
              return;
            }
          }
        } catch {
          // navigator.clipboard.read() 권한 없거나 미지원 시 readText로 폴백
        }
      }

      // 2. 클립보드 텍스트/링크/코드 확인
      if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
        const rawText = await navigator.clipboard.readText();
        const text = rawText.trim();
        if (!text) {
          emitNotice(t("attachments.clipboard_empty"));
          return;
        }

        // 2-A. URL 링크 판정
        const isUrl = /^https?:\/\/[^\s]+$/i.test(text);
        if (isUrl) {
          await call("attachment_add_link", {
            note_id: id,
            name: text,
            url: text,
          });
          await refresh();
          return;
        }

        // 2-B. 코드(Code) 판정
        const codeBlockMatch = text.match(/^```([a-zA-Z0-9_-]*)\n([\s\S]*?)```$/);
        const isLikelyCode =
          !!codeBlockMatch ||
          /(?:^import\s+|^export\s+|^const\s+|^let\s+|^function\s+|^class\s+|^def\s+|^fn\s+|^pub\s+fn\s+|^<[a-zA-Z][^>]*>|[{};]\s*$)/m.test(text);

        if (codeBlockMatch) {
          const lang = codeBlockMatch[1] || "txt";
          const body = codeBlockMatch[2].trim();
          const name = `snippet_${Date.now()}.${lang}`;
          await call<Source>("source_add_text", {
            note_id: id,
            name,
            body,
          });
          await refresh();
          return;
        }

        if (isLikelyCode && text.includes("\n")) {
          // 언어 추론
          let ext = "txt";
          if (/(?:const|let|var|function|=>|console\.log)/.test(text)) ext = "ts";
          else if (/(?:def |import |class |print\()/.test(text)) ext = "py";
          else if (/(?:fn |pub |impl |struct )/.test(text)) ext = "rs";
          else if (/(?:<div|<span|<html|<body)/.test(text)) ext = "html";
          else if (/(?:select |from |where |insert into )/i.test(text)) ext = "sql";
          else if (text.startsWith("{") && text.endsWith("}")) ext = "json";

          const name = `code_${Date.now()}.${ext}`;
          await call<Source>("source_add_text", {
            note_id: id,
            name,
            body: text,
          });
          await refresh();
          return;
        }

        // 2-C. 일반 텍스트
        const firstLine = text.split("\n")[0].slice(0, 24).trim().replace(/[^\w\sㄱ-ㅎ가-힣]/g, "");
        const name = (firstLine || `clipboard_${Date.now()}`) + ".txt";
        await call<Source>("source_add_text", {
          note_id: id,
          name,
          body: text,
        });
        await refresh();
        return;
      }

      emitNotice(t("attachments.clipboard_empty"));
    } catch (e) {
      if (!(e && typeof e === "object" && "code" in e)) {
        emitNotice((e as Error)?.message ?? String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  // Tier 1 undo-on-delete: hide the tile locally right now (pendingRemovedIds) and delay the
  // real source_delete/attachment_remove ~5s — see src/lib/undo.ts. No setBusy() here: unlike
  // the old immediate-delete path, disappearance is instant and there's no network round trip to
  // block the UI on.
  const removeTile = async (e: React.MouseEvent, tile: Tile) => {
    e.stopPropagation();
    // 파생 타일(region/footnotes)은 DB 행이 없어 지울 대상이 아니다.
    if (!activeNote || (tile.kind !== "source" && tile.kind !== "attachment")) return;
    if (activeNote.note.content_locked) {
      emitNotice(t("editor.content_locked_tooltip"));
      return;
    }
    if (tile.kind !== "attachment" || tile.attachment.kind !== "internal") {
      const confirm = await askConfirmDelete();
      if (!confirm) return;
    }
    const id = tile.kind === "source" ? tile.source.id : tile.attachment.id;
    const name = tile.kind === "source" ? tile.source.name : tile.attachment.name;
    setPendingRemovedIds((prev) => new Set(prev).add(id));
    scheduleUndoableDelete({
      commit: async () => {
        try {
          if (tile.kind === "source") {
            await call("source_delete", { id: tile.source.id });
          } else {
            await call("attachment_remove", { id: tile.attachment.id });
          }
          await refresh();
        } finally {
          setPendingRemovedIds((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }
      },
      onRestore: () => {
        setPendingRemovedIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      },
      label: t("undo.deleted_named", { name }),
    });
  };

  /**
   * W7-g 다중선택 일괄 삭제. 확인 다이얼로그는 **호출자가 배치 전체에 대해 한 번만** 받고,
   * 여기서는 순차로 지운 뒤 마지막에 한 번만 refresh 한다.
   *
   * ponytail: 단일 삭제의 5초 undo(scheduleUndoableDelete)를 배치에는 쓰지 않는다 — N개의 undo
   * 토스트가 쌓이고 각자의 커밋 타이머가 엇갈린다. 대신 즉시 커밋하고 결과(성공/실패 개수)만
   * 보고한다. 첨부 삭제는 원래도 "디스크에서 지워지며 복구 불가"라 확인 다이얼로그가 있는
   * 경로이므로 undo 부재가 새로운 위험을 만들지는 않는다. 업그레이드 경로는 배치 하나를 통째로
   * 되돌리는 단일 undo 항목(lib/undo.ts 에 그룹 개념 추가).
   */
  const removeTiles = async (tiles: Tile[]): Promise<BatchResult> => {
    if (activeNote?.note.content_locked) {
      emitNotice(t("editor.content_locked_tooltip"));
      return { ok: [], failed: [] };
    }
    // region/footnotes 타일은 DB 행이 없는 파생 타일이라 지울 대상이 아니다(단일 삭제 경로와 같은 규칙).
    const byId = new Map<string, Tile>();
    for (const tile of tiles) {
      if (tile.kind === "source") byId.set(tile.source.id, tile);
      else if (tile.kind === "attachment") byId.set(tile.attachment.id, tile);
    }
    setBusy(true);
    try {
      const res = await runBatch([...byId.keys()], async (id) => {
        const tile = byId.get(id)!;
        if (tile.kind === "source") await call("source_delete", { id });
        else await call("attachment_remove", { id });
      });
      await refresh();
      return res;
    } finally {
      setBusy(false);
    }
  };

  return {
    busy,
    setBusy,
    pendingRemovedIds,
    setPendingRemovedIds,
    refresh,
    removeTiles,
    askKeepOriginal,
    addOneFile,
    renameSource,
    addFile,
    addLink,
    addNote,
    addInternal,
    addFromClipboard,
    removeTile,
  };
}
