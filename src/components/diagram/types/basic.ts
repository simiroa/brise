import type { DiagramTypeDef } from "./_def";

/** 어시스트 "순서도 그리기"(빌트인 `diagram`)의 시드 — 채워 넣을 자리 셋. 옛 `DIAGRAM_PRESET_SEED`.
 *  aiVocab 없음: 이 타입은 "무엇을 그린다"가 아니라 "빈 자리"라 프롬프트에 실을 힌트가 없다. */
export const basic: DiagramTypeDef = {
  id: "basic",
  group: "flow",
  nameKey: "editor.diagram_tpl_basic",
  hintKey: "editor.diagram_tpl_basic_hint",
  aiHintKey: "editor.diagram_tpl_basic_ai_hint",
  seed: {
    v: 1,
    nodes: [
      { id: "n1", label: "텍스트를 입력하세요", shape: "rect" },
      { id: "n2", label: "텍스트를 입력하세요", shape: "rect" },
      { id: "n3", label: "텍스트를 입력하세요", shape: "rect" },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", label: "관계", line: "solid", arrow: "end" },
      { id: "e2", from: "n1", to: "n3", label: "관계", line: "solid", arrow: "end" },
    ],
  },
};
