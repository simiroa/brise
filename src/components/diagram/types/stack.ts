import type { DiagramTypeDef } from "./_def";

/** 계층 스택 — layout:"stack". 노드 배열 순서 = 위→아래, 엣지 없음. */
export const stack: DiagramTypeDef = {
  id: "stack",
  group: "layout",
  nameKey: "editor.diagram_tpl_stack",
  hintKey: "editor.diagram_tpl_stack_hint",
  aiHintKey: "editor.diagram_tpl_stack_ai_hint",
  aiVocab: '계층 스택 — layout:"stack", 노드 배열 순서 = 위→아래 층, 엣지 없음, 자체 개발/외부 서비스/레거시는 states',
  seed: {
    v: 1,
    type: "stack",
    layout: "stack",
    states: ["자체 개발", "외부 서비스", "레거시"],
    nodes: [
      { id: "n1", label: "사용자 인터페이스", state: 0 },
      { id: "n2", label: "애플리케이션", state: 0 },
      { id: "n3", label: "서비스 API", state: 0 },
      { id: "n4", label: "데이터 저장소", state: 1 },
      { id: "n5", label: "인프라", state: 1 },
    ],
    edges: [],
  },
};
