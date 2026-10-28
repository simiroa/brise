import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSettingsStore } from "../../stores/settings";
import { AiPermissionsSection } from "./AiPermissionsSection";

const callMock = vi.fn().mockResolvedValue({ settings: {} });
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(),
}));

/**
 * PLAN-2026-09-12 D8/D9 — 이 페이지가 권한 6종의 **유일한 거처**이고, 마스터 스위치는 여기
 * 없다(일반 페이지로 갔다). 검증하는 계약은 셋이다:
 *   ① 6종이 전부 여기 있고, 카드 하나 안의 읽기/쓰기/안전장치 SubGroup 셋으로 갈려 있다
 *      (오너 QA 2026-09-15 R2 — 카드 셋 → 카드 하나)
 *   ② 마스터 토글은 더 이상 이 페이지의 행이 아니다 — 꺼져 있을 때만 배너로 나타난다
 *   ③ 외부 전송 요약은 그대로 산다
 */
describe("AiPermissionsSection", () => {
  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({ settings: {} });
    useSettingsStore.setState({
      uiLang: "ko",
      aiEnabled: true,
      aiPostProcess: true,
      linkSuggestions: false,
      chatReadHistory: true,
      chatReadFiles: true,
      chatWriteEnabled: true,
      collectChatRegister: false,
      aiConfirmBeforeApply: true,
      aiDebugVerbose: false,
      seenFeatureBriefs: [],
    } as never);
  });

  it("권한 6종이 카드 하나 안의 읽기/쓰기/안전장치 SubGroup 셋의 스위치 그리드로 모여 있다 (R2)", () => {
    const { container } = render(<AiPermissionsSection />);

    // 카드는 하나뿐 — SubGroup 셋이 전부 그 안에 있다.
    expect(container.querySelectorAll(".card")).toHaveLength(1);
    const card = screen.getByTestId("settings-ai-permissions");
    expect(card.classList.contains("card")).toBe(true);
    for (const id of ["read", "write", "safety"]) {
      const group = screen.getByTestId(`settings-ai-permissions-${id}`);
      expect(card.contains(group)).toBe(true);
      expect(group.classList.contains("card")).toBe(false);
    }
    // SubGroup 제목이 그대로 산다.
    expect(screen.getByTestId("settings-ai-permissions-read").textContent).toContain("읽기");
    expect(screen.getByTestId("settings-ai-permissions-write").textContent).toContain("쓰기");
    expect(screen.getByTestId("settings-ai-permissions-safety").textContent).toContain("안전장치");

    for (const id of [
      "chat_read_history",
      "chat_read_files",
      "chat_write_enabled",
      "collect_chat_register",
      "ai_confirm_before_apply",
      "ai_debug_verbose",
    ]) {
      expect(screen.getByTestId(`switch-grid-toggle-${id}`)).toBeTruthy();
    }

    // 위험도가 다른 것을 한 격자에 섞지 않는다 — 읽기 2 / 쓰기 2 / 안전장치 2.
    expect(screen.getByTestId("ai-permissions-read-grid").children).toHaveLength(2);
    expect(screen.getByTestId("ai-permissions-write-grid").children).toHaveLength(2);
    expect(screen.getByTestId("ai-permissions-safety-grid").children).toHaveLength(2);
  });

  it("D7: 마스터 스위치 행은 여기 없고, AI 가 켜져 있으면 꺼짐 링크도 뜨지 않는다", () => {
    render(<AiPermissionsSection />);

    expect(screen.queryByTestId("ai-enabled-toggle")).toBeNull();
    expect(screen.queryByTestId("ai-permissions-master-row")).toBeNull();
    expect(screen.queryByTestId("ai-off-link")).toBeNull();
  });

  it("D7: AI 가 꺼져 있으면 켜기 버튼 없이 AI 제공자 페이지로 가는 링크 한 줄만 뜬다", async () => {
    useSettingsStore.setState({ aiEnabled: false } as never);
    const onNavigate = vi.fn();
    render(<AiPermissionsSection onNavigate={onNavigate} />);

    expect(screen.getByTestId("ai-off-link")).toBeTruthy();
    expect(screen.queryByTestId("ai-off-banner-enable")).toBeNull();
    await userEvent.click(screen.getByTestId("ai-off-link-go"));

    expect(onNavigate).toHaveBeenCalledWith("ai");
    // 링크는 읽기만 한다 — 스스로 켜지 않는다.
    expect(useSettingsStore.getState().aiEnabled).toBe(false);
    expect(callMock).not.toHaveBeenCalledWith("settings_set", expect.anything());
  });

  it("여섯 토글이 각자의 설정 키로 저장된다", async () => {
    render(<AiPermissionsSection />);

    const cases: Array<[string, string, boolean]> = [
      ["chat_read_history", "chat_read_history", false],
      ["chat_read_files", "chat_read_files", false],
      ["chat_write_enabled", "chat_write_enabled", false],
      ["collect_chat_register", "collect_chat_register", true],
      ["ai_confirm_before_apply", "ai_confirm_before_apply", false],
      ["ai_debug_verbose", "ai_debug_verbose", true],
    ];

    for (const [id, key, next] of cases) {
      await userEvent.click(screen.getByTestId(`switch-grid-toggle-${id}`));
      expect(callMock).toHaveBeenCalledWith(
        "settings_set",
        expect.objectContaining({ entries: expect.objectContaining({ [key]: next }) }),
      );
    }
  });

  // WCAG 2.5.3 (Label in Name). ko 번역은 짧은 라벨이 긴 라벨의 부분 문자열이라 우연히
  // 통과했고 en/fr 에서만 깨져 있었다 — 그래서 이 테스트는 **세 로케일을 전부** 돈다.
  // 한 로케일만 돌면 지금 고친 바로 그 결함을 다시 못 잡는다.
  it.each(["ko", "en", "fr"])("[%s] 토글의 접근 이름이 화면 라벨을 포함한다 (WCAG 2.5.3)", (lang) => {
    useSettingsStore.setState({ uiLang: lang } as never);
    render(<AiPermissionsSection />);

    for (const id of [
      "chat_read_history",
      "chat_read_files",
      "chat_write_enabled",
      "collect_chat_register",
      "ai_confirm_before_apply",
      "ai_debug_verbose",
    ]) {
      const cell = screen.getByTestId(`switch-grid-cell-${id}`);
      // 셀 구조(SettingsRow): <div><div column><div inline-flex>[<span>라벨</span> + 힌트]</div></div><control/></div> — 라벨 줄 안의
      // 첫 span 이 화면에 보이는 라벨이다(힌트 배지는 라벨이 아니라 옆에 붙는 부가 설명). 2026-10-28 C4: SwitchGrid 가 SettingsRow 로 통일돼 한 단 깊어졌다.
      const visible = cell.firstElementChild?.firstElementChild?.firstElementChild?.textContent ?? "";
      const accessibleName =
        screen.getByTestId(`switch-grid-toggle-${id}`).getAttribute("aria-label") ?? "";

      expect(visible.length).toBeGreaterThan(0);
      expect(accessibleName).toContain(visible);
    }
  });

  it("제목 줄 전체 토글이 읽기·쓰기 권한 4가지를 한꺼번에 켜고 끈다 — 안전장치는 건드리지 않는다", async () => {
    // 전체 토글은 키별 setter 넷이 아니라 배치 setter 한 번(IPC 한 번·롤백 한 번)으로 간다.
    const setters = {
      setSimplePrefs: vi.fn().mockResolvedValue(undefined),
      setChatReadHistory: vi.fn(),
      setChatReadFiles: vi.fn(),
      setChatWriteEnabled: vi.fn(),
      setCollectChatRegister: vi.fn(),
      setAiConfirmBeforeApply: vi.fn(),
      setAiDebugVerbose: vi.fn(),
    };
    useSettingsStore.setState({
      chatReadHistory: true,
      chatReadFiles: true,
      chatWriteEnabled: true,
      collectChatRegister: false,
      ...setters,
    } as never);
    render(<AiPermissionsSection />);
    const master = screen.getByTestId("ai-permissions-master");
    expect(master.getAttribute("aria-checked")).toBe("false"); // 일부만 켜짐 → 꺼진 쪽
    expect(screen.queryByTestId("ai-external-summary")).toBeNull();
    master.click();
    await Promise.resolve();
    expect(setters.setSimplePrefs).toHaveBeenCalledTimes(1);
    expect(setters.setSimplePrefs).toHaveBeenCalledWith({
      chatReadHistory: true,
      chatReadFiles: true,
      chatWriteEnabled: true,
      collectChatRegister: true,
    });
    for (const k of ["setChatReadHistory", "setChatReadFiles", "setChatWriteEnabled", "setCollectChatRegister"] as const) {
      expect(setters[k]).not.toHaveBeenCalled();
    }
    expect(setters.setAiConfirmBeforeApply).not.toHaveBeenCalled();
    expect(setters.setAiDebugVerbose).not.toHaveBeenCalled();
  });
});
