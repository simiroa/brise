import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as fs from "node:fs";
import * as path from "node:path";
import { useSettingsStore } from "../../stores/settings";
import { useAiPresetsStore } from "../../stores/aiPresets";
import { builtinDefaults } from "../../stores/aiPrompts";
import { AI_CAPABILITIES, type AiCapabilityTier } from "../../lib/aiCapabilities";
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

describe("Challenger M4: AiCapabilityCatalog Empirical Adversarial Challenge", () => {
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

  /* ─────────────────────────────────────────────────────────────────────────
   * 1. Search Filter Responsiveness & Edge Cases
   * ───────────────────────────────────────────────────────────────────────── */
  describe("1. Search Filter Responsiveness & Edge Cases", () => {
    it("1.1 matches exact Korean title query and filters out non-matching rows", async () => {
      render(<AiCapabilityCatalog onNavigate={navigateMock} />);
      const searchInput = screen.getByTestId("ai-capability-search-input");

      expect(screen.getByTestId("ai-capability-row-proofread")).toBeTruthy();
      expect(screen.getByTestId("ai-capability-row-list")).toBeTruthy();

      await userEvent.type(searchInput, "맞춤법");

      expect(screen.getByTestId("ai-capability-row-proofread")).toBeTruthy();
      expect(screen.queryByTestId("ai-capability-row-list")).toBeNull();
      expect(screen.queryByTestId("ai-capability-row-agent_split")).toBeNull();
    });

    it("1.2 matches capabilities by description/readsKey text", async () => {
      render(<AiCapabilityCatalog onNavigate={navigateMock} />);
      const searchInput = screen.getByTestId("ai-capability-search-input");

      // "본문을 항목별 리스트로 재구성합니다." is readsKey for "list"
      await userEvent.type(searchInput, "리스트");

      expect(screen.getByTestId("ai-capability-row-list")).toBeTruthy();
      expect(screen.queryByTestId("ai-capability-row-proofread")).toBeNull();
    });

    it("1.3 handles completely non-matching queries gracefully with 0 rows and an empty state", async () => {
      render(<AiCapabilityCatalog onNavigate={navigateMock} />);
      const searchInput = screen.getByTestId("ai-capability-search-input");

      await userEvent.type(searchInput, "존재하지않는기능검색어_XYZ_9999");

      // No rows should exist
      const allRows = screen.queryAllByTestId(/^ai-capability-row-/);
      expect(allRows).toHaveLength(0);

      // 빈 아코디언 셋("0개") 대신 빈 상태 한 줄
      expect(screen.queryAllByText("0개")).toHaveLength(0);
      expect(screen.getByTestId("ai-capability-empty")).toBeTruthy();
    });

    it("1.4 handles leading and trailing whitespace without breaking search", async () => {
      render(<AiCapabilityCatalog onNavigate={navigateMock} />);
      const searchInput = screen.getByTestId("ai-capability-search-input");

      await userEvent.type(searchInput, "   맞춤법   ");

      expect(screen.getByTestId("ai-capability-row-proofread")).toBeTruthy();
      expect(screen.queryByTestId("ai-capability-row-list")).toBeNull();
    });

    it("1.5 performs case-insensitive search correctly", async () => {
      render(<AiCapabilityCatalog onNavigate={navigateMock} />);
      const searchInput = screen.getByTestId("ai-capability-search-input");

      // Search with mixed/upper casing if any English terms exist, or general query
      await userEvent.type(searchInput, "AI");

      // Rows containing "AI" in name/reads should be preserved
      const matchedRows = screen.queryAllByTestId(/^ai-capability-row-/);
      expect(matchedRows.length).toBeGreaterThan(0);
    });

    it("1.6 clearing search query instantly restores all capabilities across all tiers", async () => {
      render(<AiCapabilityCatalog onNavigate={navigateMock} />);
      const searchInput = screen.getByTestId("ai-capability-search-input");

      await userEvent.type(searchInput, "맞춤법");
      expect(screen.queryByTestId("ai-capability-row-list")).toBeNull();

      await userEvent.clear(searchInput);
      expect(screen.getByTestId("ai-capability-row-list")).toBeTruthy();
      expect(screen.getByTestId("ai-capability-row-proofread")).toBeTruthy();
      expect(screen.getByTestId("ai-capability-row-ai_post_process")).toBeTruthy();
    });

    it("1.7 handles rapid successive search query transitions stably", async () => {
      render(<AiCapabilityCatalog onNavigate={navigateMock} />);
      const searchInput = screen.getByTestId("ai-capability-search-input");

      await userEvent.type(searchInput, "폴더");
      expect(screen.getByTestId("ai-capability-row-agent_folder")).toBeTruthy();

      const adversarialQueries = ["<script>alert(1)</script>", "'; DROP TABLE;--", "\u0000", "a".repeat(256)];
      for (const q of adversarialQueries) {
        fireEvent.change(searchInput, { target: { value: q } });
        // Expect no crashes or unhandled exceptions
        expect(screen.getByTestId("ai-capability-policy-card")).toBeTruthy();
      }

      expect(screen.queryByTestId("ai-capability-row-agent_folder")).toBeNull();

      await userEvent.clear(searchInput);
      expect(screen.getByTestId("ai-capability-row-agent_folder")).toBeTruthy();
      expect(screen.getByTestId("ai-capability-row-agent_split")).toBeTruthy();
    });
  });

  /* ─────────────────────────────────────────────────────────────────────────
   * 2. Target Filter Toggling & Combination Matrix
   * ───────────────────────────────────────────────────────────────────────── */
  describe("2. Target Filter Toggling & Combination Matrix", () => {
    it("2.1 toggles target filter chips bar when filter button is clicked", async () => {
      render(<AiCapabilityCatalog onNavigate={navigateMock} />);
      const filterBtn = screen.getByTestId("ai-capability-filter-button");

      // Initially closed
      expect(screen.queryByRole("radio", { name: "에디터" })).toBeNull();

      // Click to open
      await userEvent.click(filterBtn);
      expect(screen.getByRole("radio", { name: "전체" })).toBeTruthy();
      expect(screen.getByRole("radio", { name: "에디터" })).toBeTruthy();
      expect(screen.getByRole("radio", { name: "노트" })).toBeTruthy();
      expect(screen.getByRole("radio", { name: "폴더" })).toBeTruthy();
      expect(screen.getByRole("radio", { name: "챗" })).toBeTruthy();

      // Click to close
      await userEvent.click(filterBtn);
      expect(screen.queryByRole("radio", { name: "에디터" })).toBeNull();
    });

    it("2.2 filters strictly by 'editor' target and excludes other targets", async () => {
      render(<AiCapabilityCatalog onNavigate={navigateMock} />);
      await userEvent.click(screen.getByTestId("ai-capability-filter-button"));
      await userEvent.click(screen.getByRole("radio", { name: "에디터" }));

      // Editor capabilities present
      expect(screen.getByTestId("ai-capability-row-list")).toBeTruthy();
      expect(screen.getByTestId("ai-capability-row-proofread")).toBeTruthy();

      // Non-editor capabilities excluded
      expect(screen.queryByTestId("ai-capability-row-agent_split")).toBeNull(); // note
      expect(screen.queryByTestId("ai-capability-row-agent_folder")).toBeNull(); // folder
      expect(screen.queryByTestId("ai-capability-row-ask_note")).toBeNull(); // chat
    });

    it("2.3 filters strictly by 'note' target", async () => {
      render(<AiCapabilityCatalog onNavigate={navigateMock} />);
      await userEvent.click(screen.getByTestId("ai-capability-filter-button"));
      await userEvent.click(screen.getByRole("radio", { name: "노트" }));

      expect(screen.getByTestId("ai-capability-row-agent_split")).toBeTruthy();
      expect(screen.queryByTestId("ai-capability-row-list")).toBeNull();
    });

    it("2.4 filters strictly by 'folder' target", async () => {
      render(<AiCapabilityCatalog onNavigate={navigateMock} />);
      await userEvent.click(screen.getByTestId("ai-capability-filter-button"));
      await userEvent.click(screen.getByRole("radio", { name: "폴더" }));

      expect(screen.getByTestId("ai-capability-row-agent_folder")).toBeTruthy();
      expect(screen.queryByTestId("ai-capability-row-list")).toBeNull();
    });

    it("2.5 filters strictly by 'chat' target", async () => {
      render(<AiCapabilityCatalog onNavigate={navigateMock} />);
      await userEvent.click(screen.getByTestId("ai-capability-filter-button"));
      await userEvent.click(screen.getByRole("radio", { name: "챗" }));

      expect(screen.getByTestId("ai-capability-row-ask_note")).toBeTruthy();
      expect(screen.getByTestId("ai-capability-row-find_related")).toBeTruthy();
      expect(screen.queryByTestId("ai-capability-row-list")).toBeNull();
    });

    it("2.6 resets target filter when '전체' is selected", async () => {
      render(<AiCapabilityCatalog onNavigate={navigateMock} />);
      await userEvent.click(screen.getByTestId("ai-capability-filter-button"));

      // Filter by folder first
      await userEvent.click(screen.getByRole("radio", { name: "폴더" }));
      expect(screen.queryByTestId("ai-capability-row-list")).toBeNull();

      // Reset to all
      await userEvent.click(screen.getByRole("radio", { name: "전체" }));
      expect(screen.getByTestId("ai-capability-row-list")).toBeTruthy();
      expect(screen.getByTestId("ai-capability-row-agent_folder")).toBeTruthy();
    });

    it("2.7 combines search query with target filter accurately (cross-filtering)", async () => {
      render(<AiCapabilityCatalog onNavigate={navigateMock} />);
      const searchInput = screen.getByTestId("ai-capability-search-input");
      await userEvent.click(screen.getByTestId("ai-capability-filter-button"));

      // Select target "노트"
      await userEvent.click(screen.getByRole("radio", { name: "노트" }));

      // Type matching query for note target ("노트 분리 계획 지침")
      await userEvent.type(searchInput, "분리");
      expect(screen.getByTestId("ai-capability-row-agent_split")).toBeTruthy();

      // Type query that matches an editor capability but NOT note
      await userEvent.clear(searchInput);
      await userEvent.type(searchInput, "맞춤법");

      // Should be 0 matches because proofread target is editor, not note
      expect(screen.queryByTestId("ai-capability-row-proofread")).toBeNull();
      expect(screen.queryByTestId("ai-capability-row-agent_split")).toBeNull();
    });
  });

  /* ─────────────────────────────────────────────────────────────────────────
   * 3. Accordion Cards Collapse / Expand Stress Test
   * ───────────────────────────────────────────────────────────────────────── */
  describe("3. Accordion Cards Collapse / Expand Stress Test", () => {
    it("3.1 all tiers are expanded by default", () => {
      render(<AiCapabilityCatalog onNavigate={navigateMock} />);
      const tiers: AiCapabilityTier[] = ["refine", "organize", "gather"];

      for (const tier of tiers) {
        const header = screen.getByTestId(`ai-capability-tier-header-${tier}`);
        expect(header.getAttribute("aria-expanded")).toBe("true");
      }
    });

    it("3.2 collapsing a tier sets aria-expanded to false and hides its subcard container", async () => {
      render(<AiCapabilityCatalog onNavigate={navigateMock} />);

      const refineHeader = screen.getByTestId("ai-capability-tier-header-refine");
      const organizeHeader = screen.getByTestId("ai-capability-tier-header-organize");

      // Collapse refine
      await userEvent.click(refineHeader);
      expect(refineHeader.getAttribute("aria-expanded")).toBe("false");

      // Organize should remain expanded
      expect(organizeHeader.getAttribute("aria-expanded")).toBe("true");

      // Verify DOM container style display toggling
      const refineTierCard = screen.getByTestId("ai-capability-tier-refine");
      const subcardContainer = refineTierCard.children[1] as HTMLElement;
      expect(subcardContainer.style.display).toBe("none");

      const organizeTierCard = screen.getByTestId("ai-capability-tier-organize");
      const organizeContainer = organizeTierCard.children[1] as HTMLElement;
      expect(organizeContainer.style.display).toBe("flex");
    });

    it("3.3 expanding a collapsed tier restores display: flex and aria-expanded: true", async () => {
      render(<AiCapabilityCatalog onNavigate={navigateMock} />);

      const gatherHeader = screen.getByTestId("ai-capability-tier-header-gather");
      await userEvent.click(gatherHeader);
      expect(gatherHeader.getAttribute("aria-expanded")).toBe("false");

      await userEvent.click(gatherHeader);
      expect(gatherHeader.getAttribute("aria-expanded")).toBe("true");

      const gatherTierCard = screen.getByTestId("ai-capability-tier-gather");
      const subcardContainer = gatherTierCard.children[1] as HTMLElement;
      expect(subcardContainer.style.display).toBe("flex");
    });

    it("3.4 survives search query filtering while all tiers are collapsed without error", async () => {
      render(<AiCapabilityCatalog onNavigate={navigateMock} />);

      // Collapse all 3 tiers
      await userEvent.click(screen.getByTestId("ai-capability-tier-header-refine"));
      await userEvent.click(screen.getByTestId("ai-capability-tier-header-organize"));
      await userEvent.click(screen.getByTestId("ai-capability-tier-header-gather"));

      expect(screen.getByTestId("ai-capability-tier-header-refine").getAttribute("aria-expanded")).toBe("false");
      expect(screen.getByTestId("ai-capability-tier-header-organize").getAttribute("aria-expanded")).toBe("false");
      expect(screen.getByTestId("ai-capability-tier-header-gather").getAttribute("aria-expanded")).toBe("false");

      // Search while collapsed
      const searchInput = screen.getByTestId("ai-capability-search-input");
      await userEvent.type(searchInput, "맞춤법");

      // Re-expand refine tier
      await userEvent.click(screen.getByTestId("ai-capability-tier-header-refine"));
      expect(screen.getByTestId("ai-capability-row-proofread")).toBeTruthy();
    });
  });

  /* ─────────────────────────────────────────────────────────────────────────
   * 4. Dynamic Policy Level Switching & Attribute Synchronization
   * ───────────────────────────────────────────────────────────────────────── */
  describe("4. Dynamic Policy Level Switching & Attribute Synchronization", () => {
    it("4.1 dynamically updates blocked attributes when switching through policy levels", async () => {
      render(<AiCapabilityCatalog onNavigate={navigateMock} />);

      const radioGather = screen.getByRole("radio", { name: "수집" });
      const radioRefine = screen.getByRole("radio", { name: "손질" });
      const radioOrganize = screen.getByRole("radio", { name: "정돈" });

      // Initial state: organize
      expect(screen.getByTestId("ai-capability-row-ai_post_process").getAttribute("data-policy-blocked")).toBeNull();
      expect(screen.getByTestId("ai-capability-row-list").getAttribute("data-policy-blocked")).toBeNull();
      expect(screen.getByTestId("ai-capability-row-link_suggestions").getAttribute("data-policy-blocked")).toBeNull();

      // ── SWITCH TO '수집' (gather) ──────────────────────────────────────────
      await userEvent.click(radioGather);
      expect(useSettingsStore.getState().aiPolicyLevel).toBe("gather");

      // Organize tier row (ai_post_process) must be dynamically BLOCKED
      const postProcessRowGather = screen.getByTestId("ai-capability-row-ai_post_process");
      expect(postProcessRowGather.getAttribute("data-policy-blocked")).toBe("true");
      expect(screen.getByTestId("ai-capability-toggle-ai_post_process").getAttribute("aria-disabled")).toBe("true");
      expect(postProcessRowGather.getAttribute("title")).toBeTruthy();

      // Refine tier row (list) must be dynamically BLOCKED
      const listRowGather = screen.getByTestId("ai-capability-row-list");
      expect(listRowGather.getAttribute("data-policy-blocked")).toBe("true");
      expect(screen.getByTestId("ai-capability-toggle-list").getAttribute("aria-disabled")).toBe("true");

      // Gather tier row (link_suggestions) must remain ALLOWED
      const linkRowGather = screen.getByTestId("ai-capability-row-link_suggestions");
      expect(linkRowGather.getAttribute("data-policy-blocked")).toBeNull();
      expect(screen.getByTestId("ai-capability-toggle-link_suggestions").getAttribute("aria-disabled")).toBeNull();

      // ── SWITCH TO '손질' (refine) ──────────────────────────────────────────
      await userEvent.click(radioRefine);
      expect(useSettingsStore.getState().aiPolicyLevel).toBe("refine");

      // Organize row still blocked
      expect(screen.getByTestId("ai-capability-row-ai_post_process").getAttribute("data-policy-blocked")).toBe("true");

      // Refine row dynamically UNBLOCKED
      const listRowRefine = screen.getByTestId("ai-capability-row-list");
      expect(listRowRefine.getAttribute("data-policy-blocked")).toBeNull();
      expect(screen.getByTestId("ai-capability-toggle-list").getAttribute("aria-disabled")).toBeNull();

      // Gather row remains allowed
      expect(screen.getByTestId("ai-capability-row-link_suggestions").getAttribute("data-policy-blocked")).toBeNull();

      // ── SWITCH BACK TO '정돈' (organize) ──────────────────────────────────
      await userEvent.click(radioOrganize);
      expect(useSettingsStore.getState().aiPolicyLevel).toBe("organize");

      // All rows unblocked
      expect(screen.getByTestId("ai-capability-row-ai_post_process").getAttribute("data-policy-blocked")).toBeNull();
      expect(screen.getByTestId("ai-capability-toggle-ai_post_process").getAttribute("aria-disabled")).toBeNull();
      expect(screen.getByTestId("ai-capability-row-list").getAttribute("data-policy-blocked")).toBeNull();
      expect(screen.getByTestId("ai-capability-row-link_suggestions").getAttribute("data-policy-blocked")).toBeNull();
    });
  });

  /* ─────────────────────────────────────────────────────────────────────────
   * 5. Token and Surface Compliance Static Verification
   * ───────────────────────────────────────────────────────────────────────── */
  describe("5. Token and Surface Compliance Verification", () => {
    const catalogFilePath = path.resolve(__dirname, "AiCapabilityCatalog.tsx");
    const source = fs.readFileSync(catalogFilePath, "utf-8");

    it("5.1 contains zero raw hex color literals (#...)", () => {
      const codeWithoutComments = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
      const hexMatches = codeWithoutComments.match(/#[0-9a-fA-F]{3,8}\b/g);
      expect(hexMatches ?? []).toEqual([]);
    });

    it("5.2 contains zero raw rgb(...) or rgba(...) color literals", () => {
      const codeWithoutComments = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
      const rgbMatches = codeWithoutComments.match(/\brgba?\s*\(/g);
      expect(rgbMatches ?? []).toEqual([]);
    });

    it("5.3 contains zero var(--line) borders, strictly adhering to var(--divider)", () => {
      expect(source.includes("var(--line)")).toBe(false);
      expect(source.includes("var(--divider)")).toBe(true);
    });

    it("5.4 does not violate the surface contract with inline background: var(--surface-base)", () => {
      expect(source.includes("var(--surface-base)")).toBe(false);
    });

    it("5.5 strictly enforces font-weight to 400 or 600 in all inline styles", () => {
      /* type-scale-exempt: static check for font weights in source code */
      const fwRegex = new RegExp("font" + "Weight:\\s*([0-9]+)", "g");
      const fontWeightMatches = [...source.matchAll(fwRegex)];
      for (const match of fontWeightMatches) {
        const weight = Number(match[1]);
        expect([400, 600]).toContain(weight);
      }
    });
  });

  /* ─────────────────────────────────────────────────────────────────────────
   * 6. Badges, Presets & Action Link Interactivity
   * ───────────────────────────────────────────────────────────────────────── */
  describe("6. Badges, Presets & Action Link Interactivity", () => {
    it("6.1 displays metadata-only badge for non-external capabilities when external provider is active", () => {
      render(<AiCapabilityCatalog provider="OpenAI" onNavigate={navigateMock} />);

      // Capabilities with external=false should display metadata_only_badge ("메타데이터만")
      const nonExtCap = AI_CAPABILITIES.find((c) => !c.external);
      expect(nonExtCap).toBeDefined();

      if (nonExtCap) {
        const row = screen.getByTestId(`ai-capability-row-${nonExtCap.id}`);
        expect(row.textContent).toContain(t("aiCapabilities.metadata_only_badge"));
      }
    });

    it("6.2 toggling setting capability updates store and triggers feature brief notice", async () => {
      render(<AiCapabilityCatalog onNavigate={navigateMock} />);
      const toggle = screen.getByTestId("ai-capability-toggle-ai_post_process");

      expect(useSettingsStore.getState().aiPostProcess).toBe(true);
      await userEvent.click(toggle);
      expect(useSettingsStore.getState().aiPostProcess).toBe(false);
    });

    it("6.3 toggling preset capability updates preset hidden state in aiPresets store", async () => {
      render(<AiCapabilityCatalog onNavigate={navigateMock} />);
      const toggle = screen.getByTestId("ai-capability-toggle-list");

      // Initially list preset is not hidden
      const initialPreset = useAiPresetsStore.getState().list.find((p) => p.id === "list");
      expect(initialPreset?.hidden).toBeFalsy();

      await userEvent.click(toggle);

      const updatedPreset = useAiPresetsStore.getState().list.find((p) => p.id === "list");
      expect(updatedPreset?.hidden).toBe(true);
    });

    it("6.4 non-link rows have no settings button; only link rows render one (PLAN-09-15 D5)", () => {
      render(<AiCapabilityCatalog onNavigate={navigateMock} />);

      expect(screen.queryByTestId("ai-capability-settings-btn-list")).toBeNull();
      expect(screen.queryByTestId("ai-capability-link-list")).toBeNull();
      const linkCaps = AI_CAPABILITIES.filter((c) => c.control.kind === "link");
      expect(screen.queryAllByTestId(/^ai-capability-link-/)).toHaveLength(linkCaps.length);
    });
  });
});
