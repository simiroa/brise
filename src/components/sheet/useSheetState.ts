import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Section } from "../../lib/commands.gen";
import { registerFlush, emitNotice } from "../../lib/invoke";
import { registerSheetTarget } from "../../lib/aiSectionBridge";
import { useNotesStore } from "../../stores/notes";
import { patchSectionBodyCache } from "../../lib/sectionBodyCache";
import { useSheetFocus } from "../../stores/sheetFocus";
import { t } from "../../i18n/t";
import {
  type CellFmt,
  type CellPatch,
  type ChartSpec,
  type ColSpec,
  type SheetDoc,
  applyPatch,
  emptySheet,
  invertPatch,
  parseSheet,
  serializeSheet,
} from "../../lib/sheet/types";
import {
  type UndoStep,
  atLimit as checkAtLimit,
  deleteCols,
  deleteRows as deleteRowsRange,
  deleteRowsAt,
  ensureCapacity,
  insertCols,
  insertRows,
  sortByCol,
} from "../../lib/sheet/ops";
import { SheetEngine } from "../../lib/sheet/engine";
import { SheetHistory } from "../../lib/sheet/history";
import { parseRef, refKey } from "../../lib/sheet/a1";
import { relocateFormula } from "../../lib/sheet/rewrite";

export interface CellRange {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export interface SheetSelection {
  activeCell: string; // e.g. "A1"
  range: CellRange | null; // normalized r1 <= r2, c1 <= c2
}

/**
 * 편집 **중인 칸의 글자**는 여기서만 산다. 리액트 상태에 두면 한 글자마다 그리드 전체가 다시
 * 그려진다(측정: 26k 셀에서 타건당 81ms). 구독자는 수식 입력줄과 셀 오버레이 둘뿐이고, 둘 다
 * 자기만 다시 그린다.
 */
export interface DraftChannel {
  subscribe: (cb: () => void) => () => void;
  /** `useSyncExternalStore` 의 getSnapshot 으로 그대로 쓸 수 있다(같은 문자열을 돌려준다). */
  get: () => string;
  /** `caret` 을 같이 주면 구독자(CellEditor)가 입력칸 커서를 그 자리로 되돌린다(PLAN-2026-09-21 W2 —
   *  참조 클릭 삽입·F4·Ctrl+;). 생략하면(일반 타건) 커서는 건드리지 않는다. */
  set: (value: string, caret?: number) => void;
  /** 마지막 set 이 넘긴 caret. 없으면 null(구독자가 재배치를 건너뛴다). */
  getCaret: () => number | null;
}

/** 어느 칸을 편집 중인가. 글자는 여기 없다 — `DraftChannel` 이 가진다. */
export interface EditingState {
  cell: string;
}

/** 쓰기 관문(`commit`) 한 번에 넘기는 것. 필드 주석이 곧 "op 마다 갈리는 것"의 목록이다. */
interface Commit {
  doc: SheetDoc;
  /** 이 편집을 되돌리는 스텝. undo/redo 는 히스토리가 스택을 직접 다루므로 생략한다. */
  step?: UndoStep;
  /** 엔진 동기화 — 구조 편집·문서 교체는 `"load"`(전체 다시 적재), 셀 편집은 그 패치만 부분 적용,
   *  열 폭·서식/차트/첫 행 고정은 계산에 영향이 없어 생략. */
  engine?: "load" | CellPatch;
  /** 저장 — 기본은 700ms 디바운스. `"now"` 는 AI 시트 수정(사용자가 "적용"을 눌러 도달)뿐. */
  save?: "now";
}

export function useSheetState(section: Section) {
  const docRef = useRef<SheetDoc>(parseSheet(section.body_md) ?? emptySheet());
  const engineRef = useRef<SheetEngine>(new SheetEngine(docRef.current));
  const historyRef = useRef<SheetHistory>(new SheetHistory());
  const savedRef = useRef<string>(section.body_md);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [version, setVersion] = useState(0);
  const triggerUpdate = useCallback(() => setVersion((v) => v + 1), []);

  const [selection, setSelectionState] = useState<SheetSelection>({
    activeCell: "A1",
    range: { r1: 0, c1: 0, r2: 0, c2: 0 },
  });

  const [editing, setEditingState] = useState<EditingState | null>(null);

  const draftRef = useRef("");
  const draftCaretRef = useRef<number | null>(null);
  const draftSubs = useRef(new Set<() => void>());
  const draft = useMemo<DraftChannel>(() => ({
    subscribe: (cb) => {
      draftSubs.current.add(cb);
      return () => {
        draftSubs.current.delete(cb);
      };
    },
    get: () => draftRef.current,
    set: (value, caret) => {
      draftCaretRef.current = caret ?? null;
      if (draftRef.current === value) {
        // 값은 그대로인데 caret 만 옮기는 경우(F4 로 같은 길이 참조를 다시 쓸 때는 없지만 방어적으로) —
        // 그래도 구독자에게 알려야 caret 재배치가 반영된다.
        if (caret !== undefined) for (const cb of draftSubs.current) cb();
        return;
      }
      draftRef.current = value;
      for (const cb of draftSubs.current) cb();
    },
    getCaret: () => draftCaretRef.current,
  }), []);

  // 내용잠금: saveNow와 같은 방식으로 매번 store에서 fresh하게 읽는다(useCallback 의존성 배열에
  // 갇힌 값이 아니라) — 아래 쓰기 함수들(setCells/patchCol/saveChart/...)이 SheetGrid에 넘겨진
  // 뒤로도 잠금이 바뀌면 즉시 반영돼야 한다.
  const isContentLocked = useCallback(
    () => !!useNotesStore.getState().activeNote?.note?.content_locked,
    [],
  );

  // 저장 및 activeNote.sections 캐시 동기화
  // 저장 프로미스를 돌려준다 — registerFlush 가 기다려야 창 닫기가 저장 IPC 완료 뒤에 일어난다
  // (DiagramSection.tsx::saveNow 와 같은 이유). updateSectionBody 는 reject 하지 않는다.
  const saveNow = useCallback((text: string) => {
    savedRef.current = text;
    const saved = useNotesStore.getState().updateSectionBody(section.id, text);
    patchSectionBodyCache(section.id, text);
    return saved;
  }, [section.id]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const serialized = serializeSheet(docRef.current);
      saveNow(serialized);
    }, 700);
  }, [saveNow]);

  const flushSave = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const current = serializeSheet(docRef.current);
    if (current !== savedRef.current) {
      return saveNow(current);
    }
    return undefined;
  }, [saveNow]);

  /**
   * **모든 쓰기가 지나가는 단 하나의 관문** — 히스토리 적재 → 문서 교체 → 엔진 동기화 → 리렌더 →
   * 저장. 이 골격을 op 마다 손으로 복제하던 것이 실제 결함을 낳았다(b7ed6f3c: `setFrozenRows` 가
   * push 를 빠뜨려 첫 행 고정이 되돌려지지 않았다) — CLAUDE.md "모든 호출자가 지나가는 지점에서
   * 한 번". 반대로 **op 마다 다른 것**(잠금 가드·no-op 조기 반환)은 조건이 제각각이라 여기로
   * 올리지 않고 각 op 진입부에 남긴다.
   *
   * 스텝은 **그 편집이 바꾼 것만** 든다(`UndoStep` 주석 참고) — 셀 편집 스텝이 rows/cols/charts 를
   * 싣지 않으므로, 그 뒤에 바뀐 열 서식·차트가 셀 undo 에 딸려 되감기지 않는다.
   */
  const commit = useCallback((c: Commit) => {
    if (c.step) historyRef.current.push(c.step);
    docRef.current = c.doc;
    if (c.engine === "load") engineRef.current.load(c.doc);
    else if (c.engine) engineRef.current.setCells(c.engine);
    triggerUpdate();
    if (c.save === "now") saveNow(serializeSheet(c.doc));
    else scheduleSave();
  }, [saveNow, scheduleSave, triggerUpdate]);

  // 라이프사이클: 마운트 시 초기화 및 flush 채널 등록
  useEffect(() => {
    docRef.current = ensureCapacity(docRef.current);
    // flush 기준선 = 칠한 문서의 직렬화(폰 MobileSheetEditor 의 sentRef 와 같다). DB 원문을 그대로 두면 정규형이 아닌 본문
    // (Rust sheet_set_cells 의 키 정렬 JSON 등)은 손대지 않아도 flushAll 마다 다시 써지고, 읽지 못한 본문은 빈 시트로 덮인다(2026-10-18).
    if (savedRef.current === section.body_md) savedRef.current = serializeSheet(docRef.current);
    engineRef.current.load(docRef.current);
    triggerUpdate();

    const unregisterFlush = registerFlush(async () => {
      await flushSave();
    });

    const unregisterTarget = registerSheetTarget(() => ({
      sectionId: section.id,
      source: serializeSheet(docRef.current),
      replaceSection: async (body_md: string) => {
        // 10번째 쓰기 경로 — setCells를 거치지 않고 docRef를 직접 갈아끼운다(AI "시트 채우기/수정").
        // 다른 9개와 같은 원칙으로 막되, 이건 사용자가 명시적으로 "적용"을 눌러 도달하는 지점이라
        // 알림을 띄운다(나머지는 키 입력/드래그처럼 조용히 무시해도 되는 조작).
        if (isContentLocked()) {
          emitNotice(t("editor.content_locked_tooltip"));
          return;
        }
        const nextDoc = parseSheet(body_md) ?? emptySheet();
        const grown = ensureCapacity(nextDoc);
        // AI 편집도 한 번에 undo (specs/features/sheet.md 상호작용 결정) — 교체 전 문서로
        // 되돌리는 패치 1개를 일반 편집과 같은 스택에 넣는다. 손댄 키 = 이전 ∪ 이후.
        const touched: CellPatch = {};
        for (const key of Object.keys(docRef.current.cells)) touched[key] = { raw: null };
        for (const key of Object.keys(grown.cells)) touched[key] = { raw: null };
        // 문서를 통째로 갈아끼우므로 스텝도 전부(cells·rows·cols·charts) 든다.
        commit({
          doc: grown,
          step: {
            patch: invertPatch(docRef.current, touched),
            rows: docRef.current.rows,
            cols: docRef.current.cols,
            charts: docRef.current.charts,
          },
          engine: "load",
          save: "now",
        });
      },
    }));

    return () => {
      unregisterFlush();
      unregisterTarget();
      if (saveTimer.current) clearTimeout(saveTimer.current);
      void flushSave();
    };
  }, [section.id, flushSave, triggerUpdate, commit]);

  /**
   * 여러 셀을 **한 번에** — 패치 하나, undo 스텝 하나. 셀 단위 setCell 을 반복하면 Ctrl+Z 를
   * 셀 수만큼 눌러야 하므로, 범위를 건드리는 모든 경로(Delete 키·툴바 지우기·채우기 핸들)는
   * 여기로 들어온다. 빈 패치는 스택을 더럽히지 않도록 무시.
   */
  const setCells = useCallback((patch: CellPatch) => {
    if (isContentLocked()) return;
    if (Object.keys(patch).length === 0) return;
    const beforeDoc = docRef.current;
    const grown = ensureCapacity(applyPatch(beforeDoc, patch));
    // 셀 패치는 rows/cols 를 바꾸지 않는다 — 자동 성장이 **실제로** 일어났을 때만 이전 값을 싣는다.
    const step: UndoStep = { patch: invertPatch(beforeDoc, patch) };
    if (grown.rows !== beforeDoc.rows) step.rows = beforeDoc.rows;
    if (grown.cols !== beforeDoc.cols) step.cols = beforeDoc.cols;
    commit({ doc: grown, step, engine: patch });
  }, [commit]);

  const setCell = useCallback((a1: string, raw: string, fmt?: CellFmt, dp?: number, cur?: string) => {
    setCells({ [a1]: { raw, fmt: fmt ?? null, dp: dp ?? null, cur: cur ?? null } });
  }, [setCells]);

  /** 범위의 내용을 비운다(서식은 남는다) — Delete 키와 툴바 "선택 영역 지우기"의 공통 경로. */
  const clearRange = useCallback((range: CellRange) => {
    const patch: CellPatch = {};
    for (let r = range.r1; r <= range.r2; r++) {
      for (let c = range.c1; c <= range.c2; c++) {
        const key = refKey(c, r);
        if ((docRef.current.cells[key]?.raw ?? "") !== "") patch[key] = { raw: "" };
      }
    }
    setCells(patch);
  }, [setCells]);

  /** 열 하나를 갈아끼우고 이전 `cols` 만 담은 스텝을 쌓는다 — 폭·서식 공용. */
  const patchCol = useCallback((colIdx: number, next: ColSpec) => {
    if (isContentLocked()) return;
    const before = docRef.current.cols;
    if (!before[colIdx]) return;
    const cols = [...before];
    cols[colIdx] = next;
    commit({ doc: { ...docRef.current, cols }, step: { patch: {}, cols: before } });
  }, [commit]);

  // 폭 드래그는 SheetGrid 가 드래그 중 로컬 미리보기로 그리고 **마우스를 뗄 때 한 번만** 부른다
  // — 그래서 드래그 하나 = undo 한 단계다(픽셀마다 스텝이 쌓이지 않는다).
  const setColWidth = useCallback((colIdx: number, width: number) => {
    const col = docRef.current.cols[colIdx];
    if (col) patchCol(colIdx, { ...col, w: width });
  }, [patchCol]);

  const setColFormat = useCallback((colIdx: number, fmt: CellFmt, dp?: number, cur?: string) => {
    const col = docRef.current.cols[colIdx];
    if (col) patchCol(colIdx, { ...col, fmt, dp, cur });
  }, [patchCol]);

  /** 차트 추가·수정 — 문서 변경은 전부 이 훅을 지나간다(SheetSection 이 직접 doc 을 만지지 않는다). */
  const saveChart = useCallback((spec: ChartSpec) => {
    if (isContentLocked()) return;
    const before = docRef.current.charts;
    const idx = before.findIndex((c) => c.id === spec.id);
    const charts = idx >= 0 ? before.map((c, i) => (i === idx ? spec : c)) : [...before, spec];
    commit({ doc: { ...docRef.current, charts }, step: { patch: {}, charts: before } });
  }, [commit]);

  const deleteChart = useCallback((chartId: string) => {
    if (isContentLocked()) return;
    const before = docRef.current.charts;
    const charts = before.filter((c) => c.id !== chartId);
    if (charts.length === before.length) return;
    commit({ doc: { ...docRef.current, charts }, step: { patch: {}, charts: before } });
  }, [commit]);

  const insertRow = useCallback((atRow: number, after?: boolean) => {
    if (isContentLocked()) return;
    const at = after ? atRow + 1 : atRow;
    const res = insertRows(docRef.current, at, 1);
    commit({ doc: ensureCapacity(res.doc), step: res.undo, engine: "load" });
  }, [commit]);

  const deleteRow = useCallback((atRow: number) => {
    if (isContentLocked()) return;
    const res = deleteRowsRange(docRef.current, atRow, 1);
    commit({ doc: ensureCapacity(res.doc), step: res.undo, engine: "load" });
  }, [commit]);

  /** 임의의(연속 아닐 수도 있는) 행 목록을 한 번에 삭제 — dedupe_rows 어시스트(PLAN-2026-09-21 §4 W3
   *  2차) 전용. 단일 `deleteRow` 와 달리 undo 1스텝에 여러 행을 담는다(ops.ts::deleteRowsAt). */
  const deleteRows = useCallback((rows: number[]) => {
    if (isContentLocked()) return;
    const res = deleteRowsAt(docRef.current, rows);
    if (Object.keys(res.undo.patch).length === 0 && res.undo.rows === undefined) return;
    commit({ doc: ensureCapacity(res.doc), step: res.undo, engine: "load" });
  }, [commit]);

  const insertCol = useCallback((atCol: number, after?: boolean) => {
    if (isContentLocked()) return;
    const at = after ? atCol + 1 : atCol;
    const res = insertCols(docRef.current, at, 1);
    commit({ doc: ensureCapacity(res.doc), step: res.undo, engine: "load" });
  }, [commit]);

  const deleteCol = useCallback((atCol: number) => {
    if (isContentLocked()) return;
    const res = deleteCols(docRef.current, atCol, 1);
    commit({ doc: ensureCapacity(res.doc), step: res.undo, engine: "load" });
  }, [commit]);

  const sortRange = useCallback((colIdx: number, desc?: boolean) => {
    if (isContentLocked()) return;
    const dir = desc ? "desc" : "asc";
    const res = sortByCol(docRef.current, colIdx, dir);
    // 정렬은 행·열 수를 바꾸지 않는다 — 다른 구조 편집과 달리 여기만 ensureCapacity 를 거치지 않는다.
    commit({ doc: res.doc, step: res.undo, engine: "load" });
  }, [commit]);

  /** 첫 행 고정 토글(PLAN-2026-09-21 W2) — undo 1스텝(charts 와 같은 패턴, UndoStep.frozenRows). */
  const setFrozenRows = useCallback((n: number) => {
    if (isContentLocked()) return;
    const next = n > 0 ? n : undefined;
    const prev = docRef.current.frozenRows ?? 0;
    if (prev === (next ?? 0)) return;
    const { frozenRows: _drop, ...rest } = docRef.current;
    commit({ doc: next ? { ...rest, frozenRows: next } : rest, step: { patch: {}, frozenRows: prev } });
  }, [commit]);

  // 활성 시트의 선택·문서를 stores/sheetFocus 에 게시한다(PLAN-2026-09-20 §2.4) — 어시스트 Explore
  // 그룹·고스트·addChartFromSelection 이 읽는다. 드래그 중 선택은 매 셀마다 바뀌므로 100ms 뒤 한 번만
  // (setTimeout 하나 = 트레일링 스로틀). `version` 이 deps 에 있는 이유: 문서가 바뀔 때마다(docRef 교체)
  // 게시된 doc 참조도 따라가야 추천·고스트가 방금 친 값을 본다. `ops`(PLAN-2026-09-21 W3, D5) 는
  // setCells/setColFormat/sortRange/insertRow/insertCol/deleteRows 를 그대로 싣는다 — 전부 useCallback 이라
  // 이미 안정적(쓰기 관문 `commit` 하나만 deps, 그 commit 도 안정)이라 재게시 빈도를 늘리지 않는다.
  useEffect(() => {
    const timer = setTimeout(() => {
      useSheetFocus.getState().setFocus({
        noteId: useNotesStore.getState().activeNote?.note.id ?? "",
        sectionId: section.id,
        range: selection.range,
        doc: docRef.current,
        engine: engineRef.current,
        addChart: saveChart,
        ops: { setCells, setColFormat, sortRange, insertRow, insertCol, deleteRows },
      });
    }, 100);
    return () => clearTimeout(timer);
  }, [section.id, selection.range, version, saveChart, setCells, setColFormat, sortRange, insertRow, insertCol, deleteRows]);
  useEffect(() => () => useSheetFocus.getState().setFocus(null), []);

  const undo = useCallback(() => {
    // 잠금 전에 쌓인 undo 스택이 남아 있을 수 있다 — 잠긴 동안은 되돌리기도 새 쓰기이므로 막는다.
    if (isContentLocked()) return;
    const prev = historyRef.current.undo(docRef.current);
    if (!prev) return;
    // 스택은 히스토리가 직접 옮기므로 관문에 step 을 주지 않는다(다시 push 하면 되돌리기가 쌓인다).
    commit({ doc: ensureCapacity(prev), engine: "load" });
  }, [commit]);

  const redo = useCallback(() => {
    if (isContentLocked()) return;
    const next = historyRef.current.redo(docRef.current);
    if (!next) return;
    commit({ doc: ensureCapacity(next), engine: "load" });
  }, [commit]);

  const setSelection = useCallback((activeCell: string, range: CellRange | null = null) => {
    const ref = parseRef(activeCell);
    const resolvedRange: CellRange = range ?? (ref ? { r1: ref.row, c1: ref.col, r2: ref.row, c2: ref.col } : { r1: 0, c1: 0, r2: 0, c2: 0 });
    setSelectionState({
      activeCell,
      range: {
        r1: Math.min(resolvedRange.r1, resolvedRange.r2),
        c1: Math.min(resolvedRange.c1, resolvedRange.c2),
        r2: Math.max(resolvedRange.r1, resolvedRange.r2),
        c2: Math.max(resolvedRange.c1, resolvedRange.c2),
      },
    });
  }, []);

  const startEditing = useCallback((cell: string, initialValue?: string) => {
    const raw = initialValue ?? docRef.current.cells[cell]?.raw ?? "";
    // 이미 같은 칸을 편집 중이면(수식 도우미) 오버레이는 구독으로 글자를 받는다 — 재마운트 없음.
    draft.set(raw);
    setEditingState((prev) => (prev && prev.cell === cell ? prev : { cell }));
  }, [draft]);

  const setEditingValue = useCallback((value: string, caret?: number) => {
    draft.set(value, caret);
  }, [draft]);

  const commitEditing = useCallback((nextAction?: "down" | "right" | "stay") => {
    if (!editing) return;
    const { cell } = editing;
    const value = draftRef.current;
    setEditingState(null);

    const oldRaw = docRef.current.cells[cell]?.raw ?? "";
    if (oldRaw !== value) {
      setCell(cell, value);
    }

    const ref = parseRef(cell);
    if (ref && nextAction && nextAction !== "stay") {
      const nextRow = nextAction === "down" ? ref.row + 1 : ref.row;
      const nextCol = nextAction === "right" ? ref.col + 1 : ref.col;
      const nextA1 = refKey(nextCol, nextRow);
      setSelection(nextA1);
    }
  }, [editing, setCell, setSelection]);

  const cancelEditing = useCallback(() => {
    setEditingState(null);
  }, []);

  // 연속 채우기 (Fill Handle) — 채우기 핸들 드래그(수직만)와 Ctrl+D/R(PLAN-2026-09-21 W2, 수직+수평)이
  // 같이 쓴다. Ctrl+D/R 은 sourceRange 를 선택 범위의 첫 행/첫 열(높이·너비 1)로 좁혀 부르므로
  // 아래 수열 감지(srcValues.length>=2)가 걸리지 않고 "첫 행/열을 나머지로" 규칙과 정확히 같아진다
  // (lib/sheet/editing.ts 의 fillDownPatch/fillRightPatch 가 그 단순 규칙의 순수 버전 — 리터럴 테스트는
  // 거기서, 여기 setCells 왕복은 이 함수가 이미 하던 채우기 핸들 테스트가 덮는다).
  const applyFillHandle = useCallback((sourceRange: CellRange, targetRange: CellRange) => {
    const dRow = targetRange.r2 - sourceRange.r2;
    const dCol = targetRange.c2 - sourceRange.c2;

    // 수평 방향 오른쪽으로 확장 — 수직 분기와 대칭(행↔열).
    if (dCol > 0 && targetRange.r1 === sourceRange.r1 && targetRange.r2 === sourceRange.r2) {
      const srcWidth = sourceRange.c2 - sourceRange.c1 + 1;
      const patch: CellPatch = {};
      for (let r = sourceRange.r1; r <= sourceRange.r2; r++) {
        const srcValues: Array<number | null> = [];
        for (let c = sourceRange.c1; c <= sourceRange.c2; c++) {
          const raw = docRef.current.cells[refKey(c, r)]?.raw ?? "";
          const num = Number(raw);
          srcValues.push(raw !== "" && !isNaN(num) ? num : null);
        }
        const isNumericSeq = srcValues.length >= 2 && srcValues.every((v) => v !== null);
        const step = isNumericSeq ? (srcValues[srcValues.length - 1]! - srcValues[0]!) / (srcValues.length - 1) : 0;

        for (let c = sourceRange.c2 + 1; c <= targetRange.c2; c++) {
          const offset = c - sourceRange.c2;
          const srcCol = sourceRange.c1 + ((c - sourceRange.c1) % srcWidth);
          const srcCellKey = refKey(srcCol, r);
          const srcRaw = docRef.current.cells[srcCellKey]?.raw ?? "";

          if (srcRaw.startsWith("=")) {
            const deltaC = c - srcCol;
            patch[refKey(c, r)] = { raw: relocateFormula(srcRaw, 0, deltaC) };
          } else if (isNumericSeq) {
            const lastVal = srcValues[srcValues.length - 1]!;
            patch[refKey(c, r)] = { raw: String(lastVal + step * offset) };
          } else {
            patch[refKey(c, r)] = { raw: srcRaw };
          }
        }
      }
      setCells(patch);
      return;
    }

    // 수직 방향 아래로 확장
    if (dRow > 0 && targetRange.c1 === sourceRange.c1 && targetRange.c2 === sourceRange.c2) {
      const srcHeight = sourceRange.r2 - sourceRange.r1 + 1;
      // 채운 셀 전체가 undo 한 번에 되돌아가야 한다 — 셀마다 setCell 하지 않고 패치 하나로 모은다.
      const patch: CellPatch = {};
      for (let c = sourceRange.c1; c <= sourceRange.c2; c++) {
        // 2개 이상 숫자 연속인지 검사
        const srcValues: Array<number | null> = [];
        for (let r = sourceRange.r1; r <= sourceRange.r2; r++) {
          const raw = docRef.current.cells[refKey(c, r)]?.raw ?? "";
          const num = Number(raw);
          srcValues.push(raw !== "" && !isNaN(num) ? num : null);
        }
        const isNumericSeq = srcValues.length >= 2 && srcValues.every((v) => v !== null);
        const step = isNumericSeq ? (srcValues[srcValues.length - 1]! - srcValues[0]!) / (srcValues.length - 1) : 0;

        for (let r = sourceRange.r2 + 1; r <= targetRange.r2; r++) {
          const offset = r - sourceRange.r2;
          const srcRow = sourceRange.r1 + ((r - sourceRange.r1) % srcHeight);
          const srcCellKey = refKey(c, srcRow);
          const srcRaw = docRef.current.cells[srcCellKey]?.raw ?? "";

          if (srcRaw.startsWith("=")) {
            const deltaR = r - srcRow;
            patch[refKey(c, r)] = { raw: relocateFormula(srcRaw, deltaR, 0) };
          } else if (isNumericSeq) {
            const lastVal = srcValues[srcValues.length - 1]!;
            patch[refKey(c, r)] = { raw: String(lastVal + step * offset) };
          } else {
            patch[refKey(c, r)] = { raw: srcRaw };
          }
        }
      }
      setCells(patch);
    }
  }, [setCells]);

  return {
    doc: docRef.current,
    engine: engineRef.current,
    atLimit: checkAtLimit(docRef.current),
    canUndo: historyRef.current.canUndo,
    canRedo: historyRef.current.canRedo,
    undo,
    redo,
    selection,
    setSelection,
    editing,
    draft,
    startEditing,
    setEditingValue,
    commitEditing,
    cancelEditing,
    setCell,
    setCells,
    clearRange,
    setColWidth,
    setColFormat,
    saveChart,
    deleteChart,
    insertRow,
    deleteRow,
    deleteRows,
    insertCol,
    deleteCol,
    sortRange,
    applyFillHandle,
    setFrozenRows,
    flushSave,
  };
}
