import type { DiagramTypeDef } from "./_def";

/** 의존 관계 — dagre LR. 화살표 = "…에 의존한다", 버전은 tag. */
export const deps: DiagramTypeDef = {
  id: "deps",
  group: "structure",
  nameKey: "editor.diagram_tpl_deps",
  hintKey: "editor.diagram_tpl_deps_hint",
  aiHintKey: "editor.diagram_tpl_deps_ai_hint",
  aiVocab: '의존 관계 — direction:"LR", 엣지 = "A 가 B 에 의존" (from:A, to:B), 버전은 tag, 안정/변경 중/폐기 예정은 states',
  seed: {
    v: 1,
    type: "deps",
    direction: "LR",
    states: ["안정", "변경 중", "폐기 예정"],
    nodes: [
      { id: "n1", label: "app", tag: "v2.1", state: 1 },
      { id: "n2", label: "ui", tag: "v1.4", state: 0 },
      { id: "n3", label: "api", tag: "v3.0", state: 1 },
      { id: "n4", label: "design-tokens", tag: "v0.9", state: 0 },
      { id: "n5", label: "db-client", tag: "v2.0", state: 0 },
      { id: "n6", label: "auth", tag: "v1.0", state: 2 },
      { id: "n7", label: "crypto", tag: "v1.2", state: 0 },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2" },
      { id: "e2", from: "n1", to: "n3" },
      { id: "e3", from: "n2", to: "n4" },
      { id: "e4", from: "n3", to: "n5" },
      { id: "e5", from: "n3", to: "n6" },
      { id: "e6", from: "n6", to: "n7" },
    ],
  },
};
