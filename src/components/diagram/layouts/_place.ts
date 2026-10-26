/** 배치 함수들이 공유하는 산수 두 개. 리액트·캔버스 패키지 import 없음. */
import type { DiagramModel, DiagramNode } from "../diagramSchema";
import type { XY } from "../flowLayout";

/** 원점 기준으로 놓은 좌표를 좌상단이 (margin, margin) 이 되게 평행이동. 정수로 반올림. */
export function shiftToMargin(positions: Record<string, XY>, margin: number): Record<string, XY> {
  const all = Object.values(positions);
  if (!all.length) return positions;
  const dx = margin - Math.min(...all.map((p) => p.x));
  const dy = margin - Math.min(...all.map((p) => p.y));
  const out: Record<string, XY> = {};
  for (const [id, p] of Object.entries(positions)) out[id] = { x: Math.round(p.x + dx), y: Math.round(p.y + dy) };
  return out;
}

/** 그룹 배열 순서대로 [그룹, 직접 멤버]. 그룹 없는 노드는 마지막에 `null` 그룹으로 한 묶음(비어 있으면 생략). */
export function membersByGroup(model: DiagramModel): { id: string | null; nodes: DiagramNode[] }[] {
  const out = model.groups.map((g) => ({ id: g.id as string | null, nodes: model.nodes.filter((n) => n.group === g.id) }));
  const known = new Set(model.groups.map((g) => g.id));
  const loose = model.nodes.filter((n) => !n.group || !known.has(n.group));
  if (loose.length) out.push({ id: null, nodes: loose });
  return out;
}
