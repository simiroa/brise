import type { DiagramTypeDef } from "./_def";

/** 방사형 트리 — layout:"radial". 루트(들어오는 엣지 없는 노드)가 중심, 깊이마다 바깥 원. */
export const radialtree: DiagramTypeDef = {
  id: "radialtree",
  group: "structure",
  nameKey: "editor.diagram_tpl_radialtree",
  hintKey: "editor.diagram_tpl_radialtree_hint",
  aiHintKey: "editor.diagram_tpl_radialtree_ai_hint",
  aiVocab: '방사형 트리 — layout:"radial", 중심 노드 하나(들어오는 엣지 없음)에서 from→to 로 뻗는 트리, 가지는 arrow:"none"',
  seed: {
    v: 1,
    type: "radialtree",
    layout: "radial",
    states: ["기초", "중급", "심화"],
    nodes: [
      { id: "n1", label: "프로그래밍", shape: "circle" },
      { id: "n2", label: "언어", shape: "round", state: 0 },
      { id: "n3", label: "자료구조", shape: "round", state: 1 },
      { id: "n4", label: "알고리즘", shape: "round", state: 1 },
      { id: "n5", label: "도구", shape: "round", state: 0 },
      { id: "n6", label: "Python", state: 0 },
      { id: "n7", label: "JavaScript", state: 0 },
      { id: "n8", label: "정렬", state: 2 },
      { id: "n9", label: "Git", state: 0 },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", arrow: "none" },
      { id: "e2", from: "n1", to: "n3", arrow: "none" },
      { id: "e3", from: "n1", to: "n4", arrow: "none" },
      { id: "e4", from: "n1", to: "n5", arrow: "none" },
      { id: "e5", from: "n2", to: "n6", arrow: "none" },
      { id: "e6", from: "n2", to: "n7", arrow: "none" },
      { id: "e7", from: "n4", to: "n8", arrow: "none" },
      { id: "e8", from: "n5", to: "n9", arrow: "none" },
    ],
  },
};
