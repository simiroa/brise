import type { AskAiTarget } from "../AskAiModal";
import { t } from "../../i18n/t";
import { DIAGRAM_TYPES, DIAGRAM_TYPE_GROUPS } from "../diagram/types/registry";
import { diagramTemplateSource } from "../diagram/diagramStarter";
import { usageOf } from "../../lib/diagramTypeUsage";
import { DIAGRAM_LAYOUTS } from "../diagram/diagramSchema";
import { setLayout as layoutSource } from "../diagram/diagramModel";
import { LAYOUT_HOVER_PREFIX } from "../../stores/presets";
import { useDiagramFocus } from "../../stores/diagramFocus";
import { IconGraph, IconSparkles } from "../icons";
import { AssistRow } from "../presets/AssistRow";
import { RowIconBtn } from "../presets/PresetRow";
import { getAssistPresets, runAssistPreset, assistTestId } from "./rows";
import { tileIcon } from "../ai/askAiPresets";
import { useAiPresetsStore } from "../../stores/aiPresets";
import type { AiActionPreset } from "../../stores/aiPrompts";
import { AiActionsGroupHeader, MutedFormatHeader } from "./AssistPanel";
import { DIAGRAM_GROUP_LABEL_KEY, type usePresetEntries } from "./usePresetEntries";

type Entries = ReturnType<typeof usePresetEntries>;

/** 배치 이름 → i18n 키. `diagram_layout_<name>` 그대로라 별도 맵이 아니라 템플릿 리터럴로 충분. */
const layoutLabelKey = (name: (typeof DIAGRAM_LAYOUTS)[number]) => `editor.diagram_layout_${name}` as const;

/**
 * 관계도 어시스트 — PresetList.tsx strips 분기에서 그대로 옮김(PLAN-2026-09-21 W1, 목표 매트릭스 §2).
 *   start(blank): AI로 채우기(타입별 반짝이) · 타입 27장(그룹 4, 호버 고스트) — "AI 시작" 행은 없다
 *                 (레지스트리 타입이 그 자리를 대신한다). 텍스트 문법 진입점은 W2 몫.
 *   work(!blank): AI 4행 · 배치 바꾸기(베타, W4/D4) — 관계도가 열려 있을 때(diagramFocus)만.
 *
 * 베타 삭제 절차(오너가 안 남기기로 정하면, PLAN §6): ⓐ 이 파일에서 "배치 바꾸기" 그룹 JSX(아래
 * `!blank && diagramFocus &&` 블록)와 `layoutLabelKey` 제거 ⓑ `i18n/{ko,en,fr}/editor.json` 의
 * `diagram_layout_*` 키 11개(그룹 헤더 diagram_layout_title · 배치 9종 diagram_layout_<name> ·
 * diagram_layout_sequence_hint) 삭제 + `scripts/i18n-keys-snapshot.json` 갱신 ⓒ
 * `DiagramAssist.test.tsx` 의 "배치 바꾸기" describe 삭제 ⓓ `DiagramSection.tsx` 의 diagramFocus
 * 게시 effect 제거(다른 소비자가 생기지 않았다면) + `stores/diagramFocus.ts` 삭제. 설정 키는 없다
 * (settings_schema arm 없이 저장이 조용히 실패하는 함정을 피함).
 */
