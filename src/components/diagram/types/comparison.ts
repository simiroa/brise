import type { DiagramTypeDef } from "./_def";

export const comparison: DiagramTypeDef = {
  id: "comparison",
  group: "structure",
  nameKey: "editor.diagram_tpl_comparison",
  hintKey: "editor.diagram_tpl_comparison_hint",
  aiHintKey: "editor.diagram_tpl_comparison_ai_hint",
  aiVocab: "비교·대안 — 후보마다 루트 노드 하나, 장점/단점은 엣지 라벨, 평가는 states(우수/보통/미흡), 추천 후보는 flag:true",
  seed: {
    v: 1,
    route: "curve",
    states: ["우수", "보통", "미흡"],
    nodes: [
      { id: "n1", label: "후보 A: 옵션 1", shape: "rect", flag: true },
      { id: "n2", label: "빠른 구현", shape: "rect", state: 0 },
      { id: "n3", label: "높은 비용", shape: "rect", state: 2 },
      { id: "n4", label: "후보 B: 옵션 2", shape: "rect" },
      { id: "n5", label: "유지보수 용이", shape: "rect", state: 0 },
      { id: "n6", label: "초기 학습 필요", shape: "rect", state: 1 },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", label: "장점", line: "solid", arrow: "end" },
      { id: "e2", from: "n1", to: "n3", label: "단점", line: "solid", arrow: "end" },
      { id: "e3", from: "n4", to: "n5", label: "장점", line: "solid", arrow: "end" },
      { id: "e4", from: "n4", to: "n6", label: "단점", line: "solid", arrow: "end" },
    ],
  },
};
