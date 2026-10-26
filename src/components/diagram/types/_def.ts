import type { DiagramJson } from "../diagramSchema";

/** 어시스트 패널의 4개 헤더 — 구조 / 흐름 / 상태·시간 / 배치형 (PLAN-2026-09-20 D2). 헤더 순서이기도 하다. */
export const DIAGRAM_TYPE_GROUPS = ["structure", "flow", "state", "layout"] as const;
export type DiagramTypeGroup = (typeof DIAGRAM_TYPE_GROUPS)[number];

/**
 * 관계도 타입 하나 = 파일 하나 + `registry.ts` 한 줄.
 *
 * 타입 파일은 자기 시드·자기 i18n 키·자기 AI 힌트만 안다. 배치 함수(W2 `layouts/`)는 타입을 모르고
 * 시드의 `layout` 값만 본다 — 그래서 여기에 `layout` 필드를 따로 두지 않는다(시드가 유일한 진실,
 * `DiagramModel` 위 주석과 같은 이유). 지우는 절차: 파일 삭제 + registry 한 줄 + i18n 키 3벌.
 *
 * 키 규칙(파일이 아니라 소비자가 강제한다 — `MobileDiagramSheet` 가 `editor.diagram_tpl_${id}` 를
 * id 로 조립해 읽으므로 nameKey 는 반드시 그 형태여야 한다):
 *   nameKey   = editor.diagram_tpl_<id>
 *   hintKey   = editor.diagram_tpl_<id>_hint
 *   aiHintKey = editor.diagram_tpl_<id>_ai_hint
 */
export interface DiagramTypeDef {
  /** 파일명과 같다. `data-testid="diagram-tpl-<id>"` 의 접미사. */
  id: string;
  group: DiagramTypeGroup;
  /** JSON IR v1. 노드 ≤9·엣지 ≤12(diagram-design 예산) — 시드가 곧 "이 타입은 이렇게 쓴다"는 교본.
   *  `pos` 는 쓰지 않는다(배치가 만든다). `states`/`route` 는 "AI로 채우기"가 프롬프트에 싣는다. */
  seed: DiagramJson;
  nameKey: string;
  hintKey: string;
  /** "AI로 채우기"가 [사용자 요청] 으로 싣는 문구 — 로케일을 따른다. */
  aiHintKey: string;
  /** 시스템 프롬프트(`aiPrompts.ts::DIAGRAM_CREATE_VOCAB`, 한국어)에 이어 붙는 한 줄. 타입을 지우면
   *  프롬프트에서도 사라진다. 없으면 그 타입은 프롬프트에 안 나온다. */
  aiVocab?: string;
}
