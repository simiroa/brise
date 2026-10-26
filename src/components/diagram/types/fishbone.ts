import type { DiagramTypeDef } from "./_def";

/** 피시본 — layout:"fishbone". 머리 = 그룹 없는 노드(결과), 그룹 = 가시(원인 범주), 그룹 안 노드 = 원인. */
export const fishbone: DiagramTypeDef = {
  id: "fishbone",
  group: "layout",
  nameKey: "editor.diagram_tpl_fishbone",
  hintKey: "editor.diagram_tpl_fishbone_hint",
  aiHintKey: "editor.diagram_tpl_fishbone_ai_hint",
  aiVocab: '피시본(원인 분석) — layout:"fishbone", 머리 = 그룹 없는 결과 노드 하나, 그룹 = 원인 범주(사람/장비/방법/재료…), 그룹 안 노드 = 원인, 범주당 첫 원인→머리 엣지',
  seed: {
    v: 1,
    type: "fishbone",
    layout: "fishbone",
    states: ["주요 원인", "부차 원인", "확인 필요"],
    nodes: [
      { id: "n1", label: "납기 지연", shape: "round" },
      { id: "n2", label: "인력 부족", group: "g1", state: 0 },
      { id: "n3", label: "교육 미비", group: "g1", state: 1 },
      { id: "n4", label: "노후 설비", group: "g2", state: 0 },
      { id: "n5", label: "잦은 고장", group: "g2", state: 2 },
      { id: "n6", label: "절차 불명확", group: "g3", state: 1 },
      { id: "n7", label: "자재 입고 지연", group: "g4", state: 0 },
    ],
    edges: [
      { id: "e1", from: "n2", to: "n1" },
      { id: "e2", from: "n4", to: "n1" },
      { id: "e3", from: "n6", to: "n1" },
      { id: "e4", from: "n7", to: "n1" },
    ],
    groups: [
      { id: "g1", title: "사람" },
      { id: "g2", title: "장비" },
      { id: "g3", title: "방법" },
      { id: "g4", title: "재료" },
    ],
  },
};
