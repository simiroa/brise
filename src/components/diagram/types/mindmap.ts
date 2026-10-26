import type { DiagramTypeDef } from "./_def";

/** 어시스트 "마인드맵"(빌트인 `diagram_mindmap`)의 시드. 가지 선에 화살촉이 없다 — 중심에서 뻗은 포함
 *  관계지 방향이 있는 흐름이 아니다(라벨을 붙이지 않는 이유도 같다: 양 끝이 관계를 완전히 함의한다).
 *  `layout:"radial"` — 중심에서 방사형으로 퍼진다(PLAN-2026-09-20 W2, `layouts/radial.ts`). */
export const mindmap: DiagramTypeDef = {
  id: "mindmap",
  group: "structure",
  nameKey: "editor.diagram_tpl_mindmap",
  hintKey: "editor.diagram_tpl_mindmap_hint",
  aiHintKey: "editor.diagram_tpl_mindmap_ai_hint",
  aiVocab: '마인드맵 — 중심 주제 하나(shape:"circle")에서 가지가 뻗는 트리, 가지는 arrow:"none" 에 라벨 없음',
  seed: {
    v: 1,
    layout: "radial",
    nodes: [
      { id: "n1", label: "중심 주제", shape: "circle" },
      { id: "n2", label: "주요 아이디어 A", shape: "round" },
      { id: "n3", label: "세부 항목 1", shape: "rect" },
      { id: "n4", label: "세부 항목 2", shape: "rect" },
      { id: "n5", label: "주요 아이디어 B", shape: "round" },
      { id: "n6", label: "세부 항목 3", shape: "rect" },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", line: "solid", arrow: "none" },
      { id: "e2", from: "n2", to: "n3", line: "solid", arrow: "none" },
      { id: "e3", from: "n2", to: "n4", line: "solid", arrow: "none" },
      { id: "e4", from: "n1", to: "n5", line: "solid", arrow: "none" },
      { id: "e5", from: "n5", to: "n6", line: "solid", arrow: "none" },
    ],
  },
};
