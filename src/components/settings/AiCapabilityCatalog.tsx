import { useEffect, useState, useMemo, type ReactNode } from "react";
import { useSettingsStore, type SimplePrefKey } from "../../stores/settings";
import { useAiPresetsStore } from "../../stores/aiPresets";
import { t } from "../../i18n/t";
import {
  AI_CAPABILITIES,
  AI_POLICY_LEVELS,
  isPlanOnlyCapability,
  isTierAllowed,
  type AiCapability,
  type AiCapabilityTarget,
  type AiCapabilityTier,
  type AiPolicyLevel,
} from "../../lib/aiCapabilities";
import { useFeatureBriefTrigger } from "../../lib/useFeatureBrief";
import { groupCardStyle, isExternalProvider } from "./shared";
import { Toggle } from "./Toggle";
import { SegGroup } from "./SegGroup";
import { Badge } from "./Badge";
import { HintBadge } from "./HintBadge";
import { SettingsRow } from "./SettingsRow";
import { AiOffLink } from "./AiOffLink";
import { useAiConnectionSettings } from "./useAiConnectionSettings";
import { IconChip } from "./IconChip";
import {
  IconSparkles,
  IconSearch,
  IconFilter,
  IconChevron,
  IconNote,
  IconFolder,
  IconBook,
  IconSheet,
  IconGraph,
  IconChat,
  IconLink,
  IconPlus,
  IconSpellCheck,
  IconArrowRight,
} from "../icons";
import { IconAction } from "./IconAction";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up.mjs";
import PenLine from "lucide-react/dist/esm/icons/pen-line.mjs";

/**
 * 설정 > AI > 기능 — AI 기능 카탈로그.
 * 히어로(정책 수준 SegGroup) → 검색·대상 필터 → 계층(tier)별 아코디언 카드. 검색이 아무것도 못 찾으면
 * 아코디언 대신 빈 상태 한 줄을 보인다.
 */

const TIER_ORDER: AiCapabilityTier[] = ["refine", "organize", "gather"];

const TIER_TITLE_KEY: Record<AiCapabilityTier, string> = {
  refine: "aiCapabilities.tier_refine_title",
  organize: "aiCapabilities.tier_organize_title",
  gather: "aiCapabilities.tier_gather_title",
};

const TIER_ACCORDION_TITLE_KEY: Record<AiCapabilityTier, string> = {
  refine: "settings.ai_tier_refine_title_new",
  organize: "settings.ai_tier_organize_title_new",
  gather: "settings.ai_tier_gather_title_new",
};

const TIER_HINT_KEY: Record<AiCapabilityTier, string> = {
  refine: "aiCapabilities.tier_refine_hint",
  organize: "aiCapabilities.tier_organize_hint",
  gather: "aiCapabilities.tier_gather_hint",
};

const TARGET_LABEL_KEY: Record<AiCapabilityTarget, string> = {
  editor: "aiCapabilities.target_editor",
  note: "aiCapabilities.target_note",
  folder: "aiCapabilities.target_folder",
  notebook: "aiCapabilities.target_notebook",
  sheet: "aiCapabilities.target_sheet",
  diagram: "aiCapabilities.target_diagram",
  chat: "aiCapabilities.target_chat",
  link: "aiCapabilities.target_link",
  collect: "aiCapabilities.target_collect",
};

const PAGE_LABEL_KEY: Record<string, string> = {
  collect: "settings.page_collect",
  pet: "settings.pet",
  ai_chat: "settings.page_ai_chat",
};

interface AiCapabilityCatalogProps {
  /** 시험용 덮어쓰기 — 주지 않으면 저장된 프로바이더를 스스로 읽는다(useAiConnectionSettings). */
  provider?: string;
  onNavigate: (pageId: string) => void;
}

function getTierIcon(tier: AiCapabilityTier): ReactNode {
  switch (tier) {
    case "refine":
      return <PenLine size={16} strokeWidth={2} />;
    case "organize":
      return <IconGraph size={16} strokeWidth={2} />;
    case "gather":
      return <IconFolder size={16} strokeWidth={2} />;
  }
}

