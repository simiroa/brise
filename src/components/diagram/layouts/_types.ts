/**
 * 배치 함수의 계약 (PLAN-2026-09-20 §2.1 / §3). 각 배치는 **순수 함수 — 리액트·캔버스 패키지 import 없음**
 * (테스트가 소스 문자열로 고정). 좌표는 dagre 와 같은 **top-left** 규약(`flowLayout.ts::dagreLayout`).
 * 배치 함수는 타입(`model.type`)을 모르고 `layout` 이름만 안다 — 그룹·엣지 순서로 입력을 받는다.
 * `export function` 선언으로 쓴다(`flowLayout.ts` 와 순환 import 라 호이스팅이 필요).
 *
 * ponytail: 그룹 중첩은 1단만(`node.group === id` 직접 소속). 중첩 그룹은 dagre 가 담당한다.
 */
import type { DiagramModel } from "../diagramSchema";
import type { XY } from "../flowLayout";

export type Sizes = Record<string, { width: number; height: number }>;

export interface LayoutResult {
  positions: Record<string, XY>;
  /** sequence 전용(W2b) — 엣지 id → 수평 메시지 선의 y. `flowEdgePath` 가 있으면 수평 경로로 쓴다. */
  edgeAnchors?: Record<string, { y: number }>;
  /** sequence 전용(W2b) — 라이프라인 아래 끝의 y(절대 좌표, 모든 노드 공통 = 마지막 앵커 y + STEP). */
  lifelineH?: number;
}

export type LayoutFn = (model: DiagramModel, sizes: Sizes) => LayoutResult;

/** dagre 의 marginx/marginy 와 같은 바깥 여백. */
export const LAYOUT_MARGIN = 24;
