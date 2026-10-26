import { type FC, Suspense, useCallback, useMemo, useState, useEffect, useRef } from "react";
import type { Section } from "../lib/commands.gen";
import { t } from "../i18n/t";
import { useNotesStore } from "../stores/notes";
import { registerFlush } from "../lib/invoke";
import { reportFallback } from "../lib/diag";
import { patchSectionBodyCache } from "../lib/sectionBodyCache";
import { isSectionGated } from "../lib/sectionTokens";
import { clearSaveFailed, markSaveFailed } from "../lib/sectionSaveFailures";
import { parseRef, refKey } from "../lib/sheet/a1";
import { emptySheet, parseSheet, serializeSheet, type SheetDoc } from "../lib/sheet/types";
import { SheetEngine } from "../lib/sheet/engine";
import { IconCheck, IconClose, IconPlus, IconChart } from "../components/icons";
import { MobileSheetGrid } from "./MobileSheetGrid";
import { keepEditorFocus } from "./keepEditorFocus";
import { SheetChart } from "../lazySurfaces";
import { preloadIntentProps } from "../lib/lazyPreload";

// 번들 W1-(b)-2: 데스크톱 SheetSection.tsx 는 이미 SheetChart 를 lazy() 로 지연한다(차트 라이브러리
// 실측 400KB) — 여기는 정적 import 라 폰이 데스크톱보다 더 받는 역전이었다. 같은 패턴으로 맞춘다.


export interface MobileSheetEditorProps {
  section: Section;
}

