// 새 관계도(diagram) 섹션의 시작 소스 — JSON IR v1 형식.
//
// 시드는 전부 `types/<id>.ts` 가 갖고 `types/registry.ts` 가 나열한다(PLAN-2026-09-20 W1). 이 파일은
// 그 레지스트리에서 **파생**한 상수만 재export 한다 — 기존 import 경로(`DIAGRAM_TILES`·
// `DIAGRAM_TEMPLATE_IDS`·`diagramTemplateSource`·시드 상수 셋)를 그대로 살리기 위해서다. 시드를 고치거나
// 타입을 더하려면 여기가 아니라 `types/` 로 간다.
import type { DiagramRoute } from "./diagramSchema";
import { DIAGRAM_TYPES } from "./types/registry";

/** 레지스트리 id 그대로(`types/<id>.ts`). 문자열이라 타입을 더해도 여기를 고칠 일이 없다. */
export type DiagramTemplateId = string;

export interface DiagramTemplateTile {
  id: DiagramTemplateId;
  nameKey: string;
  hintKey: string;
  aiHintKey: string;
  states: string[];
  route: DiagramRoute;
  source: string;
}

/** The no-picker default */
export const DIAGRAM_STARTER = JSON.stringify(
  {
    v: 1,
    nodes: [
      { id: "n1", label: "첫 번째", shape: "rect" },
      { id: "n2", label: "두 번째", shape: "rect" },
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", label: "관계", line: "solid", arrow: "end" },
    ],
  },
  null,
  2,
);

/** 갤러리 타일 = 레지스트리 전체, 같은 순서. `source` 는 시드를 한 번만 직렬화한 것. */
export const DIAGRAM_TILES: DiagramTemplateTile[] = DIAGRAM_TYPES.map((def) => ({
  id: def.id,
  nameKey: def.nameKey,
  hintKey: def.hintKey,
  aiHintKey: def.aiHintKey,
  states: def.seed.states ?? [],
  route: def.seed.route ?? "curve",
  source: JSON.stringify(def.seed, null, 2),
}));

export const DIAGRAM_TEMPLATE_IDS: DiagramTemplateId[] = DIAGRAM_TILES.map((tile) => tile.id);

export function diagramTemplateSource(id: DiagramTemplateId): string {
  return DIAGRAM_TILES.find((tile) => tile.id === id)?.source ?? DIAGRAM_STARTER;
}

/** 어시스트(빈 노트) 관계도 프리셋 전용 시드 — `types/basic.ts`. */
export const DIAGRAM_PRESET_SEED = diagramTemplateSource("basic");
/** 어시스트 "마인드맵" 프리셋 시드 — `types/mindmap.ts`. */
export const DIAGRAM_MINDMAP_SEED = diagramTemplateSource("mindmap");
/** 어시스트 "시퀀스" 프리셋 시드 — `types/sequence.ts`. */
export const DIAGRAM_SEQUENCE_SEED = diagramTemplateSource("sequence");

export function diagramBody(bodyMd?: string): string {
  return bodyMd && bodyMd.trim() ? bodyMd : DIAGRAM_STARTER;
}
