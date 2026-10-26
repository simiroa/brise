// 활성 시트의 선택 스토어 (PLAN-2026-09-20 §2.4, D6 전제). 쓰는 곳은 useSheetState 하나(선택·문서가
// 바뀔 때 100ms 뒤, 언마운트에 null), 읽는 곳은 어시스트 Explore 그룹·고스트·addChartFromSelection.
// `addChart` 가 여기 실리는 이유: lib(훅 밖)의 addChartFromSelection 이 열린 시트의 undo 스택을
// 지나야 하는데(useSheetState.saveChart 가 유일한 차트 쓰기 경로), 훅 상태는 lib 에서 못 부른다 —
// 활성 인스턴스가 자기 saveChart 를 등록해 두면 진입점 셋이 모두 그 한 함수를 부른다.
// ponytail: 한 칸 — 시트가 동시에 둘 열리는 일은 없다(한 노트 한 활성 섹션). 분할 뷰가 생기면
// sectionId 키 맵으로.
import { create } from "zustand";
import type { CellRange } from "../components/sheet/useSheetState";
import type { SheetEngine } from "../lib/sheet/engine";
import type { SheetAssistOps } from "../lib/sheet/assists";
import type { ChartSpec, SheetDoc } from "../lib/sheet/types";

export interface SheetFocus {
  noteId: string;
  sectionId: string;
  range: CellRange | null;
  /** 마지막 게시 시점의 문서 참조 — useSheetState 가 문서를 바꿀 때마다 다시 게시한다. */
  doc: SheetDoc;
  engine: SheetEngine;
  /** = useSheetState.saveChart (undo 1스텝 + 700ms 저장 예약). */
  addChart: (spec: ChartSpec) => void;
  /** = useSheetState 의 쓰기 함수들 — 수식·서식 프리셋 어시스트(PLAN-2026-09-21 W3, D5)가 부른다.
   *  전부 useCallback 으로 이미 안정적(모듈 deps 만)이라 재게시 빈도를 늘리지 않는다.
   *  optional 인 이유: 이 필드를 모르는 기존 테스트(ChartRegister.test.tsx·addChart.test.ts 등, 이
   *  웨이브 소유권 밖)가 `focus` 리터럴을 이 필드 없이 만든다 — required 로 하면 그 파일들의 tsc 가
   *  깨진다. 실제 훅(useSheetState)은 항상 채워 게시하므로 어시스트 쪽만 부재를 가드하면 된다. */
  ops?: SheetAssistOps;
}

interface SheetFocusState {
  focus: SheetFocus | null;
  setFocus: (focus: SheetFocus | null) => void;
  /** 열린 SheetSection 의 차트 편집기 열기(null = 새 차트) — 어시스트 상단 차트 카드(SheetChartsPanel)가
   *  부른다. focus 와 별도 칸인 이유: focus 는 useSheetState 가 100ms 디바운스로 통째 다시 게시한다. */
  openChartEditor: ((spec: ChartSpec | null) => void) | null;
  setOpenChartEditor: (fn: ((spec: ChartSpec | null) => void) | null) => void;
}

export const useSheetFocus = create<SheetFocusState>((set) => ({
  focus: null,
  setFocus: (focus) => set({ focus }),
  openChartEditor: null,
  setOpenChartEditor: (fn) => set({ openChartEditor: fn }),
}));
