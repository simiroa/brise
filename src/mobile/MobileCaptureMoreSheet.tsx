import { useState } from "react";
import type { CustomPreset } from "../stores/presets";
import { IconMoreHorizontal } from "../components/icons";
import { MobileModal } from "./MobileModal";
import { t } from "../i18n/t";
import { useSettingsStore } from "../stores/settings";
import { useAiStore, selectAiAvailability, getAiDisabledHint } from "../stores/ai";

export interface MobileCaptureMoreSheetProps {
  customPresets: CustomPreset[];
  aiReady: boolean;
  onApply: (req: { title: string | null; bodyMd: string }) => void;
  onGenerateAi: (topic: string) => Promise<string | null>;
  onRename: (id: string, name: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onClose: () => void;
}

/**
 * 더보기 sheet for capture chips — custom presets, rename/delete, and AI-start.
 * The chip row itself stays in MobileCapturePresets (that's the surface; this is the overflow).
 */
export function MobileCaptureMoreSheet({
  customPresets,
  aiReady,
  onApply,
  onGenerateAi,
  onRename,
  onRemove,
  onClose,
}: MobileCaptureMoreSheetProps) {
  const [aiOpen, setAiOpen] = useState(false);
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  const aiReachable = useAiStore((s) => s.aiReachable);
  const availability = selectAiAvailability({ aiEnabled }, { aiReachable });
  const [aiTopic, setAiTopic] = useState("");
  const [aiPending, setAiPending] = useState(false);
  const [optionsTarget, setOptionsTarget] = useState<CustomPreset | null>(null);
  const [renameTarget, setRenameTarget] = useState<CustomPreset | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<CustomPreset | null>(null);

  const title = renameTarget
    ? t("presets.rename_title")
    : deleteTarget
      ? t("presets.delete_title")
      : optionsTarget
        ? optionsTarget.name
        : t("presets.panel_title");

  const submitAi = async () => {
    const topic = aiTopic.trim();
    if (!topic || aiPending) return;
    setAiPending(true);
    try {
      const generated = await onGenerateAi(topic);
      if (!generated) return;
      onClose();
      onApply({ title: topic, bodyMd: generated });
    } finally {
      setAiPending(false);
    }
  };

  const commitRename = () => {
    const newName = renameDraft.trim();
    if (newName && renameTarget) void onRename(renameTarget.id, newName);
    setRenameTarget(null);
  };

  return (
    <MobileModal
      title={title}
      onClose={onClose}
      footer={
        renameTarget ? (
          <>
            <button type="button" className="mobile-text-btn" onClick={() => setRenameTarget(null)}>
              {t("common.cancel")}
            </button>
            <button type="button" className="mobile-text-btn mobile-text-btn--accent" onClick={commitRename}>
              {t("common.apply")}
            </button>
          </>
        ) : deleteTarget ? (
          <>
            <button type="button" className="mobile-text-btn" onClick={() => setDeleteTarget(null)}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="mobile-text-btn mobile-text-btn--danger"
              onClick={() => {
                void onRemove(deleteTarget.id);
                setDeleteTarget(null);
              }}
            >
              {t("ctx.remove")}
            </button>
          </>
        ) : (
          <button type="button" className="mobile-text-btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
        )
      }
    >
      {renameTarget ? (
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
              commitRename();
            }
          }}
        />
      ) : deleteTarget ? (
        <p>{t("presets.delete_confirm", { name: deleteTarget.name })}</p>
      ) : optionsTarget ? (
        <div className="mobile-ai-actions mobile-modal-options">
          <button
            type="button"
            className="menu-row mobile-ai-action"
            onClick={() => {
              setRenameDraft(optionsTarget.name);
              setRenameTarget(optionsTarget);
              setOptionsTarget(null);
            }}
          >
            {t("ctx.rename")}
          </button>
          <button
            type="button"
            className="menu-row mobile-ai-action"
            onClick={() => {
              setDeleteTarget(optionsTarget);
              setOptionsTarget(null);
            }}
          >
            {t("ctx.remove")}
          </button>
        </div>
      ) : (
        <div className="mobile-ai-actions mobile-modal-options">
          {customPresets.length > 0 && (
            <>
              <div className="label-caps">{t("presets.custom_section")}</div>
              {customPresets.map((p) => (
                <div key={p.id} className="mobile-preset-custom-row">
                  <button
                    type="button"
                    className="menu-row mobile-ai-action"
                    onClick={() => {
                      onClose();
                      onApply({ title: p.name, bodyMd: p.bodyMd });
                    }}
                  >
                    {p.name}
                  </button>
                  <button
                    type="button"
                    className="mobile-icon-btn"
                    title="More options"
                    aria-label="More options"
                    onClick={() => setOptionsTarget(p)}
                  >
                    <IconMoreHorizontal size={16} strokeWidth={2} />
                  </button>
                </div>
              ))}
            </>
          )}
          <div className="label-caps">{t("presets.ai_action_title")}</div>
          <button
            type="button"
            className="menu-row mobile-ai-action"
            disabled={!aiReady}
            title={aiReady ? undefined : getAiDisabledHint(availability, "presets")}
            onClick={() => {
              if (!aiReady) return;
              setAiOpen((v) => !v);
            }}
          >
            {t("presets.ai_name")}
          </button>
          {aiOpen && aiReady && (
            <div className="mobile-preset-ai-row">
              <input
                autoFocus
                className="mobile-preset-ai-input"
                value={aiTopic}
                onChange={(e) => setAiTopic(e.target.value)}
                placeholder={t("presets.ai_topic_placeholder")}
                disabled={aiPending}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void submitAi();
                  }
                }}
              />
              <button
                type="button"
                className="mobile-preset-ai-submit"
                disabled={aiPending || !aiTopic.trim()}
                onClick={() => void submitAi()}
              >
                {aiPending ? t("presets.ai_generating") : t("presets.ai_generate_btn")}
              </button>
            </div>
          )}
        </div>
      )}
    </MobileModal>
  );
}
