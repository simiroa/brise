/**
 * Unified Attachment Service for Brise.
 * Centralizes internal attachment creation, bidirectional backlink removal, and undo workflows.
 */
import { call } from "./invoke";
import { showUndoToast } from "./undo";
import type { NoteDetail } from "./commands.gen";
import { t } from "../i18n/t";

export interface RemoveBacklinkResult {
  removed: boolean;
  removedCount: number;
  attachName?: string;
  sourceId: string;
  targetId: string;
}

/**
 * Adds an internal note attachment linking sourceNote to targetNote.
 */
export async function addInternalAttachment(
  noteId: string,
  targetNoteId: string,
  name: string,
): Promise<{ id: string }> {
  return await call<{ id: string }>("attachment_add_internal", {
    note_id: noteId,
    target_note_id: targetNoteId,
    name,
  });
}

/**
 * Removes bidirectional internal backlink attachments between source and target notes,
 * and triggers an Undo toast allowing the user to restore the severed connection.
 */
export async function removeInternalBacklink(
  sourceId: string,
  targetId: string,
  options?: {
    showUndo?: boolean;
    onRestored?: () => void;
  },
): Promise<RemoveBacklinkResult> {
  const showUndo = options?.showUndo ?? true;
  let attachNoteId = sourceId;
  let attachTargetId = targetId;
  let attachName = "";
  let removedCount = 0;

  try {
    const sourceDetail = await call<NoteDetail>("note_get", { id: sourceId });
    const matchingOnSource =
      sourceDetail.attachments?.filter((a) => a.kind === "internal" && a.url === targetId) ?? [];

    if (matchingOnSource.length > 0) {
      for (const att of matchingOnSource) {
        await call("attachment_remove", { id: att.id });
        removedCount++;
      }
      attachName = matchingOnSource[0].name;
    } else {
      // Check target note in case direction was saved inversely
      const targetDetail = await call<NoteDetail>("note_get", { id: targetId });
      const matchingOnTarget =
        targetDetail.attachments?.filter((a) => a.kind === "internal" && a.url === sourceId) ?? [];

      if (matchingOnTarget.length > 0) {
        for (const att of matchingOnTarget) {
          await call("attachment_remove", { id: att.id });
          removedCount++;
        }
        attachNoteId = targetId;
        attachTargetId = sourceId;
        attachName = matchingOnTarget[0].name;
      }
    }

    if (removedCount > 0 && showUndo) {
      const finalNoteId = attachNoteId;
      const finalTargetId = attachTargetId;
      const finalName = attachName;
      const displayName = finalName?.trim() ? finalName.trim() : t("home.graph_backlink");
      showUndoToast(t("undo.link_removed", { name: displayName }), async () => {
        try {
          await call("attachment_add_internal", {
            note_id: finalNoteId,
            target_note_id: finalTargetId,
            name: finalName,
          });
          options?.onRestored?.();
        } catch {
          // Handled by undo bridge
        }
      });
    }

    return {
      removed: removedCount > 0,
      removedCount,
      attachName,
      sourceId: attachNoteId,
      targetId: attachTargetId,
    };
  } catch {
    return {
      removed: false,
      removedCount: 0,
      sourceId,
      targetId,
    };
  }
}
