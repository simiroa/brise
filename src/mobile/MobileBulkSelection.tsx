import React, { useEffect, useState } from "react";
import { useArchiveStore } from "../stores/archive";
import { useSettingsStore } from "../stores/settings";
import { emitNotice } from "../lib/invoke";
import type { Folder } from "../lib/commands.gen";
import { addNoteTags, moveNote, deleteNote } from "../lib/noteActions";
import { runBatch, reportBatch, type BatchResult } from "../lib/batchActions";
import { SelectionActionBar, SelectionActionButton } from "../components/SelectionActionBar";
import { t } from "../i18n/t";
import { MobileModal } from "./MobileModal";
import { MobileFolderPicker } from "./MobileFolderPicker";
import { MobileTagSheet } from "./MobileTagSheet";
import { IconArchive, IconFolder, IconSparkles, IconTag, IconTrash } from "../components/icons";
import { AiBatchOrganizeModal } from "../lazySurfaces";


type BulkDialog = { kind: "move" } | { kind: "tag" } | { kind: "confirmDelete" } | { kind: "ai" };

interface MobileBulkSelectionProps {
  /** Ids in the 노트 tree's multi-select (stores/selection.ts). The bar shows from 2 up. */
  selectedNoteIds: string[];
  /** Folders a bulk move may target (the tree's folders, inbox excluded). */
  moveTargets: Folder[];
  onClear: () => void;
  /** After a batch, keep only the notes whose action failed selected so the user can retry them. */
  onKeepSelected: (ids: string[]) => void;
}

/**
 * Multi-select action bar of the 노트 tree plus the dialogs its verbs open (same 5 verbs as desktop's
 * NoteSelectionBar: move · tags · archive · delete · AI organize). Always mounted by MobileNoteTree —
 * the dialog state lives here — and renders the bar only for 2+ selected notes. Every verb loops the
 * single-id gateways (lib/noteActions.ts, stores/archive.ts) through lib/batchActions.ts's runBatch,
 * so a mid-batch failure keeps going and is reported once.
 */
export function MobileBulkSelection({ selectedNoteIds, moveTargets, onClear, onKeepSelected }: MobileBulkSelectionProps) {
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  const [bulkDialog, setBulkDialog] = useState<BulkDialog | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  // "AI 정리" 버튼이 담긴 선택 막대가 뜨는 순간 = 그 모달을 열 수 있게 된 때 — 폰은 유휴 미리 받기가 없고
  // 터치는 누르기 직전 신호가 짧아서, 버튼 의도(intentProps)보다 이른 막대 등장 시점에 미리 받는다.
  const aiBarShown = aiEnabled && selectedNoteIds.length >= 2;
  useEffect(() => {
    if (aiBarShown) void AiBatchOrganizeModal.preload();
  }, [aiBarShown]);

  const runBulk = async (fn: (id: string) => Promise<void>): Promise<BatchResult> => {
    const ids = [...selectedNoteIds];
    setBatchBusy(true);
    const res = await runBatch(ids, fn);
    setBatchBusy(false);
    reportBatch(res);
    onKeepSelected(res.failed);
    return res;
  };

  return (
    <>
      {selectedNoteIds.length >= 2 && (
        <SelectionActionBar count={selectedNoteIds.length} onClear={onClear} busy={batchBusy}>
          <SelectionActionButton
            label={t("ctx.move_to_folder")}
            icon={<IconFolder size={14} strokeWidth={1.8} />}
            onClick={() => setBulkDialog({ kind: "move" })}
            disabled={batchBusy || moveTargets.length === 0}
            testid="mobile-selection-move"
          />
          <SelectionActionButton
            label={t("selection.add_tags")}
            icon={<IconTag size={14} strokeWidth={1.8} />}
            onClick={() => setBulkDialog({ kind: "tag" })}
            disabled={batchBusy}
            testid="mobile-selection-tag"
          />
          <SelectionActionButton
            label={t("ctx.archive")}
            icon={<IconArchive size={14} strokeWidth={1.8} />}
            onClick={() =>
              void (async () => {
                const res = await runBulk((id) => useArchiveStore.getState().archiveNote(id));
                if (res.ok.length > 0) emitNotice(t("archive.moved"));
              })()
            }
            disabled={batchBusy}
            testid="mobile-selection-archive"
          />
          <SelectionActionButton
            label={t("common.delete")}
            icon={<IconTrash size={14} strokeWidth={1.8} />}
            onClick={() => setBulkDialog({ kind: "confirmDelete" })}
            disabled={batchBusy}
            danger
            testid="mobile-selection-delete"
          />
          {aiEnabled && (
            <SelectionActionButton
              label={t("selection.ai_organize")}
              icon={<IconSparkles size={14} strokeWidth={1.8} />}
              onClick={() => setBulkDialog({ kind: "ai" })}
              disabled={batchBusy}
              testid="mobile-selection-ai"
            />
          )}
        </SelectionActionBar>
      )}

      {bulkDialog?.kind === "move" && (
        <MobileFolderPicker
          folders={moveTargets}
          onClose={() => setBulkDialog(null)}
          onPick={(folderId) =>
            void (async () => {
              setBulkDialog(null);
              await runBulk((id) => moveNote(id, folderId));
            })()
          }
        />
      )}

      {bulkDialog?.kind === "tag" && (
        <MobileTagSheet
          onClose={() => setBulkDialog(null)}
          onSubmit={(names) =>
            void (async () => {
              setBulkDialog(null);
              await runBulk((id) => addNoteTags(id, names));
            })()
          }
        />
      )}

      {bulkDialog?.kind === "confirmDelete" && (
        <MobileModal
          title={t("selection.delete_confirm_title", { n: selectedNoteIds.length })}
          onClose={() => setBulkDialog(null)}
          footer={
            <>
              <button type="button" className="mobile-text-btn" onClick={() => setBulkDialog(null)}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="mobile-text-btn mobile-text-btn--danger"
                onClick={() =>
                  void (async () => {
                    setBulkDialog(null);
                    await runBulk(deleteNote);
                  })()
                }
              >
                {t("common.delete")}
              </button>
            </>
          }
        >
          <p style={{ fontSize: "var(--text-sm)", color: "var(--text)" }}>{t("selection.delete_confirm_body")}</p>
        </MobileModal>
      )}

      {bulkDialog?.kind === "ai" && (
        <React.Suspense fallback={null}>
          <AiBatchOrganizeModal noteIds={[...selectedNoteIds]} onClose={() => setBulkDialog(null)} />
        </React.Suspense>
      )}
    </>
  );
}
