import { useEffect } from "react";
import { useUiStore } from "../stores/ui";
import { useArchiveStore } from "../stores/archive";
import { useNotesStore, displayTitle } from "../stores/notes";
import { ModalShell } from "./ModalShell";
import { IconNote } from "./icons";
import { noteIconComp } from "../lib/noteIcons";
import { t } from "../i18n/t";

/**
 * Archive view (W7-f) — reachable from the sidebar's Archive row (rows.ts/TreeListRow.tsx, only
 * shown when archiveCount > 0), modeled directly on TrashModal. Unlike Trash, there is no
 * permanent-delete action here: an archived note is a normal note, only hidden from passive
 * browsing (tree/dashboard) while staying fully searchable (FTS retained — repo::notes::archive).
 * Removing it entirely goes through the ordinary delete path (which sends it to Trash), so each
 * row offers only "Unarchive" (bring back into the tree) and "Go to note" (open it read/write,
 * same as any other note — note_get doesn't filter archived_at).
 */
export function ArchiveModal() {
  const open = useUiStore((s) => s.archiveOpen);
  const close = useUiStore((s) => s.closeArchive);
  const archiveList = useArchiveStore((s) => s.archiveList);
  const loadArchive = useArchiveStore((s) => s.loadArchive);
  const unarchiveNote = useArchiveStore((s) => s.unarchiveNote);
  const selectNote = useNotesStore((s) => s.selectNote);

  useEffect(() => {
    if (open) void loadArchive();
  }, [open, loadArchive]);

  if (!open) return null;

  const goToNote = (id: string) => {
    close();
    void selectNote(id);
  };

  return (
    <ModalShell title={t("archive.title")} onClose={close} width={480}>
      {archiveList.length === 0 ? (
        <div style={{ padding: "20px 4px", textAlign: "center", color: "var(--faint)" }}>
          {t("archive.empty_state")}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {archiveList.map((n) => {
            const NIcon = noteIconComp(n.icon, IconNote);
            return (
              <div
                key={n.id}
                className="menu-row menu-item"
                style={{ cursor: "default" }}
              >
                <NIcon size={15} strokeWidth={1.7} style={{ color: "var(--muted)", flex: "none" }} />
                <div
                  onClick={() => goToNote(n.id)}
                  style={{ flex: 1, minWidth: 0, cursor: "pointer" }}
                  title={t("archive.go_to_note")}
                >
                  <div
                    style={{
                      fontSize: "var(--text-md)",
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {displayTitle(n.title)}
                  </div>
                  <div style={{ fontSize: "var(--text-label)", color: "var(--muted)" }}>{n.year}</div>
                </div>
                <button
                  type="button"
                  onClick={() => void unarchiveNote(n.id)}
                  className="btn"
                  style={{ fontSize: "var(--text-sm)", padding: "6px 10px" }}
                >
                  {t("archive.unarchive")}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </ModalShell>
  );
}
