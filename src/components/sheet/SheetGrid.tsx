import {
  type CSSProperties,
  type FC,
  type KeyboardEvent,
  type MouseEvent,
  type UIEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Grid, type GridImperativeAPI } from "react-window";
import { colToLetters, parseRef, refKey } from "../../lib/sheet/a1";
import { formatCell } from "../../lib/sheet/format";
import type { CellFmt, SheetDoc } from "../../lib/sheet/types";
import type { SheetEngine } from "../../lib/sheet/engine";
import { fromTsv } from "../../lib/sheet/projection";
import {
  autoFitWidth,
  fillHandleDoubleClickTarget,
  selectAllRange,
  SHEET_MIN_COL_WIDTH,
} from "../../lib/sheet/navigation";
import { columnSuggestion, cycleAbsolute, insertRefIntoFormula, refAtCaret } from "../../lib/sheet/editing";
import { DEFAULT_ROW_HEIGHT, rowHeightOf, rowLineCounts, rowOffsets } from "../../lib/sheet/rowHeights";
import { handleSheetKeyDown, nowHM, todayYMD } from "./sheetKeymap";
import type { CellRange, DraftChannel, EditingState, SheetSelection } from "./useSheetState";
import { SheetContextMenu } from "./SheetContextMenu";
import { usePresetsStore } from "../../stores/presets";
import { IconChart } from "../icons";
import { t } from "../../i18n/t";

export const SHEET_PRESET_GHOSTS: Record<string, Record<string, string>> = {
  sheet: {
    A1: "항목",
    B1: "수량",
    C1: "단가",
    D1: "금액",
    A2: "샘플 A",
    B2: "2",
    C2: "10,000",
    D2: "20,000",
    A3: "샘플 B",
    B3: "5",
    C3: "3,000",
    D3: "15,000",
  },
  budget: {
    A1: "날짜",
    B1: "구분",
    C1: "내용",
    D1: "금액",
    A2: "09/01",
    B2: "식비",
    C2: "점심 식사",
    D2: "-12,000",
    A3: "09/02",
    B3: "교통",
    C3: "지하철",
    D3: "-30,000",
  },
  sheet_schedule: {
    A1: "시간",
    B1: "월",
    C1: "화",
    D1: "수",
    E1: "목",
    F1: "금",
    A2: "09:00",
    B2: "주간 회의",
    C2: "기획 검토",
    D2: "디자인 리뷰",
    E2: "개발 스프린트",
    F2: "주간 회고",
    A3: "14:00",
    B3: "팀 미팅",
    C3: "자료 작성",
    D3: "QA 테스트",
    E3: "배포 준비",
    F3: "정리",
  },
  sheet_tracker: {
    A1: "작업명",
    B1: "담당자",
    C1: "마감일",
    D1: "상태",
    E1: "우선순위",
    A2: "로그인 화면 개선",
    B2: "홍길동",
    C2: "09/10",
    D2: "진행중",
    E2: "높음",
    A3: "데이터 백업",
    B3: "이순신",
    C3: "09/15",
    D3: "대기",
    E3: "보통",
  },
};

export interface SheetGridProps {
  doc: SheetDoc;
  engine: SheetEngine;
  selection: SheetSelection;
  editing: EditingState | null;
  /** 편집 중인 글자가 흐르는 채널. 리액트 상태가 아니다 — 헤더 주석 참고. */
  draft: DraftChannel;
  onSetSelection: (activeCell: string, range?: CellRange | null) => void;
  onStartEditing: (cell: string, initialValue?: string) => void;
  /** `caret` 을 같이 주면 편집칸 커서를 그 자리로 되돌린다(참조 클릭 삽입 등). */
  onSetEditingValue: (value: string, caret?: number) => void;
  onCommitEditing: (nextAction?: "down" | "right" | "stay") => void;
  onCancelEditing: () => void;
  onSetCell: (a1: string, raw: string, fmt?: CellFmt, dp?: number, cur?: string) => void;
  /** 범위 비우기(Delete/Backspace) — 패치 하나·undo 하나. */
  onClearRange: (range: CellRange) => void;
  onSetColWidth: (colIdx: number, width: number) => void;
  onInsertRow: (atRow: number, after?: boolean) => void;
  onDeleteRow: (atRow: number) => void;
  onInsertCol: (atCol: number, after?: boolean) => void;
  onDeleteCol: (atCol: number) => void;
  onSortRange: (colIdx: number, desc?: boolean) => void;
  onApplyFillHandle: (sourceRange: CellRange, targetRange: CellRange) => void;
  onUndo: () => void;
  onRedo: () => void;
  /** 첫 행 고정 토글(우클릭 행 메뉴) — 없으면 그 메뉴 항목이 안 나온다(PLAN-2026-09-21 W2). */
  onSetFrozenRows?: (n: number) => void;
  /** 수식 도우미(Ctrl+Enter) — 없으면 그 키는 그냥 무시된다(읽기 전용 미리보기 등). */
  onFormulaHelper?: (cell: string) => void;
  /** 선택 모서리 퀵 차트 칩(PLAN-2026-09-20 D6ⓑ) — 없으면 칩도 없다(추천 종류가 없을 때 SheetSection 이 뺀다).
   *  칩은 선택이 2셀 이상일 때만 그려지고, 클릭 좌표를 팝오버 앵커로 넘긴다. */
  onQuickChart?: (anchor: { x: number; y: number }) => void;
}

const DEFAULT_COL_WIDTH = 100;
const ROW_HEADER_WIDTH = 45;
const COL_HEADER_HEIGHT = 24;

// ponytail: ResizeObserver 가 없거나(jsdom) 컨테이너가 아직 0×0 일 때 쓰는 가짜 뷰포트.
// 실제 브라우저에선 useLayoutEffect 의 첫 clientWidth 읽기가 곧바로 진짜 값을 넣는다.
const FALLBACK_VIEWPORT = { width: 800, height: 400 };

