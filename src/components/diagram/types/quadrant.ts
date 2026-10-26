import type { DiagramTypeDef } from "./_def";

/** 사분면 — layout:"quadrant" + axes. 그룹 4개 순서 = 좌상·우상·좌하·우하. 엣지 없음. */
export const quadrant: DiagramTypeDef = {
  id: "quadrant",
  group: "layout",
  nameKey: "editor.diagram_tpl_quadrant",
  hintKey: "editor.diagram_tpl_quadrant_hint",
  aiHintKey: "editor.diagram_tpl_quadrant_ai_hint",
  aiVocab: '사분면 — layout:"quadrant", axes:{x:["왼쪽","오른쪽"],y:["아래","위"]}, 그룹 정확히 4개(순서 좌상·우상·좌하·우하), 각 노드는 group 하나, 엣지 없음',
  seed: {
    v: 1,
    type: "quadrant",
    layout: "quadrant",
    axes: { x: ["노력 적음", "노력 많음"], y: ["효과 낮음", "효과 높음"] },
    states: ["지금", "다음", "보류"],
    nodes: [
      { id: "n1", label: "온보딩 개선", group: "g1", state: 0 },
      { id: "n2", label: "오류 문구 정리", group: "g1", state: 0 },
      { id: "n3", label: "결제 재설계", group: "g2", state: 1 },
      { id: "n4", label: "검색 엔진 교체", group: "g2", state: 1 },
      { id: "n5", label: "아이콘 교체", group: "g3", state: 2 },
      { id: "n6", label: "폰트 조정", group: "g3", state: 2 },
      { id: "n7", label: "관리자 화면 리뉴얼", group: "g4", state: 2 },
      { id: "n8", label: "레거시 마이그레이션", group: "g4", state: 2 },
    ],
    edges: [],
    groups: [
      { id: "g1", title: "빠른 성과", tone: "done" },
      { id: "g2", title: "큰 프로젝트", tone: "accent" },
      { id: "g3", title: "채우기 과제" },
      { id: "g4", title: "피할 것", tone: "muted" },
    ],
  },
};
