import { useState, useRef, useEffect } from "react";
import { t } from "../../i18n/t";
import { Select } from "../Select";
import { ENGINE_INSTRUCTION_DEFS } from "../../stores/aiPrompts";
import { useAiInstructionsStore } from "../../stores/aiInstructions";
import { groupCardStyle } from "./shared";

/**
 * 앱 내부 지침(엔진 지침 16개) 편집기 (PLAN-2026-09-27 §7.1, §8 Q5(b)).
 *
 * 메타데이터 제안 기준, 관계도·시트 JSON 출력 규칙, 에이전트 계획 지침 등
 * 앱이 AI 모델에 함께 보내는 핵심 엔진 지침들을 일반 AI 프리셋 목록과 분리하여
 * 고급 아코디언 UI 안에 안전하게 배치한다.
 */
export function AiInternalInstructionsEditor() {
  const instructions = useAiInstructionsStore((s) => s.instructions);
  const loaded = useAiInstructionsStore((s) => s.loaded);
  const load = useAiInstructionsStore((s) => s.load);
  const setInstruction = useAiInstructionsStore((s) => s.setInstruction);
  const resetInstruction = useAiInstructionsStore((s) => s.resetInstruction);
  const resetAll = useAiInstructionsStore((s) => s.resetAll);

  const [selectedId, setSelectedId] = useState<string>("metadata");
  const [draft, setDraft] = useState<{ id: string; prompt: string } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const selectedDef = ENGINE_INSTRUCTION_DEFS.find((d) => d.id === selectedId) ?? ENGINE_INSTRUCTION_DEFS[0];
  const customPrompt = instructions[selectedDef.id];
  const activePrompt = draft && draft.id === selectedDef.id ? draft.prompt : (customPrompt ?? selectedDef.prompt);
  const isCustomized = customPrompt !== undefined && customPrompt !== selectedDef.prompt;

  const commit = async () => {
    if (!draft) return;
    const { id, prompt } = draft;
    setDraft(null);
    const def = ENGINE_INSTRUCTION_DEFS.find((d) => d.id === id);
    if (!def) return;
    if (prompt.trim() === def.prompt.trim()) {
      await resetInstruction(id);
    } else {
      await setInstruction(id, prompt);
    }
  };

  const handleSelect = async (id: string) => {
    await commit();
    setSelectedId(id);
  };

  const handleResetCurrent = async () => {
    setDraft(null);
    await resetInstruction(selectedDef.id);
  };

  const options = ENGINE_INSTRUCTION_DEFS.map((d) => {
    const customized = instructions[d.id] !== undefined && instructions[d.id] !== d.prompt;
    return {
      value: d.id,
      label: `${t(d.nameKey)} (${d.id})${customized ? " *" : ""}`,
    };
  });

  return (
    <div data-testid="ai-internal-instructions-editor" className="ai-instructions">
      {/* 눈에 띄는 주의 경고 배너 — 모양은 tokens.css .ai-instructions__warning */}
      <div className="ai-instructions__warning" role="note">
        <div className="ai-instructions__warning-title">{t("ai.internal_instructions_warning")}</div>
        <div className="ai-instructions__warning-desc">{t("ai.internal_instructions_desc")}</div>
      </div>

      <div className="ai-instructions__picker">
        <Select
          value={selectedDef.id}
          onChange={(v) => void handleSelect(v)}
          options={options}
          ariaLabel={t("ai.internal_instructions_title")}
          style={{ flex: 1, minWidth: 0 }}
        />
        {isCustomized && (
          <button
            type="button"
            onClick={() => void handleResetCurrent()}
            className="btn btn--sm"
            title={t("ai.action_reset_default")}
          >
            {t("ai.action_reset_default")}
          </button>
        )}
      </div>

      <textarea
        ref={textareaRef}
        value={activePrompt}
        onChange={(e) => setDraft({ id: selectedDef.id, prompt: e.target.value })}
        onBlur={() => void commit()}
        rows={12}
        className="field ai-instructions__prompt"
        aria-label={t(selectedDef.nameKey)}
      />

      <div className="ai-instructions__foot">
        <span className="ai-instructions__custom-mark">
          {isCustomized ? `* ${t("ai.custom_edit_suffix")}` : ""}
        </span>
        {Object.keys(instructions).length > 0 && (
          <button
            type="button"
            onClick={() => void resetAll()}
            className="btn btn--sm btn--danger"
          >
            {t("ai.internal_instructions_reset_all")}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * 설정 > AI > 고급 섹션의 "앱 내부 지침" 아코디언 UI
 */
export function AiInternalInstructionsSection() {
  const [open, setOpen] = useState(false);

  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className="card"
      style={{
        ...groupCardStyle,
        marginTop: "var(--space-6)",
        cursor: "default",
      }}
      data-testid="ai-internal-instructions-accordion"
    >
      <summary
        style={{
          cursor: "pointer",
          fontWeight: 600,
          fontSize: "var(--text-sm)",
          color: "var(--muted)",
          userSelect: "none",
          padding: "var(--space-1) 0",
        }}
      >
        {t("ai.internal_instructions_title")}
      </summary>
      {open && <AiInternalInstructionsEditor />}
    </details>
  );
}
