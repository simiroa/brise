// 활성 관계도의 배치 스토어 (PLAN-2026-09-21 W4, D4 — sheetFocus.ts 와 동형, lib/aiSectionBridge::
// registerDiagramTarget 선례). 어시스트는 DiagramSection 밖이라 actions 를 직접 못 잡는다 — 열린
// DiagramSection 이 자기 model.layout·section.id·actions.setLayout 을 게시하면, 배치 바꾸기(베타)
// 그룹이 그것만 읽고 부른다.
// ponytail: 한 칸 — 관계도 섹션이 동시에 둘 열리는 일은 없다(sheetFocus 와 같은 전제). 분할 뷰가
// 생기면 sectionId 키 맵으로.
import { create } from "zustand";
import type { DiagramLayout } from "../components/diagram/diagramSchema";

export interface DiagramFocus {
  sectionId: string;
  /** 현재 배치 — 없으면(dagre) undefined. */
  layout: DiagramLayout | undefined;
  /** 현재 관계도의 직렬화 본문 — 배치 행 호버 고스트가 `diagramModel::setLayout(source, name)` 으로
   *  "이 배치면 이렇게" 를 그려 보이는 데 쓴다(EditorGhostOverlay 의 `layout:` 분기). */
  source: string;
  setLayout: (layout: DiagramLayout) => void;
}

interface DiagramFocusState {
  focus: DiagramFocus | null;
  setFocus: (focus: DiagramFocus | null) => void;
}

export const useDiagramFocus = create<DiagramFocusState>((set) => ({
  focus: null,
  setFocus: (focus) => set({ focus }),
}));
