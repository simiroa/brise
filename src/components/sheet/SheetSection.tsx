import { type FC, Suspense, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Section } from "../../lib/commands.gen";
import { usePresetsStore } from "../../stores/presets";
import { t } from "../../i18n/t";
import { BodyCollapseToggle } from "../BodyCollapseToggle";
import { parseRef, refKey } from "../../lib/sheet/a1";
import { defaultChartRanges, recommendChartTypes } from "../../lib/sheet/chart";
import { exportSheetAsCsv } from "../../lib/sheet/exportCsv";
import type { ChartSpec } from "../../lib/sheet/types";
import { type DraftChannel, useSheetState } from "./useSheetState";
import { SheetToolbar } from "./SheetToolbar";
import { SheetGrid } from "./SheetGrid";
import { SheetGhostOverlay } from "./SheetGhostOverlay";
import { SheetQuickChart } from "./SheetQuickChart";

import { IconGrab, IconMouseDoubleClick, IconMousePointerClick } from "../icons";
import { useNotesStore } from "../../stores/notes";
import { useSheetFocus } from "../../stores/sheetFocus";
import { runSheetFormulaHelper } from "../../stores/runAiAction";
import { CheatsheetPopover, type CheatsheetItem, Gesture, Key, Sep } from "../common/CheatsheetPopover";
import "./sheetSection.css";
import { ChartEditor } from "../../lazySurfaces";

export interface SheetSectionProps {
  section: Section;
  onOpenChart?: () => void;
}

/**
 * 수식 입력줄만 별도 컴포넌트인 이유: 편집 중 글자는 `DraftChannel` 로 흐르고 **이 컴포넌트만**
 * 구독한다. 부모(SheetSection)가 구독하면 타건마다 툴바·차트·그리드까지 전부 다시 그려진다.
 */
/** 범위 선택 시 나오는 빠른 수식. 이름이 곧 라벨이라 번역할 것이 없다(툴팁은 넣을 수식 그대로). */
const QUICK_FNS = ["SUM", "AVERAGE", "COUNT"] as const;

const SheetFormulaBar: FC<{
  activeCell: string;
  /** 편집칸 왼쪽 상자에 찍히는 글자 — 한 칸이면 "A1", 범위면 "A1:E11". */
  cellLabel: string;
  /** 범위가 두 칸 이상일 때만 넘어온다 = 빠른 수식 칩이 뜨는 조건. */
  quickRange: string | null;
  rawValue: string;
  editingCell: string | null;
  draft: DraftChannel;
  onChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onHelper: () => void;
  onQuickFormula: (fn: string) => void;
}> = ({ activeCell, cellLabel, quickRange, rawValue, editingCell, draft, onChange, onCommit, onCancel, onHelper, onQuickFormula }) => {
  const draftValue = useSyncExternalStore(draft.subscribe, draft.get);
  const value = editingCell === activeCell ? draftValue : rawValue;

  return (
    <div className="sheet-formula-bar">
      <span className="sheet-formula-cell-ref" data-testid="sheet-formula-cell-ref">{cellLabel}</span>
      <span className="sheet-formula-fx">fx</span>
      <input
        className="sheet-formula-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            onHelper();
          } else if (e.key === "Enter") {
            e.preventDefault();
            onCommit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder={t("editor.sheet_formula_helper")}
      />
      {quickRange && (
        <span className="sheet-formula-quick" data-testid="sheet-formula-quick">
          {QUICK_FNS.map((fn) => (
            <button
              key={fn}
              type="button"
              className="sheet-formula-quick-btn"
              // 셀 오버레이에서 편집 중일 때 포커스를 뺏으면 onBlur 가 커밋해 버린다.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onQuickFormula(fn)}
              title={`=${fn}(${quickRange})`}
            >
              {fn}
            </button>
          ))}
        </span>
      )}
    </div>
  );
};

/**
 * Cheatsheet items for the Sheet section.
 * Called at render time so a UI-language switch re-reads it.
 * Every row maps 1:1 to handlers in SheetGrid.tsx.
 */