function getCapabilityIcon(cap: AiCapability): ReactNode {
  if (cap.id === "proofread") return <IconSpellCheck size={16} />;
  switch (cap.target) {
    case "editor":
      return <IconNote size={16} />;
    case "note":
      return <IconNote size={16} />;
    case "folder":
      return <IconFolder size={16} />;
    case "notebook":
      return <IconBook size={16} />;
    case "sheet":
      return <IconSheet size={16} />;
    case "diagram":
      return <IconGraph size={16} />;
    case "chat":
      return <IconChat size={16} />;
    case "link":
      return <IconLink size={16} />;
    case "collect":
      return <IconPlus size={16} />;
    default:
      return <IconSparkles size={16} />;
  }
}

function isAutoCapability(cap: AiCapability): boolean {
  return (
    cap.control.kind === "setting" ||
    cap.id === "list" ||
    cap.id === "organize" ||
    cap.id === "metadata" ||
    cap.id === "agent_folder" ||
    cap.target === "folder" ||
    cap.target === "notebook"
  );
}

export function AiCapabilityCatalog({ provider: providerOverride, onNavigate }: AiCapabilityCatalogProps) {
  const storedProvider = useAiConnectionSettings().fields.provider;
  const provider = providerOverride ?? storedProvider;
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  const aiPostProcess = useSettingsStore((s) => s.aiPostProcess);
  const setAiPostProcess = useSettingsStore((s) => s.setAiPostProcess);
  const linkSuggestions = useSettingsStore((s) => s.linkSuggestions);
  const setLinkSuggestions = useSettingsStore((s) => s.setLinkSuggestions);
  const aiPolicyLevel = useSettingsStore((s) => s.aiPolicyLevel);
  const setAiPolicyLevel = useSettingsStore((s) => s.setAiPolicyLevel);

  const notifyFeatureBrief = useFeatureBriefTrigger();

  const presetList = useAiPresetsStore((s) => s.list);
  const presetsLoaded = useAiPresetsStore((s) => s.loaded);
  const loadPresets = useAiPresetsStore((s) => s.load);
  const setPresetHidden = useAiPresetsStore((s) => s.setHidden);

  useEffect(() => {
    if (!presetsLoaded) void loadPresets();
  }, [presetsLoaded, loadPresets]);

  const [searchQuery, setSearchQuery] = useState("");
  const [filterTarget, setFilterTarget] = useState<string>("all");
  const [showFilters, setShowFilters] = useState(false);
  const targetOptions = [
    { value: "all", label: t("aiCapabilities.target_all") },
    ...Object.entries(TARGET_LABEL_KEY).map(([value, key]) => ({ value, label: t(key) })),
  ];

  // Accordion cards are open by default so immediate test queries pass
  const [expandedTiers, setExpandedTiers] = useState<Record<AiCapabilityTier, boolean>>({
    refine: true,
    organize: true,
    gather: true,
  });

  const toggleTier = (tier: AiCapabilityTier) => {
    setExpandedTiers((prev) => ({ ...prev, [tier]: !prev[tier] }));
  };

  const providerExternal = aiEnabled && isExternalProvider(provider);

  const settingValue = (key: SimplePrefKey): boolean => {
    switch (key) {
      case "aiPostProcess":
        return aiPostProcess;
      case "linkSuggestions":
        return linkSuggestions;
      default:
        return false;
    }
  };

  const setSettingValue = (key: SimplePrefKey, next: boolean) => {
    switch (key) {
      case "aiPostProcess":
        notifyFeatureBrief("ai_post_process", aiPostProcess, next);
        void setAiPostProcess(next);
        break;
      case "linkSuggestions":
        notifyFeatureBrief("link_suggestions", linkSuggestions, next);
        void setLinkSuggestions(next);
        break;
      default:
        break;
    }
  };

  const isPresetVisible = (presetId: string): boolean => {
    const preset = presetList.find((p) => p.id === presetId);
    return !preset?.hidden;
  };

  // Real-time filtering
  const filteredCapabilities = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return AI_CAPABILITIES.filter((cap) => {
      if (filterTarget !== "all" && cap.target !== filterTarget) {
        return false;
      }
      if (!q) return true;
      const name = t(cap.nameKey).toLowerCase();
      const reads = t(cap.readsKey).toLowerCase();
      const detail = t(cap.detailKey).toLowerCase();
      return name.includes(q) || reads.includes(q) || detail.includes(q);
    });
  }, [searchQuery, filterTarget]);

  // AI 기능 레벨은 페이지 맨 위 카드의 첫 줄 설정 행(PLAN-2026-10-24 D4, 옛 히어로 우측 동작).
  const policyCard = (
    <div className="card" style={groupCardStyle} data-testid="ai-capability-policy-card">
      <SettingsRow
        anchor="ai_policy_level"
        label={t("settings.ai_policy_level_title")}
        hint={t("settings.ai_policy_level_hint")}
        control={
          <SegGroup<AiPolicyLevel>
            value={aiPolicyLevel}
            onChange={(v) => void setAiPolicyLevel(v)}
            ariaLabel={t("settings.ai_policy_level_title")}
            options={AI_POLICY_LEVELS.map((level) => ({
              value: level,
              label: t(TIER_TITLE_KEY[level]),
            }))}
          />
        }
      />
    </div>
  );

  return (
    <>
      {/* 오너 R1(2026-09-15): 정책 카드·검색·티어 아코디언은 전부 페이지 최상위 형제다 —
          티어 아코디언만 카드다. */}
      {policyCard}

      {/* 꺼짐 링크는 다른 AI 페이지처럼 정책 카드 바로 아래. */}
      <AiOffLink onNavigate={onNavigate} />

      {/* 검색칸은 표준 .field 다 — 돋보기는 칸 안 왼쪽에 겹쳐 두고, 글자가 그 뒤에서 시작하도록 왼쪽 안쪽
          여백만 아이콘 폭만큼 더 준다. */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <div style={{ position: "relative", flex: 1, display: "flex", alignItems: "center" }}>
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                left: "var(--space-4)",
                color: "var(--muted)",
                display: "flex",
                alignItems: "center",
                pointerEvents: "none",
              }}
            >
              <IconSearch size={16} />
            </span>
            <input
              type="search"
              className="field"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("settings.ai_search_placeholder")}
              aria-label={t("settings.ai_search_placeholder")}
              data-testid="ai-capability-search-input"
              // type-scale-exempt: 16px 는 간격이 아니라 왼쪽에 겹쳐 놓은 IconSearch(size 16)의 폭이다
              style={{ paddingLeft: "calc(var(--space-4) + 16px + var(--space-3))" }}
            />
          </div>
          {/* 필터가 걸려 있으면(전체 아님) .icon-btn[data-active] 의 선택 면으로 알린다. --lg 는 .field 와 같은 높이(--ctrl-h-lg). */}
          <IconAction
            icon={<IconFilter size={16} />}
            label={t("settings.ai_filter_button")}
            size="lg"
            data-testid="ai-capability-filter-button"
            aria-pressed={showFilters}
            aria-expanded={showFilters}
            data-active={filterTarget !== "all" ? "true" : undefined}
            onClick={() => setShowFilters((prev) => !prev)}
          />
        </div>

        {/* Filter Chips Bar */}
        {showFilters && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              flexWrap: "wrap",
              marginTop: "var(--space-3)",
              padding: "var(--space-3) var(--space-4)",
              background: "var(--surface-sunken)",
              border: "1px solid var(--divider)",
              borderRadius: "var(--radius-sm)",
            }}
          >
            {targetOptions.map((opt) => (
              <button
                key={opt.value}
                type="button"
                aria-pressed={filterTarget === opt.value}
                onClick={() => setFilterTarget(opt.value)}
                style={{
                  padding: "var(--space-1) var(--space-4)",
                  borderRadius: "var(--radius-pill)",
                  border: "1px solid var(--divider)",
                  background: filterTarget === opt.value ? "var(--accent)" : "transparent",
                  color: filterTarget === opt.value ? "var(--on-accent)" : "var(--muted)",
                  fontSize: "var(--text-xs)",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 검색·필터가 아무것도 못 찾았다 — 빈 아코디언 셋 대신 한 줄로 말한다. */}
      {filteredCapabilities.length === 0 && (
        <p
          role="status"
          data-testid="ai-capability-empty"
          style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--muted)", textAlign: "center" }}
        >
          {t("settings.ai_search_empty")}
        </p>
      )}

      {/* 계층별 아코디언 카드 — 검색 결과가 하나도 없으면 세우지 않는다. */}
      {filteredCapabilities.length > 0 && TIER_ORDER.map((tier) => {
        const tierCaps = filteredCapabilities.filter((c) => c.tier === tier);
        const isExpanded = expandedTiers[tier];

        return (
          <div
            key={tier}
            className="card"
            style={groupCardStyle}
            data-testid={`ai-capability-tier-${tier}`}
          >
            {/* Accordion Header */}
            <button
              type="button"
              onClick={() => toggleTier(tier)}
              data-testid={`ai-capability-tier-header-${tier}`}
              aria-expanded={isExpanded}
              title={isExpanded ? t("aiCapabilities.detail_collapse") : t("aiCapabilities.detail_expand")}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                width: "100%",
                background: "transparent",
                border: "none",
                padding: 0,
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)", minWidth: 0 }}>
                <IconChip size={32}>{getTierIcon(tier)}</IconChip>
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2xs)", minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                    <span style={{ fontSize: "var(--text-lg)", fontWeight: 600, color: "var(--text)" }}>
                      {t(TIER_ACCORDION_TITLE_KEY[tier])}
                    </span>
                    <Badge tone="accent">{t("settings.ai_tier_count", { n: tierCaps.length })}</Badge>
                  </div>
                  <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--muted)", fontWeight: 400 }}>
                    {t(TIER_HINT_KEY[tier])}
                  </p>
                </div>
              </div>
              <div style={{ color: "var(--muted)", display: "flex", alignItems: "center", flexShrink: 0 }}>
                {isExpanded ? <ChevronUp size={18} /> : <IconChevron size={18} />}
              </div>
            </button>

            {/* Subcard Feature Rows List */}
            <div
              style={{
                display: isExpanded ? "flex" : "none",
                flexDirection: "column",
                gap: "var(--space-3)",
                paddingTop: "var(--space-5)",
              }}
            >
              {tierCaps.map((cap) => (
                <CapabilityRow
                  key={cap.id}
                  cap={cap}
                  aiEnabled={aiEnabled}
                  policyAllowed={isTierAllowed(cap.tier, aiPolicyLevel)}
                  metadataOnlyBadgeVisible={!cap.external && providerExternal}
                  onNavigate={onNavigate}
                  getSettingValue={settingValue}
                  onSettingToggle={setSettingValue}
                  isPresetVisible={isPresetVisible}
                  onPresetToggle={(presetId, nextVisible) => void setPresetHidden(presetId, !nextVisible)}
                />
              ))}
            </div>
          </div>
        );
      })}

      {/* F2(PLAN-2026-09-15): 하단 로드맵 배너 삭제 — "보기" 버튼에 onClick 이 없어 아무 데도
          가지 않았다. 오너: 죽은 버튼만이 아니라 배너째 뺀다. */}
    </>
  );
}