export function DiagramAssist({
  blank,
  entries,
  glowOf,
  setAskAiTarget,
  presets,
  autorun,
  onToggleAutorun,
}: {
  blank: boolean;
  entries: Entries;
  glowOf: Record<string, import("../../stores/ai").AiGlowPhase | false>;
  setAskAiTarget: (target: AskAiTarget) => void;
  presets?: AiActionPreset[];
  autorun?: boolean;
  onToggleAutorun?: (v: boolean) => void;
}) {
  // 배치 바꾸기(베타)는 열린 관계도 섹션이 게시한 diagramFocus 를 읽는다 — 없으면 그룹 자체가 없다.
  const diagramFocus = useDiagramFocus((s) => s.focus);

  if (!blank) {
    const list = presets ?? useAiPresetsStore.getState().list;
    const rows = getAssistPresets("diagram", false, list);
    return (
      <div className="assist-list" style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }} data-testid="note-assist">
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
          <AiActionsGroupHeader autorun={autorun} onToggleAutorun={onToggleAutorun} />
          {rows.map((preset) => {
            const Icon = tileIcon(preset.icon, preset.kind);
            return (
              <AssistRow
                key={preset.id}
                testid={assistTestId(preset.id)}
                icon={<Icon size={15} strokeWidth={1.8} style={{ color: "var(--accent)", flex: "none" }} />}
                label={preset.name}
                isGlow={glowOf[preset.id]}
                onClick={() => runAssistPreset(preset, "diagram", !!autorun, setAskAiTarget)}
              />
            );
          })}
        </div>

        {diagramFocus && (
          <div data-testid="diagram-layout-group">
            <MutedFormatHeader label={t("editor.diagram_layout_title")} />
            {DIAGRAM_LAYOUTS.map((name) => (
              <AssistRow
                key={name}
                testid={`diagram-layout-${name}`}
                icon={<IconGraph size={15} strokeWidth={1.8} style={{ color: "var(--accent)", flex: "none" }} />}
                label={t(layoutLabelKey(name))}
                active={(diagramFocus.layout ?? "dagre") === name}
                title={name === "sequence" ? t("editor.diagram_layout_sequence_hint") : undefined}
                onClick={() => diagramFocus.setLayout(name)}
                // 호버 = "이 배치면 이렇게" — 현재 관계도를 그 배치로 다시 그린 고스트가 캔버스를 덮는다
                // (EditorGhostOverlay 의 layout: 분기, 게이트는 resolveGhostBody 하나).
                {...entries.hoverProps(`${LAYOUT_HOVER_PREFIX}${name}`, () => layoutSource(diagramFocus.source, name))}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  // 시작(blank) — 레지스트리를 그룹 4개 헤더로(비어 있는 그룹은 헤더도 없다). 행 클릭 = 시드로 새
  // 섹션, 우측 반짝이 = 같은 타입을 AI 로 채워 새 섹션(AI 켜짐+도달일 때만 존재).
  return (
    <div className="assist-list" style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }} data-testid="diagram-type-groups">
        {DIAGRAM_TYPE_GROUPS.map((group) => {
          const defs = DIAGRAM_TYPES.filter((d) => d.group === group);
          if (!defs.length) return null;
          return (
            <div key={group} data-testid={`diagram-type-group-${group}`}>
              <MutedFormatHeader label={t(DIAGRAM_GROUP_LABEL_KEY[group])} />
              {defs.map((def) => {
                // 사용 카운트(오너 제안 #7) — "써보고 지운다"의 데이터. 0 이면 아무것도 안 보인다.
                const usage = usageOf(def.id);
                const usageTotal = usage.seed + usage.ai;
                return (
                <div key={def.id} style={{ display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <AssistRow
                      testid={`diagram-type-${def.id}`}
                      icon={<IconGraph size={15} strokeWidth={1.8} style={{ color: "var(--accent)", flex: "none" }} />}
                      label={t(def.nameKey)}
                      onClick={() => entries.applyDiagramType(def)}
                      {...entries.hoverProps(def.id, diagramTemplateSource(def.id))}
                    />
                  </div>
                  {usageTotal > 0 && (
                    <span
                      data-testid={`diagram-type-usage-${def.id}`}
                      title={t("editor.diagram_type_usage_tip", {
                        seed: usage.seed,
                        ai: usage.ai,
                        last: new Date(usage.last).toLocaleDateString(),
                      })}
                      style={{ fontSize: "var(--text-xs)", color: "var(--faint)", flex: "none" }}
                    >
                      {usageTotal}
                    </span>
                  )}
                  {entries.showDiagramAiFill && (
                    <RowIconBtn
                      testid={`diagram-type-ai-${def.id}`}
                      label={t("presets.diagram_ai_fill")}
                      disabled={entries.aiFillPending !== null}
                      onClick={() => void entries.fillDiagramWithAi(def)}
                    >
                      <IconSparkles size={13} strokeWidth={1.8} style={{ color: "var(--accent)" }} />
                    </RowIconBtn>
                  )}
                </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
