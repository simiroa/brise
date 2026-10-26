import type { DiagramTypeDef } from "./_def";

/** 피라미드 — layout:"stack" 에 type:"pyramid"(배치가 가운데 정렬). 층이 내려갈수록 라벨이 길어 넓어진다. */
export const pyramid: DiagramTypeDef = {
  id: "pyramid",
  group: "layout",
  nameKey: "editor.diagram_tpl_pyramid",
  hintKey: "editor.diagram_tpl_pyramid_hint",
  aiHintKey: "editor.diagram_tpl_pyramid_ai_hint",
  aiVocab: '피라미드 — layout:"stack", type:"pyramid", 노드 배열 순서 = 꼭대기→바닥, 아래층일수록 라벨을 길게, 엣지 없음',
  seed: {
    v: 1,
    type: "pyramid",
    layout: "stack",
    states: ["장기", "중기", "단기"],
    nodes: [
      { id: "n1", label: "비전", state: 0 },
      { id: "n2", label: "전략 목표 세 가지", state: 0 },
      { id: "n3", label: "핵심 과제와 담당 조직", state: 1 },
      { id: "n4", label: "세부 실행 계획과 분기별 마일스톤", state: 2 },
      { id: "n5", label: "일상 업무 · 측정 지표 · 주간 점검 루틴", state: 2 },
    ],
    edges: [],
  },
};
