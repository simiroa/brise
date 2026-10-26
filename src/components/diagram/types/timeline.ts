import type { DiagramTypeDef } from "./_def";

export const timeline: DiagramTypeDef = {
  id: "timeline",
  group: "state",
  nameKey: "editor.diagram_tpl_timeline",
  hintKey: "editor.diagram_tpl_timeline_hint",
  aiHintKey: "editor.diagram_tpl_timeline_ai_hint",
  aiVocab: "프로젝트 타임라인 — 단계를 시간순 한 줄로 잇고 라벨 앞에 'N단계:' 접두, 진척은 states(계획/진행/마감)",
  seed: {
    v: 1,
    route: "curve",
    states: ["계획", "진행", "마감"],
    nodes: [
      { id: "n1", label: "1단계: 요구사항 정의", shape: "rect", state: 2 },
      { id: "n2", label: "2단계: 프로토타입 작성", shape: "rect", state: 2 },
      { id: "n3", label: "3단계: 핵심 기능 개발", shape: "rect", state: 1 },
      { id: "n4", label: "4단계: 최종 검수 및 오픈", shape: "rect", state: 0 },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", label: "다음 단계", line: "solid", arrow: "end" },
      { id: "e2", from: "n2", to: "n3", label: "다음 단계", line: "solid", arrow: "end" },
      { id: "e3", from: "n3", to: "n4", label: "다음 단계", line: "solid", arrow: "end" },
    ],
  },
};
