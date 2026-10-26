import type { DiagramTypeDef } from "./_def";

/** 클래스 다이어그램 — dagre TB(BT 가 아니라 부모가 위) + rows(멤버). 상속은 자식→부모, 포함은 dashed. */
export const classDiagram: DiagramTypeDef = {
  id: "class",
  group: "structure",
  nameKey: "editor.diagram_tpl_class",
  hintKey: "editor.diagram_tpl_class_hint",
  aiHintKey: "editor.diagram_tpl_class_ai_hint",
  aiVocab: '클래스 — direction:"TB", 노드 = 클래스, rows = ["+area(): float", "-radius: float"] 멤버 목록, 상속 엣지는 자식→부모 라벨 "상속", 포함/참조는 line:"dashed"',
  seed: {
    v: 1,
    type: "class",
    direction: "TB",
    states: ["추상", "구체", "유틸"],
    nodes: [
      { id: "n1", label: "Shape", state: 0, rows: ["+area(): float", "+draw(): void"] },
      { id: "n2", label: "Circle", state: 1, rows: ["-radius: float", "+area(): float"] },
      { id: "n3", label: "Rect", state: 1, rows: ["-w: float", "-h: float", "+area(): float"] },
      { id: "n4", label: "Canvas", state: 2, rows: ["-shapes: Shape[]", "+render(): void"] },
    ],
    edges: [
      { id: "e1", from: "n2", to: "n1", label: "상속" },
      { id: "e2", from: "n3", to: "n1", label: "상속" },
      { id: "e3", from: "n4", to: "n1", label: "포함", line: "dashed" },
    ],
  },
};
