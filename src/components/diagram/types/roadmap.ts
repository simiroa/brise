import type { DiagramTypeDef } from "./_def";

/** 로드맵 — dagre LR. 그룹 = 분기(기간), tag = 시점, 완료/진행 중/계획은 states. */
export const roadmap: DiagramTypeDef = {
  id: "roadmap",
  group: "state",
  nameKey: "editor.diagram_tpl_roadmap",
  hintKey: "editor.diagram_tpl_roadmap_hint",
  aiHintKey: "editor.diagram_tpl_roadmap_ai_hint",
  aiVocab: '로드맵 — direction:"LR", 그룹 = 기간(분기/월), tag = 시점("3월"), 완료/진행 중/계획은 states, 선후 관계는 엣지',
  seed: {
    v: 1,
    type: "roadmap",
    direction: "LR",
    states: ["완료", "진행 중", "계획"],
    nodes: [
      { id: "n1", label: "MVP 출시", group: "g1", tag: "1월", state: 0 },
      { id: "n2", label: "사용자 피드백", group: "g1", tag: "3월", state: 0 },
      { id: "n3", label: "결제 연동", group: "g2", tag: "5월", state: 1 },
      { id: "n4", label: "모바일 앱", group: "g2", tag: "6월", state: 2 },
      { id: "n5", label: "해외 진출", group: "g3", tag: "9월", state: 2 },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2" },
      { id: "e2", from: "n2", to: "n3" },
      { id: "e3", from: "n2", to: "n4" },
      { id: "e4", from: "n3", to: "n5" },
      { id: "e5", from: "n4", to: "n5" },
    ],
    groups: [
      { id: "g1", title: "1분기" },
      { id: "g2", title: "2분기" },
      { id: "g3", title: "3분기" },
    ],
  },
};