interface CapabilityRowProps {
  cap: AiCapability;
  aiEnabled: boolean;
  policyAllowed: boolean;
  metadataOnlyBadgeVisible: boolean;
  onNavigate: (pageId: string) => void;
  getSettingValue: (key: SimplePrefKey) => boolean;
  onSettingToggle: (key: SimplePrefKey, next: boolean) => void;
  isPresetVisible: (presetId: string) => boolean;
  onPresetToggle: (presetId: string, nextVisible: boolean) => void;
}

function CapabilityRow({
  cap,
  aiEnabled,
  policyAllowed,
  metadataOnlyBadgeVisible,
  onNavigate,
  getSettingValue,
  onSettingToggle,
  isPresetVisible,
  onPresetToggle,
}: CapabilityRowProps) {
  const name = t(cap.nameKey);
  const reads = t(cap.readsKey);
  const planOnly = isPlanOnlyCapability(cap.id);
  const control = cap.control;
  const toggleDisabled = !aiEnabled || !policyAllowed;
  const toggleAriaLabel = policyAllowed ? name : `${name} — ${t("aiCapabilities.disabled_reason_policy")}`;

  return (
    <div
      data-testid={`ai-capability-row-${cap.id}`}
      data-policy-blocked={!policyAllowed ? "true" : undefined}
      title={!policyAllowed ? t("aiCapabilities.disabled_reason_policy") : undefined}
      style={{
        background: "var(--surface-sunken)",
        border: "1px solid var(--divider)",
        borderRadius: "var(--radius-sm)",
        padding: "var(--space-5) var(--space-6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "var(--space-4)",
        opacity: (!aiEnabled || !policyAllowed) ? "var(--dim-disabled)" : undefined,
        boxSizing: "border-box",
      }}
    >
      {/* Left side: 32×32 rounded icon container, bold title, one-line description */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)", minWidth: 0, flex: 1 }}>
        <IconChip size={32}>{getCapabilityIcon(cap)}</IconChip>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2xs)", minWidth: 0, flex: 1 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              fontSize: "var(--text-md)",
              fontWeight: 600,
              color: "var(--text)",
              lineHeight: "var(--lh-tight)",
            }}
          >
            <span>{name}</span>
            <HintBadge hint={t(cap.detailKey)} />
          </div>
          <div style={{ fontSize: "var(--text-xs)", color: "var(--muted)", fontWeight: 400, lineHeight: "var(--lh-ui)" }}>
            {reads}
          </div>
        </div>
      </div>

      {/* Center metadata badges cluster: Target, Execution, Policy, Metadata */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexShrink: 0, flexWrap: "wrap" }}>
        <Badge tone="accent">{t(TARGET_LABEL_KEY[cap.target])}</Badge>
        <span
          style={{
            padding: "var(--space-2xs) var(--space-3)",
            borderRadius: "var(--radius-pill)",
            background: "transparent",
            border: "1px solid var(--divider)",
            color: "var(--muted)",
            fontSize: "var(--text-xs)",
            fontWeight: 400,
            whiteSpace: "nowrap",
          }}
        >
          {isAutoCapability(cap) ? t("settings.ai_exec_auto") : t("settings.ai_exec_manual")}
        </span>
        {planOnly && (
          <Badge>{t("aiCapabilities.plan_only_badge")}</Badge>
        )}
        {metadataOnlyBadgeVisible && (
          <Badge>{t("aiCapabilities.metadata_only_badge")}</Badge>
        )}
      </div>

      {/* Right controls: Toggle switch and Action link [ 설정 > ] */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)", flexShrink: 0 }}>
        {control.kind === "setting" && (
          <Toggle
            checked={getSettingValue(control.key)}
            disabled={toggleDisabled}
            onChange={(next) => onSettingToggle(control.key, next)}
            aria-label={toggleAriaLabel}
            data-testid={`ai-capability-toggle-${cap.id}`}
          />
        )}
        {control.kind === "preset" && (
          <Toggle
            checked={isPresetVisible(control.presetId)}
            disabled={toggleDisabled}
            onChange={(next) => onPresetToggle(control.presetId, next)}
            aria-label={toggleAriaLabel}
            data-testid={`ai-capability-toggle-${cap.id}`}
          />
        )}
        {control.kind === "link" && (
          // 이름은 예전 글자("설정") 그대로, 툴팁은 어느 페이지로 가는지까지 말하던 기존 문구를 유지한다.
          // ponytail: 행마다 같은 이름 "설정"이 반복된다 — 이름 자체를 go_to_settings 로 올리려면
          // settings.ai_action_settings_btn 키를 세 로케일에서 지워야 한다(settings.json 은 이 웨이브 밖).
          <IconAction
            icon={<IconArrowRight size={14} />}
            label={t("settings.ai_action_settings_btn")}
            titleOverride={t("aiCapabilities.go_to_settings", { page: t(PAGE_LABEL_KEY[control.page] ?? "settings.page_collect") })}
            size="sm"
            data-testid={`ai-capability-link-${cap.id}`}
            onClick={() => onNavigate(control.page)}
          />
        )}
      </div>
    </div>
  );
}
