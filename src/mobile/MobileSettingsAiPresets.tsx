import { useEffect, useState } from "react";
import { useSettingsStore } from "../stores/settings";
import { useAiPresetsStore, visiblePresets } from "../stores/aiPresets";
import { type AiActionPreset } from "../stores/aiPrompts";
import { emitNotice } from "../lib/invoke";
import { t } from "../i18n/t";
import { IconCaret, IconEdit } from "../components/icons";
import { MobileModal } from "./MobileModal";

interface EditingAction {
  id: string | null; // null = creating a new custom action
  name: string;
  prompt: string;
  isBuiltin: boolean;
  isMetadata: boolean;
}

/**
 * 설정 tab · 노트 작업 프리셋 section — mirror of the desktop AI settings' preset tab. EDITABLE items:
 * pencil affordance + chevron + a group hint saying so (that hint is what makes a tap's outcome
 * predictable). Same shared aiPresets store desktop's AiActionsMenu reads, so an edit here syncs
 * both ways. The edit/add dialog lives here too.
 *
 * Deliberately out of scope (desktop-only for now): preset reordering (reorder()) and restoring a
 * deleted built-in (restoreHiddenBuiltins()).
 */
export function MobileSettingsAiPresets() {
  // aiEnabled: READ ONLY (the master toggle is desktop-only, D8) — gates the whole editor.
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  const aiPresetList = useAiPresetsStore((s) => s.list);
  const aiPresetsLoaded = useAiPresetsStore((s) => s.loaded);
  const loadAiPresets = useAiPresetsStore((s) => s.load);
  const addCustom = useAiPresetsStore((s) => s.addCustom);
  const updateItem = useAiPresetsStore((s) => s.updateItem);
  const deleteItem = useAiPresetsStore((s) => s.deleteItem);
  const resetItem = useAiPresetsStore((s) => s.resetItem);
  const [editingAction, setEditingAction] = useState<EditingAction | null>(null);
  const [savingAction, setSavingAction] = useState(false);

  useEffect(() => {
    if (!aiPresetsLoaded) void loadAiPresets();
  }, [aiPresetsLoaded, loadAiPresets]);

  const openActionEdit = (action?: AiActionPreset) => {
    setEditingAction(
      action
        ? { id: action.id, name: action.name, prompt: action.prompt, isBuiltin: action.isBuiltin, isMetadata: action.kind === "metadata" }
        : { id: null, name: "", prompt: "", isBuiltin: false, isMetadata: false }
    );
  };
  const closeActionEdit = () => setEditingAction(null);

  const saveActionEdit = async () => {
    if (!editingAction) return;
    const name = editingAction.name.trim();
    // addCustom silently no-ops on an empty name OR prompt (stores/aiPresets.ts) — the Save button
    // below is already disabled for that case, this is a defensive second guard.
    if (!name || (!editingAction.id && !editingAction.prompt.trim())) return;
    setSavingAction(true);
    try {
      if (editingAction.id) {
        await updateItem(editingAction.id, { name, prompt: editingAction.prompt });
      } else {
        await addCustom(name, editingAction.prompt);
      }
      closeActionEdit();
    } catch {
      emitNotice(t("ai.action_save_failed"));
    } finally {
      setSavingAction(false);
    }
  };

  /** delete / reset-to-default: same shape — run a store action on the open item, close on success. */
  const runOnEditingItem = async (run: (id: string) => Promise<unknown>) => {
    if (!editingAction?.id) return;
    setSavingAction(true);
    try {
      await run(editingAction.id);
      closeActionEdit();
    } catch {
      emitNotice(t("ai.action_save_failed"));
    } finally {
      setSavingAction(false);
    }
  };

  return (
    <>
      <div className="mobile-settings-section">
        <div className="mobile-settings-section-label label-caps">{t("settings.ai_tab_presets")}</div>
        {aiEnabled && (
          <>
            <div className="mobile-settings-section-hint">{t("mobile.settings_ai_hint")}</div>
            {visiblePresets(aiPresetList).map((action) => (
              <button
                type="button"
                key={action.id}
                className="mobile-settings-row"
                onClick={() => openActionEdit(action)}
              >
                <span>{action.name}</span>
                <span className="mobile-settings-value" data-testid={`mobile-settings-ai-edit-${action.id}`}>
                  <IconEdit size={16} strokeWidth={2} />
                  <IconCaret dir="right" size={17} />
                </span>
              </button>
            ))}
            <button type="button" className="mobile-settings-row mobile-settings-row--add" onClick={() => openActionEdit()}>
              <span>{t("ai.action_add")}</span>
            </button>
          </>
        )}
        {!aiEnabled && <div className="mobile-settings-section-hint">{t("mobile.settings_ai_off_hint")}</div>}
      </div>

      {editingAction && (
        <MobileModal
          title={editingAction.id ? editingAction.name || t("ai.actions_section") : t("ai.action_add")}
          onClose={closeActionEdit}
          footer={
            <>
              {editingAction.id && editingAction.isBuiltin && (
                <button type="button" className="mobile-text-btn mobile-modal-footer-lead" disabled={savingAction} onClick={() => void runOnEditingItem(resetItem)}>
                  {t("ai.action_reset_default")}
                </button>
              )}
              {editingAction.id && !editingAction.isBuiltin && (
                <button type="button" className="mobile-text-btn mobile-modal-footer-lead" disabled={savingAction} onClick={() => void runOnEditingItem(deleteItem)}>
                  {t("ai.action_delete")}
                </button>
              )}
              <button type="button" className="mobile-text-btn" disabled={savingAction} onClick={closeActionEdit}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="mobile-text-btn mobile-text-btn--accent"
                disabled={savingAction || !editingAction.name.trim() || (!editingAction.id && !editingAction.prompt.trim())}
                onClick={() => void saveActionEdit()}
              >
                {t("mobile.save_button")}
              </button>
            </>
          }
        >
          <input
            className="mobile-preset-ai-input"
            value={editingAction.name}
            placeholder={t("ai.action_name_placeholder")}
            onChange={(e) => setEditingAction((cur) => (cur ? { ...cur, name: e.target.value } : cur))}
          />
          {/* The metadata prompt IS sent to the model as guidance (repo/ai.rs::
              compose_organize_system_prompt composes it with the backend's fixed OUTPUT CONTRACT) —
              same editable posture as desktop's AiActionsSection. */}
          {editingAction.isMetadata && <div className="mobile-ai-disabled-hint">{t("ai.action_metadata_guidance_hint")}</div>}
          <textarea
            className="mobile-settings-prompt-textarea"
            rows={4}
            value={editingAction.prompt}
            placeholder={t("ai.action_prompt_placeholder")}
            onChange={(e) => setEditingAction((cur) => (cur ? { ...cur, prompt: e.target.value } : cur))}
          />
        </MobileModal>
      )}
    </>
  );
}
