import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useSettingsStore } from "../../stores/settings";
import { SettingsNav, type SettingsNavItem } from "./SettingsNav";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("0.5.0"),
}));
vi.mock("../../lib/env", () => ({ isBrowser: () => false }));

const callSilentMock = vi.fn().mockResolvedValue({ workspaces: [], active_id: "" });
vi.mock("../../lib/invoke", () => ({
  call: vi.fn(),
  callSilent: (...args: unknown[]) => callSilentMock(...args),
}));

const ALL_14_PAGES: SettingsNavItem[] = [
  { id: "general", label: "일반", group: "general", icon: <span data-testid="icon-general">⚙️</span> },
  { id: "notifications", label: "알림 및 일정", group: "general", icon: <span data-testid="icon-notifications">🔔</span> },
  { id: "appearance", label: "모양", group: "general", icon: <span data-testid="icon-appearance">🎨</span> },
  { id: "view", label: "지역", group: "general", icon: <span data-testid="icon-view">📍</span> },
  { id: "dashboard", label: "대시보드", group: "general", icon: <span data-testid="icon-dashboard">📊</span> },
  { id: "collect", label: "수집", group: "feature", badge: 3, icon: <span data-testid="icon-collect">📥</span> },
  { id: "connect", label: "연결", group: "feature", icon: <span data-testid="icon-connect">🔗</span> },
  { id: "ai", label: "AI", group: "ai", icon: <span data-testid="icon-ai">✨</span> },
  { id: "ai_permissions", label: "권한", group: "ai", icon: <span data-testid="icon-ai_permissions">🛡️</span> },
  { id: "ai_features", label: "기능", group: "ai", icon: <span data-testid="icon-ai_features">🔧</span> },
  { id: "ai_chat", label: "채팅", group: "ai", icon: <span data-testid="icon-ai_chat">💬</span> },
  { id: "data", label: "데이터", group: "system", icon: <span data-testid="icon-data">📦</span> },
  { id: "license", label: "라이선스", group: "system", icon: <span data-testid="icon-license">📜</span> },
  { id: "pet", label: "펫", group: "plugins", icon: <span data-testid="icon-pet">🐱</span> },
];

