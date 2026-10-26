import { describe, it, expect, vi, beforeEach } from "vitest";

const callMock = vi.fn();
vi.mock("../../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
}));

import { loadPetPersona, savePetPersona, readPetPersona, DEFAULT_PET_PERSONA } from "./petPersona";

/**
 * 어댑터의 계약은 하나다: 통합 UI 가 무엇을 하든 **기존 두 키**로만 읽고 쓴다
 * (docs/PLAN-2026-08-08-presets-schedule.md Q6 "저장은 유지"). 키가 바뀌면 Rust
 * repo::pet::persona_prompt 와 펫 창이 조용히 옛 값을 계속 읽는다.
 */
describe("petPersona 어댑터", () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockResolvedValue({ ok: true });
  });

  it("저장은 pet_persona_preset / pet_persona_prompt 두 키로만 나간다", async () => {
    await savePetPersona("custom", "짧게 답해");
    expect(callMock).toHaveBeenCalledWith("settings_set", {
      entries: { pet_persona_preset: "custom", pet_persona_prompt: "짧게 답해" },
    });
  });

  it("읽기는 같은 두 키에서, 미저장·불명 값은 기본값(secretary)으로 떨어진다", () => {
    expect(readPetPersona({ pet_persona_preset: "friend", pet_persona_prompt: "야!" })).toEqual({
      preset: "friend",
      prompt: "야!",
    });
    expect(readPetPersona({})).toEqual(DEFAULT_PET_PERSONA);
    // 손으로 넣은 쓰레기 값이 Select 의 value 로 새는 걸 막는다.
    expect(readPetPersona({ pet_persona_preset: "bogus" }).preset).toBe("secretary");
  });

  it("load 는 settings_get_all 한 번만 왕복하고, 실패해도 기본값을 돌려준다", async () => {
    callMock.mockResolvedValueOnce({ settings: { pet_persona_preset: "friend", pet_persona_prompt: "" } });
    expect(await loadPetPersona()).toEqual({ preset: "friend", prompt: "" });
    expect(callMock).toHaveBeenCalledWith("settings_get_all");

    callMock.mockRejectedValueOnce(new Error("offline"));
    expect(await loadPetPersona()).toEqual(DEFAULT_PET_PERSONA);
  });

  it("저장 성공은 true, 실패는 거부하지 않고 false — 호출자가 화면을 되돌린다", async () => {
    expect(await savePetPersona("friend", "")).toBe(true);
    callMock.mockRejectedValueOnce(new Error("VALIDATION"));
    expect(await savePetPersona("friend", "")).toBe(false);
  });
});
