// 선택 범위 → 차트 추천 카드 한 장 (PLAN-2026-09-30 §2). 어시스트 Explore 와 선택 모서리 퀵 칩이 **같은
// 카드**를 쓴다(similar-features-same-path) — 추천 1위를 라이브로 보여주고, 종류 칩으로 대안을 갈아끼우고,
// "고정" = addChartFromSelection(등록 포함, 기존 타일·퀵 칩과 같은 관문).
import { type FC, Suspense, useMemo, useRef, useState } from "react";
import { useElementSize } from "../../lib/useElementSize";
import { t } from "../../i18n/t";
import { addChartFromSelection } from "../../lib/sheet/addChart";
import { defaultChartRanges } from "../../lib/sheet/chart";
import { chartTypeById } from "../../lib/sheet/chartTypes";
import type { SheetEngine } from "../../lib/sheet/engine";
import type { ChartSpec, SheetDoc } from "../../lib/sheet/types";
import { IconCheck, IconPin } from "../icons";
import type { CellRange } from "./useSheetState";
import { SheetChart } from "../../lazySurfaces";


const CARD_H = 140;
// ponytail: jsdom 엔 ResizeObserver 가 없다(useElementSize 참고) — 실측 전엔 이 폭으로 가정.
const CARD_W_FALLBACK = 260;

export const ChartSuggestCard: FC<{
  sectionId: string;
  doc: SheetDoc;
  engine: SheetEngine;
  range: CellRange;
  /** = recommendChartTypes(...) — 첫 번째가 추천. 비면 부르는 쪽이 카드를 안 그린다. */
  types: readonly ChartSpec["type"][];
  onPinned?: () => void;
}> = ({ sectionId, doc, engine, range, types, onPinned }) => {
  // 폭을 재서 숫자로 넘긴다 — ResponsiveContainer 층 없이 카드 폭을 그대로 채운다(SheetChart 의 fixed 경로).
  const boxRef = useRef<HTMLDivElement>(null);
  const { width } = useElementSize(boxRef, { width: CARD_W_FALLBACK, height: 0 });
  const [picked, setPicked] = useState<ChartSpec["type"] | null>(null);
  // 선택이 바뀌어 추천 목록에서 빠진 종류를 붙들고 있지 않게 — 목록에 없으면 1위로 돌아간다.
  const type = picked && types.includes(picked) ? picked : types[0];

  const spec = useMemo<ChartSpec>(() => {
    const ranges = defaultChartRanges(doc, range);
    return { id: `preview-${type}`, type, series: ranges.series, ...(ranges.x ? { x: ranges.x } : {}) };
  }, [doc, range, type]);

  // 이미 같은 종류·같은 범위로 고정된 차트가 있으면 중복 고정을 막고 "고정됨"으로 보인다.
  const pinned = doc.charts?.some(
    (c) => c.type === spec.type && c.x === spec.x && c.series.join("|") === spec.series.join("|"),
  );

  const pin = () => {
    if (pinned) return;
    void addChartFromSelection({ sectionId, range, type, register: true });
    onPinned?.();
  };

  return (
    <div data-testid="chart-suggest-card" data-chart-type={type} style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1)", minHeight: 26 }}>
        {types.length > 1 &&
          types.map((tp) => (
            <button
              key={tp}
              type="button"
              className="toolbar-btn toolbar-btn--text"
              data-testid={`chart-suggest-type-${tp}`}
              aria-pressed={tp === type}
              data-active={tp === type ? "true" : undefined}
              onClick={() => setPicked(tp)}
              style={{ fontSize: "var(--text-xs)", padding: "var(--space-2xs) 6px" }}
            >
              {t(chartTypeById(tp)?.nameKey ?? "editor.sheet_chart")}
            </button>
          ))}
        <button
          type="button"
          className="toolbar-btn toolbar-btn--text"
          data-testid="chart-suggest-pin"
          disabled={pinned}
          onClick={pin}
          style={{ marginLeft: "auto", fontSize: "var(--text-xs)", padding: "var(--space-2xs) 6px" }}
        >
          {pinned ? <IconCheck size={12} /> : <IconPin size={12} />}
          <span>{t(pinned ? "presets.sheet_chart_pinned" : "presets.sheet_chart_pin")}</span>
        </button>
      </div>
      <div ref={boxRef} data-testid={`chart-suggest-preview-${type}`}>
        <Suspense fallback={<div style={{ height: CARD_H }} />}>
          <SheetChart spec={spec} doc={doc} engine={engine} width={Math.max(1, Math.round(width))} height={CARD_H} compact />
        </Suspense>
      </div>
    </div>
  );
};
