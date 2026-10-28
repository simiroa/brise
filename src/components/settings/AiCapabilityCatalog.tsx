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
import { groupCardStyle, isExternalProvider, linkBtn } from "./shared";
import { Toggle } from "./Toggle";
import { SegGroup } from "./SegGroup";
import { Badge } from "./Badge";
import { HintBadge } from "./HintBadge";
import { SettingsRow } from "./SettingsRow";
import { PageLead } from "./PageLead";
import { SectionHeader } from "./SectionHeader";
import { SegmentedControl } from "../common/SegmentedControl";
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

/** 기능 표의 열(2026-10-28, PLAN-2026-10-27 W4) — 머리줄과 모든 행이 같은 격자라 열이 세로로 정렬된다: 기능 | 대상·실행 | 사용. */
const TABLE_GRID = "minmax(0, 1fr) 13rem 4rem";

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
      return <PenLine size={14} strokeWidth={2} />;
    case "organize":
      return <IconGraph size={14} strokeWidth={2} />;
    case "gather":
      return <IconFolder size={14} strokeWidth={2} />;
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
    <PageLead testId="ai-capability-policy-card">
      {/* 제공자 한 줄 요약(2026-10-28) — 어떤 모델에 연결돼 있고 데이터가 밖으로 나가는지(꺼져 있으면 "AI 꺼짐"). 바꾸는 곳은 연결 페이지다.
          AI 꺼짐 안내는 이 줄 하나다 — 같은 "AI 제공자 페이지로" 링크를 AiOffLink 가 한 번 더 그려 연달아 두 줄이 나오던 것을 걷어냈다. */}
      <p data-testid="ai-provider-summary" style={{ margin: "0 0 var(--space-2)", fontSize: "var(--text-sm)", color: "var(--muted)" }}>
        {aiEnabled
          ? t(providerExternal ? "settings.ai_provider_summary_external" : "settings.ai_provider_summary_local", { provider })
          : t("settings.ai_provider_summary_off")}{" "}
        <button type="button" style={linkBtn} data-testid="ai-provider-summary-go" onClick={() => onNavigate("ai")}>
          {t("settings.ai_provider_summary_go")}
        </button>
      </p>
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
    </PageLead>
  );

  return (
    <>
      {/* 오너 R1(2026-09-15): 정책 카드·검색·티어 아코디언은 전부 페이지 최상위 형제다 —
          티어 아코디언만 카드다. */}
      {policyCard}

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

        {/* 대상 필터 — 단일 선택 띠. 칸이 많아(10) 좁은 자리에선 SegmentedControl 이 가로로 구른다. */}
        {showFilters && (
          <div style={{ marginTop: "var(--space-3)" }}>
            <SegmentedControl
              value={filterTarget}
              onChange={setFilterTarget}
              options={targetOptions}
              ariaLabel={t("settings.ai_filter_button")}
            />
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
          // 2026-10-28(PLAN-2026-10-27 W4): 그룹 제목은 박스 밖, 기능 행만 카드 안. 접으면 카드째 사라진다.
          <div
            key={tier}
            style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}
            data-testid={`ai-capability-tier-${tier}`}
          >
            {/* 등급 머리줄 — 제목 규칙은 SectionHeader(박스 밖 muted 제목·아이콘 칩·개수 뱃지) 한 벌. 단추 전체가 접기/펼치기다. */}
            <button
              type="button"
              className="ai-tier-head"
              onClick={() => toggleTier(tier)}
              data-testid={`ai-capability-tier-header-${tier}`}
              aria-expanded={isExpanded}
              title={isExpanded ? t("aiCapabilities.detail_collapse") : t("aiCapabilities.detail_expand")}
            >
              <SectionHeader
                title={t(TIER_ACCORDION_TITLE_KEY[tier])}
                icon={getTierIcon(tier)}
                badge={<Badge tone="accent">{t("settings.ai_tier_count", { n: tierCaps.length })}</Badge>}
                actions={
                  <span style={{ color: "var(--muted)", display: "flex", alignItems: "center" }}>
                    {isExpanded ? <ChevronUp size={18} /> : <IconChevron size={18} />}
                  </span>
                }
              />
              <p className="ai-tier-head__hint">{t(TIER_HINT_KEY[tier])}</p>
            </button>

            {/* Feature rows card */}
            <div
              className="card"
              style={{
                ...groupCardStyle,
                display: isExpanded ? "flex" : "none",
                flexDirection: "column",
                gap: "var(--space-2)",
              }}
            >
              <div
                aria-hidden="true"
                data-testid={`ai-capability-head-${tier}`}
                style={{
                  display: "grid",
                  gridTemplateColumns: TABLE_GRID,
                  gap: "var(--space-4)",
                  fontSize: "var(--text-xs)",
                  color: "var(--faint)",
                  paddingBottom: "var(--space-2)",
                  borderBottom: "1px solid var(--divider)",
                }}
              >
                <span>{t("settings.ai_col_feature")}</span>
                <span>{t("settings.ai_col_kind")}</span>
                <span style={{ textAlign: "right" }}>{t("settings.ai_col_use")}</span>
              </div>
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
        // 카드 없이 가볍게 — 큰 그룹(tier) 카드 안에서 행은 테두리·배경 없이 간격만 둔다.
        padding: "var(--space-2) 0",
        display: "grid",
        gridTemplateColumns: TABLE_GRID,
        alignItems: "center",
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
            {/* 한 줄 설명(reads)은 화면에서 내리고 ⓘ 툴팁으로 — 자세한 설명 앞에 붙인다. */}
            <HintBadge hint={`${reads}
${t(cap.detailKey)}`} />
          </div>
        </div>
      </div>

      {/* Center metadata badges cluster: Target, Execution, Policy, Metadata */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0, flexWrap: "wrap" }}>
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
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: "var(--space-4)" }}>
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
