import type { DiagramTypeDef } from "./_def";

/** 데이터 흐름 — dagre LR, route:"orthogonal". 엣지 라벨 = 흐르는 데이터. */
export const dataflow: DiagramTypeDef = {
  id: "dataflow",
  group: "flow",
  nameKey: "editor.diagram_tpl_dataflow",
  hintKey: "editor.diagram_tpl_dataflow_hint",
  aiHintKey: "editor.diagram_tpl_dataflow_ai_hint",
  aiVocab: '데이터 흐름 — direction:"LR", route:"orthogonal", 노드 = 처리 단계/저장소(저장소는 shape:"round"), 엣지 라벨 = 흐르는 데이터',
  seed: {
    v: 1,
    type: "dataflow",
    direction: "LR",
    route: "orthogonal",
    states: ["실시간", "배치", "보관"],
    nodes: [
      { id: "n1", label: "센서", shape: "circle", state: 0 },
      { id: "n2", label: "수집기", state: 0 },
      { id: "n3", label: "메시지 큐", shape: "stadium", state: 0 },
      { id: "n4", label: "처리 워커", state: 1 },
      { id: "n5", label: "저장소", shape: "round", state: 2 },
      { id: "n6", label: "대시보드", state: 1 },
      { id: "n7", label: "알림", state: 0 },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", label: "측정값" },
      { id: "e2", from: "n2", to: "n3", label: "이벤트" },
      { id: "e3", from: "n3", to: "n4" },
      { id: "e4", from: "n4", to: "n5", label: "집계" },
      { id: "e5", from: "n5", to: "n6", label: "조회" },
      { id: "e6", from: "n4", to: "n7", label: "임계 초과", line: "dashed" },
    ],
  },
};
