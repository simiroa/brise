// 선택 범위 → 차트 하나 — 진입점 셋(어시스트 Explore 타일 · 선택 모서리 퀵 칩 · 툴바 "차트"의 편집기
// onSave)이 **같은 관문**을 지난다(PLAN-2026-09-20 D6, similar-features-same-path). 여기서 스펙을
// 만들고 열린 시트의 `useSheetState.saveChart`(sheetFocus.addChart — undo 1스텝 + 저장 예약)에
// 넣는다. 편집기는 사용자가 범위를 손본 스펙을 같은 saveChart 에 넣으므로 관문이 같다.
import { randomId } from "../ids";
import { t } from "../../i18n/t";
import { useSheetFocus } from "../../stores/sheetFocus";
import { defaultChartRanges } from "./chart";
import { setChartRegistered } from "./chartAttachment";
import type { ChartSpec } from "./types";

export interface AddChartFromSelectionArgs {
  sectionId: string;
  range: { r1: number; c1: number; r2: number; c2: number };
  type: ChartSpec["type"];
  /** true 면 저장 뒤 첨부에 등록(D6ⓒ 와 같은 setChartRegistered). */
  register: boolean;
}

/**
 * 열린 시트가 `sectionId` 가 아니면 `ok:false`(스토어 한 칸 — 다른 섹션의 차트는 못 만든다).
 * 등록 실패는 토스트만(call 이 띄운다) — 차트 자체는 시트에 남는다.
 * ponytail: 등록이 실패해도 차트를 되돌리지 않는다. 차트는 undo 한 번으로 사용자가 지울 수 있고,
 * 첨부 등록은 카드의 클립 버튼으로 다시 시도할 수 있다.
 */
export async function addChartFromSelection(
  args: AddChartFromSelectionArgs,
): Promise<{ ok: boolean; chartId?: string }> {
  const focus = useSheetFocus.getState().focus;
  if (!focus || focus.sectionId !== args.sectionId) return { ok: false };
  const ranges = defaultChartRanges(focus.doc, args.range);
  const spec: ChartSpec = { id: randomId("chart"), type: args.type, series: ranges.series };
  if (ranges.x) spec.x = ranges.x;
  focus.addChart(spec);
  if (args.register) {
    try {
      await setChartRegistered({
        noteId: focus.noteId,
        sectionId: args.sectionId,
        chartId: spec.id,
        name: t("attachments.chart_untitled"),
        on: true,
      });
    } catch {
      // call() 이 토스트를 띄웠다.
    }
  }
  return { ok: true, chartId: spec.id };
}
