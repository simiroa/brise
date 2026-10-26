import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SettingsNav, type SettingsNavItem } from "./SettingsNav";
import { useSettingsStore } from "../../stores/settings";
import { t } from "../../i18n/t";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("0.5.0"),
}));
vi.mock("../../lib/env", () => ({ isBrowser: () => false }));

vi.mock("../../lib/invoke", () => ({
  call: vi.fn(),
  callSilent: vi.fn().mockResolvedValue({ workspaces: [], active_id: "" }),
}));

const ITEMS: SettingsNavItem[] = [
  { id: "general", label: "일반", group: "general" },
  { id: "appearance", label: "모양" },
  { id: "ai", label: "AI", group: "ai" },
];

const ALL_20_CHILDREN_ITEMS: SettingsNavItem[] = [
  { id: "general", label: "일반", group: "general" },
  { id: "editor", label: "에디터", group: "general" },
  { id: "notifications", label: "알림 및 일정", group: "general" },
  { id: "appearance", label: "모양", group: "general" },
  { id: "view", label: "지역", group: "general" },
  { id: "dashboard", label: "대시보드", group: "general" },
  { id: "collect", label: "수집", group: "feature", badge: 3 },
  { id: "connect", label: "연결", group: "feature" },
  { id: "ai", label: "AI", group: "ai", icon: <svg data-testid="test-icon" /> },
  { id: "ai_permissions", label: "권한", group: "ai" },
  { id: "ai_features", label: "기능", group: "ai" },
  { id: "ai_chat", label: "채팅", group: "ai" },
  { id: "data", label: "데이터", group: "system" },
  { id: "license", label: "라이선스", group: "system" },
  { id: "pet", label: "펫", group: "plugins" },
];

describe("SettingsNav", () => {
  beforeEach(() => {
    useSettingsStore.setState({ uiLang: "ko", activeWorkspaceId: null } as never);
  });

  async function renderNav(items: SettingsNavItem[], activeId: string, onSelect = () => {}) {
    render(<SettingsNav items={items} activeId={activeId} onSelect={onSelect} />);
    await waitFor(() => {
      expect(screen.getByTestId("settings-nav-footer").textContent).toContain("v0.5.0");
    });
  }

  it("레일 이름은 i18n 이고, 선택된 항목만 aria-current=page 다", async () => {
    await renderNav(ITEMS, "appearance");
    expect(screen.getByTestId("settings-nav").getAttribute("aria-label")).toBe(t("settings.nav_aria"));
    expect(screen.getByTestId("settings-nav-appearance").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("settings-nav-general").hasAttribute("aria-current")).toBe(false);
  });

  it("그룹 헤더는 좌측정렬이고, 자간이 항목보다 넓다", async () => {
    await renderNav(ITEMS, "general");

    for (const group of ["general", "ai"]) {
      const header = screen.getByTestId(`settings-nav-group-${group}`);
      expect(header.style.textAlign).toBe("left");
      expect(parseFloat(header.style.letterSpacing)).toBeGreaterThanOrEqual(0.12);
      expect(header.style.fontWeight).toBe("400");
    }
  });

  it("항목은 중앙정렬을 유지한다", async () => {
    await renderNav(ITEMS, "general");
    expect(screen.getByTestId("settings-nav-appearance").style.textAlign).toBe("center");
  });

  it("레일은 168px 이고 칠도 우측 선도 없다 — 메인 사이드바처럼 맨 시트 위 (GRILL-2026-10-19 R1-D, D10 ② 대체)", async () => {
    await renderNav(ITEMS, "general");
    const nav = screen.getByTestId("settings-nav");
    expect(nav.style.width).toBe("168px");
    expect(nav.style.background).toBe("");
    expect(nav.style.borderRight).toBe("");
  });

  it("정확히 21개의 직계 자식 요소를 유지한다 (SettingsPanel 계약 — 15페이지·5그룹·푸터; 헤더는 레일 밖 SettingsHeader)", async () => {
    await renderNav(ALL_20_CHILDREN_ITEMS, "general");

    const nav = screen.getByTestId("settings-nav");
    const rendered = Array.from(nav.children).map((el) => el.getAttribute("data-testid"));

    expect(rendered).toEqual([
      "settings-nav-group-general",
      "settings-nav-general",
      "settings-nav-editor",
      "settings-nav-notifications",
      "settings-nav-appearance",
      "settings-nav-view",
      "settings-nav-dashboard",
      "settings-nav-group-feature",
      "settings-nav-collect",
      "settings-nav-connect",
      "settings-nav-group-ai",
      "settings-nav-ai",
      "settings-nav-ai_permissions",
      "settings-nav-ai_features",
      "settings-nav-ai_chat",
      "settings-nav-group-system",
      "settings-nav-data",
      "settings-nav-license",
      "settings-nav-group-plugins",
      "settings-nav-pet",
      "settings-nav-footer",
    ]);
  });

  it("들여쓰기 없음 — AI 서브 항목도 다른 항목과 같은 paddingLeft 다 (D4)", async () => {
    await renderNav(ALL_20_CHILDREN_ITEMS, "general");

    for (const it of ALL_20_CHILDREN_ITEMS) {
      expect(screen.getByTestId(`settings-nav-${it.id}`).style.paddingLeft).toBe("var(--space-4)");
    }
  });

  it("선택된 항목에 알약 하이라이트 스타일이 적용된다", async () => {
    await renderNav(ALL_20_CHILDREN_ITEMS, "ai_features");

    const selectedBtn = screen.getByTestId("settings-nav-ai_features");
    expect(selectedBtn.getAttribute("data-selected")).toBe("true");
    expect(selectedBtn.style.background).toBe("var(--sel)");
    expect(selectedBtn.style.borderRadius).toBe("var(--radius-sm)");
    expect(selectedBtn.style.fontWeight).toBe("600");
    expect(selectedBtn.style.color).toBe("var(--text)");

    const unselectedBtn = screen.getByTestId("settings-nav-general");
    expect(unselectedBtn.getAttribute("data-selected")).toBe("false");
    expect(unselectedBtn.style.fontWeight).toBe("400");
    expect(unselectedBtn.style.color).toBe("var(--muted)");
  });

  it("아이콘은 투명 배경의 16px 선형 아이콘 래퍼로 렌더된다", async () => {
    await renderNav(ALL_20_CHILDREN_ITEMS, "ai");

    const aiBtn = screen.getByTestId("settings-nav-ai");
    const iconWrapper = aiBtn.querySelector("span");
    expect(iconWrapper).not.toBeNull();
    expect(iconWrapper?.style.background).toBe("transparent");
    expect(iconWrapper?.style.width).toBe("16px");
    expect(iconWrapper?.style.height).toBe("16px");
    expect(iconWrapper?.style.color).toBe("var(--accent)");
  });

  it("항목 클릭 시 onSelect 핸들러를 호출한다", async () => {
    const onSelect = vi.fn();
    await renderNav(ALL_20_CHILDREN_ITEMS, "general", onSelect);

    fireEvent.click(screen.getByTestId("settings-nav-ai_chat"));
    expect(onSelect).toHaveBeenCalledWith("ai_chat");
  });
});