const SHEET_GESTURES = (): CheatsheetItem[] => [
  { heading: t("editor.sheet_heading_edit") },
  {
    rule: [Gesture(IconMouseDoubleClick, t("common.gesture_dbl_click")), Sep("/"), Key("F2")],
    desc: t("editor.sheet_cheat1_desc"),
  },
  {
    rule: [Key(t("editor.sheet_cheat_type_key"))],
    desc: t("editor.sheet_cheat_type_desc"),
  },
  {
    rule: [Key(t("common.key_delete")), Sep("/"), Key(t("common.key_backspace"))],
    desc: t("editor.sheet_cheat_clear_desc"),
  },
  {
    rule: [Gesture(IconMousePointerClick, t("editor.sheet_cheat_refclick_key"))],
    desc: t("editor.sheet_cheat_refclick_desc"),
  },
  {
    rule: [Key("F4")],
    desc: t("editor.sheet_cheat_f4_desc"),
  },
  {
    rule: [Key(t("common.key_ctrl")), Sep("+"), Key("D"), Sep("/"), Key("R")],
    desc: t("editor.sheet_cheat_filldownright_desc"),
  },
  {
    rule: [Key(t("common.key_ctrl")), Sep("+"), Key(";")],
    desc: t("editor.sheet_cheat_today_desc"),
  },
  {
    rule: [Key(t("common.key_alt")), Sep("+"), Key(t("common.key_enter"))],
    desc: t("editor.sheet_cheat_altenter_desc"),
  },
  {
    rule: [Key("Tab")],
    desc: t("editor.sheet_cheat_autocomplete_desc"),
  },
  {
    rule: [Gesture(IconMousePointerClick, t("editor.sheet_cheat_rclick_key")), Sep("→"), Key(t("editor.sheet_cheat_freeze_key"))],
    desc: t("editor.sheet_cheat_freeze_desc"),
  },

  { heading: t("editor.sheet_heading_nav") },
  {
    rule: [Key(t("common.key_enter")), Sep("/"), Key("Tab")],
    desc: t("editor.sheet_cheat2_desc"),
  },
  {
    rule: [Key("←↑→↓")],
    desc: t("editor.sheet_cheat_arrows_desc"),
  },
  {
    rule: [Key(t("common.key_ctrl")), Sep("+"), Key("A")],
    desc: t("editor.sheet_cheat_selectall_desc"),
  },
  {
    rule: [Key(t("common.key_shift")), Sep("+"), Key("←↑→↓")],
    desc: t("editor.sheet_cheat_shiftarrow_desc"),
  },
  {
    rule: [Key(t("common.key_ctrl")), Sep("+"), Key("←↑→↓")],
    desc: t("editor.sheet_cheat_ctrlarrow_desc"),
  },
  {
    rule: [Key(t("common.key_ctrl")), Sep("+"), Key(t("common.key_shift")), Sep("+"), Key("←↑→↓")],
    desc: t("editor.sheet_cheat_ctrlshiftarrow_desc"),
  },
  {
    rule: [Key("Home"), Sep("/"), Key("End")],
    desc: t("editor.sheet_cheat_homeend_desc"),
  },
  {
    rule: [Key(t("common.key_ctrl")), Sep("+"), Key("Home"), Sep("/"), Key("End")],
    desc: t("editor.sheet_cheat_ctrlhomeend_desc"),
  },
  {
    rule: [Key("Page Up"), Sep("/"), Key("Page Down")],
    desc: t("editor.sheet_cheat_pageupdown_desc"),
  },

  { heading: t("editor.sheet_heading_table") },
  {
    rule: [Key(t("common.key_ctrl")), Sep("+"), Key("C"), Sep("/"), Key("V")],
    desc: t("editor.sheet_cheat_copy_paste_desc"),
  },
  {
    rule: [Key(t("common.key_ctrl")), Sep("+"), Key("Z"), Sep("/"), Key("Y")],
    desc: t("editor.sheet_cheat_undo_redo_desc"),
  },
  {
    rule: [Gesture(IconMousePointerClick, t("editor.sheet_cheat_rclick_key"))],
    desc: t("editor.sheet_cheat_rclick_desc"),
  },
  {
    rule: [Gesture(IconMousePointerClick, t("editor.sheet_cheat_colhead_key"))],
    desc: t("editor.sheet_cheat_colhead_desc"),
  },
  {
    rule: [Gesture(IconGrab, t("editor.sheet_cheat_headerdrag_key"))],
    desc: t("editor.sheet_cheat_headerdrag_desc"),
  },
  {
    rule: [Gesture(IconGrab, t("editor.sheet_cheat_colresize_key"))],
    desc: t("editor.sheet_cheat_colresize_desc"),
  },
  {
    rule: [Gesture(IconMouseDoubleClick, t("editor.sheet_cheat_colboundary_dbl_key"))],
    desc: t("editor.sheet_cheat_colboundary_dbl_desc"),
  },
  {
    rule: [Gesture(IconGrab, t("editor.sheet_cheat_fill_key"))],
    desc: t("editor.sheet_cheat_fill_desc"),
  },
  {
    rule: [Gesture(IconMouseDoubleClick, t("editor.sheet_cheat_filldbl_key"))],
    desc: t("editor.sheet_cheat_filldbl_desc"),
  },
];

