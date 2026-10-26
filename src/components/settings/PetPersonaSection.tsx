import { useEffect, useRef, useState } from "react";
import { useSettingsStore } from "../../stores/settings";
import { useNotesStore } from "../../stores/notes";
import { t } from "../../i18n/t";
import { call, emitNotice } from "../../lib/invoke";
import { reportFallback } from "../../lib/diag";
import { createInboxMemo } from "../../lib/noteActions";
import { aiCreds } from "../../stores/ai";
import { row } from "./shared";
import { SubGroup } from "./SubGroup";
import { SettingsRow } from "./SettingsRow";
import { PromptDialog } from "../PromptDialog";
import { PetPersonaEditor } from "./pet/PetPersonaEditor";
import {
  DEFAULT_PET_PERSONA,
  loadPetPersona,
  savePetPersona,
  type PetPersonaPreset,
} from "../../plugins/pet/bridge/petPersona";
import { useLocalOllama } from "./useLocalOllama";
import { IconAction } from "./IconAction";
import { IconTrash } from "../icons";

/**
 * 설정 > AI > ③펫 — 말투/페르소나(docs/PLAN-2026-08-08-presets-schedule.md Q4·Q6).
 *
 * PetSection 에서 이 블록만 떼어 왔다. 남는 쪽(PetSection)은 펫의 비-AI 설정 — 마스터 토글,
 * 트레이 상주, 스프라이트 에셋 — 이라 원래 자리(설정 > 펫)에 그대로 있다.
 *
 * 저장은 어댑터(plugins/pet/bridge/petPersona.ts)를 통해 기존 키(`pet_persona_preset`/`pet_persona_prompt`)로
 * 그대로 간다. Rust 읽기 경로(repo::pet::persona_prompt)와 펫 창은 무변경.
 *
 * 게이트는 PetSection 이 쓰던 것과 같다: 펫이 켜져 있고(pet_enabled) AI 가 답할 수 있을 때
 * (ai_enabled 이거나 로컬 loopback ollama — 백엔드 repo::ai::privacy_gate_ok 와 같은 규칙).
 */

/** 인사이트 추출 프롬프트 — 문단 수만큼 `persona_prompt_N` 키로 쪼개져 있다(PLAN-2026-09-15 D13). */
const INSIGHT_PROMPT_KEYS = [1, 2, 3, 4, 5, 6].map((n) => `settings.persona_prompt_${n}`);

interface PetPersonaSectionProps {
  /** 히어로 배지용 — 로드 시와 변경 시 현재 프리셋을 부모에게 알린다(AiChatSection). */
  onPresetChange?: (preset: PetPersonaPreset) => void;
}

