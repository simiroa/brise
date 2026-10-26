import { useEffect, useState, type CSSProperties } from "react";
import { useUiStore } from "../stores/ui";
import { useTrashStore } from "../stores/trash";
import { displayTitle } from "../stores/notes";
import { ModalShell } from "./ModalShell";
import { PromptDialog } from "./PromptDialog";
import { IconNote } from "./icons";
import { noteIconComp } from "../lib/noteIcons";
import { t } from "../i18n/t";

/** section: true 면 같은 확인 다이얼로그가 섹션을 지운다 — 노트 행과 같은 관례를 쓴다. */
type TrashDialog =
  | { kind: "purgeOne"; id: string; title: string; section?: boolean }
  | { kind: "emptyAll" };

const groupHeadingStyle: CSSProperties = {
  fontSize: "var(--text-label)",
  fontWeight: 600,
  color: "var(--muted)",
  padding: "0 var(--space-2)",
};

const EMPTY_WORD = "EMPTY";

/**
 * Trash view — reachable from the sidebar's Trash row (NoteTree.tsx, only shown when
 * trashCount > 0). Restore is one click (the note is already reversible, so no confirm); purge
 * is the one truly irreversible action left in this flow, so both the per-note "Delete
 * permanently" and the "Empty trash" bulk action stay behind a confirm — modeled on
 * PromptDialog's danger confirm (per-note) and DataManagementSection's db_reset type-to-confirm
 * (empty-all, since it destroys everything in the trash at once).
 */