export const SheetSection: FC<SheetSectionProps> = ({ section, onOpenChart }) => {
  const state = useSheetState(section);
  const [chartEditorOpen, setChartEditorOpen] = useState(false);
  const [editingChartSpec, setEditingChartSpec] = useState<ChartSpec | null>(null);
  const [helperBusy, setHelperBusy] = useState(false);
  const noteId = useNotesStore((s) => s.activeNote?.note.id);
  // 차트 카드는 어시스트 상단(SheetChartsPanel)에 있다 — 카드 클릭이 이 섹션의 편집기를 열도록 등록.
  useEffect(() => {
    useSheetFocus.getState().setOpenChartEditor((spec) => {
      setEditingChartSpec(spec);
      setChartEditorOpen(true);
    });
    return () => useSheetFocus.getState().setOpenChartEditor(null);
  }, []);

  useEffect(() => {
    return () => {
      usePresetsStore.getState().clearHovered();
    };
  }, []);

  const activeRef = useMemo(
    () => parseRef(state.selection.activeCell) ?? { col: 0, row: 0 },
    [state.selection.activeCell]
  );

  const activeCol = state.doc.cols[activeRef.col];
  const activeColFormat = activeCol?.fmt ?? "text";

  // 선택 영역 지우기와 그리드의 Delete 키는 같은 useSheetState.clearRange 를 쓴다 — 범위 전체가
  // 패치 하나·undo 하나. 여기서는 버튼 활성 여부(비울 게 있는가)만 판단한다.
  const selRange = state.selection.range ?? {
    r1: activeRef.row, c1: activeRef.col, r2: activeRef.row, c2: activeRef.col,
  };
  const hasClearTarget = useMemo(() => {
    for (let r = selRange.r1; r <= selRange.r2; r++) {
      for (let c = selRange.c1; c <= selRange.c2; c++) {
        if ((state.doc.cells[refKey(c, r)]?.raw ?? "") !== "") return true;
      }
    }
    return false;
  }, [selRange.r1, selRange.c1, selRange.r2, selRange.c2, state.doc]);

  // 편집칸 왼쪽 상자 — 한 칸이면 "A1", 끌어서 고른 범위면 "A1:E11". 지금까지 범위를 끌어도
  // 활성 칸만 찍혀서 무엇을 고른 건지 그 상자가 말해주지 않았다.
  const isSingleCell = selRange.r1 === selRange.r2 && selRange.c1 === selRange.c2;
  const quickRange = isSingleCell
    ? null
    : `${refKey(selRange.c1, selRange.r1)}:${refKey(selRange.c2, selRange.r2)}`;
  const rangeLabel = quickRange ?? state.selection.activeCell;

  // 빠른 수식 — 범위 바로 다음 칸(세로 범위면 아래, 가로 한 줄이면 오른쪽)을 골라 편집칸을
  // `=SUM(A1:E11)` 로 채운다. 커밋(Enter)은 수식 도우미와 같은 규칙으로 사용자 몫이다.
  const handleQuickFormula = (fn: string) => {
    if (!quickRange) return;
    const target = selRange.r2 > selRange.r1
      ? refKey(selRange.c1, selRange.r2 + 1)
      : refKey(selRange.c2 + 1, selRange.r1);
    state.setSelection(target);
    state.startEditing(target, `=${fn}(${quickRange})`);
  };

  // 수식 도우미 — `=` 뒤 자연어를 수식 하나로 바꿔 편집칸에 채운다. 커밋(Enter)은 언제나 사용자 몫이다.
  const handleFormulaHelper = async (cell?: string) => {
    if (helperBusy) return;
    const target = cell ?? state.editing?.cell ?? state.selection.activeCell;
    const typed = state.editing?.cell === target
      ? state.draft.get()
      : (state.doc.cells[target]?.raw ?? "");
    if (!typed.replace(/^\s*=/, "").trim()) return;
    setHelperBusy(true);
    try {
      const formula = await runSheetFormulaHelper({
        doc: state.doc,
        targetRef: target,
        request: typed,
        sectionId: section.id,
      });
      // 편집칸을 채우기만 한다 — 자동 커밋 금지.
      if (formula) state.startEditing(target, formula);
    } finally {
      setHelperBusy(false);
    }
  };

  const handleExportCsv = async () => {
    await exportSheetAsCsv(state.doc, `${section.name || "sheet"}.csv`);
  };

  const handleOpenChartEditor = () => {
    if (onOpenChart) {
      onOpenChart();
      return;
    }
    setEditingChartSpec(null);
    setChartEditorOpen(true);
  };

  // 차트 기본 범위는 선택 영역에서 나온다 — 레이블 열 추측은 chart.ts 가 한다.
  const chartDefaults = useMemo(
    () => defaultChartRanges(state.doc, selRange),
    [state.doc, selRange.r1, selRange.c1, selRange.r2, selRange.c2],
  );

  // 퀵 차트 칩(D6ⓑ) — 추천 종류가 없으면 칩·팝오버 둘 다 **부재**(onQuickChart 를 안 넘긴다).
  // 추천 규칙은 어시스트 Explore 그룹과 같은 recommendChartTypes(순수 함수) 하나.
  const quickChartTypes = useMemo(
    () => recommendChartTypes(state.doc, selRange, state.engine),
    [state.doc, state.engine, selRange.r1, selRange.c1, selRange.r2, selRange.c2],
  );
  const [quickChartAnchor, setQuickChartAnchor] = useState<{ x: number; y: number } | null>(null);

  const filledCellCount = useMemo(() => {
    return Object.values(state.doc.cells).filter((c) => c && c.raw.trim().length > 0).length;
  }, [state.doc.cells]);

  useEffect(() => {
    usePresetsStore.getState().setActiveEditorState("sheet", filledCellCount === 0);
  }, [filledCellCount]);

  return (
    <div className="sheet-section" data-testid="sheet-section">
      <SheetToolbar
        canUndo={state.canUndo}
        canRedo={state.canRedo}
        onUndo={state.undo}
        onRedo={state.redo}
        activeFormat={activeColFormat}
        activeDp={activeCol?.dp ?? 0}
        onSetFormat={(fmt, dp, cur) => state.setColFormat(activeRef.col, fmt, dp, cur)}
        onSetDecimals={(dp) => state.setColFormat(activeRef.col, activeColFormat, dp, activeCol?.cur)}
        onInsertRow={() => state.insertRow(activeRef.row, false)}
        onDeleteRow={() => state.deleteRow(activeRef.row)}
        onInsertCol={() => state.insertCol(activeRef.col, false)}
        onDeleteCol={() => state.deleteCol(activeRef.col)}
        onAddRow={() => state.insertRow(state.doc.rows, true)}
        onAddCol={() => state.insertCol(state.doc.cols.length, true)}
        onSortAsc={() => state.sortRange(activeRef.col, false)}
        onSortDesc={() => state.sortRange(activeRef.col, true)}
        onClear={() => state.clearRange(selRange)}
        canClear={hasClearTarget}
        onOpenChart={handleOpenChartEditor}
        onExportCsv={handleExportCsv}
      />

      {/* 수식 입력줄 (Formula Bar) */}
      <SheetFormulaBar
        activeCell={state.selection.activeCell}
        cellLabel={rangeLabel}
        quickRange={quickRange}
        rawValue={state.doc.cells[state.selection.activeCell]?.raw ?? ""}
        editingCell={state.editing?.cell ?? null}
        draft={state.draft}
        onChange={(value) => {
          if (!state.editing || state.editing.cell !== state.selection.activeCell) {
            state.startEditing(state.selection.activeCell, value);
          } else {
            state.setEditingValue(value);
          }
        }}
        onCommit={() => state.commitEditing("down")}
        onCancel={state.cancelEditing}
        onHelper={() => void handleFormulaHelper()}
        onQuickFormula={handleQuickFormula}
      />

      {/* 상한 도달 배너 */}
      {state.atLimit && (
        <div className="sheet-limit-banner">
          <span>{t("editor.sheet_at_limit")}</span>
          <button type="button" className="toolbar-btn toolbar-btn--text" onClick={handleExportCsv}>
            {t("editor.sheet_export_csv")}
          </button>
        </div>
      )}

      {/* 메인 스프레드시트 그리드 및 고스트 오버레이 */}
      <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <SheetGhostOverlay isEmpty={filledCellCount === 0} />
        <SheetGrid
          doc={state.doc}
          engine={state.engine}
          selection={state.selection}
          editing={state.editing}
          draft={state.draft}
          onSetSelection={state.setSelection}
          onStartEditing={state.startEditing}
          onSetEditingValue={state.setEditingValue}
          onCommitEditing={state.commitEditing}
          onCancelEditing={state.cancelEditing}
          onSetCell={state.setCell}
          onClearRange={state.clearRange}
          onSetColWidth={state.setColWidth}
          onInsertRow={state.insertRow}
          onDeleteRow={state.deleteRow}
          onInsertCol={state.insertCol}
          onDeleteCol={state.deleteCol}
          onSortRange={state.sortRange}
          onApplyFillHandle={state.applyFillHandle}
          onSetFrozenRows={state.setFrozenRows}
          onUndo={state.undo}
          onRedo={state.redo}
          onFormulaHelper={(cell) => void handleFormulaHelper(cell)}
          onQuickChart={quickChartTypes.length > 0 ? setQuickChartAnchor : undefined}
        />
        <SheetQuickChart
          anchor={quickChartAnchor}
          sectionId={section.id}
          doc={state.doc}
          engine={state.engine}
          range={selRange}
          types={quickChartTypes}
          onClose={() => setQuickChartAnchor(null)}
        />
      </div>

      {/* 하단 상태바 */}
      <div className="sheet-footer-info section-statusbar">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-7)" }}>
          {/* W24: 어시스트+첨부 일괄 접기/펼치기(ㄴ/ㄱ) — 리치텍스트 상태줄과 공유 컴포넌트. */}
          <BodyCollapseToggle />
          <span>{t("editor.sheet_count_rows", { n: state.doc.rows })}</span>
          {" · "}
          <span>{t("editor.sheet_count_cols", { n: state.doc.cols.length })}</span>
          {" · "}
          <span>{t("editor.sheet_count_cells", { n: filledCellCount })}</span>
        </div>
        <CheatsheetPopover title={t("editor.sheet_cheatsheet_title")} items={SHEET_GESTURES()} />
      </div>

      {/* 차트 에디터 모달 */}
      {chartEditorOpen && (
        <Suspense fallback={null}>
          <ChartEditor
            initialSpec={editingChartSpec}
            doc={state.doc}
            engine={state.engine}
            defaultXRange={chartDefaults.x}
            defaultSeriesRanges={chartDefaults.series}
            onSave={state.saveChart}
            onDelete={state.deleteChart}
            noteId={noteId}
            sectionId={section.id}
            onClose={() => {
              setChartEditorOpen(false);
              setEditingChartSpec(null);
            }}
          />
        </Suspense>
      )}
    </div>
  );
};
