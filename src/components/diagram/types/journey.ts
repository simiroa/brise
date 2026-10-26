import type { DiagramTypeDef } from "./_def";

/** 사용자 여정 — layout:"grid". 그룹 = 단계(열), 그룹 안 노드 = 접점(행). */
export const journey: DiagramTypeDef = {
  id: "journey",
  group: "flow",
  nameKey: "editor.diagram_tpl_journey",
  hintKey: "editor.diagram_tpl_journey_hint",
  aiHintKey: "editor.diagram_tpl_journey_ai_hint",
  aiVocab: '사용자 여정 — layout:"grid", 그룹 = 단계(좌→우 열), 그룹 안 노드 배열 순서 = 접점(위→아래 행), 감정은 states',
  seed: {
    v: 1,
    type: "journey",
    layout: "grid",
    states: ["만족", "보통", "불만"],
    nodes: [
      { id: "n1", label: "광고 노출", group: "g1", state: 1 },
      { id: "n2", label: "검색", group: "g1", state: 0 },
      { id: "n3", label: "상품 비교", group: "g2", state: 1 },
      { id: "n4", label: "리뷰 확인", group: "g2", state: 0 },
      { id: "n5", label: "결제", group: "g3", state: 2 },
      { id: "n6", label: "배송 안내", group: "g3", state: 1 },
      { id: "n7", label: "첫 사용", group: "g4", state: 0 },
      { id: "n8", label: "재구매", group: "g4", state: 0 },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n3" },
      { id: "e2", from: "n4", to: "n5" },
      { id: "e3", from: "n6", to: "n7" },
    ],
    groups: [
      { id: "g1", title: "인지" },
      { id: "g2", title: "탐색" },
      { id: "g3", title: "구매" },
      { id: "g4", title: "사용" },
    ],
  },
};