describe("Challenger 1 M2: SettingsNav Empirical Adversarial Challenge", () => {
  beforeEach(() => {
    useSettingsStore.setState({ uiLang: "ko", activeWorkspaceId: null } as never);
    callSilentMock.mockClear();
  });

  async function renderNav(items: SettingsNavItem[], activeId: string, onSelect = () => {}) {
    const utils = render(<SettingsNav items={items} activeId={activeId} onSelect={onSelect} />);
    await waitFor(() => {
      expect(screen.getByTestId("settings-nav-footer").textContent).toContain("v0.5.0");
    });
    return utils;
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * 1. No indent (PLAN-2026-09-15 D4) — group labels carry hierarchy
   * ───────────────────────────────────────────────────────────────────────── */
  describe("Flat rail (D4)", () => {
    it("gives every item the same paddingLeft regardless of group or ai_ prefix", async () => {
      const items: SettingsNavItem[] = [
        { id: "general", label: "일반", group: "general" },
        { id: "ai", label: "AI 루트", group: "ai" },
        { id: "ai_permissions", label: "AI 권한", group: "ai" },
        { id: "other_ai_tool", label: "기타 AI 툴", group: "ai" },
        { id: "ai_scanner", label: "AI 스캐너", group: "feature" },
        { id: "orphan", label: "고아 항목" },
      ];

      await renderNav(items, "general");

      for (const itm of items) {
        expect(screen.getByTestId(`settings-nav-${itm.id}`).style.paddingLeft).toBe("var(--space-4)");
      }
    });
  });

  /* ─────────────────────────────────────────────────────────────────────────
   * 2. Active Selection Switching Across Groups & Pill Highlight Fidelity
   * ───────────────────────────────────────────────────────────────────────── */
  describe("Active Selection Switching Across Groups", () => {
    it("dynamically switches selection across all 5 groups and updates pill styles faithfully", async () => {
      const { rerender } = await renderNav(ALL_14_PAGES, "general");

      const targets = [
        { id: "general", group: "general" },
        { id: "collect", group: "feature" },
        { id: "ai_features", group: "ai" },
        { id: "data", group: "system" },
        { id: "pet", group: "plugins" },
      ];

      for (const target of targets) {
        rerender(<SettingsNav items={ALL_14_PAGES} activeId={target.id} onSelect={() => {}} />);

        // Verify active item styling
        const activeBtn = screen.getByTestId(`settings-nav-${target.id}`);
        expect(activeBtn.getAttribute("data-selected")).toBe("true");
        expect(activeBtn.style.background).toBe("var(--sel)");
        expect(activeBtn.style.fontWeight).toBe("600");
        expect(activeBtn.style.color).toBe("var(--text)");

        // Verify active icon color
        const activeIconWrapper = activeBtn.querySelector("span");
        expect(activeIconWrapper?.style.color).toBe("var(--accent)");

        // Verify all OTHER items remain unselected
        for (const other of ALL_14_PAGES) {
          if (other.id === target.id) continue;
          const otherBtn = screen.getByTestId(`settings-nav-${other.id}`);
          expect(otherBtn.getAttribute("data-selected")).toBe("false");
          expect(otherBtn.style.background).toBe("");
          expect(otherBtn.style.fontWeight).toBe("400");
          expect(otherBtn.style.color).toBe("var(--muted)");

          const otherIconWrapper = otherBtn.querySelector("span");
          expect(otherIconWrapper?.style.color).toBe("var(--muted)");
        }
      }
    });

    it("handles switching within AI sub-tree between parent and child items accurately", async () => {
      const { rerender } = await renderNav(ALL_14_PAGES, "ai");

      // Root AI active
      expect(screen.getByTestId("settings-nav-ai").getAttribute("data-selected")).toBe("true");
      expect(screen.getByTestId("settings-nav-ai_permissions").getAttribute("data-selected")).toBe("false");
      expect(screen.getByTestId("settings-nav-ai_features").getAttribute("data-selected")).toBe("false");

      // Switch to ai_permissions
      rerender(<SettingsNav items={ALL_14_PAGES} activeId="ai_permissions" onSelect={() => {}} />);
      expect(screen.getByTestId("settings-nav-ai").getAttribute("data-selected")).toBe("false");
      expect(screen.getByTestId("settings-nav-ai_permissions").getAttribute("data-selected")).toBe("true");
      expect(screen.getByTestId("settings-nav-ai_permissions").style.background).toBe("var(--sel)");

      // Switch to ai_chat
      rerender(<SettingsNav items={ALL_14_PAGES} activeId="ai_chat" onSelect={() => {}} />);
      expect(screen.getByTestId("settings-nav-ai_permissions").getAttribute("data-selected")).toBe("false");
      expect(screen.getByTestId("settings-nav-ai_chat").getAttribute("data-selected")).toBe("true");
      expect(screen.getByTestId("settings-nav-ai_chat").style.background).toBe("var(--sel)");
    });

    it("handles non-existent or empty activeId gracefully with zero active items", async () => {
      await renderNav(ALL_14_PAGES, "non_existent_page_id");

      for (const itm of ALL_14_PAGES) {
        const btn = screen.getByTestId(`settings-nav-${itm.id}`);
        expect(btn.getAttribute("data-selected")).toBe("false");
        expect(btn.style.background).toBe("");
        expect(btn.style.fontWeight).toBe("400");
      }
    });

    it("survives rapid consecutive 30-step selection transitions without leaking active state", async () => {
      const { rerender } = await renderNav(ALL_14_PAGES, "general");

      for (let i = 0; i < 30; i++) {
        const page = ALL_14_PAGES[i % ALL_14_PAGES.length];
        rerender(<SettingsNav items={ALL_14_PAGES} activeId={page.id} onSelect={() => {}} />);
        expect(screen.getByTestId(`settings-nav-${page.id}`).getAttribute("data-selected")).toBe("true");
      }
    });
  });

  /* ─────────────────────────────────────────────────────────────────────────
   * 3. Badge Rendering & Right Alignment with Long Labels Stress
   * ───────────────────────────────────────────────────────────────────────── */
  describe("Badge Rendering and Layout Stress", () => {
    it("does NOT render badge element for 0, negative values, or undefined", async () => {
      const items: SettingsNavItem[] = [
        { id: "zero_badge", label: "0 뱃지", badge: 0 },
        { id: "neg_badge", label: "음수 뱃지", badge: -10 },
        { id: "undef_badge", label: "미정 뱃지", badge: undefined },
      ];

      await renderNav(items, "zero_badge");

      expect(screen.queryByTestId("settings-nav-badge-zero_badge")).toBeNull();
      expect(screen.queryByTestId("settings-nav-badge-neg_badge")).toBeNull();
      expect(screen.queryByTestId("settings-nav-badge-undef_badge")).toBeNull();
    });

    it("renders badge element with correct styling and count for positive values", async () => {
      const items: SettingsNavItem[] = [
        { id: "b1", label: "뱃지 1", badge: 1 },
        { id: "b99", label: "뱃지 99", badge: 99 },
        { id: "b999", label: "뱃지 999", badge: 999 },
      ];

      await renderNav(items, "b1");

      const badge1 = screen.getByTestId("settings-nav-badge-b1");
      expect(badge1.textContent).toBe("1");
      expect(badge1.style.marginLeft).toBe("auto");
      expect(badge1.style.background).toBe("var(--accent)");
      expect(badge1.style.color).toBe("var(--on-accent)");
      expect(badge1.style.borderRadius).toBe("var(--radius-pill)");
      expect(badge1.style.fontWeight).toBe("600");
      expect(badge1.getAttribute("aria-label")).toBeTruthy();

      const badge99 = screen.getByTestId("settings-nav-badge-b99");
      expect(badge99.textContent).toBe("99");

      const badge999 = screen.getByTestId("settings-nav-badge-b999");
      expect(badge999.textContent).toBe("999");
    });

    it("anchors badge to the right edge with marginLeft: auto even alongside an ultra-long label", async () => {
      const ultraLongLabel =
        "자동으로 감지된 정기 수집 파이프라인의 실시간 동기화 상태와 시스템 이벤트 로그를 통합 관리하는 초장문 설정 메뉴 라벨입니다 ".repeat(3);

      const items: SettingsNavItem[] = [
        {
          id: "long_with_badge",
          label: ultraLongLabel,
          badge: 42,
          icon: <span data-testid="long-icon">📦</span>,
        },
      ];

      await renderNav(items, "long_with_badge");

      const btn = screen.getByTestId("settings-nav-long_with_badge");
      const labelSpan = btn.querySelector<HTMLElement>("span:nth-of-type(2)");
      const badgeSpan = screen.getByTestId("settings-nav-badge-long_with_badge");

      expect(labelSpan).not.toBeNull();
      expect(labelSpan?.textContent).toBe(ultraLongLabel);
      expect(labelSpan?.style.flexGrow).toBe("1");
      expect(labelSpan?.style.textAlign).toBe("left");

      expect(badgeSpan.style.marginLeft).toBe("auto");
      expect(badgeSpan.textContent).toBe("42");
    });

    it("renders badges simultaneously on multiple items across different groups", async () => {
      const items: SettingsNavItem[] = [
        { id: "c1", label: "수집 1", group: "feature", badge: 5 },
        { id: "c2", label: "수집 2", group: "feature", badge: 12 },
        { id: "a1", label: "AI 1", group: "ai", badge: 1 },
      ];

      await renderNav(items, "c1");

      expect(screen.getByTestId("settings-nav-badge-c1").textContent).toBe("5");
      expect(screen.getByTestId("settings-nav-badge-c2").textContent).toBe("12");
      expect(screen.getByTestId("settings-nav-badge-a1").textContent).toBe("1");
    });
  });

  /* ─────────────────────────────────────────────────────────────────────────
   * 4. Keyboard and Mouse Interactions on All 14 Page Buttons
   * ───────────────────────────────────────────────────────────────────────── */
  describe("Interaction on All 14 Page Buttons", () => {
    it("invokes onSelect properly when mouse clicked across all 14 page buttons in order", async () => {
      const onSelect = vi.fn();
      await renderNav(ALL_14_PAGES, "general", onSelect);

      for (const page of ALL_14_PAGES) {
        const btn = screen.getByTestId(`settings-nav-${page.id}`);
        expect(btn.tagName).toBe("BUTTON");
        expect(btn.getAttribute("type")).toBe("button");

        fireEvent.click(btn);
        expect(onSelect).toHaveBeenLastCalledWith(page.id);
      }

      expect(onSelect).toHaveBeenCalledTimes(14);
    });

    it("invokes onSelect properly when clicked in reverse order from pet to general", async () => {
      const onSelect = vi.fn();
      await renderNav(ALL_14_PAGES, "pet", onSelect);

      const reversed = [...ALL_14_PAGES].reverse();
      for (const page of reversed) {
        const btn = screen.getByTestId(`settings-nav-${page.id}`);
        fireEvent.click(btn);
        expect(onSelect).toHaveBeenLastCalledWith(page.id);
      }

      expect(onSelect).toHaveBeenCalledTimes(14);
    });

    it("supports repeated clicks on the active button without throwing or dropping calls", async () => {
      const onSelect = vi.fn();
      await renderNav(ALL_14_PAGES, "general", onSelect);

      const generalBtn = screen.getByTestId("settings-nav-general");
      for (let i = 0; i < 5; i++) {
        fireEvent.click(generalBtn);
      }

      expect(onSelect).toHaveBeenCalledTimes(5);
      expect(onSelect).toHaveBeenLastCalledWith("general");
    });

    it("supports keyboard focus navigation and click activation across all 14 page buttons", async () => {
      const onSelect = vi.fn();
      await renderNav(ALL_14_PAGES, "general", onSelect);

      for (const page of ALL_14_PAGES) {
        const btn = screen.getByTestId(`settings-nav-${page.id}`);
        // Keyboard focus
        btn.focus();
        expect(document.activeElement).toBe(btn);

        // Native button activation
        fireEvent.click(btn);
        expect(onSelect).toHaveBeenLastCalledWith(page.id);
      }

      expect(onSelect).toHaveBeenCalledTimes(14);
    });
  });

  /* ─────────────────────────────────────────────────────────────────────────
   * 5. Edge Cases & Boundary Conditions
   * ───────────────────────────────────────────────────────────────────────── */
  describe("Edge Cases and Structural Integrity", () => {
    it("renders empty items array gracefully with only the footer present", async () => {
      await renderNav([], "none");

      const nav = screen.getByTestId("settings-nav");
      expect(nav).toBeTruthy();
      expect(nav.children.length).toBe(1);
      expect(screen.getByTestId("settings-nav-footer")).toBeTruthy();
    });

    it("renders items without any group header when group is undefined (orphans)", async () => {
      const orphanItems: SettingsNavItem[] = [
        { id: "o1", label: "고아 1" },
        { id: "o2", label: "고아 2" },
      ];

      await renderNav(orphanItems, "o1");

      expect(screen.queryByTestId(/settings-nav-group-/)).toBeNull();
      expect(screen.getByTestId("settings-nav-o1")).toBeTruthy();
      expect(screen.getByTestId("settings-nav-o2")).toBeTruthy();
    });

    it("renders group header again if non-contiguous groups appear", async () => {
      const pingPongItems: SettingsNavItem[] = [
        { id: "g1", label: "일반 1", group: "general" },
        { id: "f1", label: "기능 1", group: "feature" },
        { id: "g2", label: "일반 2", group: "general" },
      ];

      await renderNav(pingPongItems, "g1");

      const headers = screen.getAllByTestId("settings-nav-group-general");
      expect(headers.length).toBe(2);
      expect(screen.getByTestId("settings-nav-group-feature")).toBeTruthy();
    });

    it("renders items without icons cleanly without placeholder gaps", async () => {
      const noIconItems: SettingsNavItem[] = [
        { id: "no_icon", label: "아이콘 없음", group: "general" },
      ];

      await renderNav(noIconItems, "no_icon");

      const btn = screen.getByTestId("settings-nav-no_icon");
      expect(btn.querySelectorAll("span").length).toBe(1); // Only label span
      expect(screen.getByText("아이콘 없음")).toBeTruthy();
    });

    it("safely handles special characters, unicode, and emojis in labels and IDs", async () => {
      const specialItems: SettingsNavItem[] = [
        {
          id: "special_!@#",
          label: "<특수문자 & 이모지 🤖🔥>",
          badge: 7,
          icon: <span>🧪</span>,
        },
      ];

      await renderNav(specialItems, "special_!@#");

      expect(screen.getByTestId("settings-nav-special_!@#")).toBeTruthy();
      expect(screen.getByText("<특수문자 & 이모지 🤖🔥>")).toBeTruthy();
      expect(screen.getByTestId("settings-nav-badge-special_!@#").textContent).toBe("7");
    });

    it("maintains the exact 20 direct children contract: 14 pages, 5 group headers, footer", async () => {
      await renderNav(ALL_14_PAGES, "general");

      const nav = screen.getByTestId("settings-nav");
      const childrenIds = Array.from(nav.children).map((el) => el.getAttribute("data-testid"));

      expect(childrenIds.length).toBe(20);
      expect(childrenIds).toEqual([
        "settings-nav-group-general",
        "settings-nav-general",
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

    it("resiliently handles a massive list of 100 items across multiple groups without crashing", async () => {
      const groups = ["general", "feature", "ai", "system", "plugins"] as const;
      const massiveItems: SettingsNavItem[] = Array.from({ length: 100 }, (_, i) => ({
        id: `item_${i}`,
        label: `대용량 항목 ${i}`,
        group: groups[i % groups.length],
        badge: i % 5 === 0 ? i : undefined,
      }));

      await renderNav(massiveItems, "item_0");

      const nav = screen.getByTestId("settings-nav");
      expect(nav).toBeTruthy();
      expect(screen.getByTestId("settings-nav-item_0")).toBeTruthy();
      expect(screen.getByTestId("settings-nav-item_99")).toBeTruthy();
    });

    it("handles boundary badge values like NaN or non-positive gracefully", async () => {
      const boundaryItems: SettingsNavItem[] = [
        { id: "nan_badge", label: "NaN 뱃지", badge: Number.NaN },
        { id: "zero_dot_five", label: "소수 뱃지", badge: 0.5 },
      ];

      await renderNav(boundaryItems, "nan_badge");

      // NaN > 0 is false, so it must not render
      expect(screen.queryByTestId("settings-nav-badge-nan_badge")).toBeNull();
      // 0.5 > 0 is true, renders 0.5
      expect(screen.getByTestId("settings-nav-badge-zero_dot_five").textContent).toBe("0.5");
    });
  });
});