/**
 * 열 경계 더블클릭 자동 맞춤 — 그리드 폰트로 텍스트 폭을 재는 캔버스 하나를 재사용한다.
 * ponytail: jsdom(테스트)은 2d 컨텍스트가 없다 — 그때는 글자 수 어림값으로 떨어진다(실제
 * 브라우저에선 항상 canvas 를 쓴다).
 */
let measureCtx: CanvasRenderingContext2D | null | undefined;
function measureTextWidth(font: string, text: string): number {
  if (measureCtx === undefined) measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length * 7;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

// --- 테스트 프로브 -------------------------------------------------------------
// 셀 컴포넌트 본문이 몇 번 돌았는지. "타건 한 번에 그리드가 다시 그려지지 않는다"는 계약을
// 회귀로 잡는 유일한 방법이라 프로덕션 코드에 남긴다(카운터 증가 한 줄).
let cellRenders = 0;
export function sheetCellRenderCount(): number {
  return cellRenders;
}
export function resetSheetCellRenderCount(): void {
  cellRenders = 0;
}

type ContextTarget = { type: "cell" | "row" | "col"; row?: number; col?: number; a1?: string };

/** 셀이 부모를 부를 때 쓰는 창구. 객체 하나가 마운트 내내 같은 참조로 유지된다(메모 유지). */
interface GridHandlers {
  mouseDown: (r: number, c: number, e: MouseEvent) => void;
  mouseEnter: (r: number, c: number) => void;
  doubleClick: (a1: string) => void;
  contextMenu: (e: MouseEvent, target: ContextTarget) => void;
  setCell: (a1: string, raw: string) => void;
  startFill: (e: MouseEvent) => void;
  fillHandleDoubleClick: () => void;
  commit: (next?: "down" | "right" | "stay") => void;
  cancel: () => void;
  formulaHelper: (cell: string) => void;
  quickChart: (anchor: { x: number; y: number }) => void;
}

/**
 * `react-window` 는 이 객체를 모든 셀에 그대로 넘기고, 값이 얕게 같으면 셀 렌더를 건너뛴다
 * (`memo` + shallow compare 가 라이브러리 안에 있다). 그래서 **여기 담긴 값이 안 바뀌면
 * 그리드는 다시 그려지지 않는다** — 타건 격리가 성립하는 지점이 정확히 이곳이다.
 */
interface CellData {
  doc: SheetDoc;
  engine: SheetEngine;
  activeRow: number;
  activeCol: number;
  selR1: number;
  selC1: number;
  selR2: number;
  selC2: number;
  editingCell: string | null;
  draft: DraftChannel;
  h: GridHandlers;
  /** 퀵 차트 칩을 그릴 수 있는가(= onQuickChart 있음). 2셀 이상 조건은 셀이 sel 좌표로 판단한다. */
  quickChart: boolean;
}

type CellRenderProps = CellData & {
  columnIndex: number;
  rowIndex: number;
  style: CSSProperties;
};

/** 편집 오버레이. 글자를 **자기가** 들고, 커밋/취소 때만 부모에게 말한다.
 * `<textarea>` 인 이유는 Alt+Enter 셀 내 줄바꿈(PLAN-2026-09-21 W2) 하나 — 행 높이는 고정(§3 잔여)이라
 * 읽기 모드 렌더(`.sheet-cell` white-space:nowrap)는 그대로 한 줄로 보이고, 편집 중에만 여러 줄이
 * 보인다(넘치는 줄은 잘린다 — 계획 표가 제시한 두 택 중 첫 번째). */
const CellEditor: FC<{
  cellRef: string;
  draft: DraftChannel;
  h: GridHandlers;
  doc: SheetDoc;
  col: number;
  row: number;
}> = ({ cellRef, draft, h, doc, col, row }) => {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 같은 열 자동완성 제안 — draft 는 리액트 상태가 아니라(헤더 주석) 이 칸 자신의 로컬 상태로 켠다.
  // 켜져 있는 동안만 이 편집 인스턴스가 다시 그려진다(그리드 전체 리렌더가 아니다).
  const [suggestion, setSuggestion] = useState<string | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    // 수식 입력줄·수식 도우미·참조 삽입이 밖에서 글자를 바꾸면 DOM 값만 갈아끼운다(리렌더 없음).
    return draft.subscribe(() => {
      const el = inputRef.current;
      if (!el) return;
      if (el.value !== draft.get()) el.value = draft.get();
      const caret = draft.getCaret();
      if (caret != null) el.setSelectionRange(caret, caret);
    });
  }, [draft]);

  const updateSuggestion = (value: string) => {
    if (value.startsWith("=") || value.length < 2) {
      setSuggestion(null);
      return;
    }
    setSuggestion(columnSuggestion(doc, col, row, value));
  };

  const acceptSuggestion = () => {
    if (!suggestion) return false;
    draft.set(suggestion, suggestion.length);
    setSuggestion(null);
    return true;
  };

  return (
    <>
      <textarea
        ref={inputRef}
        className="sheet-cell-input-overlay"
        rows={1}
        defaultValue={draft.get()}
        onChange={(e) => {
          draft.set(e.target.value);
          updateSuggestion(e.target.value);
        }}
        onKeyDown={(e) => {
          const el = e.currentTarget;
          if (e.key === "Tab" && acceptSuggestion()) {
            e.preventDefault();
            return;
          }
          if (e.key === "ArrowRight" && (el.selectionStart ?? 0) === draft.get().length && acceptSuggestion()) {
            e.preventDefault();
            return;
          }
          if (e.key === "F4") {
            // 캐럿이 걸친 참조의 $ 순환(B2 → $B$2 → B$2 → $B2 → B2) — 수식 편집 중에만 의미가 있다.
            e.preventDefault();
            const caret = el.selectionStart ?? draft.get().length;
            const hit = refAtCaret(draft.get(), caret);
            if (hit) {
              const cycled = cycleAbsolute(hit.text);
              const next = draft.get().slice(0, hit.start) + cycled + draft.get().slice(hit.end);
              draft.set(next, hit.start + cycled.length);
            }
            return;
          }
          if ((e.ctrlKey || e.metaKey) && (e.code === "Semicolon" || e.key === ";" || e.key === ":")) {
            // Ctrl+; 오늘 날짜 / Ctrl+Shift+; 지금 시각 — 캐럿(또는 선택 영역)에 삽입.
            // 표준 US 배열에서 Shift 를 누르면 세미콜론 키의 e.key 가 ":" 로 바뀐다(리뷰 발견,
            // PLAN-2026-09-21 W2) — e.code(물리 키) 를 우선 확인하고, 없는 환경 대비 ":" 도 함께 받는다.
            e.preventDefault();
            const start = el.selectionStart ?? draft.get().length;
            const end = el.selectionEnd ?? start;
            const text = e.shiftKey ? nowHM() : todayYMD();
            const next = draft.get().slice(0, start) + text + draft.get().slice(end);
            draft.set(next, start + text.length);
            return;
          }
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            // 수식 도우미 — 커밋하지 않는다. 제안이 이 칸에 채워지고 Enter 는 사용자가.
            e.preventDefault();
            h.formulaHelper(cellRef);
          } else if (e.key === "Enter" && e.altKey) {
            // 셀 내 줄바꿈 — 커밋하지 않는다.
            e.preventDefault();
            const start = el.selectionStart ?? draft.get().length;
            const end = el.selectionEnd ?? start;
            const next = draft.get().slice(0, start) + "\n" + draft.get().slice(end);
            draft.set(next, start + 1);
          } else if (e.key === "Enter") {
            e.preventDefault();
            h.commit("down");
          } else if (e.key === "Tab") {
            e.preventDefault();
            h.commit("right");
          } else if (e.key === "Escape") {
            e.preventDefault();
            h.cancel();
          }
        }}
        onBlur={() => h.commit("stay")}
      />
      {suggestion && (
        // 고전적인 고스트 자동완성 트릭 — 타이핑한 부분은 투명(실제 textarea 글자가 그대로 비친다),
        // 나머지 꼬리만 회색으로 그 뒤에 겹쳐 보인다. textarea 를 투명하게 만들 필요가 없다
        // (아크릴 계약 위반 없이 기존 불투명 편집 배경을 유지).
        <div className="sheet-cell-suggest" aria-hidden="true">
          <span className="sheet-cell-suggest-typed">{draft.get()}</span>
          <span className="sheet-cell-suggest-rest">{suggestion.slice(draft.get().length)}</span>
        </div>
      )}
    </>
  );
};

