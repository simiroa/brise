import type { DiagramTypeDef } from "./_def";

/** 조직도 — dagre TB, 위계선은 화살촉 없음(보고 관계는 위→아래로 읽힌다). */
export const org: DiagramTypeDef = {
  id: "org",
  group: "structure",
  nameKey: "editor.diagram_tpl_org",
  hintKey: "editor.diagram_tpl_org_hint",
  aiHintKey: "editor.diagram_tpl_org_ai_hint",
  aiVocab: '조직도 — direction:"TB", 상위→하위 엣지는 arrow:"none" 라벨 없음, 직급은 states 로',
  seed: {
    v: 1,
    type: "org",
    direction: "TB",
    states: ["임원", "팀장", "팀원"],
    nodes: [
      { id: "n1", label: "대표이사", shape: "round", state: 0 },
      { id: "n2", label: "CTO", shape: "round", state: 0 },
      { id: "n3", label: "CFO", shape: "round", state: 0 },
      { id: "n4", label: "개발팀장", state: 1 },
      { id: "n5", label: "디자인팀장", state: 1 },
      { id: "n6", label: "회계팀장", state: 1 },
      { id: "n7", label: "백엔드 개발자", state: 2 },
      { id: "n8", label: "프런트 개발자", state: 2 },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", arrow: "none" },
      { id: "e2", from: "n1", to: "n3", arrow: "none" },
      { id: "e3", from: "n2", to: "n4", arrow: "none" },
      { id: "e4", from: "n2", to: "n5", arrow: "none" },
      { id: "e5", from: "n3", to: "n6", arrow: "none" },
      { id: "e6", from: "n4", to: "n7", arrow: "none" },
      { id: "e7", from: "n4", to: "n8", arrow: "none" },
    ],
  },
};
