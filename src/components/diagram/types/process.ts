import type { DiagramTypeDef } from "./_def";

export const process: DiagramTypeDef = {
  id: "process",
  group: "flow",
  nameKey: "editor.diagram_tpl_process",
  hintKey: "editor.diagram_tpl_process_hint",
  aiHintKey: "editor.diagram_tpl_process_ai_hint",
  aiVocab: '단계별 프로세스 — 주 경로 한 줄, 진행 상태는 states(대기/진행중/완료), 되돌아가는 피드백은 line:"dotted"',
  seed: {
    v: 1,
    route: "curve",
    states: ["대기", "진행중", "완료"],
    nodes: [
      { id: "n1", label: "아이디어 수집", shape: "rect", state: 2 },
      { id: "n2", label: "디자인 및 설계", shape: "rect", state: 1 },
      { id: "n3", label: "개발 구현", shape: "rect", state: 0 },
      { id: "n4", label: "배포 및 출시", shape: "rect", state: 0 },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", label: "기획 확정", line: "solid", arrow: "end" },
      { id: "e2", from: "n2", to: "n3", label: "검수 통과", line: "solid", arrow: "end" },
      { id: "e3", from: "n3", to: "n4", label: "테스트 완료", line: "solid", arrow: "end" },
      { id: "e4", from: "n4", to: "n1", label: "피드백 수집", line: "dotted", arrow: "end" },
    ],
  },
};