describe("SettingsNav — 지연 화면 미리받기 · 점", () => {
  beforeEach(() => {
    useSettingsStore.setState({ uiLang: "ko", activeWorkspaceId: null } as never);
  });

  it("dot 이 있는 항목에만 접근 가능한 라벨의 점이 붙는다 (업데이트 있음 — PLAN-2026-10-24 D2)", () => {
    render(
      <SettingsNav
        items={[
          { id: "general", label: "일반", group: "general", dot: { label: "업데이트 있음" } },
          { id: "editor", label: "에디터", group: "general" },
        ]}
        activeId="editor"
        onSelect={() => {}}
      />,
    );
    const dot = screen.getByTestId("settings-nav-dot-general");
    expect(dot.getAttribute("aria-label")).toBe("업데이트 있음");
    expect(screen.getByTestId("settings-nav-general").contains(dot)).toBe(true);
    expect(screen.queryByTestId("settings-nav-dot-editor")).toBeNull();
  });

  it("레일 항목에 마우스를 올리거나 포커스하면 그 페이지의 지연 화면을 미리 받는다", () => {
    const preload = vi.fn(() => Promise.resolve());
    render(
      <SettingsNav
        items={[{ id: "ai", label: "AI", group: "ai", surfaces: [{ preload }] }, { id: "general", label: "일반" }]}
        activeId="general"
        onSelect={() => {}}
      />,
    );
    fireEvent.pointerEnter(screen.getByTestId("settings-nav-ai"));
    fireEvent.focus(screen.getByTestId("settings-nav-ai"));
    expect(preload).toHaveBeenCalledTimes(2);
    // surfaces 가 없는 항목은 아무것도 받지 않는다(즉시 import 페이지).
    fireEvent.pointerEnter(screen.getByTestId("settings-nav-general"));
    expect(preload).toHaveBeenCalledTimes(2);
  });
});
