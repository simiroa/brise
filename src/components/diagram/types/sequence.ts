import type { DiagramTypeDef } from "./_def";

/** 어시스트 "시퀀스"(빌트인 `diagram_sequence`)의 시드. 돌아오는 쪽(응답)은 `dashed` — 옛 mermaid 시드의
 *  `-->>` 가 뜻하던 것이고, JSON IR 에서는 그 뜻을 `line` 이 갖는다(`arrow` 와 분리된 축).
 *  `layout:"sequence"` — 노드 배열 순서 = 라이프라인 좌→우, 엣지 배열 순서 = 시간순(`layouts/sequence.ts`). */
export const sequence: DiagramTypeDef = {
  id: "sequence",
  group: "flow",
  nameKey: "editor.diagram_tpl_sequence",
  hintKey: "editor.diagram_tpl_sequence_hint",
  aiHintKey: "editor.diagram_tpl_sequence_ai_hint",
  aiVocab: '시퀀스 — direction:"LR", 노드 = 참여자(배열 순서 = 좌→우), 엣지 배열 순서 = 시간순, 응답은 line:"dashed"',
  seed: {
    v: 1,
    layout: "sequence",
    direction: "LR",
    nodes: [
      { id: "n1", label: "사용자", shape: "round" },
      { id: "n2", label: "시스템", shape: "rect" },
      { id: "n3", label: "데이터베이스", shape: "stadium" },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", label: "요청 전송", line: "solid", arrow: "end" },
      { id: "e2", from: "n2", to: "n3", label: "데이터 조회", line: "solid", arrow: "end" },
      { id: "e3", from: "n3", to: "n2", label: "결과 반환", line: "dashed", arrow: "end" },
      { id: "e4", from: "n2", to: "n1", label: "응답 완료", line: "dashed", arrow: "end" },
    ],
  },
};