export const MobileSheetEditor: FC<MobileSheetEditorProps> = ({ section }) => {
  const [doc, setDoc] = useState<SheetDoc>(() => parseSheet(section.body_md) ?? emptySheet());
  const [activeCell, setActiveCell] = useState<string>("A1");
  const [editingValue, setEditingValue] = useState<string>("");
  const [isInputActive, setIsInputActive] = useState(false);
  const [showCharts, setShowCharts] = useState(false);

  const engine = useMemo(() => new SheetEngine(doc), [doc]);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 가장 마지막 편집 — 렌더가 아니라 persistDoc 이 동기로 쓴다. 저장(디바운스·언마운트·flushAll)은 전부 이걸
  // 읽는다: 효과 정리 함수가 렌더 시점의 낡은 `doc` 을 쥐고 있던 것이 "저장본이 한 편집씩 뒤처지는" 원인이었다.
  const latestDocRef = useRef<SheetDoc>(doc);
  // 마지막으로 **보낸** 본문(성공 여부와 무관 — useSheetState.ts 와 같다). 보내기 전에 갱신해야 충돌로 게이트가
  // 쥔 본문이 언마운트(충돌 "복사" → remountSheet) 때 새 서버본 위에 다시 쓰이지 않는다. 처음 값은 section.body_md
  // 가 아니라 정규화된 직렬화 — 손대지 않은 시트를 열었다 닫을 때 서식 차이만으로 쓰지 않도록.
  const sentRef = useRef<string>(serializeSheet(doc));

  // Parse active cell coordinates
  const activeCoord = useMemo(() => parseRef(activeCell) ?? { col: 0, row: 0 }, [activeCell]);

  // Sync draft value when active cell changes
  useEffect(() => {
    const rawVal = doc.cells[activeCell]?.raw ?? "";
    setEditingValue(rawVal);
  }, [activeCell, doc.cells]);

  // 대기 중인 편집을 지금 쓴다(없으면 무동작). updateSectionBody 는 비초안 노트에서 reject 하지 않는다(실패는
  // savedState "failed" 로 남는다) — useSheetState.flushSave 와 같은 계약. 초안 노트는 ensureMaterialized 가 던질
  // 수 있어, 그 거절은 진단에 남기고 호출자(타이머·언마운트·flushAll)에겐 넘기지 않는다.
  // async 지만 첫 await 전까지 동기로 돈다 — 언마운트 정리 함수 안에서도 쓰기 호출이 그 자리에서 나간다.
  const flushPending = useCallback(async (): Promise<void> => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    const jsonStr = serializeSheet(latestDocRef.current);
    if (jsonStr === sentRef.current) return;
    const prevSent = sentRef.current;
    sentRef.current = jsonStr;
    // activeNote.sections 를 같이 맞춘다(스토어는 캐럿 보호로 일부러 안 고친다 — 함정 4). 안 맞추면 다른 탭을
    // 다녀온 시트가 낡은 본문으로 다시 마운트돼 다음 편집이 앞선 편집을 덮는다. 본문만 바뀌므로 노트 로드 효과는
    // updated_at 이 같아 다시 칠하지 않는다.
    patchSectionBodyCache(section.id, jsonStr);
    let failedWrite = false;
    try {
      await useNotesStore.getState().updateSectionBody(section.id, jsonStr);
      // 비초안 노트의 쓰기 실패는 reject 가 아니라 savedState "failed" 로 온다. 충돌·사라진 섹션은 게이트가 본문을 쥐고 있어
      // (언마운트 때 새 서버본 위에 다시 쓰지 않도록 sentRef 를 그대로 둬야 한다) 여기서 되돌리지 않는다.
      failedWrite = useNotesStore.getState().savedState === "failed" && !isSectionGated(section.id);
    } catch (e) {
      failedWrite = true;
      reportFallback("mobile-sheet", "save_rejected", e instanceof Error ? e.message : String(e));
    }
    if (failedWrite) {
      // M-11: 보낸 표시를 되돌려야 다음 flush(다시 시도·나가기)가 실제로 다시 보낸다. 나가기 차단은 실패 집합이 안다.
      if (sentRef.current === jsonStr) sentRef.current = prevSent;
      markSaveFailed(section.id);
    } else if (!isSectionGated(section.id)) {
      clearSaveFailed(section.id);
    }
  }, [section.id]);

  // Debounced autosave
  const persistDoc = (nextDoc: SheetDoc) => {
    latestDocRef.current = nextDoc;
    setDoc(nextDoc);
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => void flushPending(), 700);
  };

  // flushAll(창 닫기·pagehide·실패 다시 시도·충돌 해결 전 수집)에 등록하고, 언마운트(섹션 전환·노트 떠나기)
  // 때 대기분을 쓴다. 의존성은 section.id 뿐 — doc 을 넣으면 편집마다 정리 함수가 돌아 디바운스를 취소한다.
  useEffect(() => {
    const unregister = registerFlush(flushPending);
    return () => {
      unregister();
      void flushPending();
    };
  }, [flushPending]);

  const handleCellClick = (col: number, row: number) => {
    const key = refKey(col, row);
    setActiveCell(key);
    const colDef = doc.cols[col];
    const fmt = doc.cells[key]?.fmt ?? colDef?.fmt ?? "text";

    if (fmt === "checkbox") {
      const currentVal = doc.cells[key]?.raw?.toUpperCase() === "TRUE";
      const nextRaw = currentVal ? "FALSE" : "TRUE";
      const nextDoc: SheetDoc = {
        ...doc,
        cells: {
          ...doc.cells,
          [key]: {
            ...doc.cells[key],
            raw: nextRaw,
          },
        },
      };
      persistDoc(nextDoc);
    } else {
      setIsInputActive(true);
    }
  };

  const handleCommitValue = (nextValue: string, moveDown = false) => {
    const current = doc.cells[activeCell];
    const trimmed = nextValue;

    let nextCells = { ...doc.cells };
    if (!trimmed) {
      if (current) {
        const { [activeCell]: _, ...rest } = nextCells;
        nextCells = rest;
      }
    } else {
      nextCells[activeCell] = {
        ...current,
        raw: trimmed,
      };
    }

    const nextDoc: SheetDoc = {
      ...doc,
      cells: nextCells,
    };
    persistDoc(nextDoc);

    if (moveDown) {
      const nextRow = Math.min(activeCoord.row + 1, doc.rows - 1);
      setActiveCell(refKey(activeCoord.col, nextRow));
    }
  };

  const handleAddRow = () => {
    const nextDoc: SheetDoc = {
      ...doc,
      rows: doc.rows + 1,
    };
    persistDoc(nextDoc);
  };

  const handleAddCol = () => {
    const nextDoc: SheetDoc = {
      ...doc,
      cols: [...doc.cols, { w: 96, fmt: "text" }],
    };
    persistDoc(nextDoc);
  };

  // 레이아웃·표면은 전부 styles/mobile/sheet.css 가 가진다(인라인 스타일은 클래스 규칙을 가려 표면 계약을
  // 깬다). 관계도(.mobile-diagram-host)와 같이 화면 끝까지 닿는 한 장이다 — 예전엔 `.card`(테두리·모서리)
  // + 고정 높이 상자 안에 스크롤러가 갇혀 있었다.
  return (
    <div className="mobile-sheet-editor">
      {/* 얇은 도구 줄 — 행/열 추가. 키보드가 열린(= 셀 입력 중) 동안은 CSS 가 걷는다. 눌러도 입력 포커스를 뺏지
          않는다(keepEditorFocus) — 하드웨어 키보드 태블릿처럼 줄이 남아 있을 때 화면 키보드가 내려가지 않도록. */}
      <div className="mobile-sheet-toolbar" onMouseDown={keepEditorFocus}>
        <div className="mobile-sheet-tools">
          <button type="button" className="mobile-sheet-tool" onClick={handleAddRow}>
            <IconPlus size={14} />
            <span>{t("editor.sheet_add_row")}</span>
          </button>
          <button type="button" className="mobile-sheet-tool" onClick={handleAddCol}>
            <IconPlus size={14} />
            <span>{t("editor.sheet_add_col")}</span>
          </button>
        </div>

        {doc.charts && doc.charts.length > 0 && (
          <button
            type="button"
            className="mobile-icon-btn mobile-sheet-chart-toggle"
            data-active={showCharts}
            aria-pressed={showCharts}
            aria-label={t("editor.sheet_chart")}
            {...preloadIntentProps(SheetChart)}
            onClick={() => setShowCharts(!showCharts)}
            title={t("editor.sheet_chart")}
          >
            <IconChart size={16} />
          </button>
        )}
      </div>

      {/* 차트 영역 (토글 시 표시) */}
      {showCharts && doc.charts && doc.charts.length > 0 && (
        <div className="mobile-sheet-charts">
          {doc.charts.map((c) => (
            <div key={c.id} className="mobile-sheet-chart">
              <Suspense fallback={<div style={{ height: 140 }} />}>
                <SheetChart spec={c} doc={doc} engine={engine} height={140} compact />
              </Suspense>
            </div>
          ))}
        </div>
      )}

      {/* 터치 최적화 스프레드시트 그리드 */}
      <MobileSheetGrid doc={doc} engine={engine} activeCell={activeCell} onCellClick={handleCellClick} />

      {/* 모바일 하단 셀 편집 바 — 화면 폭 전체의 독. `.overlay`(불투명 표면)라 그 아래로 스크롤되는 셀이 비치지 않는다.
          z-index 는 일부러 없다(sheet.css): 독 슬롯의 ＋ 스피드 다이얼이 이 바 위로 열려야 한다. */}
      {isInputActive && (
        <div className="mobile-sheet-editbar overlay">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--m-accent-text)" }}>
              {activeCell}
            </span>
            <div className="mobile-sheet-snippets" onMouseDown={keepEditorFocus}>
              {["=", "+", "-", "*", "/", "SUM("].map((snippet) => (
                <button
                  key={snippet}
                  type="button"
                  className="mobile-sheet-snippet"
                  onClick={() => setEditingValue((prev) => prev + snippet)}
                >
                  {snippet}
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="text"
              className="field"
              value={editingValue}
              onChange={(e) => setEditingValue(e.target.value)}
              placeholder={t("editor.sheet_formula_helper")}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleCommitValue(editingValue, true);
                } else if (e.key === "Escape") {
                  setIsInputActive(false);
                }
              }}
              style={{
                flex: 1,
                fontSize: "var(--text-md)",
                padding: "8px 10px",
                borderRadius: "var(--radius-sm)",
              }}
            />

            <button
              type="button"
              className="mobile-sheet-confirm"
              aria-label={t("common.apply")}
              onMouseDown={keepEditorFocus}
              onClick={() => handleCommitValue(editingValue, true)}
            >
              <IconCheck size={18} />
            </button>

            <button
              type="button"
              className="mobile-icon-btn"
              onMouseDown={keepEditorFocus}
              onClick={() => setIsInputActive(false)}
              aria-label={t("common.close")}
            >
              <IconClose size={16} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
