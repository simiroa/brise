import { useEffect, useState } from "react";
import { useSettingsStore } from "../stores/settings";
import { useAiStore, selectAiAvailability, getAiDisabledHint } from "../stores/ai";
import { useNotesStore } from "../stores/notes";
import { useAiPresetsStore, menuActionPresets } from "../stores/aiPresets";
import { runAiAction } from "../stores/runAiAction";
import { isDiagramEditPreset, isSheetEditPreset, type AiActionPreset } from "../stores/aiPrompts";
import { flushAll, emitNotice } from "../lib/invoke";
import { t } from "../i18n/t";
import { MobileModal } from "./MobileModal";

interface MobileAiSheetProps {
  open: boolean;
  onClose: () => void;
  getActiveSection: () => { id: string; body_md: string } | null;
  insertSection: (
    name: string,
    body_md: string,
    targetNoteId: string,
    kind?: "text" | "diagram" | "sheet",
  ) => Promise<void>;
  only?: string[];
  activeSectionKind?: "text" | "diagram" | "sheet";
  replaceSection?: (body_md: string) => Promise<void>;
}

export function MobileAiSheet({
  open,
  onClose,
  getActiveSection,
  insertSection,
  only,
  activeSectionKind,
  replaceSection,
}: MobileAiSheetProps) {
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  const aiReachable = useAiStore((s) => s.aiReachable);
  const list = useAiPresetsStore((s) => s.list);
  const presetsLoaded = useAiPresetsStore((s) => s.loaded);
  const loadPresets = useAiPresetsStore((s) => s.load);

  const [pending, setPending] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [instruction, setInstruction] = useState("");

  useEffect(() => {
    if (open && !presetsLoaded) void loadPresets();
  }, [open, presetsLoaded, loadPresets]);

  useEffect(() => {
    if (!open) {
      setPending(null);
      setEditOpen(false);
      setInstruction("");
    }
  }, [open]);

  if (!open) return null;

  const availability = selectAiAvailability({ aiEnabled }, { aiReachable });
  const ready = availability === "ready";
  const canEditDiagram = activeSectionKind === "diagram" && !!replaceSection;
  const canEditSheet = activeSectionKind === "sheet" && !!replaceSection;

  const visible = menuActionPresets(list)
    .filter((p) => !only || only.includes(p.id))
    .filter((p) => !isDiagramEditPreset(p) || canEditDiagram)
    .filter((p) => !isSheetEditPreset(p) || canEditSheet);

  const run = async (preset: AiActionPreset) => {
    setPending(preset.id);
    try {
      await flushAll();
      const targetNoteId = useNotesStore.getState().activeNote?.note.id;
      if (!targetNoteId) {
        emitNotice(t("editor.note_required_for_section"));
        return;
      }
      const contextText = getActiveSection()?.body_md ?? "";
      // K5(2026-09-06) — getActiveSection()이 곧 이 시트의 "지금" 소스(contextText와 동일한
      // 경로) 라 재대조(runAiAction.ts::applyIfFresh)가 자기 자신과 비교하지 않고 실제로 다시
      // 읽는다. sectionId도 함께 실어 CLAUDE.md 함정 #4(스토어 신선도) 대로 activeNote.sections가
      // 아니라 이 화면이 실제 쓰는 라이브 게터를 그대로 재사용한다.
      const getLive = () => {
        const s = getActiveSection();
        return s ? { sectionId: s.id, source: s.body_md } : null;
      };
      const ok = await runAiAction(preset, {
        contextText,
        insertSection,
        targetNoteId,
        ...(isDiagramEditPreset(preset) && replaceSection
          ? { diagram: { sectionId: getActiveSection()?.id, source: contextText, instruction, replaceSection, getLive } }
          : {}),
        ...(isSheetEditPreset(preset) && replaceSection
          ? { sheet: { sectionId: getActiveSection()?.id, source: contextText, instruction, replaceSection, getLive } }
          : {}),
      });
      if (ok) onClose();
    } finally {
      setPending(null);
    }
  };

  return (
    <MobileModal
      title={t("mobile.ai_sheet_title")}
      onClose={onClose}
      footer={
        <button type="button" className="mobile-text-btn" onClick={onClose}>
          {t("common.close")}
        </button>
      }
    >
      <>
        {!ready && <div className="mobile-ai-disabled-hint">{getAiDisabledHint(availability, "mobile")}</div>}

        {ready && !presetsLoaded && <div className="mobile-ai-disabled-hint">{t("mobile.ai_pending")}</div>}

        {ready && presetsLoaded && (
          <div className="mobile-ai-actions mobile-modal-options">
            {visible.map((preset) => {
              const isEditAction = isDiagramEditPreset(preset) || isSheetEditPreset(preset);
              const placeholder = isDiagramEditPreset(preset)
                ? t("mobile.diagram_edit_placeholder")
                : t("editor.sheet_formula_helper");
              const submitText = isDiagramEditPreset(preset)
                ? t("mobile.diagram_edit_apply")
                : t("ai.action_default_name_sheet_edit");

              return isEditAction ? (
                <div key={preset.id}>
                  <button
                    type="button"
                    className="menu-row mobile-ai-action"
                    disabled={pending !== null}
                    aria-expanded={editOpen}
                    onClick={() => setEditOpen((v) => !v)}
                  >
                    {pending === preset.id ? t("mobile.ai_pending") : preset.name}
                  </button>
                  {editOpen && (
                    <div className="mobile-preset-ai-row">
                      <input
                        autoFocus
                        className="mobile-preset-ai-input"
                        value={instruction}
                        onChange={(e) => setInstruction(e.target.value)}
                        placeholder={placeholder}
                        aria-label={preset.name}
                        disabled={pending !== null}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            void run(preset);
                          }
                        }}
                      />
                      <button
                        type="button"
                        className="mobile-preset-ai-submit"
                        disabled={pending !== null || !instruction.trim()}
                        onClick={() => void run(preset)}
                      >
                        {submitText}
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <button
                  key={preset.id}
                  type="button"
                  className="menu-row mobile-ai-action"
                  disabled={pending !== null}
                  onClick={() => void run(preset)}
                >
                  {pending === preset.id ? t("mobile.ai_pending") : preset.name}
                </button>
              );
            })}
          </div>
        )}
      </>
    </MobileModal>
  );
}
