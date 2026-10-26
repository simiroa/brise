import { useEffect, useState } from "react";
import { useUiStore } from "../stores/ui";
import type { Section } from "../lib/commands.gen";
import { t } from "../i18n/t";
import { IconArrowLeft, IconArrowRight, IconEdit, IconTrash } from "../components/icons";
import { beginLongPress, cancelLongPress, consumeLongPress, moveLongPress } from "../lib/longPress";
import { MobileModal } from "./MobileModal";
import { useBackClosable } from "./useBackClosable";

export interface MobileSectionStripProps {
  sections: Section[];
  currentSectionId: string | null;
  onSelect: (section: Section) => void;
  onRename: (id: string, name: string) => Promise<void>;
  onMove: (id: string, direction: -1 | 1) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onAddText: () => void;
  onAddDiagram: () => void;
  onAddSheet: () => void;
}

/**
 * Section tabs + "+" picker + long-press rename/move/delete.
 * Mutations stay in MobileNote (they flush the editor); this file only owns the chrome.
 */
export function MobileSectionStrip({
  sections,
  currentSectionId,
  onSelect,
  onRename,
  onMove,
  onDelete,
  onAddText,
  onAddDiagram,
  onAddSheet,
}: MobileSectionStripProps) {
  const [addOpen, setAddOpen] = useState(false);
  const [actionsFor, setActionsFor] = useState<Section | null>(null);
  const [dialog, setDialog] = useState<"rename" | "confirmDelete" | null>(null);
  const [busy, setBusy] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");

  // 새 섹션 직후 이름 입력(데스크톱 SectionTabBar 와 같은 renameSectionId 신호). 섹션이 sections 에 붙은 뒤 잡힌다.
  const renameSectionId = useUiStore((s) => s.renameSectionId);
  useEffect(() => {
    if (!renameSectionId) return;
    const sec = sections.find((s) => s.id === renameSectionId);
    if (!sec) return;
    useUiStore.setState({ renameSectionId: null });
    setActionsFor(sec);
    setRenameDraft(sec.name);
    setDialog("rename");
  }, [renameSectionId, sections]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      setActionsFor(null);
      setDialog(null);
    } catch {
      // call() already toasted; keep the sheet open to retry/cancel.
    } finally {
      setBusy(false);
    }
  };

  // Held while the long-press sheet OR its rename/delete dialog is up (dialog stacks on top).
  useBackClosable(actionsFor !== null, () => setActionsFor(null));

  const idx = actionsFor ? sections.findIndex((s) => s.id === actionsFor.id) : -1;

  return (
    <>
      <div className="mobile-section-strip scroll" role="tablist" aria-label={t("editor.new_section")}>
        {sections.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            className="mobile-section-tab"
            data-testid={`mobile-section-tab-${s.id}`}
            data-active={s.id === currentSectionId}
            aria-selected={s.id === currentSectionId}
            onPointerDown={(e) => beginLongPress(() => setActionsFor(s), undefined, e)}
            onPointerUp={cancelLongPress}
            onPointerCancel={cancelLongPress}
            onPointerLeave={cancelLongPress}
            onPointerMove={moveLongPress}
            onClick={() => {
              if (consumeLongPress()) return;
              onSelect(s);
            }}
          >
            {s.name}
          </button>
        ))}
        <button
          type="button"
          className="mobile-section-add"
          data-testid="mobile-section-add"
          aria-label={t("editor.new_section")}
          title={t("editor.new_section")}
          onClick={() => setAddOpen(true)}
        >
          +
        </button>
      </div>

      {addOpen && (
        <MobileModal
          title={t("editor.new_section")}
          onClose={() => setAddOpen(false)}
          footer={
            <button type="button" className="mobile-text-btn" onClick={() => setAddOpen(false)}>
              {t("common.cancel")}
            </button>
          }
        >
          <div className="mobile-ai-actions mobile-modal-options">
            <button
              type="button"
              className="menu-row mobile-ai-action"
              data-testid="mobile-section-add-text"
              onClick={() => {
                setAddOpen(false);
                onAddText();
              }}
            >
              {t("editor.new_section_text")}
            </button>
            <button
              type="button"
              className="menu-row mobile-ai-action"
              data-testid="mobile-section-add-diagram"
              onClick={() => {
                setAddOpen(false);
                onAddDiagram();
              }}
            >
              {t("editor.new_section_diagram")}
            </button>
            <button
              type="button"
              className="menu-row mobile-ai-action"
              data-testid="mobile-section-add-sheet"
              onClick={() => {
                setAddOpen(false);
                onAddSheet();
              }}
            >
              {t("editor.new_section_sheet")}
            </button>
          </div>
        </MobileModal>
      )}

      {actionsFor && dialog === null && (
        <>
          <div className="mobile-sheet-backdrop" onClick={() => setActionsFor(null)} />
          <div className="mobile-sheet overlay" role="dialog" aria-modal="true" aria-label={actionsFor.name}>
            <div className="mobile-ai-actions">
              <button
                type="button"
                className="menu-row mobile-ai-action"
                data-testid="mobile-section-action-rename"
                disabled={busy}
                onClick={() => {
                  setRenameDraft(actionsFor.name);
                  setDialog("rename");
                }}
              >
                <IconEdit size={16} strokeWidth={1.8} aria-hidden />
                {t("ctx.rename")}
              </button>
              <button
                type="button"
                className="menu-row mobile-ai-action"
                data-testid="mobile-section-action-forward"
                disabled={busy || idx <= 0}
                onClick={() => void run(() => onMove(actionsFor.id, -1))}
              >
                <IconArrowLeft size={16} strokeWidth={1.8} aria-hidden />
                {t("mobile.section_move_forward")}
              </button>
              <button
                type="button"
                className="menu-row mobile-ai-action"
                data-testid="mobile-section-action-backward"
                disabled={busy || idx >= sections.length - 1}
                onClick={() => void run(() => onMove(actionsFor.id, 1))}
              >
                <IconArrowRight size={16} strokeWidth={1.8} aria-hidden />
                {t("mobile.section_move_backward")}
              </button>
              <button
                type="button"
                className="menu-row mobile-ai-action"
                data-testid="mobile-section-action-delete"
                disabled={busy || sections.length <= 1}
                onClick={() => setDialog("confirmDelete")}
                style={{ color: "var(--danger)" }}
              >
                <IconTrash size={16} strokeWidth={1.8} aria-hidden />
                {t("common.delete")}
              </button>
            </div>
            <button
              type="button"
              className="mobile-text-btn mobile-sheet-close"
              onClick={() => setActionsFor(null)}
            >
              {t("common.cancel")}
            </button>
          </div>
        </>
      )}

      {actionsFor && dialog === "rename" && (
        <MobileModal
          title={t("mobile.section_rename_prompt")}
          onClose={() => setDialog(null)}
          footer={
            <>
              <button type="button" className="mobile-text-btn" onClick={() => setDialog(null)}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="mobile-text-btn mobile-text-btn--accent"
                disabled={busy}
                onClick={() => {
                  const trimmed = renameDraft.trim();
                  if (trimmed) void run(() => onRename(actionsFor.id, trimmed));
                }}
              >
                {t("common.apply")}
              </button>
            </>
          }
        >
          <input
            autoFocus
            className="mobile-modal-input"
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") {
                e.preventDefault();
                const trimmed = renameDraft.trim();
                if (trimmed) void run(() => onRename(actionsFor.id, trimmed));
              }
            }}
          />
        </MobileModal>
      )}

      {actionsFor && dialog === "confirmDelete" && (
        <MobileModal
          title={t("mobile.section_delete_confirm_title")}
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
                onClick={() => void run(() => onDelete(actionsFor.id))}
              >
                {t("common.delete")}
              </button>
            </>
          }
        >
          <p style={{ fontSize: "var(--text-sm)", color: "var(--text)" }}>
            {t("mobile.delete_confirm_irreversible_body")}
          </p>
        </MobileModal>
      )}
    </>
  );
}
