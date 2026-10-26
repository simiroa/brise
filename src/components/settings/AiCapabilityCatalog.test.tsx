import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSettingsStore } from "../../stores/settings";
import { useAiPresetsStore } from "../../stores/aiPresets";
import { builtinDefaults } from "../../stores/aiPrompts";
import { AI_CAPABILITIES } from "../../lib/aiCapabilities";
import { t } from "../../i18n/t";
import { AiCapabilityCatalog } from "./AiCapabilityCatalog";

const callMock = vi.fn().mockResolvedValue({ settings: {} });
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(),
}));

/**
 * W11(§6-A, docs/PLAN-2026-08-30-ai-surface-and-clients.md): 전역 AI 정책 레벨 세그먼트 +
 * 정책/마스터 두 disabled 사유의 구분. logic 자체(isTierAllowed/AI_POLICY_LEVELS)는
 * lib/aiCapabilities.test.ts 가 이미 덮는다 — 여기서는 그 결과가 실제 DOM(토글 disabled·배지)에
 * 정확히 반영되는지만 본다.
 */
describe("AiCapabilityCatalog — 전역 AI 정책 레벨", () => {
  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({ settings: {} });
    useSettingsStore.setState({
      uiLang: "ko",
      aiEnabled: true,
      aiPolicyLevel: "organize",
      aiPostProcess: true,
      linkSuggestions: false,
      aiChatMemory: true,
    } as any);
    useAiPresetsStore.setState({ list: builtinDefaults(), loaded: true });
  });

  it("세그먼트 컨트롤이 손질/정돈/수집 3택으로 렌더된다", () => {
    render(<AiCapabilityCatalog onNavigate={() => {}} />);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(radios.map((r) => r.textContent)).toEqual(
      expect.arrayContaining(["손질", "정돈", "수집"]),
    );
  });

  it("기본 정책(organize)에서는 어느 행에도 정책 제한 배지가 뜨지 않는다", () => {
    render(<AiCapabilityCatalog onNavigate={() => {}} />);
    expect(screen.getByTestId("ai-capability-row-ai_post_process").getAttribute("data-policy-blocked")).toBeNull();
    expect(screen.getByTestId("ai-capability-row-list").getAttribute("data-policy-blocked")).toBeNull();
    expect(screen.getByTestId("ai-capability-toggle-ai_post_process").getAttribute("aria-disabled")).toBeNull();
  });

  it("세그먼트에서 '손질'을 클릭하면 정책이 refine 으로 바뀐다", async () => {
    render(<AiCapabilityCatalog onNavigate={() => {}} />);
    await userEvent.click(screen.getByRole("radio", { name: "손질" }));
    expect(useSettingsStore.getState().aiPolicyLevel).toBe("refine");
  });

  it("gather 정책에서는 organize/refine tier 행이 잠기고, gather tier 행은 그대로 켜진다", () => {
    useSettingsStore.setState({ aiPolicyLevel: "gather" } as any);
    render(<AiCapabilityCatalog onNavigate={() => {}} />);

    // organize tier (설정 킬스위치) — 잠김 + 배지.
    expect(screen.getByTestId("ai-capability-row-ai_post_process").getAttribute("data-policy-blocked")).toBe("true");
    expect(screen.getByTestId("ai-capability-toggle-ai_post_process").getAttribute("aria-disabled")).toBe("true");

    // refine tier (프리셋 토글: "목록으로 정리") — 잠김 + 배지.
    expect(screen.getByTestId("ai-capability-row-list").getAttribute("data-policy-blocked")).toBe("true");
    expect(screen.getByTestId("ai-capability-toggle-list").getAttribute("aria-disabled")).toBe("true");

    // gather tier (링크 붙여넣기 제안) — 정책과 무관하게 항상 허용, 배지 없음, 안 잠김.
    // (같은 gather tier 의 ai_chat_memory 는 PLAN-2026-09-01 W0 로 "AI 채팅" 페이지 링크가 돼서
    //  여기 토글이 없다 — 토글이 남아 있는 gather 행으로 같은 사실을 본다.)
    expect(screen.getByTestId("ai-capability-row-link_suggestions").getAttribute("data-policy-blocked")).toBeNull();
    expect(screen.getByTestId("ai-capability-toggle-link_suggestions").getAttribute("aria-disabled")).toBeNull();
  });

  it("마스터(aiEnabled) 꺼짐과 정책 잠금은 서로 다른 신호를 낸다 — 마스터 꺼짐은 배지를 달지 않는다", () => {
    // 정책은 organize(전부 허용)인데 마스터만 꺼진 경우: 전 행이 disabled 지만 정책 배지는 하나도
    // 없어야 한다 — "왜 꺼졌는지"가 위 마스터 스위치라는 게 이미 명백하므로 배지로 중복 안내하지
    // 않는다(오너 요구: 두 사유를 구분해서 안내).
    useSettingsStore.setState({ aiEnabled: false, aiPolicyLevel: "organize" } as any);
    render(<AiCapabilityCatalog onNavigate={() => {}} />);

    expect(screen.getByTestId("ai-capability-toggle-ai_post_process").getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByTestId("ai-capability-row-ai_post_process").getAttribute("data-policy-blocked")).toBeNull();
  });
});

