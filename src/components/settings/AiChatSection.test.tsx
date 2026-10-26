import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AiChatSection } from "./AiChatSection";
import { useSettingsStore } from "../../stores/settings";

// PLAN-2026-09-01 W0 — 사용자 이름은 일반 탭에서, 챗 메모리는 펫 페이지에서 이 페이지로 왔다.
// 두 검사 모두 원래 자리(GeneralSection.test.tsx · PetSection.test.tsx 13.5)에서 옮겨온 것이다.
//
// PLAN-2026-09-12 D8 — "챗봇 권한" 카드는 한때 여기서 사라지고 AI 권한 페이지 한 곳으로만
// 모였었다. PLAN-2026-09-14 D8이 정정: 읽기 2·쓰기 2는 이 페이지에도 다시 노출한다(안전장치
// 2종만 권한 페이지 전용으로 남음) — 같은 스토어 키를 그리는 두 번째 뷰라 저장 계약은 여전히
// AiPermissionsSection.test.tsx 가 본다.

const callMock = vi.fn().mockResolvedValue({});
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(),
}));

describe("AiChatSection", () => {
  beforeEach(() => {
    callMock.mockClear();
    useSettingsStore.setState({
      userName: "",
      chatMemory: [],
      aiChatMemory: true,
      uiLang: "ko",
      chatReadHistory: true,
      chatReadFiles: true,
      chatWriteEnabled: true,
      collectChatRegister: false,
      filterRoster: [
        { mode: "region", enabled: true },
        { mode: "timeline", enabled: true },
        { mode: "calendar", enabled: true },
        { mode: "gallery", enabled: true },
        { mode: "chat", enabled: true },
      ],
    } as never);
  });

  it("페르소나와 인터페이스, 권한 링크, 대화 기억의 3카드 구조로 구성된다 (onNavigate 전달 시)", () => {
    const { container } = render(<AiChatSection onNavigate={vi.fn()} />);
    const cards = container.querySelectorAll(".card");
    expect(cards.length).toBe(3);
    // 게이지·표는 카드 밖(오너 R1): 통계 스트립과 표는 박스에 넣지 않는다.
    expect(screen.getByTestId("settings-chat-memory-gauge").closest(".card")).toBeNull();
    expect(screen.getByText("기억 내용").closest(".card")).toBeNull();

    // Card 1: 페르소나 및 사용자 이름, 사이드바 토글
    expect(screen.getByTestId("settings-pet-persona-section")).toBeTruthy();
    expect(screen.getByText("사용자 이름")).toBeTruthy();
    expect(screen.getByTestId("settings-ai-chat-sidebar-toggle")).toBeTruthy();
    const input = screen.getByPlaceholderText("이름 입력 (선택)");
    expect(input.getAttribute("maxlength")).toBe("64");

    // Card 2: 권한 링크
    expect(screen.getByTestId("settings-ai-chat-permissions-card")).toBeTruthy();
    expect(screen.getByTestId("settings-ai-chat-permissions-link")).toBeTruthy();

    // Card 3: 대화 기억 및 자동 기억 추출 토글
    expect(screen.getByText("챗 메모리 자동 추출")).toBeTruthy();
    expect(screen.getByTestId("settings-ai-chat-memory-toggle")).toBeTruthy();
    expect(screen.getByTestId("settings-chat-memory-section")).toBeTruthy();
  });

  it("Wave SET (2026-10-18): 권한 토글 대신 'AI 권한 열기' 링크가 렌더되고 클릭 시 ai_permissions로 이동한다", async () => {
    const onNavigate = vi.fn();
    render(<AiChatSection onNavigate={onNavigate} />);

    // 격자 토글은 렌더되지 않는다
    expect(screen.queryByTestId("ai-chat-permissions-grid")).toBeNull();
    for (const id of [
      "switch-grid-toggle-chat_read_history",
      "switch-grid-toggle-chat_read_files",
      "switch-grid-toggle-chat_write_enabled",
      "switch-grid-toggle-collect_chat_register",
    ]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }

    // 링크 버튼 검증
    const linkBtn = screen.getByTestId("settings-ai-chat-permissions-link");
    expect(linkBtn).toBeTruthy();
    expect(linkBtn.textContent).toBe("AI 권한 열기");

    await userEvent.click(linkBtn);
    expect(onNavigate).toHaveBeenCalledWith("ai_permissions");
  });

  it("onNavigate가 전달되지 않으면 권한 링크 행/카드를 렌더하지 않는다", () => {
    render(<AiChatSection />);
    expect(screen.queryByTestId("settings-ai-chat-permissions-link")).toBeNull();
    expect(screen.queryByTestId("settings-ai-chat-permissions-card")).toBeNull();
  });

  it("사이드바 AI 채팅 토글을 누르면 filterRoster 가 업데이트된다", async () => {
    render(<AiChatSection />);
    const toggle = screen.getByTestId("settings-ai-chat-sidebar-toggle");
    await userEvent.click(toggle);

    const roster = useSettingsStore.getState().filterRoster;
    expect(roster.find((r) => r.mode === "chat")?.enabled).toBe(false);
  });

  it("사용자 이름을 입력하고 블러하면 스토어에 반영된다 (입력 중에는 IPC 안 쏨)", () => {
    render(<AiChatSection />);
    callMock.mockClear();
    const input = screen.getByPlaceholderText("이름 입력 (선택)");
    fireEvent.change(input, {
      target: { value: "홍길동" },
    });
    // 입력 중에는 settings_set 호출 없음
    expect(callMock).not.toHaveBeenCalledWith("settings_set", expect.anything());

    fireEvent.blur(input);
    expect(useSettingsStore.getState().userName).toBe("홍길동");
    expect(callMock).toHaveBeenCalledWith(
      "settings_set",
      expect.objectContaining({ entries: expect.objectContaining({ user_name: "홍길동" }) }),
    );
  });

  it("기억을 추가하면 chat_memory 로 저장된다", async () => {
    render(<AiChatSection />);

    expect(screen.getByTestId("settings-chat-memory-section")).toBeTruthy();
    await userEvent.type(screen.getByTestId("settings-chat-memory-input"), "고양이를 키움");
    await userEvent.click(screen.getByTestId("settings-chat-memory-add-btn"));

    expect(callMock).toHaveBeenCalledWith(
      "settings_set",
      expect.objectContaining({
        entries: expect.objectContaining({
          chat_memory: expect.arrayContaining([expect.objectContaining({ text: "고양이를 키움" })]),
        }),
      }),
    );
  });

  it("자동 기억 추출 토글이 ai_chat_memory 를 저장한다", async () => {
    render(<AiChatSection />);
    await userEvent.click(screen.getByTestId("settings-ai-chat-memory-toggle"));

    expect(useSettingsStore.getState().aiChatMemory).toBe(false);
    expect(callMock).toHaveBeenCalledWith(
      "settings_set",
      expect.objectContaining({ entries: expect.objectContaining({ ai_chat_memory: false }) }),
    );
  });

  it("페이지엔 아래 행 값을 되풀이하는 배지가 없다(페르소나·사이드바 노출은 행이 보여 준다)", () => {
    render(<AiChatSection />);
    expect(screen.queryByTestId("ai-chat-persona-badge")).toBeNull();
    expect(screen.queryByTestId("ai-chat-sidebar-badge")).toBeNull();
  });

  it("카드 1 은 어시스턴트 / 프로필 SubGroup 2개이고, '페르소나' 는 그룹 제목으로 겹쳐 쓰지 않는다", async () => {
    useSettingsStore.setState({ aiEnabled: true } as never);
    render(<AiChatSection />);
    const group = screen.getByTestId("settings-pet-persona-section");
    expect(group.textContent).toContain("어시스턴트");
    const card1 = screen.getByTestId("settings-ai-chat-persona-card");
    expect(card1.querySelector("[data-testid=settings-pet-persona-section]")).toBeTruthy();
    // 편집면이 열리면(AI 켜짐) "페르소나" 는 행 라벨 한 번뿐이다.
    expect(await screen.findByTestId("settings-pet-persona")).toBeTruthy();
    expect(screen.getAllByText("페르소나").length).toBe(1);
    const profile = screen.getByTestId("settings-ai-chat-profile");
    expect(profile.textContent).toContain("프로필");
    expect(profile.contains(screen.getByTestId("settings-ai-chat-sidebar-toggle"))).toBe(true);
  });
});
