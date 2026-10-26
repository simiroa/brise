import type { DiagramTypeDef } from "./_def";

/** 분류 트리 — dagre TB. 상위 분류에서 하위로 갈라지는 포함 관계라 화살촉이 없다. */
export const tree: DiagramTypeDef = {
  id: "tree",
  group: "structure",
  nameKey: "editor.diagram_tpl_tree",
  hintKey: "editor.diagram_tpl_tree_hint",
  aiHintKey: "editor.diagram_tpl_tree_ai_hint",
  aiVocab: '분류 트리 — direction:"TB", 부모→자식 엣지 arrow:"none", 깊이(계/문/강 등)는 states 로',
  seed: {
    v: 1,
    type: "tree",
    direction: "TB",
    states: ["계", "문", "강"],
    nodes: [
      { id: "n1", label: "동물", shape: "round", state: 0 },
      { id: "n2", label: "척추동물", state: 1 },
      { id: "n3", label: "무척추동물", state: 1 },
      { id: "n4", label: "포유류", state: 2 },
      { id: "n5", label: "조류", state: 2 },
      { id: "n6", label: "곤충", state: 2 },
      { id: "n7", label: "연체동물", state: 2 },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", arrow: "none" },
      { id: "e2", from: "n1", to: "n3", arrow: "none" },
      { id: "e3", from: "n2", to: "n4", arrow: "none" },
      { id: "e4", from: "n2", to: "n5", arrow: "none" },
      { id: "e5", from: "n3", to: "n6", arrow: "none" },
      { id: "e6", from: "n3", to: "n7", arrow: "none" },
    ],
  },
};
