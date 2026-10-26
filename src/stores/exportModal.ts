import { create } from "zustand";

/**
 * 내보내기·인쇄 모달(components/export/ExportModal)이 열려 있는지와 무엇을 내보내려는지.
 *
 * 진입점은 셋이고 전부 같은 모달을 연다 — 범위만 미리 골라진 채로:
 *  - 섹션 탭 우클릭 "내보내기…"(SectionTabBar): sectionId 를 넘긴다 → "이 섹션"이 골라진다.
 *  - 노트 우클릭 "내보내기"(ContextMenu), 제목 줄 "…" 메뉴(TitleBar): sectionId 없음 → "노트 전체".
 * 모달은 열릴 때 문서를 새로 읽으므로(flushAll → note_get) 여기에는 식별자만 둔다.
 */
export interface ExportRequest {
  noteId: string;
  /** 모달 제목줄·기본 파일 이름에 쓸 노트 제목(빈 문자열이면 "제목 없음"으로 대체). */
  noteTitle: string;
  /** 있으면 "이 섹션"을 고를 수 있고 그것이 기본 범위다. 텍스트 섹션이어야 한다. */
  sectionId: string | null;
}

interface ExportModalState {
  request: ExportRequest | null;
  open: (request: ExportRequest) => void;
  close: () => void;
}

export const useExportModalStore = create<ExportModalState>((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));

/** 컴포넌트 밖(이벤트 핸들러)에서 한 줄로 여는 진입점. */
export function openExportModal(request: ExportRequest): void {
  useExportModalStore.getState().open(request);
}