export function PetPersonaSection({ onPresetChange }: PetPersonaSectionProps = {}) {
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  const localOllama = useLocalOllama();
  const [preset, setPreset] = useState<PetPersonaPreset>(DEFAULT_PET_PERSONA.preset);
  const [prompt, setPrompt] = useState(DEFAULT_PET_PERSONA.prompt);
  const [isExtractingInsights, setIsExtractingInsights] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  // 마지막으로 저장됐다고 아는 값 — 저장 실패 시 되돌릴 자리, blur 때 "안 바뀌었으면 생략"의 기준.
  const saved = useRef(DEFAULT_PET_PERSONA);

  useEffect(() => {
    let cancelled = false;
    // loadPetPersona 는 실패해도 기본값으로 풀린다 — 여기 catch 는 반영 단계(부모 콜백)의 예외를 기록한다.
    void loadPetPersona()
      .then((p) => {
        if (cancelled) return;
        saved.current = p;
        setPreset(p.preset);
        setPrompt(p.prompt);
        onPresetChange?.(p.preset);
      })
      .catch((e: unknown) => reportFallback("pet", "persona_load_apply_failed", e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  /** 낙관적으로 바꾼 화면을 저장하고, 실패하면(call() 이 토스트) 마지막 저장값으로 되돌린다. */
  const persist = async (nextPreset: PetPersonaPreset, nextPrompt: string) => {
    if (await savePetPersona(nextPreset, nextPrompt)) {
      saved.current = { preset: nextPreset, prompt: nextPrompt };
      return;
    }
    const back = saved.current;
    setPreset(back.preset);
    setPrompt(back.prompt);
    onPresetChange?.(back.preset);
  };

  const aiChatReady = aiEnabled || localOllama;

  /**
   * F6(PLAN-2026-09-15): 전량 삭제는 확인 한 번을 거치고, 실패는 토스트로 말한다
   * (예전엔 `.catch(() => {})` 로 소각됐다). 기록 관리는 **AI 게이트 밖**이다 —
   * AI 를 끈 사용자가 기록을 지울 방법이 사라지던 자리.
   */
  const doClearChat = async () => {
    setConfirmClear(false);
    try {
      await call("pet_chat_clear", {});
      emitNotice(t("settings.pet_chat_cleared"));
    } catch {
      /* call() 이 이미 실패 토스트를 띄웠다 — 여기서 붙잡기만 한다(함정 8) */
    }
  };

  const clearChatButton = (
    // 확인 모달(PromptDialog)이 지킨다 — 버튼은 여는 것뿐이라 아이콘으로 충분.
    <IconAction
      icon={<IconTrash size={16} />}
      label={t("settings.pet_chat_clear_btn")}
      danger
      onClick={() => setConfirmClear(true)}
      data-testid="settings-pet-chat-clear-btn"
    />
  );

  const handleExtractInsights = async () => {
    if (isExtractingInsights) return;
    setIsExtractingInsights(true);
    try {
      const historyRes = await call<{ messages: Array<{ role: string; text: string }> }>(
        "pet_chat_history",
        { limit: 50 },
      );
      const messages = historyRes?.messages || [];
      if (messages.length === 0) {
        emitNotice(t("settings.pet_chat_history_empty"));
        return;
      }

      const conversationText = messages
        .map((m) => `${m.role === "user" ? t("settings.persona_role_user") : t("settings.persona_role_assistant")}: ${m.text}`)
        .join("\n\n");

      const promptText = INSIGHT_PROMPT_KEYS.map((k) => t(k)).join("\n");

      const res = await call<{ generated: string }>("ai_generate_from_prompt", {
        prompt: promptText,
        context_text: conversationText,
        // D1(AUDIT-2026-09-26) 후속: 이 호출도 provider 를 아예 안 보내 Rust 쪽 provider: String
        // 필수 인자에서 매번 조용히 거부되고 있었다(commands/ai.rs) — aiCreds() 로 실제 크리덴셜을
        // 채운다(stores/ai.ts::aiCreds, 크리덴셜 로직 중복 금지).
        ...(await aiCreds()),
      });

      if (res && res.generated) {
        const now = new Date();
        const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        const title = t("settings.persona_insight_title", { date: dateStr });
        const created = await createInboxMemo(res.generated, title);
        if (created?.note_id) {
          await useNotesStore.getState().selectNote(created.note_id);
        }
        emitNotice(t("settings.pet_chat_insights_saved"));
      }
    } catch (err) {
      // IPC 실패는 call() 이 이미 토스트·기록했다 — 그 밖(메모 생성 뒤 노트 열기 등)도 진단에는 남긴다.
      reportFallback("pet", "insight_extract_failed", err instanceof Error ? err.message : String(err));
    } finally {
      setIsExtractingInsights(false);
    }
  };

  return (
    // 그룹 제목은 "어시스턴트" — "페르소나" 는 안쪽 행(PetPersonaEditor)의 라벨이라 두 번 쓰지 않는다.
    <SubGroup title={t("settings.chat_group_assistant")} data-testid="settings-pet-persona-section">
      {/* AI 게이트는 **편집면에만** 걸린다 — 아래 기록 관리 행은 AI 가 꺼져 있어도 남는다(F6). */}
      {!aiChatReady && (
        <>
          <div style={{ ...row, fontSize: "var(--text-sm)", color: "var(--muted)" }} data-testid="settings-pet-chat-needs-ai">
            {t("settings.pet_chat_needs_ai")}
          </div>
          <SettingsRow
            label={t("settings.pet_chat_clear")}
            hint={t("settings.chat_history_hint")}
            control={clearChatButton}
          />
        </>
      )}
      {aiChatReady && (
        <PetPersonaEditor
          preset={preset}
          prompt={prompt}
          onPresetChange={(next) => {
            setPreset(next);
            onPresetChange?.(next);
            void persist(next, prompt);
          }}
          onPromptChange={setPrompt}
          onPromptBlur={() => {
            if (prompt !== saved.current.prompt || preset !== saved.current.preset) void persist(preset, prompt);
          }}
          onClearChat={() => setConfirmClear(true)}
          onExtractInsights={handleExtractInsights}
          isExtractingInsights={isExtractingInsights}
        />
      )}

      {confirmClear && (
        <PromptDialog
          title={t("settings.pet_chat_clear")}
          description={t("settings.pet_chat_clear_confirm")}
          mode="confirm"
          danger
          confirmLabel={t("settings.pet_chat_clear_btn")}
          onCancel={() => setConfirmClear(false)}
          onSubmit={() => void doClearChat()}
        />
      )}
    </SubGroup>
  );
}
