import { type FC, Suspense, useRef, useState } from "react";
import { useSheetFocus } from "../../stores/sheetFocus";
import { useNotesStore } from "../../stores/notes";
import { isChartRegistered, setChartRegistered } from "../../lib/sheet/chartAttachment";
import type { ChartSpec } from "../../lib/sheet/types";
import { useElementSize } from "../../lib/useElementSize";
import { IconCaret, IconCheck, IconPaperclip, IconPlus } from "../icons";
import { ContextMenuShell } from "../common/ContextMenuShell";
import { CHART_TYPES, chartTypeById } from "../../lib/sheet/chartTypes";
import { t } from "../../i18n/t";
import { SheetChart, ChartEditor } from "../../lazySurfaces";
import { preloadIntentProps } from "../../lib/lazyPreload";


// 카드 폭 반응형 높이(오너 제안 #8, 2026-09-21) — 16:9 비율, 120~260 사이로 clamp.
// kpi·total 은 숫자 몇 개뿐인 요약 카드라 폭이 늘어도 키울 내용이 없다 — 오히려 넓은 카드에서
// 커지면 어색하다. cardBoxStyle 고정 높이(기존 140) 그대로 두고 비율 계산에서 제외한다.
const CARD_CHART_TYPES: ReadonlySet<ChartSpec["type"]> = new Set(["kpi", "total"]);
const CARD_HEIGHT = 140;
const CHART_ASPECT = 9 / 16;
const CHART_MIN_H = 120;
const CHART_MAX_H = 260;
// ponytail: jsdom 엔 ResizeObserver 가 없다(useElementSize 참고) — 실측 전엔 이 폭으로 가정.
const CHART_WIDTH_FALLBACK = 300;

/**
 * 카드의 "차트 형식 바꾸기" 진입점 — 모달을 열지 않고 종류만 갈아끼운다. 저장은 편집기와 같은 관문
 * (focus.addChart = useSheetState.saveChart, id 가 같으면 교체 + undo 1스텝 + 저장 예약).
 * 시리즈 수가 모자라 못 그리는 종류(scatter 는 2개 이상)는 목록에서 뺀다.
 */
const ChartTypeButton: FC<{ chart: ChartSpec; onPick: (spec: ChartSpec) => void }> = ({ chart, onPick }) => {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const seriesCount = chart.series.filter((s) => s.trim().length > 0).length;
  const current = chartTypeById(chart.type);
  return (
    <>
      <button
        type="button"
        className="toolbar-btn toolbar-btn--text"
        data-testid={`chart-type-${chart.id}`}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        title={t("presets.sheet_chart_change_type")}
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          setAnchor({ x: r.left, y: r.bottom + 4 });
        }}
        style={{ fontSize: "var(--text-xs)", padding: "var(--space-2xs) 6px" }}
      >
        <span>{t(current?.nameKey ?? "editor.sheet_chart")}</span>
        <IconCaret dir="down" size={10} />
      </button>
      {anchor && (
        <ContextMenuShell anchor={anchor} onClose={() => setAnchor(null)} testId="chart-type-menu" ariaLabel={t("presets.sheet_chart_change_type")} minWidth={140}>
          {CHART_TYPES.filter((c) => seriesCount >= c.minSeries).map((c) => (
            <button
              key={c.id}
              type="button"
              role="menuitemradio"
              aria-checked={c.id === chart.type}
              className="menu-row menu-item"
              data-testid={`chart-type-option-${c.id}`}
              onClick={(e) => {
                e.stopPropagation();
                setAnchor(null);
                if (c.id !== chart.type) onPick({ ...chart, type: c.id, x: c.needsX ? chart.x : undefined });
              }}
              style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}
            >
              <span style={{ flex: 1 }}>{t(c.nameKey)}</span>
              {c.id === chart.type && <IconCheck size={12} />}
            </button>
          ))}
        </ContextMenuShell>
      )}
    </>
  );
};

/**
 * 열린 시트의 차트 카드 — 어시스트 패널 **상단**(PresetList, 시트 탭일 때). 시트 위 띠에 있던 것을 그대로
 * 옮겼다(오너 2026-09-21: "시트 위쪽이 아니라 어시스트 상단에"). 데이터는 stores/sheetFocus 가 게시하는
 * 문서 참조(차트 추가·수정 뒤 100ms 안에 따라온다), 카드 클릭 = 열린 SheetSection 의 차트 편집기
 * (focus.openChartEditor). 클립 버튼(D6ⓒ)은 편집기 토글과 **같은 함수** setChartRegistered — 진실은 DB 행.
 * 차트가 없으면 통째로 부재(빈 헤더 없음).
 */
