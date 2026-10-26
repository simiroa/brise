import { useMemo } from "react";
import type { AskAiTarget } from "../AskAiModal";
import { t } from "../../i18n/t";
import { useSheetFocus } from "../../stores/sheetFocus";
import { recommendChartTypes } from "../../lib/sheet/chart";
import { SHEET_ASSISTS, recommendSheetAssists, type SheetAssistCtx } from "../../lib/sheet/assists";
import type { ChartSpec } from "../../lib/sheet/types";
import { SheetChartsPanel } from "../sheet/SheetChartsPanel";
import { ChartSuggestCard } from "../sheet/ChartSuggestCard";
import { IconChart } from "../icons";
import { AssistRow } from "../presets/AssistRow";
import { BUILTIN_VERB_LABEL_KEY } from "../presets/presetConstants";
import { getAssistPresets, runAssistPreset, assistTestId } from "./rows";
import { tileIcon } from "../ai/askAiPresets";
import { useAiPresetsStore } from "../../stores/aiPresets";
import type { AiActionPreset } from "../../stores/aiPrompts";
import { AiActionsGroupHeader, MutedFormatHeader } from "./AssistPanel";
import type { usePresetEntries } from "./usePresetEntries";

type Entries = ReturnType<typeof usePresetEntries>;

/**
 * 시트 어시스트 — PresetList.tsx strips 분기에서 그대로 옮김(PLAN-2026-09-21 W1, 목표 매트릭스 §2).
 *   start(blank): AI 시작 1행 · 시트 템플릿 4
 *   work(!blank): 차트 카드(있을 때) · Explore(추천 차트) · 수식·서식 프리셋(D5, W3) · AI 4행 —
 *   시트 템플릿은 work 에 **없다**(D1).
 */
export function SheetAssist({
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
  const list = presets ?? useAiPresetsStore.getState().list;
  const rows = getAssistPresets("sheet", blank, list);

  // 활성 시트의 선택 범위(stores/sheetFocus)에서 추천 차트 종류 — 추천이 없으면 그룹 자체가 부재.
  const sheetFocus = useSheetFocus((s) => s.focus);
  const sheetChartTypes = useMemo<ChartSpec["type"][]>(
    () => (sheetFocus?.range ? recommendChartTypes(sheetFocus.doc, sheetFocus.range, sheetFocus.engine) : []),
    [sheetFocus],
  );

  // 수식·서식 프리셋(PLAN-2026-09-21 W3, D5) — Explore 와 같은 순수 함수 모델. ops 가 없으면(이 스토어를
  // 모르는 옛 테스트의 focus 리터럴 등) 조용히 그룹이 부재한다.
  const sheetAssistIds = useMemo(() => {
    if (!sheetFocus?.range || !sheetFocus.ops) return [];
    return recommendSheetAssists(sheetFocus.doc, sheetFocus.range, sheetFocus.engine);
  }, [sheetFocus]);
  const runSheetAssist = (id: (typeof sheetAssistIds)[number]) => {
    if (!sheetFocus?.range || !sheetFocus.ops) return;
    const def = SHEET_ASSISTS.find((d) => d.id === id);
    if (!def) return;
    const ctx: SheetAssistCtx = { doc: sheetFocus.doc, engine: sheetFocus.engine, range: sheetFocus.range, ops: sheetFocus.ops };
    def.apply(ctx);
  };

  return (
    <div
      className="assist-list"
      style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}
      data-testid={!blank ? "note-assist" : undefined}
    >
      {/* 열린 시트의 차트 카드 — 어시스트 상단(오너 2026-09-21). 차트가 없으면 부재. */}
      {!blank && <SheetChartsPanel />}

      {/* Explore — 데이터를 그래프로. 추천 1위 카드 한 장 + 종류 칩 + 고정(PLAN-2026-09-30). */}
      {!blank && sheetChartTypes.length > 0 && sheetFocus?.range && (
        <div data-testid="sheet-explore-group">
          <MutedFormatHeader label={t("presets.sheet_explore_title")} />
          <ChartSuggestCard
            sectionId={sheetFocus.sectionId}
            doc={sheetFocus.doc}
            engine={sheetFocus.engine}
            range={sheetFocus.range}
            types={sheetChartTypes}
          />
        </div>
      )}

      {/* 수식·서식 프리셋(PLAN-2026-09-21 W3, D5) — Explore 다음, AI 앞(계획 §4 W3 위치 규칙).
          추천이 비면 그룹 자체가 DOM 에 없다. preview 슬롯은 쓰지 않는다(함정 7 — 행 높이 들쭉날쭉). */}
      {!blank && sheetAssistIds.length > 0 && (
        <div>
          <MutedFormatHeader label={t("presets.sheet_assist_title")} />
          {sheetAssistIds.map((id) => {
            const def = SHEET_ASSISTS.find((d) => d.id === id);
            if (!def) return null;
            return (
              <AssistRow
                key={id}
                testid={`assist-sheet-${id}`}
                icon={
                  def.Icon ? (
                    <def.Icon size={15} strokeWidth={1.8} style={{ color: "var(--accent)", flex: "none" }} />
                  ) : (
                    <IconChart size={15} strokeWidth={1.8} style={{ color: "var(--accent)", flex: "none" }} />
                  )
                }
                label={t(def.nameKey)}
                onClick={() => runSheetAssist(id)}
              />
            );
          })}
        </div>
      )}

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
              onClick={() => runAssistPreset(preset, "sheet", !!autorun, setAskAiTarget)}
            />
          );
        })}
      </div>

      {/* 시트 템플릿 — 시작(blank)에서만. 작업 모드는 D5(W3)까지 템플릿이 없다(D1). */}
      {blank && (
        <div>
          <MutedFormatHeader label={t("presets.sheet_name")} />
          {entries.sheetEntries.map((e) => (
            <AssistRow
              key={e.key}
              icon={e.icon}
              label={t(BUILTIN_VERB_LABEL_KEY[e.key as keyof typeof BUILTIN_VERB_LABEL_KEY] ?? "") || e.label}
              onClick={e.onApply}
              onContextMenu={entries.contextMenuFor(e)}
              {...e.hover}
            />
          ))}
        </div>
      )}
    </div>
  );
}
