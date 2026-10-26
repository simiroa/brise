import type { DiagramTypeDef } from "./_def";

/** 생애주기 루프 — layout:"circle". 엣지를 따라간 순서로 원 위에. */
export const lifecycle: DiagramTypeDef = {
  id: "lifecycle",
  group: "state",
  nameKey: "editor.diagram_tpl_lifecycle",
  hintKey: "editor.diagram_tpl_lifecycle_hint",
  aiHintKey: "editor.diagram_tpl_lifecycle_ai_hint",
  aiVocab: '생애주기 — layout:"circle", 단계 노드들을 엣지로 한 바퀴 잇는다(마지막→첫 번째 엣지 포함), 준비/실행/점검은 states',
  seed: {
    v: 1,
    type: "lifecycle",
    layout: "circle",
    states: ["준비", "실행", "점검"],
    nodes: [
      { id: "n1", label: "계획", shape: "round", state: 0 },
      { id: "n2", label: "개발", shape: "round", state: 1 },
      { id: "n3", label: "테스트", shape: "round", state: 2 },
      { id: "n4", label: "배포", shape: "round", state: 1 },
      { id: "n5", label: "운영", shape: "round", state: 1 },
      { id: "n6", label: "회고", shape: "round", state: 2 },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2" },
      { id: "e2", from: "n2", to: "n3" },
      { id: "e3", from: "n3", to: "n4" },
      { id: "e4", from: "n4", to: "n5" },
      { id: "e5", from: "n5", to: "n6" },
      { id: "e6", from: "n6", to: "n1" },
    ],
  },
};
