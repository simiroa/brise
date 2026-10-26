import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PetPersonaSection } from "./PetPersonaSection";
import { useSettingsStore } from "../../stores/settings";

const callMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));

function mockBackend(settings: Record<string, unknown>) {
  callMock.mockReset().mockImplementation((cmd: string) => {
    if (cmd === "settings_get_all") return Promise.resolve({ settings });
    if (cmd === "folder_list") return Promise.resolve({ folders: [], notes_by_folder: {} });
    return Promise.resolve({ ok: true });
  });
}

/**
 * 설정 > AI > ③펫 탭 — PetSection 에서 옮겨온 페르소나 UI. 핵심 계약은 "UI 는 통합, 저장은
 * 기존 키 그대로"(Q6): 어떤 화면에서 바꾸든 `pet_persona_preset`/`pet_persona_prompt` 로 나가야
 * Rust 읽기 경로(repo::pet::persona_prompt)와 펫 창이 그대로 동작한다.
 */
describe("PetPersonaSection", () => {
  beforeEach(() => {
    mockBackend({});
    useSettingsStore.setState({ aiEnabled: true, uiLang: "en" } as never);
  });

  it("AI 게이트가 닫혀 있으면(클라우드 + AI 꺼짐) 편집면만 사라지고 기록 관리는 남는다", async () => {
    useSettingsStore.setState({ aiEnabled: false } as never);
    mockBackend({ pet_enabled: "0", ai_provider: "gemini", ai_endpoint: "" });
    render(<PetPersonaSection />);

    await waitFor(() => expect(screen.getByTestId("settings-pet-chat-needs-ai")).toBeTruthy());
    expect(screen.queryByTestId("settings-pet-persona")).toBeNull();
    // F6(PLAN-2026-09-15): 카드가 통째로 사라지면 AI 를 끈 사용자는 기록을 지울 방법이 없다.
    expect(screen.getByTestId("settings-pet-chat-clear-btn")).toBeTruthy();
  });

  // F6: 되돌릴 수 없는 전량 삭제 — 확인 한 번을 거치고, 실패는 토스트로 말한다.
  it("대화 기록 지우기는 확인을 거쳐야 pet_chat_clear 로 간다", async () => {
    mockBackend({ pet_enabled: "1" });
    render(<PetPersonaSection />);

    await userEvent.click(await screen.findByTestId("settings-pet-chat-clear-btn"));
    expect(callMock).not.toHaveBeenCalledWith("pet_chat_clear", {});

    // 취소하면 아무 일도 없다
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(callMock).not.toHaveBeenCalledWith("pet_chat_clear", {});

    await userEvent.click(screen.getByTestId("settings-pet-chat-clear-btn"));
    const buttons = screen.getAllByRole("button", { name: "Delete all" });
    await userEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("pet_chat_clear", {}));
  });

  it("지우기가 실패해도 조용히 삼키지 않는다", async () => {
    mockBackend({ pet_enabled: "1" });
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") return Promise.resolve({ settings: { pet_enabled: "1" } });
      if (cmd === "pet_chat_clear") return Promise.reject(new Error("boom"));
      return Promise.resolve({ ok: true });
    });
    render(<PetPersonaSection />);

    await userEvent.click(await screen.findByTestId("settings-pet-chat-clear-btn"));
    const buttons = screen.getAllByRole("button", { name: "Delete all" });
    await userEvent.click(buttons[buttons.length - 1]);

    // call() 이 토스트를 띄우고 재throw 한다 — 붙잡되 삼키지 않는다(함정 8). 미처리 rejection 이
    // 새지 않고 다이얼로그는 닫힌다.
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("pet_chat_clear", {}));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull());
  });

  it("저장된 페르소나를 읽어와 보여주고, 바꾸면 기존 두 키로 그대로 저장한다", async () => {
    mockBackend({ pet_enabled: "1", pet_persona_preset: "secretary", pet_persona_prompt: "" });
    render(<PetPersonaSection />);

    const persona = await screen.findByTestId("settings-pet-persona");
    // custom 이 아니면 자유 프롬프트 칸은 없다(백엔드가 그때만 읽는다).
    expect(screen.queryByTestId("settings-pet-persona-prompt")).toBeNull();

    await userEvent.click(persona);
    await userEvent.click(screen.getByRole("option", { name: "Custom" }));

    expect(callMock).toHaveBeenCalledWith("settings_set", {
      entries: { pet_persona_preset: "custom", pet_persona_prompt: "" },
    });
    await waitFor(() => expect(screen.getByTestId("settings-pet-persona-prompt")).toBeTruthy());
  });

  it("페르소나 저장이 실패하면 화면이 마지막 저장값으로 되돌아간다", async () => {
    mockBackend({ pet_enabled: "1", pet_persona_preset: "secretary", pet_persona_prompt: "" });
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") {
        return Promise.resolve({ settings: { pet_enabled: "1", pet_persona_preset: "secretary", pet_persona_prompt: "" } });
      }
      if (cmd === "settings_set") return Promise.reject(new Error("VALIDATION"));
      return Promise.resolve({ ok: true });
    });
    const onPresetChange = vi.fn();
    render(<PetPersonaSection onPresetChange={onPresetChange} />);

    const persona = await screen.findByTestId("settings-pet-persona");
    await waitFor(() => expect(onPresetChange).toHaveBeenCalledWith("secretary"));
    await userEvent.click(persona);
    await userEvent.click(screen.getByRole("option", { name: "Custom" }));

    // 낙관적으로 custom 이 됐다가, 저장 실패로 secretary 로 돌아온다(자유 프롬프트 칸도 사라진다).
    await waitFor(() => expect(onPresetChange).toHaveBeenLastCalledWith("secretary"));
    await waitFor(() => expect(screen.queryByTestId("settings-pet-persona-prompt")).toBeNull());
  });

  it("프롬프트를 바꾸지 않고 포커스만 빼면 저장하지 않는다", async () => {
    mockBackend({ pet_enabled: "1", pet_persona_preset: "custom", pet_persona_prompt: "그대로" });
    render(<PetPersonaSection />);
    const box = await screen.findByTestId("settings-pet-persona-prompt");
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe("그대로"));
    await userEvent.click(box);
    await userEvent.tab();
    expect(callMock).not.toHaveBeenCalledWith("settings_set", expect.anything());
  });

  it("custom 프롬프트를 편집하고 포커스를 빼면 preset 과 함께 저장된다", async () => {
    mockBackend({ pet_enabled: "1", pet_persona_preset: "custom", pet_persona_prompt: "" });
    render(<PetPersonaSection />);

    const box = await screen.findByTestId("settings-pet-persona-prompt");
    await userEvent.type(box, "짧게 답해");
    await userEvent.tab();

    expect(callMock).toHaveBeenCalledWith("settings_set", {
      entries: { pet_persona_preset: "custom", pet_persona_prompt: "짧게 답해" },
    });
  });

  it("대화 인사이트 찾기 버튼을 누르면 대화 기록을 분석해 새 노트로 저장한다", async () => {
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "settings_get_all") return Promise.resolve({ settings: { pet_enabled: "1" } });
      if (cmd === "pet_chat_history") {
        return Promise.resolve({
          messages: [
            { role: "user", text: "React 19 마이그레이션 계획을 세워줘" },
            { role: "assistant", text: "React 19에서는 액션과 컴파일러가 도입됩니다." },
          ],
        });
      }
      if (cmd === "ai_generate_from_prompt") {
        return Promise.resolve({ generated: "## React 19 마이그레이션 인사이트\n- 주요 액션 아이템..." });
      }
      if (cmd === "pet_note_create") {
        return Promise.resolve({ note_id: "new-insight-note", title: "대화 인사이트" });
      }
      if (cmd === "folder_list") return Promise.resolve({ folders: [], notes_by_folder: {} });
      return Promise.resolve({ ok: true });
    });

    render(<PetPersonaSection />);

    const extractBtn = await screen.findByTestId("settings-pet-chat-extract-insights");
    await userEvent.click(extractBtn);

    expect(callMock).toHaveBeenCalledWith("pet_chat_history", { limit: 50 });
    expect(callMock).toHaveBeenCalledWith(
      "ai_generate_from_prompt",
      expect.objectContaining({
        // PLAN-2026-09-15 D13: 역할 라벨·프롬프트 본문 모두 t() — uiLang=en 이라 영문으로 나간다.
        context_text: expect.stringContaining("User: React 19 마이그레이션 계획을 세워줘"),
        prompt: expect.stringContaining("Below is the recent conversation"),
      }),
    );
    expect(callMock).toHaveBeenCalledWith(
      "pet_note_create",
      expect.objectContaining({ title: expect.stringMatching(/^Chat insights \(\d{4}-\d{2}-\d{2}\)$/) }),
    );
    expect(callMock).toHaveBeenCalledWith(
      "pet_note_create",
      expect.objectContaining({
        text: "## React 19 마이그레이션 인사이트\n- 주요 액션 아이템...",
      }),
    );
  });
});
