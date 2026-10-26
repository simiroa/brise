export interface MultiDragSource {
  id: string;
  x: number;
  y: number;
}

export interface GraphMultiDragOverlayProps {
  /** 활성 노드를 제외한 나머지 선택 노드들의 중심(컨테이너 상대 px). 활성 노드의 선은 React Flow
   *  자신이 connection-path 로 그린다. */
  sources: MultiDragSource[];
  pointerCanvasPos: { x: number; y: number } | null;
}

/**
 * 다중선택 상태에서 노드 하나를 끌면 **선택된 모든 노드에서** 선이 뽑혀 나오게 하는 오버레이.
 *
 * 좌표를 부모(GraphCanvas)가 flow 좌표에서 계산해 넘긴다 — 예전에는 이 컴포넌트가 렌더 중에
 * `.react-flow__node[data-id]` 를 querySelector 로 찾아 getBoundingClientRect 를 읽었는데,
 * 그 조회가 실패하면(마운트 타이밍·리렌더 순서) 선이 **하나도** 그려지지 않았고, 성공해도 노드
 * div 의 transform 트랜지션 때문에 선 끝이 노드에서 떨어져 보였다.
 */
export function GraphMultiDragOverlay({ sources, pointerCanvasPos }: GraphMultiDragOverlayProps) {
  if (!pointerCanvasPos || sources.length === 0) return null;

  const { x: tx, y: ty } = pointerCanvasPos;

  return (
    <svg className="graph-multi-drag-overlay" data-testid="graph-multi-drag-overlay">
      {sources.map((s) => {
        const dx = Math.max(30, Math.abs(tx - s.x) * 0.45);
        return (
          <path
            key={s.id}
            d={`M ${s.x} ${s.y} C ${s.x + dx} ${s.y}, ${tx - dx} ${ty}, ${tx} ${ty}`}
            className="graph-multi-drag-wire"
          />
        );
      })}
    </svg>
  );
}