export const SheetChartsPanel: FC = () => {
  const focus = useSheetFocus((s) => s.focus);
  const openChartEditor = useSheetFocus((s) => s.openChartEditor);
  const noteId = useNotesStore((s) => s.activeNote?.note.id);
  const attachments = useNotesStore((s) => s.activeNote?.attachments);
  const [registerBusyId, setRegisterBusyId] = useState<string | null>(null);
  // 카드마다 관찰자를 두지 않고 패널 하나에 — 모든 카드가 같은 컨테이너 폭을 공유한다.
  const containerRef = useRef<HTMLDivElement>(null);
  const { width: panelWidth } = useElementSize(containerRef, { width: CHART_WIDTH_FALLBACK, height: 0 });
  const chartHeight = Math.round(Math.min(CHART_MAX_H, Math.max(CHART_MIN_H, panelWidth * CHART_ASPECT)));

  const charts = focus?.doc.charts ?? [];
  if (!focus || charts.length === 0) return null;
  const sectionId = focus.sectionId;

  const toggleChartRegistered = async (chart: ChartSpec) => {
    if (!noteId || registerBusyId) return;
    setRegisterBusyId(chart.id);
    try {
      await setChartRegistered({
        noteId,
        sectionId,
        chartId: chart.id,
        name: chart.title?.trim() || t("attachments.chart_untitled"),
        on: !isChartRegistered(attachments, sectionId, chart.id),
      });
    } catch {
      // call() 이 토스트를 띄웠다 — 낙관적 갱신이 없으니 되돌릴 것도 없다.
    } finally {
      setRegisterBusyId(null);
    }
  };

  return (
    <div
      ref={containerRef}
      data-testid="sheet-charts-panel"
      style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span className="label-caps" style={{ color: "var(--muted)", fontSize: "var(--text-xs)" }}>
          {t("editor.sheet_chart")} ({charts.length})
        </span>
        {openChartEditor && (
          <button
            type="button"
            className="toolbar-btn toolbar-btn--text"
            data-testid="sheet-charts-panel-add"
            onClick={() => openChartEditor(null)}
            {...preloadIntentProps(ChartEditor)}
            style={{ fontSize: "var(--text-xs)", padding: "var(--space-2xs) 6px" }}
          >
            <IconPlus size={12} />
            <span>{t("editor.sheet_chart")}</span>
          </button>
        )}
      </div>
      {charts.map((chart) => {
        const height = CARD_CHART_TYPES.has(chart.type) ? CARD_HEIGHT : chartHeight;
        return (
          <div
            key={chart.id}
            className="sheet-chart-card"
            // 테두리·안쪽 패딩 없음 — 차트가 패널 폭을 그대로 채운다(PLAN-2026-09-30 §3).
            style={{ cursor: openChartEditor ? "pointer" : undefined }}
            onClick={() => openChartEditor?.(chart)}
            {...(openChartEditor ? preloadIntentProps(ChartEditor) : undefined)}
            title={t("editor.sheet_chart_edit_hint")}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <ChartTypeButton chart={chart} onPick={focus.addChart} />
              {noteId && (
                <button
                  type="button"
                  className="toolbar-btn"
                  data-testid={`chart-register-${chart.id}`}
                  data-active={isChartRegistered(attachments, sectionId, chart.id) ? "true" : undefined}
                  aria-pressed={isChartRegistered(attachments, sectionId, chart.id)}
                  aria-label={t("attachments.chart_register")}
                  title={t("attachments.chart_register")}
                  disabled={registerBusyId === chart.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    void toggleChartRegistered(chart);
                  }}
                  style={{ padding: 4 }}
                >
                  <IconPaperclip size={13} strokeWidth={1.8} />
                </button>
              )}
            </div>
            <Suspense fallback={<div style={{ height }} />}>
              <SheetChart spec={chart} doc={focus.doc} engine={focus.engine} height={height} compact />
            </Suspense>
          </div>
        );
      })}
    </div>
  );
};
