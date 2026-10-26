import { call, callSilent } from "../../../lib/invoke";

/**
 * 펫 페르소나(말투) 저장 어댑터 — docs/PLAN-2026-08-08-presets-schedule.md Q6("모델·UI 통합,
 * 저장은 유지").
 *
 * 통합 프리셋 UI(설정 > AI > 펫 탭, 모바일 설정의 펫 섹션)는 페르소나를 다른 프리셋과 한자리에서
 * 보여주지만, 저장은 **기존 키 그대로**다: `pet_persona_preset` / `pet_persona_prompt`. 그래야
 * Rust 쪽 읽기 경로(repo::pet::persona_prompt)와 펫 창이 한 줄도 안 바뀐다. 이 파일은 그 두 키를
 * 읽고 쓰는 얇은 어댑터일 뿐이고, 새 키·새 스토어를 만들지 않는다.
 *
 * settings_set 호출을 `entries: { … }` 리터럴로 둔 건 취향이 아니라 게이트 때문이다 —
 * scripts/check-settings-keys.mjs 가 그 리터럴을 찾아 백엔드 allowlist 와 대조한다
 * (AiProviderSection.tsx::persistAiField 의 같은 주석 참고).
 */

export const PET_PERSONA_PRESETS = ["secretary", "friend", "custom"] as const;
export type PetPersonaPreset = (typeof PET_PERSONA_PRESETS)[number];

export interface PetPersona {
  preset: PetPersonaPreset;
  /** preset === "custom" 일 때만 실제로 쓰인다(repo::pet::persona_prompt). */
  prompt: string;
}

export const DEFAULT_PET_PERSONA: PetPersona = { preset: "secretary", prompt: "" };

function asPreset(v: unknown): PetPersonaPreset {
  return (PET_PERSONA_PRESETS as readonly string[]).includes(v as string)
    ? (v as PetPersonaPreset)
    : DEFAULT_PET_PERSONA.preset;
}

/** 이미 settings_get_all 응답을 손에 쥔 호출자용(왕복 한 번 아끼기). */
export function readPetPersona(settings: Record<string, unknown>): PetPersona {
  return {
    preset: asPreset(settings.pet_persona_preset),
    prompt: (settings.pet_persona_prompt as string) || "",
  };
}

/** 선택적 조회 — 실패하면 기본 페르소나로 그린다(callSilent 가 진단에 남기므로 토스트는 없다). 거부하지 않는다. */
export async function loadPetPersona(): Promise<PetPersona> {
  try {
    const r = await callSilent<{ settings: Record<string, unknown> }>("settings_get_all");
    return readPetPersona(r.settings);
  } catch {
    return DEFAULT_PET_PERSONA;
  }
}

/**
 * 사용자 행동의 저장이라 call() 이다 — 실패하면 토스트가 뜨고 false 를 돌려준다. 거부(reject)하지
 * 않는 이유: `void savePetPersona(...)` 로 부르는 호출자(SidebarChat)가 있어 rejection 이 새면 안 된다.
 * 낙관적으로 화면을 바꾼 호출자는 false 를 받으면 되돌린다.
 */
export async function savePetPersona(preset: PetPersonaPreset, prompt: string): Promise<boolean> {
  try {
    await call("settings_set", {
      entries: { pet_persona_preset: preset, pet_persona_prompt: prompt },
    });
    return true;
  } catch {
    return false;
  }
}
