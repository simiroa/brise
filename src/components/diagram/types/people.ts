import type { DiagramTypeDef } from "./_def";

export const people: DiagramTypeDef = {
  id: "people",
  group: "structure",
  nameKey: "editor.diagram_tpl_people",
  hintKey: "editor.diagram_tpl_people_hint",
  aiHintKey: "editor.diagram_tpl_people_ai_hint",
  aiVocab: '인물·팀 관계망 — 역할은 tag 로, 핵심/협력/외부 같은 거리는 states 로, 협업은 arrow:"both"',
  seed: {
    v: 1,
    route: "curve",
    states: ["핵심", "협력", "외부"],
    nodes: [
      { id: "n1", label: "팀장 김민준", shape: "rect", state: 0, tag: "Lead" },
      { id: "n2", label: "디자이너 이서연", shape: "rect", state: 1 },
      { id: "n3", label: "개발자 박도현", shape: "rect", state: 1 },
      { id: "n4", label: "외주 개발사", shape: "rect", state: 2 },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", label: "선임 레포트", line: "solid", arrow: "end" },
      { id: "e2", from: "n1", to: "n3", label: "개발 지시", line: "solid", arrow: "end" },
      { id: "e3", from: "n2", to: "n3", label: "협업", line: "solid", arrow: "both" },
      { id: "e4", from: "n3", to: "n4", label: "외부 파트너", line: "solid", arrow: "both" },
    ],
  },
};
