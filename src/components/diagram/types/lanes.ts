import type { DiagramTypeDef } from "./_def";

/** 스윔레인 — layout:"lanes". 그룹 = 레인(담당), 엣지 순서가 곧 단계. */
export const lanes: DiagramTypeDef = {
  id: "lanes",
  group: "flow",
  nameKey: "editor.diagram_tpl_lanes",
  hintKey: "editor.diagram_tpl_lanes_hint",
  aiHintKey: "editor.diagram_tpl_lanes_ai_hint",
  aiVocab: '스윔레인 — layout:"lanes", 그룹 = 레인(담당 역할·부서), 각 노드는 자기 담당 group, 엣지가 단계 순서',
  seed: {
    v: 1,
    type: "lanes",
    layout: "lanes",
    states: ["대기", "진행", "완료"],
    nodes: [
      { id: "n1", label: "주문 요청", group: "g1", state: 2 },
      { id: "n2", label: "견적 검토", group: "g2", state: 2 },
      { id: "n3", label: "계약", group: "g2", state: 1 },
      { id: "n4", label: "출고 준비", group: "g3", state: 0 },
      { id: "n5", label: "배송", group: "g3", state: 0 },
      { id: "n6", label: "수령 확인", group: "g1", state: 0 },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2" },
      { id: "e2", from: "n2", to: "n3" },
      { id: "e3", from: "n3", to: "n4" },
      { id: "e4", from: "n4", to: "n5" },
      { id: "e5", from: "n5", to: "n6" },
    ],
    groups: [
      { id: "g1", title: "고객" },
      { id: "g2", title: "영업" },
      { id: "g3", title: "물류" },
    ],
  },
};
