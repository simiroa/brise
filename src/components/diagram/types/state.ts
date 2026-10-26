import type { DiagramTypeDef } from "./_def";

/** 상태 전이 — dagre. 노드 = 상태(stadium), 엣지 라벨 = 전이를 일으키는 사건. */
export const state: DiagramTypeDef = {
  id: "state",
  group: "state",
  nameKey: "editor.diagram_tpl_state",
  hintKey: "editor.diagram_tpl_state_hint",
  aiHintKey: "editor.diagram_tpl_state_ai_hint",
  aiVocab: '상태 전이 — 노드 = 상태(shape:"stadium"), 엣지 라벨 = 전이 사건(제출/승인/반려), 초기/활성/종료는 states',
  seed: {
    v: 1,
    type: "state",
    states: ["초기", "활성", "종료"],
    nodes: [
      { id: "n1", label: "초안", shape: "stadium", state: 0 },
      { id: "n2", label: "검토 중", shape: "stadium", state: 1 },
      { id: "n3", label: "승인됨", shape: "stadium", state: 1 },
      { id: "n4", label: "게시됨", shape: "stadium", state: 1 },
      { id: "n5", label: "반려", shape: "stadium", state: 1 },
      { id: "n6", label: "보관", shape: "stadium", state: 2 },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", label: "제출" },
      { id: "e2", from: "n2", to: "n3", label: "승인" },
      { id: "e3", from: "n3", to: "n4", label: "게시" },
      { id: "e4", from: "n2", to: "n5", label: "반려" },
      { id: "e5", from: "n5", to: "n1", label: "수정", line: "dashed" },
      { id: "e6", from: "n4", to: "n6", label: "만료" },
    ],
  },
};
