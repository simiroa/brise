import type { DiagramTypeDef } from "./_def";

export const system: DiagramTypeDef = {
  id: "system",
  group: "structure",
  nameKey: "editor.diagram_tpl_system",
  hintKey: "editor.diagram_tpl_system_hint",
  aiHintKey: "editor.diagram_tpl_system_ai_hint",
  aiVocab: '시스템 구성도 — route:"orthogonal", 저장소는 shape:"circle", 엣지 라벨은 요청/데이터 흐름, states 는 정상/주의/장애',
  seed: {
    v: 1,
    route: "orthogonal",
    states: ["정상", "주의", "장애"],
    nodes: [
      { id: "n1", label: "클라이언트 앱", shape: "rect", state: 0 },
      { id: "n2", label: "게이트웨이 서버", shape: "rect", state: 0 },
      { id: "n3", label: "메인 서비스 백엔드", shape: "rect", state: 0 },
      { id: "n4", label: "메인 DB", shape: "circle", state: 0 },
      { id: "n5", label: "Redis 캐시", shape: "circle", state: 0 },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", label: "API 요청", line: "solid", arrow: "end" },
      { id: "e2", from: "n2", to: "n3", label: "인증 / 라우팅", line: "solid", arrow: "end" },
      { id: "e3", from: "n3", to: "n4", label: "데이터 조회", line: "solid", arrow: "end" },
      { id: "e4", from: "n3", to: "n5", label: "캐시 읽기", line: "solid", arrow: "end" },
    ],
  },
};
