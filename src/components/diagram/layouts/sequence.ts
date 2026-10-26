/**
 * sequence — 시퀀스 다이어그램. **노드 배열 순서 = 라이프라인 좌→우**(상자는 맨 위 한 줄, y 동일),
 * **엣지 배열 순서 = 시간순**(엣지 i 의 메시지 선 y = 상자 아래 + (i+1)·STEP). 유일하게 엣지 y 를 배치가
 * 정하는 배치라 `edgeAnchors` 를 채우고, 라이프라인 아래 끝을 `lifelineH` 로 돌려준다(캔버스 배경 레이어와
 * 정적 SVG 가 같은 값으로 세로선을 긋는다).
 *
 * ponytail: 라이프라인 간격은 고정(NODESEP) — 긴 메시지 라벨이 이웃 라이프라인을 넘칠 수 있다. 업그레이드
 * 경로: 인접 쌍마다 그 사이 라벨의 최대 폭으로 간격을 벌린다. 드래그된 노드(`pos`)는 그 x 를 따라가지만
 * 앵커 y 는 재계산하지 않는다(`flowLayout.ts` 의 pos 우선 규칙 그대로).
 */
import { DAGRE_NODESEP, NODE_H, NODE_W, type XY } from "../flowLayout";
import { LAYOUT_MARGIN, type LayoutResult, type Sizes } from "./_types";
import type { DiagramModel } from "../diagramSchema";

/** 메시지 선 사이의 세로 간격 — 라벨 칩(~20px) 하나와 숨 쉴 틈. */
export const SEQUENCE_STEP = 44;

export function sequenceLayout(model: DiagramModel, sizes: Sizes): LayoutResult {
  const positions: Record<string, XY> = {};
  let x = LAYOUT_MARGIN;
  let maxH = 0;
  for (const n of model.nodes) {
    const s = sizes[n.id] ?? { width: NODE_W, height: NODE_H };
    positions[n.id] = { x, y: LAYOUT_MARGIN };
    x += s.width + DAGRE_NODESEP;
    maxH = Math.max(maxH, s.height);
  }
  const base = LAYOUT_MARGIN + maxH;
  const edgeAnchors: Record<string, { y: number }> = {};
  model.edges.forEach((e, i) => {
    edgeAnchors[e.id] = { y: base + (i + 1) * SEQUENCE_STEP };
  });
  return { positions, edgeAnchors, lifelineH: base + (model.edges.length + 1) * SEQUENCE_STEP };
}
