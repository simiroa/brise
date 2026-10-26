import type { DiagramTypeDef } from "./_def";

/** 원형 루프/플라이휠 — layout:"circle". 한 바퀴 도는 강화 루프. */
export const circle: DiagramTypeDef = {
  id: "circle",
  group: "layout",
  nameKey: "editor.diagram_tpl_circle",
  hintKey: "editor.diagram_tpl_circle_hint",
  aiHintKey: "editor.diagram_tpl_circle_ai_hint",
  aiVocab: '플라이휠 — layout:"circle", 서로를 강화하는 단계를 엣지로 한 바퀴(마지막→첫 번째 포함), 가속/유지/병목은 states',
  seed: {
    v: 1,
    type: "circle",
    layout: "circle",
    states: ["가속", "유지", "병목"],
    nodes: [
      { id: "n1", label: "콘텐츠 제작", shape: "round", state: 0 },
      { id: "n2", label: "방문자 증가", shape: "round", state: 0 },
      { id: "n3", label: "구독 전환", shape: "round", state: 2 },
      { id: "n4", label: "수익", shape: "round", state: 1 },
      { id: "n5", label: "재투자", shape: "round", state: 1 },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2" },
      { id: "e2", from: "n2", to: "n3" },
      { id: "e3", from: "n3", to: "n4" },
      { id: "e4", from: "n4", to: "n5" },
      { id: "e5", from: "n5", to: "n1" },
    ],
  },
};