describe("AiCapabilityCatalog — 현대적 AI 관리 센터 UI & 상호작용", () => {
  const navigateMock = vi.fn();

  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({ settings: {} });
    navigateMock.mockReset();
    useSettingsStore.setState({
      uiLang: "ko",
      aiEnabled: true,
      aiPolicyLevel: "organize",
      aiPostProcess: true,
      linkSuggestions: false,
      aiChatMemory: true,
    } as any);
    useAiPresetsStore.setState({ list: builtinDefaults(), loaded: true });
  });

  it("정책 수준은 맨 위 카드의 첫 줄이고, 힌트는 HintBadge 다", () => {
    render(<AiCapabilityCatalog onNavigate={navigateMock} />);
    const card = screen.getByTestId("ai-capability-policy-card");
    expect(within(card).getByText("AI 기능 레벨")).toBeTruthy();
    // ⓘ 는 접근 이름을 가진 HintBadge — 툴팁만 있는 맨 span 이 아니다.
    expect(within(card).getAllByLabelText(/이 레벨을 넘는 기능은/).length).toBeGreaterThan(0);
  });

  it("값이 적은 통계 타일 띠(전체/활성/카테고리)는 없다", () => {
    render(<AiCapabilityCatalog onNavigate={navigateMock} />);
    expect(screen.queryByTestId("ai-capability-metrics")).toBeNull();
    expect(screen.queryByTestId("metric-tile-total")).toBeNull();
  });

  it("검색칸은 표준 .field 이고, 아무것도 못 찾으면 빈 상태 한 줄을 보인다", async () => {
    render(<AiCapabilityCatalog onNavigate={navigateMock} />);
    const searchInput = screen.getByTestId("ai-capability-search-input");
    expect(searchInput.classList.contains("field")).toBe(true);
    expect(screen.queryByTestId("ai-capability-empty")).toBeNull();
    await userEvent.type(searchInput, "zzzz-nothing-matches");
    expect(screen.getByTestId("ai-capability-empty").textContent).toBe("검색과 일치하는 AI 기능이 없습니다.");
    expect(screen.queryByTestId("ai-capability-tier-refine")).toBeNull();
  });

  it("필터 칩은 aria-pressed 로 선택 상태를 알린다", async () => {
    render(<AiCapabilityCatalog onNavigate={navigateMock} />);
    await userEvent.click(screen.getByTestId("ai-capability-filter-button"));
    const all = screen.getByRole("button", { name: "전체" });
    expect(all.getAttribute("aria-pressed")).toBe("true");
    const chips = screen.getAllByRole("button").filter((b) => b.getAttribute("aria-pressed") === "false");
    expect(chips.length).toBeGreaterThan(0);
    await userEvent.click(chips[0]);
    expect(chips[0].getAttribute("aria-pressed")).toBe("true");
    expect(all.getAttribute("aria-pressed")).toBe("false");
  });

  it("실시간 검색창에 검색어를 입력하면 기능 행이 실시간으로 필터링된다", async () => {
    render(<AiCapabilityCatalog onNavigate={navigateMock} />);
    const searchInput = screen.getByTestId("ai-capability-search-input");

    // 초기 상태에서는 여러 행이 존재
    expect(screen.getByTestId("ai-capability-row-list")).toBeTruthy();
    expect(screen.getByTestId("ai-capability-row-proofread")).toBeTruthy();

    // "맞춤법" 검색
    await userEvent.type(searchInput, "맞춤법");

    // proofread는 보이고 list는 필터링됨
    expect(screen.getByTestId("ai-capability-row-proofread")).toBeTruthy();
    expect(screen.queryByTestId("ai-capability-row-list")).toBeNull();

    // 검색어 지우기
    await userEvent.clear(searchInput);
    expect(screen.getByTestId("ai-capability-row-list")).toBeTruthy();
  });

  it("필터 버튼을 클릭하면 타깃 필터 칩들이 노출되고 특정 타깃으로 필터링할 수 있다", async () => {
    render(<AiCapabilityCatalog onNavigate={navigateMock} />);
    const filterBtn = screen.getByTestId("ai-capability-filter-button");

    // 필터 버튼 클릭하여 칩 표시
    await userEvent.click(filterBtn);
    expect(screen.getByRole("button", { name: "에디터" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "폴더" })).toBeTruthy();

    // "폴더" 칩 클릭
    await userEvent.click(screen.getByRole("button", { name: "폴더" }));

    // 폴더 타깃인 agent_folder는 보이고, 에디터 타깃인 list는 제외됨
    expect(screen.getByTestId("ai-capability-row-agent_folder")).toBeTruthy();
    expect(screen.queryByTestId("ai-capability-row-list")).toBeNull();

    // "전체" 클릭으로 복원
    await userEvent.click(screen.getByRole("button", { name: "전체" }));
    expect(screen.getByTestId("ai-capability-row-list")).toBeTruthy();
  });

  it("아코디언 카드가 기본적으로 펼쳐져 있고 헤더 클릭으로 접고 펼 수 있다", async () => {
    render(<AiCapabilityCatalog onNavigate={navigateMock} />);

    // 아코디언 헤더들 확인
    const refineHeader = screen.getByTestId("ai-capability-tier-header-refine");
    expect(refineHeader.getAttribute("aria-expanded")).toBe("true");

    // 기본적으로 펼쳐져 있어 행들이 접근 가능
    expect(screen.getByTestId("ai-capability-row-list")).toBeTruthy();

    // 헤더 클릭으로 토글
    await userEvent.click(refineHeader);
    expect(refineHeader.getAttribute("aria-expanded")).toBe("false");

    // 다시 클릭하여 펼침
    await userEvent.click(refineHeader);
    expect(refineHeader.getAttribute("aria-expanded")).toBe("true");
  });

  it("기능 행에 메타데이터 배지(타깃, 자동/수동 실행, 지침 전용)가 올바르게 렌더링된다", () => {
    render(<AiCapabilityCatalog onNavigate={navigateMock} />);

    const listRow = screen.getByTestId("ai-capability-row-list");
    expect(listRow.textContent).toContain("에디터");
    expect(listRow.textContent).toContain("자동 실행");

    const splitRow = screen.getByTestId("ai-capability-row-agent_split");
    expect(splitRow.textContent).toContain("노트");
    expect(splitRow.textContent).toContain("수동 실행");
    expect(splitRow.textContent).toContain("지침 전용");
  });

  it("링크 타입 기능 행의 설정 버튼을 누르면 해당 페이지로 이동한다", async () => {
    render(<AiCapabilityCatalog onNavigate={navigateMock} />);

    const linkBtn = screen.getByTestId("ai-capability-link-collect_nl_source");
    await userEvent.click(linkBtn);
    expect(navigateMock).toHaveBeenCalledWith("collect");
  });

  it("링크가 아닌 행에는 설정 버튼이 없고, ⓘ 툴팁이 상세 설명(detailKey)을 담는다 (PLAN-09-15 D5)", () => {
    render(<AiCapabilityCatalog onNavigate={navigateMock} />);

    const cap = AI_CAPABILITIES.find((c) => c.id === "list")!;
    expect(cap.control.kind).not.toBe("link");
    const row = screen.getByTestId("ai-capability-row-list");
    expect(row.querySelector('[data-testid^="ai-capability-settings-btn-"]')).toBeNull();
    expect(row.querySelector('[data-testid^="ai-capability-link-"]')).toBeNull();
    expect(within(row).getByTitle(t(cap.detailKey))).toBeTruthy();
  });

  // F2(PLAN-2026-09-15): 로드맵 배너는 통째로 사라졌다 — "보기" 버튼이 아무 데도 가지 않았다.
  it("하단 로드맵 배너가 더 이상 없다", () => {
    render(<AiCapabilityCatalog onNavigate={navigateMock} />);
    expect(screen.queryByTestId("ai-capability-roadmap-banner")).toBeNull();
  });
});
