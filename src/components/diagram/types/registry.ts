import type { DiagramTypeDef } from "./_def";
import { people } from "./people";
import { process } from "./process";
import { decision } from "./decision";
import { comparison } from "./comparison";
import { system } from "./system";
import { timeline } from "./timeline";
import { basic } from "./basic";
import { mindmap } from "./mindmap";
import { sequence } from "./sequence";
import { org } from "./org";
import { tree } from "./tree";
import { radialtree } from "./radialtree";
import { deps } from "./deps";
import { deploy } from "./deploy";
import { er } from "./er";
import { classDiagram } from "./class";
import { lanes } from "./lanes";
import { dataflow } from "./dataflow";
import { journey } from "./journey";
import { state } from "./state";
import { lifecycle } from "./lifecycle";
import { roadmap } from "./roadmap";
import { quadrant } from "./quadrant";
import { stack } from "./stack";
import { circle } from "./circle";
import { fishbone } from "./fishbone";
import { pyramid } from "./pyramid";

export type { DiagramTypeDef, DiagramTypeGroup } from "./_def";
export { DIAGRAM_TYPE_GROUPS } from "./_def";

/**
 * 관계도 타입 레지스트리 — 타입당 한 줄. 이 순서가 갤러리(`DiagramTemplateGrid`·모바일 시트)의 순서이고,
 * 어시스트 패널은 `group` 별로 나눈 뒤 이 순서를 지킨다. 타입을 빼려면 이 줄 + 파일 + i18n 키 3벌만
 * 지운다(`_def.ts`). `diagramStarter.ts` 의 `DIAGRAM_TILES`·`DIAGRAM_TEMPLATE_IDS`·시드 상수는
 * 전부 여기서 파생되고, `diagramStarter.test.ts` 가 모든 시드를 파싱·검증한다.
 * 배치 함수(`layouts/`)는 시드의 `layout` 만 본다 — 이 목록은 타입이지 배치 목록이 아니다.
 */
export const DIAGRAM_TYPES: readonly DiagramTypeDef[] = [
  // 기존 6장 + 어시스트 3장 (W1)
  people,
  process,
  decision,
  comparison,
  system,
  timeline,
  basic,
  mindmap,
  sequence,
  // 구조 (W2)
  org,
  tree,
  radialtree,
  deps,
  deploy,
  er,
  classDiagram,
  // 흐름
  lanes,
  dataflow,
  journey,
  // 상태·시간
  state,
  lifecycle,
  roadmap,
  // 배치형
  quadrant,
  stack,
  circle,
  fishbone,
  pyramid,
];

export function diagramTypeById(id: string): DiagramTypeDef | undefined {
  return DIAGRAM_TYPES.find((d) => d.id === id);
}
