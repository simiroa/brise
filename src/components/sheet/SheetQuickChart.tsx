// 선택 모서리 퀵 차트 팝오버 (PLAN-2026-09-20 D6ⓑ·W5 → PLAN-2026-09-30). 어시스트 Explore 와 **같은 카드**
// (ChartSuggestCard: 추천 1위 + 종류 칩 + 고정)를 앱 공용 ContextMenuShell(.overlay·포털·바깥클릭/Escape·
// 화면 밖 클램프) 안에 담는다. 고정 = addChartFromSelection(등록 포함) — 다른 진입점과 같은 관문.
import { type FC } from "react";
import { t } from "../../i18n/t";
import { ContextMenuShell } from "../common/ContextMenuShell";
import type { SheetEngine } from "../../lib/sheet/engine";
import type { ChartSpec, SheetDoc } from "../../lib/sheet/types";
import { ChartSuggestCard } from "./ChartSuggestCard";
import type { CellRange } from "./useSheetState";

export interface SheetQuickChartProps {
  anchor: { x: number; y: number } | null;
  sectionId: string;
  doc: SheetDoc;
  engine: SheetEngine;
  range: CellRange;
  /** = recommendChartTypes(doc, range, engine) — 비어 있으면 SheetSection 이 칩 자체를 안 그린다. */
  types: readonly ChartSpec["type"][];
  onClose: () => void;
}

const CARD_W = 260;

export const SheetQuickChart: FC<SheetQuickChartProps> = ({ anchor, sectionId, doc, engine, range, types, onClose }) => (
  <ContextMenuShell anchor={anchor} onClose={onClose} testId="sheet-quick-chart-popover" ariaLabel={t("editor.sheet_quick_chart")} minWidth={CARD_W}>
    <div style={{ width: CARD_W }}>
      <ChartSuggestCard sectionId={sectionId} doc={doc} engine={engine} range={range} types={types} onPinned={onClose} />
    </div>
  </ContextMenuShell>
);
