import { useState } from "react";
import type { Folder, NoteSummary } from "../lib/commands.gen";
import { t } from "../i18n/t";
import { emitNotice } from "../lib/invoke";
import { renameNote, moveNote, deleteNote, toggleFavorite, addNoteTags } from "../lib/noteActions";
import { useArchiveStore } from "../stores/archive";
import { useSelectionStore } from "../stores/selection";
import { MobileModal } from "./MobileModal";
import { useBackClosable } from "./useBackClosable";
import { MobileFolderPicker } from "./MobileFolderPicker";
import { MobileTagSheet } from "./MobileTagSheet";
import {
  IconArchive,
  IconCheckMark,
  IconEdit,
  IconFolder,
  IconStar,
  IconTag,
  IconTrash,
} from "../components/icons";

type Dialog = { kind: "rename" } | { kind: "move" } | { kind: "tags" } | { kind: "confirmDelete" };

interface MobileActionSheetProps {
  note: NoteSummary;
  /** Already excludes inbox, same rule as desktop's NoteSelectionBar pickableFolders. */
  pickableFolders: Folder[];
  onClose: () => void;
  /** Called after a mutation actually lands, so the caller can dismiss a stale row/refresh
   *  anything it holds beyond the shared notesByFolder cache the mutations already patch. */
  onMutated?: () => void;
}

/**
 * Bottom-sheet stand-in for desktop's right-click ContextMenu (§3.4 — that menu now rides
 * common/ContextMenuShell, a coordinate-anchored portal that doesn't fit a touch bottom-sheet
 * posture; this is a new, separate surface rather than a reuse of ContextMenu). Same 7 verbs as
 * the desktop menu's note-row subset, every mutation routed through the same gateways desktop uses
 * (lib/noteActions.ts, stores/archive.ts) — loadTree() itself now knows to skip the folder_list
 * roundtrip on mobile (stores/notesTree.ts), so there is no mobile-only copy of these left.
 */
export function MobileActionSheet({ note, pickableFolders, onClose, onMutated }: MobileActionSheetProps) {
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);
  // Held for the sheet's whole lifetime (not just while the list is showing) so the rename/move/
  // tags/confirm dialogs stack ON TOP of this entry: back closes the dialog, then the sheet.
  useBackClosable(true, onClose);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      onMutated?.();
      onClose();
    } catch {
      // call() already toasted; keep the sheet open so the user can retry.
      setBusy(false);
    }
  };

  if (dialog?.kind === "rename") {
    return (
      <MobileRenameDialog
        initial={note.title}
        onCancel={() => setDialog(null)}
        onSubmit={(title) => void run(() => renameNote(note.id, title))}
      />
    );
  }

  if (dialog?.kind === "move") {
    return (
      <MobileFolderPicker
        folders={pickableFolders}
        onClose={() => setDialog(null)}
        onPick={(folderId) => void run(() => moveNote(note.id, folderId))}
      />
    );
  }

  if (dialog?.kind === "tags") {
    return (
      <MobileTagSheet
        onClose={() => setDialog(null)}
        onSubmit={(names) => void run(() => addNoteTags(note.id, names))}
      />
    );
  }

  if (dialog?.kind === "confirmDelete") {
    return (
      <MobileModal
        title={t("selection.delete_confirm_title", { n: 1 })}
        onClose={() => setDialog(null)}
        footer={
          <>
            <button type="button" className="mobile-text-btn" onClick={() => setDialog(null)}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="mobile-text-btn mobile-text-btn--danger"
              disabled={busy}
              onClick={() => void run(() => deleteNote(note.id))}
            >
              {t("common.delete")}
            </button>
          </>
        }
      >
        <p style={{ fontSize: "var(--text-sm)", color: "var(--text)" }}>{t("selection.delete_confirm_body")}</p>
      </MobileModal>
    );
  }

  return (
    <>
      <div className="mobile-sheet-backdrop" onClick={onClose} />
      <div className="mobile-sheet overlay" role="dialog" aria-modal="true" aria-label={t("selection.bar_label")}>
        <div className="mobile-ai-actions">
          <button
            type="button"
            className="menu-row mobile-ai-action"
            data-testid="mobile-action-rename"
            disabled={busy}
            onClick={() => setDialog({ kind: "rename" })}
          >
            <IconEdit size={16} strokeWidth={1.8} aria-hidden />
            {t("ctx.rename")}
          </button>
          <button
            type="button"
            className="menu-row mobile-ai-action"
            data-testid="mobile-action-move"
            disabled={busy || pickableFolders.length === 0}
            onClick={() => setDialog({ kind: "move" })}
          >
            <IconFolder size={16} strokeWidth={1.8} aria-hidden />
            {t("ctx.move_to_folder")}
          </button>
          <button
            type="button"
            className="menu-row mobile-ai-action"
            data-testid="mobile-action-favorite"
            disabled={busy}
            onClick={() => void run(() => toggleFavorite(note.id))}
          >
            <IconStar
              size={16}
              strokeWidth={1.8}
              aria-hidden
              style={{ fill: note.is_favorite ? "var(--accent)" : "none" }}
            />
            {t(note.is_favorite ? "ctx.remove_favorite" : "ctx.add_favorite")}
          </button>
          <button
            type="button"
            className="menu-row mobile-ai-action"
            data-testid="mobile-action-tags"
            disabled={busy}
            onClick={() => setDialog({ kind: "tags" })}
          >
            <IconTag size={16} strokeWidth={1.8} aria-hidden />
            {t("selection.add_tags")}
          </button>
          <button
            type="button"
            className="menu-row mobile-ai-action"
            data-testid="mobile-action-archive"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await useArchiveStore.getState().archiveNote(note.id);
                emitNotice(t("archive.moved"));
              })
            }
          >
            <IconArchive size={16} strokeWidth={1.8} aria-hidden />
            {t("ctx.archive")}
          </button>
          <button
            type="button"
            className="menu-row mobile-ai-action"
            data-testid="mobile-action-select"
            disabled={busy}
            onClick={() => {
              useSelectionStore.getState().toggleNote(note.id);
              onClose();
            }}
          >
            <IconCheckMark size={16} strokeWidth={1.8} aria-hidden />
            {t("mobile.action_select")}
          </button>
          <button
            type="button"
            className="menu-row mobile-ai-action"
            data-testid="mobile-action-delete"
            disabled={busy}
            onClick={() => setDialog({ kind: "confirmDelete" })}
            style={{ color: "var(--danger)" }}
          >
            <IconTrash size={16} strokeWidth={1.8} aria-hidden />
            {t("common.delete")}
          </button>
        </div>
        <button type="button" className="mobile-text-btn mobile-sheet-close" onClick={onClose}>
          {t("common.cancel")}
        </button>
      </div>
    </>
  );
}

function MobileRenameDialog({
  initial,
  onCancel,
  onSubmit,
}: {
  initial: string;
  onCancel: () => void;
  onSubmit: (title: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed) onSubmit(trimmed);
  };
  return (
    <MobileModal
      title={t("ctx.rename_note_prompt")}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="mobile-text-btn" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button type="button" className="mobile-text-btn mobile-text-btn--accent" onClick={commit}>
            {t("common.apply")}
          </button>
        </>
      }
    >
      <input
        autoFocus
        className="mobile-modal-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
      />
    </MobileModal>
  );
}
