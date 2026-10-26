import { useEffect, useState } from "react";
import { useTrashStore } from "../stores/trash";
import { useArchiveStore } from "../stores/archive";
import { displayTitle } from "../stores/notes";
import { call } from "../lib/invoke";
import type { NoteSummary } from "../lib/commands.gen";
import { t } from "../i18n/t";
import { MobileModal } from "./MobileModal";
import { useBackClosable } from "./useBackClosable";
import { IconArchive, IconArrowLeft, IconTrash, IconUndo } from "../components/icons";

/**
 * Trash/Archive "push screen" opened from the 노트 tree's 휴지통/보관 rows (MobileNoteTree). Kept as a
 * plain overlay over the tree instead of a MobileApp screen-stack entry: it is a transient sub-view
 * of the tree with its own Android-back layer (`useBackClosable`), so a new state in MobileApp's
 * history machine would buy nothing. `.mobile-screen` gives it the same full-bleed, slide-in visual
 * treatment an actual pushed screen would have.
 *
 * Trash shows notes only — the section-trash row is 0-pinned on mobile (see MobileNoteTree's
 * flattenRows call), so there is nothing section-shaped to restore here.
 */
export function MobileTrashArchiveOverlay({ kind, onClose }: { kind: "trash" | "archive"; onClose: () => void }) {
  useBackClosable(true, onClose);
  const trashList = useTrashStore((s) => s.trashList);
  const loadTrash = useTrashStore((s) => s.loadTrash);
  const archiveList = useArchiveStore((s) => s.archiveList);
  const loadArchive = useArchiveStore((s) => s.loadArchive);
  const [purgeTarget, setPurgeTarget] = useState<NoteSummary | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (kind === "trash") void loadTrash();
    else void loadArchive();
  }, [kind, loadTrash, loadArchive]);

  const list = kind === "trash" ? trashList : archiveList;

  const restore = async (id: string) => {
    setBusyId(id);
    try {
      await useTrashStore.getState().restoreNote(id);
      await loadTrash();
      void useArchiveStore.getState().loadArchiveCount();
    } catch {
      // silent-ok: restoreNote's call() already toasted and logged the failure.
    } finally {
      setBusyId(null);
    }
  };

  const unarchive = async (id: string) => {
    setBusyId(id);
    try {
      await useArchiveStore.getState().unarchiveNote(id);
      await loadArchive();
    } catch {
      // silent-ok: unarchiveNote's call() already toasted and logged the failure.
    } finally {
      setBusyId(null);
    }
  };

  const purge = async (id: string) => {
    setPurgeTarget(null);
    try {
      await call("note_purge", { id });
      await loadTrash();
      void useArchiveStore.getState().loadArchiveCount();
    } catch {
      // call() already toasted.
    }
  };

  return (
    <div className="mobile-screen">
      <div className="mobile-topbar">
        <button type="button" className="mobile-icon-btn" onClick={onClose} aria-label={t("mobile.back")}>
          <IconArrowLeft size={20} strokeWidth={2} />
        </button>
        <span className="mobile-topbar-title">{t(kind === "trash" ? "trash.title" : "archive.title")}</span>
      </div>
      <div className="mobile-list scroll">
        {list.length === 0 && <div className="mobile-empty">{t(kind === "trash" ? "trash.empty_state" : "archive.empty_state")}</div>}
        {list.map((n) => (
          <div key={n.id} className="mobile-tree-row mobile-tree-row--note">
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="mobile-tree-row-name">{displayTitle(n.title)}</div>
            </div>
            {kind === "trash" ? (
              <>
                <button
                  type="button"
                  className="mobile-icon-btn"
                  disabled={busyId === n.id}
                  onClick={() => void restore(n.id)}
                  aria-label={t("trash.restore")}
                  title={t("trash.restore")}
                >
                  <IconUndo size={18} strokeWidth={1.8} />
                </button>
                <button
                  type="button"
                  className="mobile-icon-btn"
                  disabled={busyId === n.id}
                  onClick={() => setPurgeTarget(n)}
                  aria-label={t("trash.delete_forever")}
                  title={t("trash.delete_forever")}
                >
                  <IconTrash size={18} strokeWidth={1.8} />
                </button>
              </>
            ) : (
              <button
                type="button"
                className="mobile-icon-btn"
                disabled={busyId === n.id}
                onClick={() => void unarchive(n.id)}
                aria-label={t("archive.unarchive")}
                title={t("archive.unarchive")}
              >
                <IconArchive size={18} strokeWidth={1.8} />
              </button>
            )}
          </div>
        ))}
      </div>

      {purgeTarget && (
        <MobileModal
          title={t("trash.delete_forever")}
          onClose={() => setPurgeTarget(null)}
          footer={
            <>
              <button type="button" className="mobile-text-btn" onClick={() => setPurgeTarget(null)}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="mobile-text-btn mobile-text-btn--danger"
                onClick={() => void purge(purgeTarget.id)}
              >
                {t("common.delete")}
              </button>
            </>
          }
        >
          <p style={{ fontSize: "var(--text-sm)", color: "var(--text)" }}>
            {t("trash.delete_confirm", { title: displayTitle(purgeTarget.title) })}
          </p>
        </MobileModal>
      )}
    </div>
  );
}