function SheetCellView({
  columnIndex: c,
  rowIndex: r,
  style,
  doc,
  engine,
  activeRow,
  activeCol,
  selR1,
  selC1,
  selR2,
  selC2,
  editingCell,
  draft,
  h,
  quickChart,
}: CellRenderProps) {
  cellRenders++;

  const a1 = refKey(c, r);
  const colDef = doc.cols[c];
  const fmt = colDef?.fmt ?? "text";
  const dp = colDef?.dp;
  const cur = colDef?.cur;

  const evalVal = engine.getValue(a1);
  const isError = typeof evalVal === "object" && evalVal !== null && "error" in evalVal;
  const hl = doc.cells[a1]?.hl;

  const selected = r >= selR1 && r <= selR2 && c >= selC1 && c <= selC2;
  const active = r === activeRow && c === activeCol;
  const isEditingThis = editingCell === a1;
  // 채우기 핸들 위치: 선택 영역의 맨 우측 하단 셀
  const isBottomRight = r === selR2 && c === selC2;

  const rawVal = engine.getRaw(a1);
  const hasValue = (rawVal && rawVal.trim() !== "") || evalVal !== "";
  // 다중 줄 값(Alt+Enter 로 넣은 개행)만 읽기 모드에서도 줄바꿈을 보여준다 — 수식 결과는 항상 한 줄.
  const isMultiline = !!rawVal && !rawVal.startsWith("=") && rawVal.includes("\n");
  const hoveredPreset = usePresetsStore((s) => s.hovered);
  const ghostVal = !hasValue && hoveredPreset && SHEET_PRESET_GHOSTS[hoveredPreset.id]
    ? SHEET_PRESET_GHOSTS[hoveredPreset.id][a1]
    : undefined;

  return (
    <div
      role="gridcell"
      className={`sheet-cell ${selected ? "selected" : ""} ${active ? "active-cell" : ""} ${isError ? "error-cell" : ""}`}
      data-hl={hl}
      data-multiline={isMultiline || undefined}
      style={{
        ...style,
        textAlign: fmt === "number" || fmt === "currency" || fmt === "percent" ? "right" : "left",
      }}
      onMouseDown={(e) => h.mouseDown(r, c, e)}
      onMouseEnter={() => h.mouseEnter(r, c)}
      onDoubleClick={() => h.doubleClick(a1)}
      onContextMenu={(e) => h.contextMenu(e, { type: "cell", row: r, col: c, a1 })}
    >
      {isEditingThis ? (
        <CellEditor cellRef={a1} draft={draft} h={h} doc={doc} col={c} row={r} />
      ) : fmt === "checkbox" ? (
        <div className="sheet-cell-checkbox">
          <input
            type="checkbox"
            checked={evalVal === true || String(evalVal).toUpperCase() === "TRUE"}
            onChange={(e) => h.setCell(a1, e.target.checked ? "TRUE" : "FALSE")}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      ) : hasValue ? (
        <span>{formatCell(evalVal, fmt, { dp, cur })}</span>
      ) : ghostVal ? (
        <span style={{ color: "var(--accent)", opacity: 0.45, fontStyle: "italic" }}>
          {ghostVal}
        </span>
      ) : null}

      {isBottomRight && !editingCell && (
        <div
          className="sheet-fill-handle"
          onMouseDown={(e) => {
            e.stopPropagation();
            h.startFill(e);
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            h.fillHandleDoubleClick();
          }}
        />
      )}
      {/* 퀵 차트 칩 — 채우기 핸들과 같은 자리(선택 우하단 셀), 2셀 이상 선택일 때만.
          ponytail: 셀 안 우측에 둔다 — .sheet-cell 이 overflow:hidden 이라 셀 밖으로 못 나간다.
          밖으로 빼려면 SheetGrid 에 스크롤 추적 레이어가 필요하다. */}
      {isBottomRight && quickChart && !editingCell && (selR1 !== selR2 || selC1 !== selC2) && (
        <button
          type="button"
          className="toolbar-btn"
          data-testid="sheet-quick-chart"
          style={{ position: "absolute", right: 2, top: "50%", transform: "translateY(-50%)", width: 18, height: 18, minHeight: 18, color: "var(--accent)", opacity: 1, zIndex: 2 }}
          aria-label={t("editor.sheet_quick_chart")}
          title={t("editor.sheet_quick_chart")}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            h.quickChart({ x: e.clientX, y: e.clientY });
          }}
        >
          <IconChart size={12} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}

export const SheetGrid: FC<SheetGridProps> = (props) => {
  const {
    doc,
    engine,
    selection,
    editing,
    draft,
    onSetSelection,
    onStartEditing,
    onSetCell,
    onClearRange,
    onSetColWidth,
    onInsertRow,
    onDeleteRow,
    onInsertCol,
    onDeleteCol,
    onSortRange,
    onApplyFillHandle,
    onUndo,
    onRedo,
  } = props;

  const containerRef = useRef<HTMLDivElement>(null);
  const gridApiRef = useRef<GridImperativeAPI | null>(null);
  const colHeaderRef = useRef<HTMLDivElement>(null);
  const rowHeaderRef = useRef<HTMLDivElement>(null);
  const frozenRowsRef = useRef<HTMLDivElement>(null);

  // 컨텍스트 메뉴 상태
  const [contextMenu, setContextMenu] = useState<{
    pos: { x: number; y: number } | null;
    target: ContextTarget | null;
  }>({ pos: null, target: null });

  // 열 리사이즈 상태. 드래그 중 폭(`w`)은 **여기서만** 산다 — 문서는 마우스를 뗄 때 한 번
  // 바뀐다. 픽셀마다 doc 을 고치면 undo 스텝도 픽셀마다 쌓인다(라이브 QA 2026-08-19).
  const [resizingCol, setResizingCol] = useState<{ col: number; startX: number; startW: number; w: number } | null>(
    null
  );

  // 셀 범위 드래그 선택 상태
  const [isSelecting, setIsSelecting] = useState(false);
  const [dragStartRef, setDragStartRef] = useState<{ row: number; col: number } | null>(null);

  // 머리글 드래그 선택 상태(열/행 범위) — 셀 드래그와 같은 window mousemove/mouseup 패턴이지만
  // 머리글 칸은 mouseEnter 로만 확장한다(스크롤 밖 자동 스크롤은 하지 않는다, §3 잔여).
  const [headerDrag, setHeaderDrag] = useState<{ axis: "col" | "row"; start: number } | null>(null);

  // 채우기 핸들(Fill Handle) 드래그 상태
  const [fillDragging, setFillDragging] = useState<{
    sourceRange: CellRange;
    currentRange: CellRange;
  } | null>(null);

  // 수식 편집 중 셀/범위 클릭으로 참조를 삽입하는 드래그 상태(PLAN-2026-09-21 W2). anchor 는
  // 드래그 시작 셀, refStart/refEnd 는 draft 문자열 안에서 그 참조/범위 텍스트가 차지하는 구간 —
  // mouseEnter 가 그 구간만 다시 써서 범위를 넓힌다("A1" → "A1:B2").
  const [formulaRefDrag, setFormulaRefDrag] = useState<{
    anchorRow: number;
    anchorCol: number;
    refStart: number;
    refEnd: number;
  } | null>(null);

  const numCols = Math.max(doc.cols.length, 26);
  const numRows = Math.max(doc.rows, 50);

  // 활성 셀의 좌표 파싱
  const activeRef = useMemo(() => parseRef(selection.activeCell) ?? { col: 0, row: 0 }, [selection.activeCell]);

  // 열 너비 가져오기 — 드래그 중인 열만 미리보기 폭으로 덮어쓴다.
  const getColWidth = useCallback(
    (c: number) => (resizingCol && resizingCol.col === c ? resizingCol.w : doc.cols[c]?.w ?? DEFAULT_COL_WIDTH),
    [doc.cols, resizingCol]
  );

  // 헤더 배치를 위한 열 누적 오프셋 (길이 numCols+1)
  const colOffsets = useMemo(() => {
    const out = new Array<number>(numCols + 1);
    out[0] = 0;
    for (let i = 0; i < numCols; i++) out[i + 1] = out[i] + getColWidth(i);
    return out;
  }, [numCols, getColWidth]);

  // 가변 행 높이(lib/sheet/rowHeights.ts) — Alt+Enter 로 넣은 개행이 있는 셀만 그 행을 키운다.
  const rowLines = useMemo(() => rowLineCounts(doc, numRows), [doc, numRows]);
  const rowHeightsArr = useMemo(() => rowLines.map(rowHeightOf), [rowLines]);
  const rowOffsetsArr = useMemo(() => rowOffsets(rowHeightsArr), [rowHeightsArr]);
  const getRowHeight = useCallback((r: number) => rowHeightsArr[r] ?? DEFAULT_ROW_HEIGHT, [rowHeightsArr]);

  // --- 뷰포트 실측 -------------------------------------------------------------
  const [box, setBox] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const read = () =>
      setBox((prev) =>
        prev.width === el.clientWidth && prev.height === el.clientHeight
          ? prev
          : { width: el.clientWidth, height: el.clientHeight }
      );
    read();
    if (typeof ResizeObserver === "undefined") return; // ponytail: jsdom — FALLBACK_VIEWPORT 로 간다
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const bodyWidth = (box.width || FALLBACK_VIEWPORT.width) - ROW_HEADER_WIDTH;
  const bodyHeight = (box.height || FALLBACK_VIEWPORT.height) - COL_HEADER_HEIGHT;

  // --- 헤더에 그릴 범위 (본문이 실제로 그린 칸만) --------------------------------
  const [visible, setVisible] = useState({ rowStart: 0, rowStop: 0, colStart: 0, colStop: 0 });
  const handleCellsRendered = useCallback(
    (
      _visibleCells: unknown,
      all: { columnStartIndex: number; columnStopIndex: number; rowStartIndex: number; rowStopIndex: number }
    ) => {
      setVisible((prev) =>
        prev.rowStart === all.rowStartIndex &&
        prev.rowStop === all.rowStopIndex &&
        prev.colStart === all.columnStartIndex &&
        prev.colStop === all.columnStopIndex
          ? prev
          : {
              rowStart: all.rowStartIndex,
              rowStop: all.rowStopIndex,
              colStart: all.columnStartIndex,
              colStop: all.columnStopIndex,
            }
      );
    },
    []
  );

  // 헤더는 본문 스크롤을 따라간다. 리액트 상태를 거치지 않는다 — 스크롤마다 리렌더하면
  // 가상화로 아낀 걸 도로 쓴다.
  const handleScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (colHeaderRef.current) colHeaderRef.current.style.transform = `translateX(${-el.scrollLeft}px)`;
    if (rowHeaderRef.current) rowHeaderRef.current.style.transform = `translateY(${-el.scrollTop}px)`;
    // 첫 행 고정(PLAN-2026-09-21 W2) — 세로는 안 움직인다(그게 고정의 정의), 가로만 본문을 따라간다.
    if (frozenRowsRef.current) frozenRowsRef.current.style.transform = `translateX(${-el.scrollLeft}px)`;
  }, []);

  // 키보드로 옮긴 활성 셀을 화면 안으로.
  useEffect(() => {
    const api = gridApiRef.current;
    if (!api) return;
    try {
      api.scrollToCell({
        rowIndex: Math.min(Math.max(activeRef.row, 0), numRows - 1),
        columnIndex: Math.min(Math.max(activeRef.col, 0), numCols - 1),
      });
    } catch {
      // jsdom 은 Element.scrollTo 가 없다 — 스크롤은 뷰 관심사라 무시해도 안전하다.
    }
  }, [activeRef.row, activeRef.col, numRows, numCols]);

  // --- 마우스 전역 처리 ---------------------------------------------------------
  useEffect(() => {
    const handleMouseUp = () => {
      setIsSelecting(false);
      setDragStartRef(null);
      setHeaderDrag(null);
      setFormulaRefDrag(null); // 참조 삽입은 draft 만 바꾸는 편집 중 조작 — 뗄 때 커밋할 문서 변경이 없다.

      if (fillDragging) {
        if (fillDragging.currentRange.r2 > fillDragging.sourceRange.r2) {
          onApplyFillHandle(fillDragging.sourceRange, fillDragging.currentRange);
        }
        setFillDragging(null);
      }

      if (resizingCol) {
        // 드래그 하나 = 문서 변경 하나 = undo 한 단계.
        if (resizingCol.w !== resizingCol.startW) onSetColWidth(resizingCol.col, resizingCol.w);
        setResizingCol(null);
      }
    };

    const handleMouseMove = (e: globalThis.MouseEvent) => {
      if (resizingCol) {
        const delta = e.clientX - resizingCol.startX;
        const newW = Math.max(SHEET_MIN_COL_WIDTH, resizingCol.startW + delta);
        setResizingCol((prev) => (prev && prev.w !== newW ? { ...prev, w: newW } : prev));
      }
    };

    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("mousemove", handleMouseMove);
    return () => {
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("mousemove", handleMouseMove);
    };
  }, [fillDragging, resizingCol, isSelecting, dragStartRef, onApplyFillHandle, onSetColWidth]);

  // 선택 범위 TSV 문자열 추출
  const getSelectedTsv = useCallback(() => {
    const range = selection.range ?? { r1: activeRef.row, c1: activeRef.col, r2: activeRef.row, c2: activeRef.col };
    const rows: string[] = [];
    for (let r = range.r1; r <= range.r2; r++) {
      const cols: string[] = [];
      for (let c = range.c1; c <= range.c2; c++) {
        cols.push(doc.cells[refKey(c, r)]?.raw ?? "");
      }
      rows.push(cols.join("\t"));
    }
    return rows.join("\n");
  }, [selection.range, activeRef, doc.cells]);

  // 키보드 네비게이션 — 분기 사슬은 sheetKeymap.ts 가 통째로 들고 있다(PLAN-2026-09-13 A2b).
  // ctx 는 **매 렌더 새로** 만든다(stale 클로저 방지). 편집 중이면 키는 CellEditor 가 받으므로
  // 여기서 조기 반환한다 — 옮기기 전 handleKeyDown 첫 줄과 같은 자리다.
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing) return;
    handleSheetKeyDown(e, {
      doc,
      selection,
      activeRef,
      numRows,
      numCols,
      rowOffsets: rowOffsetsArr,
      // bodyHeight 는 실측 전엔 FALLBACK_VIEWPORT 기반이라 못 쓴다 — null 로 넘겨 10행 폴백에 맡긴다.
      pageHeight: box.height > 0 ? bodyHeight : null,
      getSelectedTsv,
      onSetSelection,
      onStartEditing,
      onSetCell,
      onClearRange,
      onApplyFillHandle,
      onUndo,
      onRedo,
    });
  };

  const selRange = selection.range ?? { r1: activeRef.row, c1: activeRef.col, r2: activeRef.row, c2: activeRef.col };
  const paintRange = fillDragging ? fillDragging.currentRange : selRange;

  // 컨텍스트 메뉴 열기. 우클릭은 **선택을 따라간다** — 그래야 툴바(서식·정렬·행/열)가 방금
  // 우클릭한 대상에 대해 동작한다. 예전엔 따라가지 않아서 메뉴가 서식 6줄을 자기 안에 또
  // 들고 있어야 했다(그래서 메뉴가 길었다). 이미 고른 범위 안을 우클릭하면 범위는 유지한다 —
  // 안 그러면 범위 복사가 한 칸 복사로 무너진다.
  const handleContextMenu = (e: MouseEvent, target: ContextTarget) => {
    e.preventDefault();
    if (target.type === "col" && target.col !== undefined) {
      onSetSelection(refKey(target.col, 0), { r1: 0, c1: target.col, r2: numRows - 1, c2: target.col });
    } else if (target.type === "row" && target.row !== undefined) {
      onSetSelection(refKey(0, target.row), { r1: target.row, c1: 0, r2: target.row, c2: numCols - 1 });
    } else if (target.type === "cell" && target.row !== undefined && target.col !== undefined) {
      const inSel =
        target.row >= selRange.r1 && target.row <= selRange.r2 &&
        target.col >= selRange.c1 && target.col <= selRange.c2;
      if (!inSel) onSetSelection(refKey(target.col, target.row));
    }
    setContextMenu({ pos: { x: e.clientX, y: e.clientY }, target });
  };

  // --- 셀이 부모를 부르는 창구 ---------------------------------------------------
  // 셀 하나하나에 클로저를 만들어 넘기면 그 클로저가 매 렌더 새 참조라 memo 가 통째로 무효화된다.
  // 최신 값은 ref 로 읽고, 창구 객체 자체는 마운트 내내 같은 참조로 둔다.
  const latest = useRef({ props, editing, activeRef, selRange, draft, fillDragging, formulaRefDrag, isSelecting, dragStartRef, handleContextMenu });
  latest.current = { props, editing, activeRef, selRange, draft, fillDragging, formulaRefDrag, isSelecting, dragStartRef, handleContextMenu };

  const handlers = useMemo<GridHandlers>(() => ({
    mouseDown: (r, c, e) => {
      if (e.button !== 0) return; // 좌클릭만 처리
      const cur = latest.current;
      const a1 = refKey(c, r);

      // 수식 작성 중 다른 셀 클릭 → 캐럿(또는 참조 직후) 위치에 참조 삽입(PLAN-2026-09-21 W2).
      // 조건에 안 맞으면(캐럿 앞이 삽입 불가 문맥) 아무 것도 안 바뀐다 — 그래도 e.preventDefault 는
      // 유지해 편집 세션이 블러로 끊기지 않게 한다.
      if (cur.editing && cur.draft.get().startsWith("=")) {
        e.preventDefault();
        const draftVal = cur.draft.get();
        const activeEl = document.activeElement as HTMLTextAreaElement | null;
        const caret = activeEl && typeof activeEl.selectionStart === "number" ? activeEl.selectionStart : draftVal.length;
        const result = insertRefIntoFormula(draftVal, caret, a1);
        if (result.draft !== draftVal) {
          cur.props.onSetEditingValue(result.draft, result.caret);
          setFormulaRefDrag({ anchorRow: r, anchorCol: c, refStart: result.caret - a1.length, refEnd: result.caret });
        }
        return;
      }

      if (cur.editing) {
        cur.props.onCommitEditing("stay");
      }

      if (e.shiftKey) {
        const r1 = Math.min(cur.activeRef.row, r);
        const c1 = Math.min(cur.activeRef.col, c);
        const r2 = Math.max(cur.activeRef.row, r);
        const c2 = Math.max(cur.activeRef.col, c);
        cur.props.onSetSelection(cur.props.selection.activeCell, { r1, c1, r2, c2 });
      } else {
        setIsSelecting(true);
        setDragStartRef({ row: r, col: c });
        cur.props.onSetSelection(a1, { r1: r, c1: c, r2: r, c2: c });
      }
    },
    mouseEnter: (r, c) => {
      const cur = latest.current;
      if (cur.formulaRefDrag) {
        // 참조 삽입 드래그 — 앵커부터 지금 칸까지 범위로 넓혀 이미 넣은 참조 구간을 다시 쓴다.
        const { anchorRow, anchorCol, refStart, refEnd } = cur.formulaRefDrag;
        const minR = Math.min(anchorRow, r), maxR = Math.max(anchorRow, r);
        const minC = Math.min(anchorCol, c), maxC = Math.max(anchorCol, c);
        const rangeStr = minR === maxR && minC === maxC
          ? refKey(minC, minR)
          : `${refKey(minC, minR)}:${refKey(maxC, maxR)}`;
        const draftVal = cur.draft.get();
        const nextDraft = draftVal.slice(0, refStart) + rangeStr + draftVal.slice(refEnd);
        const nextEnd = refStart + rangeStr.length;
        cur.props.onSetEditingValue(nextDraft, nextEnd);
        setFormulaRefDrag({ anchorRow, anchorCol, refStart, refEnd: nextEnd });
        return;
      }
      if (cur.isSelecting && cur.dragStartRef) {
        const start = cur.dragStartRef;
        cur.props.onSetSelection(cur.props.selection.activeCell, {
          r1: Math.min(start.row, r),
          c1: Math.min(start.col, c),
          r2: Math.max(start.row, r),
          c2: Math.max(start.col, c),
        });
      } else if (cur.fillDragging) {
        const src = cur.fillDragging.sourceRange;
        setFillDragging({ sourceRange: src, currentRange: { ...src, r2: Math.max(src.r2, r) } });
      }
    },
    doubleClick: (a1) => latest.current.props.onStartEditing(a1),
    contextMenu: (e, target) => latest.current.handleContextMenu(e, target),
    setCell: (a1, raw) => latest.current.props.onSetCell(a1, raw),
    startFill: () => {
      const src = latest.current.selRange;
      setFillDragging({ sourceRange: src, currentRange: src });
    },
    fillHandleDoubleClick: () => {
      const cur = latest.current;
      const src = cur.selRange;
      const target = fillHandleDoubleClickTarget(cur.props.doc, src);
      if (target.r2 > src.r2) cur.props.onApplyFillHandle(src, target);
    },
    // 커밋/취소 뒤에는 오버레이 input 이 사라지면서 포커스가 <body> 로 떨어진다 — 그리드가
    // 키보드를 다시 받지 못해 "값 입력 → Enter → 다음 값" 연속 입력이 끊긴다(2026-08-19 실기 QA).
    // 키보드로 끝낸 경우에만 그리드로 돌려준다. 다른 곳을 클릭해서 생긴 blur 커밋은 그 클릭 대상이
    // 포커스를 가져야 하므로 여기로 오지 않는다(onBlur 는 commit 만 부른다).
    commit: (next) => {
      latest.current.props.onCommitEditing(next);
      containerRef.current?.focus();
    },
    cancel: () => {
      latest.current.props.onCancelEditing();
      containerRef.current?.focus();
    },
    formulaHelper: (cell) => latest.current.props.onFormulaHelper?.(cell),
    quickChart: (anchor) => latest.current.props.onQuickChart?.(anchor),
  }), []);

  // 불리언으로 좁혀 deps 에 넣는다 — SheetSection 이 매 렌더 새 클로저를 넘겨도 cellData 는 그대로.
  const hasQuickChart = !!props.onQuickChart;
  const cellData = useMemo<CellData>(() => ({
    doc,
    engine,
    activeRow: activeRef.row,
    activeCol: activeRef.col,
    selR1: paintRange.r1,
    selC1: paintRange.c1,
    selR2: paintRange.r2,
    selC2: paintRange.c2,
    editingCell: editing?.cell ?? null,
    draft,
    h: handlers,
    quickChart: hasQuickChart && !fillDragging,
  }), [
    doc,
    engine,
    activeRef.row,
    activeRef.col,
    paintRange.r1,
    paintRange.c1,
    paintRange.r2,
    paintRange.c2,
    editing,
    draft,
    handlers,
    hasQuickChart,
    fillDragging,
  ]);

  // 열/행 머리글 클릭·Shift+클릭·드래그. 드래그는 셀 드래그와 같은 패턴(mousedown 시작 →
  // 창 mouseup 이 headerDrag 를 지운다, 위 useEffect)이지만 확장은 렌더된 머리글 칸의
  // mouseEnter 로 한다 — 화면 밖으로 끌면(자동 스크롤 없음) 그 열/행에서 멈춘다(§3 잔여).
  const handleColHeaderMouseDown = (e: MouseEvent, c: number) => {
    if (e.button !== 0) return;
    if (e.shiftKey) {
      onSetSelection(selection.activeCell, {
        r1: 0, c1: Math.min(activeRef.col, c), r2: numRows - 1, c2: Math.max(activeRef.col, c),
      });
      return;
    }
    setHeaderDrag({ axis: "col", start: c });
    onSetSelection(refKey(c, 0), { r1: 0, c1: c, r2: numRows - 1, c2: c });
  };
  const handleColHeaderMouseEnter = (c: number) => {
    if (headerDrag?.axis !== "col") return;
    const start = headerDrag.start;
    onSetSelection(refKey(start, 0), {
      r1: 0, c1: Math.min(start, c), r2: numRows - 1, c2: Math.max(start, c),
    });
  };
  const handleRowHeaderMouseDown = (e: MouseEvent, r: number) => {
    if (e.button !== 0) return;
    if (e.shiftKey) {
      onSetSelection(selection.activeCell, {
        r1: Math.min(activeRef.row, r), c1: 0, r2: Math.max(activeRef.row, r), c2: numCols - 1,
      });
      return;
    }
    setHeaderDrag({ axis: "row", start: r });
    onSetSelection(refKey(0, r), { r1: r, c1: 0, r2: r, c2: numCols - 1 });
  };
  const handleRowHeaderMouseEnter = (r: number) => {
    if (headerDrag?.axis !== "row") return;
    const start = headerDrag.start;
    onSetSelection(refKey(0, start), {
      r1: Math.min(start, r), c1: 0, r2: Math.max(start, r), c2: numCols - 1,
    });
  };

  const colHeaders = [];
  for (let c = visible.colStart; c <= visible.colStop && c < numCols; c++) {
    const colW = colOffsets[c + 1] - colOffsets[c];
    colHeaders.push(
      <div
        key={c}
        className="sheet-header-cell"
        style={{ left: colOffsets[c], width: colW }}
        onContextMenu={(e) => handleContextMenu(e, { type: "col", col: c })}
        onMouseDown={(e) => handleColHeaderMouseDown(e, c)}
        onMouseEnter={() => handleColHeaderMouseEnter(c)}
      >
        {colToLetters(c)}
        <div
          className="sheet-col-resize-handle"
          onMouseDown={(e) => {
            e.stopPropagation();
            setResizingCol({ col: c, startX: e.clientX, startW: colW, w: colW });
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            const font = containerRef.current ? getComputedStyle(containerRef.current).font : "13px sans-serif";
            const fitted = autoFitWidth(doc, c, (text) => measureTextWidth(font, text));
            onSetColWidth(c, fitted);
          }}
        />
      </div>
    );
  }

  const rowHeaders = [];
  for (let r = visible.rowStart; r <= visible.rowStop && r < numRows; r++) {
    rowHeaders.push(
      <div
        key={r}
        className="sheet-row-header-cell"
        style={{ top: rowOffsetsArr[r], height: rowHeightsArr[r] }}
        onContextMenu={(e) => handleContextMenu(e, { type: "row", row: r })}
        onMouseDown={(e) => handleRowHeaderMouseDown(e, r)}
        onMouseEnter={() => handleRowHeaderMouseEnter(r)}
      >
        {r + 1}
      </div>
    );
  }

  // 첫 행 고정(PLAN-2026-09-21 W2) — 가상 스크롤 본문(<Grid>) 은 고정을 모른다. 실제 행 0..frozenRows-1
  // 을 별도 레이어에 다시 그려 본문 위에 얹는 방식으로 최소 구현한다: 본문은 평소처럼 계속 스크롤되고
  // (숨어서 낭비되는 렌더는 이미 가상화가 그리는 만큼이라 무시 가능), 이 레이어가 항상 맨 위에서
  // 그 자리를 대신 보여준다. 셀 컴포넌트가 같아 클릭·편집·채우기 핸들 전부 그대로 동작한다.
  const frozenRows = Math.min(Math.max(doc.frozenRows ?? 0, 0), numRows);
  const frozenCells = [];
  for (let r = 0; r < frozenRows; r++) {
    for (let c = visible.colStart; c <= visible.colStop && c < numCols; c++) {
      const style: CSSProperties = {
        position: "absolute",
        left: colOffsets[c],
        top: rowOffsetsArr[r],
        width: colOffsets[c + 1] - colOffsets[c],
        height: rowHeightsArr[r],
      };
      frozenCells.push(<SheetCellView key={`fz-${r}-${c}`} columnIndex={c} rowIndex={r} style={style} {...cellData} />);
    }
  }

  return (
    <div
      ref={containerRef}
      className="sheet-grid-container"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      style={{
        gridTemplateColumns: `${ROW_HEADER_WIDTH}px 1fr`,
        gridTemplateRows: `${COL_HEADER_HEIGHT}px 1fr`,
      }}
    >
      <div
        className="sheet-corner-header"
        onClick={() => onSetSelection(selection.activeCell, selectAllRange(doc))}
      />

      <div className="sheet-grid-colheader">
        <div ref={colHeaderRef} className="sheet-grid-headertrack" style={{ width: colOffsets[numCols] }}>
          {colHeaders}
        </div>
      </div>

      <div className="sheet-grid-rowheader">
        <div
          ref={rowHeaderRef}
          className="sheet-grid-headertrack"
          style={{ height: rowOffsetsArr[numRows] }}
        >
          {rowHeaders}
        </div>
      </div>

      <Grid<CellData>
        className="sheet-grid-body"
        style={{ width: bodyWidth, height: bodyHeight }}
        gridRef={gridApiRef}
        cellComponent={SheetCellView}
        cellProps={cellData}
        columnCount={numCols}
        rowCount={numRows}
        columnWidth={getColWidth}
        rowHeight={getRowHeight}
        overscanCount={2}
        onCellsRendered={handleCellsRendered}
        onScroll={handleScroll}
      />

      {/* 첫 행 고정 레이어 — 본문(<Grid>)과 같은 grid 칸에 얹혀 항상 위에 보인다(위 frozenCells 주석). */}
      {frozenRows > 0 && (
        <div
          className="sheet-frozen-rows"
          style={{ gridColumn: 2, gridRow: 2, width: bodyWidth, height: rowOffsetsArr[frozenRows] }}
        >
          <div ref={frozenRowsRef} className="sheet-frozen-rows-track" style={{ width: colOffsets[numCols] }}>
            {frozenCells}
          </div>
        </div>
      )}

      {/* 우클릭 컨텍스트 메뉴 */}
      <SheetContextMenu
        pos={contextMenu.pos}
        target={contextMenu.target}
        onClose={() => setContextMenu({ pos: null, target: null })}
        onInsertRowAbove={() => {
          const r = contextMenu.target?.row ?? activeRef.row;
          onInsertRow(r, false);
        }}
        onInsertRowBelow={() => {
          const r = contextMenu.target?.row ?? activeRef.row;
          onInsertRow(r, true);
        }}
        onDeleteRow={() => {
          const r = contextMenu.target?.row ?? activeRef.row;
          onDeleteRow(r);
        }}
        frozenRowActive={(doc.frozenRows ?? 0) > 0}
        onToggleFreezeRow={
          props.onSetFrozenRows
            ? () => props.onSetFrozenRows!((doc.frozenRows ?? 0) > 0 ? 0 : 1)
            : undefined
        }
        onInsertColLeft={() => {
          const c = contextMenu.target?.col ?? activeRef.col;
          onInsertCol(c, false);
        }}
        onInsertColRight={() => {
          const c = contextMenu.target?.col ?? activeRef.col;
          onInsertCol(c, true);
        }}
        onDeleteCol={() => {
          const c = contextMenu.target?.col ?? activeRef.col;
          onDeleteCol(c);
        }}
        onSortAsc={() => {
          const c = contextMenu.target?.col ?? activeRef.col;
          onSortRange(c, false);
        }}
        onSortDesc={() => {
          const c = contextMenu.target?.col ?? activeRef.col;
          onSortRange(c, true);
        }}
        onCopy={() => {
          const tsv = getSelectedTsv();
          void navigator.clipboard.writeText(tsv);
        }}
        onPaste={() => {
          void navigator.clipboard.readText().then((clip) => {
            if (!clip) return;
            const patch = fromTsv(clip, refKey(activeRef.col, activeRef.row));
            for (const [k, v] of Object.entries(patch)) {
              if (v.raw !== null && v.raw !== undefined) {
                onSetCell(k, v.raw);
              }
            }
          });
        }}
      />
    </div>
  );
};