export function TrashModal() {
  const open = useUiStore((s) => s.trashOpen);
  const close = useUiStore((s) => s.closeTrash);
  const trashList = useTrashStore((s) => s.trashList);
  const loadTrash = useTrashStore((s) => s.loadTrash);
  const restoreNote = useTrashStore((s) => s.restoreNote);
  const purgeNote = useTrashStore((s) => s.purgeNote);
  const purgeAll = useTrashStore((s) => s.purgeAll);
  const sectionTrash = useTrashStore((s) => s.sectionTrash);
  const loadSectionTrash = useTrashStore((s) => s.loadSectionTrash);
  const restoreSection = useTrashStore((s) => s.restoreSection);
  const purgeSection = useTrashStore((s) => s.purgeSection);

  const [dialog, setDialog] = useState<TrashDialog | null>(null);
  const [emptyConfirm, setEmptyConfirm] = useState("");

  useEffect(() => {
    if (open) {
      void loadTrash();
      void loadSectionTrash();
    }
  }, [open, loadTrash, loadSectionTrash]);

  if (!open) return null;

  const closeEmptyDialog = () => {
    setDialog(null);
    setEmptyConfirm("");
  };

  return (
    <>
      <ModalShell title={t("trash.title")} onClose={close} width={480}>
        {trashList.length === 0 && sectionTrash.length === 0 ? (
          <div style={{ padding: "20px 4px", textAlign: "center", color: "var(--faint)" }}>
            {t("trash.empty_state")}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {trashList.length > 0 && <div style={groupHeadingStyle}>{t("trash.notes_heading")}</div>}
            {trashList.map((n) => {
              const NIcon = noteIconComp(n.icon, IconNote);
              return (
                <div
                  key={n.id}
                  className="menu-row menu-item"
                  style={{ cursor: "default" }}
                >
                  <NIcon size={15} strokeWidth={1.7} style={{ color: "var(--muted)", flex: "none" }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
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
                    onClick={() => void restoreNote(n.id)}
                    className="btn"
                    style={{ fontSize: "var(--text-sm)", padding: "6px 10px" }}
                  >
                    {t("trash.restore")}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setDialog({ kind: "purgeOne", id: n.id, title: displayTitle(n.title) })
                    }
                    className="btn"
                    style={{
                      fontSize: "var(--text-sm)",
                      padding: "6px 10px",
                      color: "var(--danger)",
                      borderColor: "var(--danger)",
                    }}
                  >
                    {t("trash.delete_forever")}
                  </button>
                </div>
              );
            })}

            {sectionTrash.length > 0 && (
              <div style={{ ...groupHeadingStyle, marginTop: trashList.length > 0 ? 10 : 0 }}>
                {t("trash.sections_heading")}
              </div>
            )}
            {sectionTrash.map((s) => (
              <div key={s.id} className="menu-row menu-item" style={{ cursor: "default" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: "var(--text-md)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {t("trash.section_from", {
                      name: s.name,
                      note: displayTitle(s.note_title),
                    })}
                  </div>
                  {s.note_deleted && (
                    <div style={{ fontSize: "var(--text-label)", color: "var(--muted)" }}>
                      {t("trash.section_restore_blocked")}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  data-testid={`section-trash-restore-${s.id}`}
                  // 원 노트가 휴지통이면 백엔드가 CONFLICT 를 낸다 — 누르기 전에 막고 이유를 적는다.
                  disabled={s.note_deleted}
                  title={s.note_deleted ? t("trash.section_restore_blocked") : undefined}
                  onClick={() => void restoreSection(s.id)}
                  className="btn"
                  style={{ fontSize: "var(--text-sm)", padding: "6px 10px" }}
                >
                  {t("trash.restore")}
                </button>
                <button
                  type="button"
                  data-testid={`section-trash-purge-${s.id}`}
                  onClick={() => setDialog({ kind: "purgeOne", id: s.id, title: s.name, section: true })}
                  className="btn"
                  style={{
                    fontSize: "var(--text-sm)",
                    padding: "6px 10px",
                    color: "var(--danger)",
                    borderColor: "var(--danger)",
                  }}
                >
                  {t("trash.delete_forever")}
                </button>
              </div>
            ))}
          </div>
        )}

        {trashList.length > 0 && (
          <div
            style={{
              marginTop: 18,
              paddingTop: 14,
              borderTop: "1px solid var(--line)",
              display: "flex",
              justifyContent: "flex-end",
            }}
          >
            <button
              type="button"
              onClick={() => setDialog({ kind: "emptyAll" })}
              className="btn"
              style={{ color: "var(--danger)", borderColor: "var(--danger)" }}
            >
              {t("trash.empty")}
            </button>
          </div>
        )}
      </ModalShell>

      {dialog?.kind === "purgeOne" && (
        <PromptDialog
          title={t("trash.delete_forever")}
          description={t("trash.delete_confirm", { title: dialog.title })}
          mode="confirm"
          danger
          confirmLabel={t("trash.delete_forever")}
          onCancel={() => setDialog(null)}
          onSubmit={() => {
            const { id, section } = dialog;
            setDialog(null);
            void (section ? purgeSection(id) : purgeNote(id));
          }}
        />
      )}

      {dialog?.kind === "emptyAll" && (
        <ModalShell
          title={t("trash.empty")}
          onClose={closeEmptyDialog}
          width={400}
        >
          <p style={{ fontSize: "var(--text-md)", color: "var(--muted)", margin: "0 0 14px" }}>
            {t("trash.empty_confirm", { n: trashList.length })}
          </p>
          <p style={{ fontSize: "var(--text-md)", color: "var(--muted)", margin: "0 0 14px" }}>
            {t("trash.empty_type_prefix")} <strong>{EMPTY_WORD}</strong> {t("trash.empty_type_suffix")}
          </p>
          <input
            value={emptyConfirm}
            onChange={(e) => setEmptyConfirm(e.target.value)}
            placeholder={EMPTY_WORD}
            className="field"
            style={{ marginBottom: "var(--space-4)" }}
          />
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
            <button type="button" onClick={closeEmptyDialog} className="btn">
              {t("common.cancel")}
            </button>
            <button
              type="button"
              disabled={emptyConfirm !== EMPTY_WORD}
              onClick={() => {
                closeEmptyDialog();
                void purgeAll();
              }}
              className={emptyConfirm === EMPTY_WORD ? "btn btn-danger" : "btn"}
            >
              {t("trash.empty")}
            </button>
          </div>
        </ModalShell>
      )}
    </>
  );
}
