import type { DiagramTypeDef } from "./_def";

export const decision: DiagramTypeDef = {
  id: "decision",
  group: "flow",
  nameKey: "editor.diagram_tpl_decision",
  hintKey: "editor.diagram_tpl_decision_hint",
  aiHintKey: "editor.diagram_tpl_decision_ai_hint",
  aiVocab: '의사결정 흐름 — 갈림길은 shape:"diamond", 결과는 shape:"stadium", 갈래 조건(예/아니오)은 엣지 라벨',
  seed: {
    v: 1,
    route: "curve",
    states: ["검토", "승인", "반려"],
    nodes: [
      { id: "n1", label: "구매 여부 결정", shape: "diamond", state: 0 },
      { id: "n2", label: "예산 확인", shape: "rect", state: 0 },
      { id: "n3", label: "위시리스트 저장", shape: "rect", state: 2 },
      { id: "n4", label: "즉시 구매", shape: "stadium", state: 1 },
      { id: "n5", label: "다음 달 이전", shape: "stadium", state: 0 },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", label: "예", line: "solid", arrow: "end" },
      { id: "e2", from: "n1", to: "n3", label: "아니오", line: "solid", arrow: "end" },
      { id: "e3", from: "n2", to: "n4", label: "승인", line: "solid", arrow: "end" },
      { id: "e4", from: "n2", to: "n5", label: "초과", line: "solid", arrow: "end" },
    ],
  },
};
