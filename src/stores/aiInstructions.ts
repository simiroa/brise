import { create } from "zustand";
import { call, emitNotice } from "../lib/invoke";
import { t } from "../i18n/t";
import { ENGINE_INSTRUCTION_DEFS } from "./aiPrompts";

/**
 * PLAN-2026-09-27 §7.1 & Q5(b) 앱 내부 지침(엔진 지침 16개) 전용 스토어.
 *
 * 관계도/시트 JSON 규칙, 에이전트 계획, 메타데이터 기준 등 앱 내부 엔진이 사용하는 장문 프롬프트.
 * 일반 AI 프리셋 목록(요청 문장 템플릿)과 완전히 분리되어 `ai_internal_instructions` 설정 키에
 * { [id: string]: string } 형태로 저장된다.
 *
 * 기본값은 code-defined ENGINE_INSTRUCTION_DEFS 이며, 사용자가 수정한 지침만 저장소에 오버라이드된다.
 */

const SETTINGS_KEY = "ai_internal_instructions";

interface AiInstructionsState {
  instructions: Record<string, string>;
  loaded: boolean;
  load: () => Promise<void>;
  updateInstruction: (id: string, prompt: string) => Promise<void>;
  setInstruction: (id: string, prompt: string) => Promise<void>;
  resetInstruction: (id: string) => Promise<void>;
  resetAll: () => Promise<void>;
  getInstruction: (id: string) => string;
  /**
   * AI 프리셋 옛 목록에서 넘어온 지침을 **한 번에** 반영한다(aiPresets.ts 의 일회 이관). `updates[id]` =
   * 문자열이면 재정의로, null 이면 "고친 적 없음"으로 본다. 이미 있는 재정의는 그 값이 옛 목록의 사본
   * (`snapshots[id]`)과 같을 때만 바꾼다 — 같다면 사람이 아니라 옛 이관이 넣은 값이고, 다르다면 설정 화면에서
   * 사람이 고친 값이라 건드리지 않는다.
   */
  /** 저장까지 끝났으면(또는 바꿀 것이 없으면) true. */
  applyMigration: (updates: Record<string, string | null>, snapshots: Record<string, string>) => Promise<boolean>;
}

export const useAiInstructionsStore = create<AiInstructionsState>((set, get) => ({
  instructions: {},
  loaded: false,

  load: async () => {
    try {
      const r = await call<{ settings: Record<string, unknown> }>("settings_get_all");
      const raw = r.settings[SETTINGS_KEY];
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof v === "string") out[k] = v;
        }
        set({ instructions: out, loaded: true });
        return;
      }
      set({ instructions: {}, loaded: true });
    } catch {
      set({ instructions: {}, loaded: true });
    }
  },

  updateInstruction: async (id: string, prompt: string) => {
    const prev = get().instructions;
    const def = ENGINE_INSTRUCTION_DEFS.find((d) => d.id === id);
    // 기본값과 정확히 같으면 저장소에서 해당 키 제거
    const next = { ...prev };
    if (def && prompt === def.prompt) {
      delete next[id];
    } else {
      next[id] = prompt;
    }

    set({ instructions: next });
    try {
      await call("settings_set", { entries: { [SETTINGS_KEY]: next } });
    } catch {
      set({ instructions: prev });
      emitNotice(t("ai.action_save_failed"));
    }
  },

  setInstruction: async (id: string, prompt: string) => {
    return get().updateInstruction(id, prompt);
  },

  resetInstruction: async (id: string) => {
    const prev = get().instructions;
    if (!(id in prev)) return;
    const next = { ...prev };
    delete next[id];
    set({ instructions: next });
    try {
      await call("settings_set", { entries: { [SETTINGS_KEY]: next } });
    } catch {
      set({ instructions: prev });
      emitNotice(t("ai.action_save_failed"));
    }
  },

  resetAll: async () => {
    const prev = get().instructions;
    if (Object.keys(prev).length === 0) return;
    set({ instructions: {} });
    try {
      await call("settings_set", { entries: { [SETTINGS_KEY]: {} } });
    } catch {
      set({ instructions: prev });
      emitNotice(t("ai.action_save_failed"));
    }
  },

  applyMigration: async (updates, snapshots) => {
    const prev = get().instructions;
    const next = { ...prev };
    for (const [id, value] of Object.entries(updates)) {
      const existing = next[id];
      if (existing !== undefined && existing !== snapshots[id]) continue; // 설정 화면에서 사람이 고친 값
      if (value === null) delete next[id];
      else next[id] = value;
    }
    if (JSON.stringify(next) === JSON.stringify(prev)) return true;
    set({ instructions: next });
    try {
      await call("settings_set", { entries: { [SETTINGS_KEY]: next } });
      return true;
    } catch {
      set({ instructions: prev });
      // call() 이 토스트를 띄웠다. 호출자(aiPresets.load)는 목록을 저장하지 않으므로 다음 로드에 이관이 다시 돈다.
      return false;
    }
  },

  getInstruction: (id: string) => {
    const custom = get().instructions[id];
    if (custom !== undefined) return custom;
    return ENGINE_INSTRUCTION_DEFS.find((d) => d.id === id)?.prompt ?? "";
  },
}));

/**
 * 앱 내부 어디서든 엔진 지침을 안전하게 읽어오는 단일 진입점.
 * 사용자가 수정한 지침이 있으면 그것을, 없으면 코드 기본값을 반환한다.
 */
/** 지침 저장소를 읽힌 상태로 만든다 — getEngineInstruction 은 동기라, 안 읽힌 채면 사용자 재정의를 조용히
 *  건너뛰고 코드 기본값을 준다. 지침을 읽는 비동기 경로는 먼저 이것을 부른다. */
export async function ensureEngineInstructions(): Promise<void> {
  const s = useAiInstructionsStore.getState();
  if (!s.loaded) await s.load();
}

export function getEngineInstruction(id: string): string {
  const custom = useAiInstructionsStore.getState().instructions[id];
  if (custom !== undefined) return custom;
  return ENGINE_INSTRUCTION_DEFS.find((d) => d.id === id)?.prompt ?? "";
}
