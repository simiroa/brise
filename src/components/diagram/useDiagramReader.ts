import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { DiagramModel } from "./diagramSchema";
import { computeReachActiveIds, type ReachDirection } from "./diagramReach";

export type DiagramReaderMode =
  | { kind: "none" }
  | { kind: "filter"; selectedStates: Set<number>; flagFilter?: boolean }
  | { kind: "reach"; startNodeId: string; direction: ReachDirection }
  | { kind: "finder"; query: string };

export interface UseDiagramReaderOptions {
  model: DiagramModel;
}

/**
 * useDiagramReader
 *
 * 흐림(Dimming) 상태 및 리더 모드의 단일 소유자 (Single Owner) 훅:
 * - DiagramReaderMode 상태 관리 (none, filter, reach, finder)
 * - dimmedIds 계산 (상태 필터링, 플래그 필터링, 도달 가능성, 텍스트 검색)
 * - toggleFilterState: 상태 칩 토글
 * - toggleFilterFlag: 플래그 칩 토글
 * - handleReach: 상류/하류 도달 분석 모드 진입/해제
 * - handleReaderKeyDown: Escape 및 '/' 키 단축키 처리 보조
 */
export function useDiagramReader({ model }: UseDiagramReaderOptions) {
  const [readerMode, setReaderMode] = useState<DiagramReaderMode>({ kind: "none" });
  const [hoveredTarget, setHoveredTarget] = useState<number | "flag" | null>(null);

  const dimmedIds = useMemo<Set<string> | null>(() => {
    // 호버 스포트라이트 (임시 호버 딤) 우선 반영
    if (hoveredTarget !== null) {
      const matchingNodes = new Set<string>();
      for (const n of model.nodes) {
        if (hoveredTarget === "flag") {
          if (n.flag) matchingNodes.add(n.id);
        } else if (n.state === hoveredTarget) {
          matchingNodes.add(n.id);
        }
      }
      const matchingEdges = new Set<string>();
      for (const e of model.edges) {
        if (matchingNodes.has(e.from) && matchingNodes.has(e.to)) {
          matchingEdges.add(e.id);
        }
      }
      return new Set([...matchingNodes, ...matchingEdges]);
    }

    if (readerMode.kind === "none") return null;

    if (readerMode.kind === "filter") {
      const hasStates = readerMode.selectedStates.size > 0;
      const hasFlag = Boolean(readerMode.flagFilter);
      if (!hasStates && !hasFlag) return null;

      const matchingNodes = new Set<string>();
      for (const n of model.nodes) {
        const stateMatch = hasStates && n.state !== undefined && readerMode.selectedStates.has(n.state);
        const flagMatch = hasFlag && Boolean(n.flag);
        if (stateMatch || flagMatch) {
          matchingNodes.add(n.id);
        }
      }
      const matchingEdges = new Set<string>();
      for (const e of model.edges) {
        if (matchingNodes.has(e.from) && matchingNodes.has(e.to)) {
          matchingEdges.add(e.id);
        }
      }
      return new Set([...matchingNodes, ...matchingEdges]);
    }

    if (readerMode.kind === "reach") {
      return computeReachActiveIds(model.edges, readerMode.startNodeId, readerMode.direction);
    }

    if (readerMode.kind === "finder") {
      const q = readerMode.query.trim().toLowerCase();
      if (!q) return null;
      const matchingNodes = new Set<string>();
      for (const n of model.nodes) {
        const labelMatch = n.label?.toLowerCase().includes(q);
        const tagMatch = n.tag ? n.tag.toLowerCase().includes(q) : false;
        const descMatch = n.desc ? n.desc.toLowerCase().includes(q) : false;
        if (labelMatch || tagMatch || descMatch) {
          matchingNodes.add(n.id);
        }
      }
      return matchingNodes;
    }

    return null;
  }, [readerMode, hoveredTarget, model]);

  const toggleFilterState = (stateIdx: number, _isShift?: boolean) => {
    let nextStates: Set<number>;
    const flagFilter = readerMode.kind === "filter" ? readerMode.flagFilter : undefined;

    if (readerMode.kind === "filter") {
      nextStates = new Set(readerMode.selectedStates);
      if (nextStates.has(stateIdx)) {
        nextStates.delete(stateIdx);
      } else {
        nextStates.add(stateIdx);
      }
    } else {
      nextStates = new Set([stateIdx]);
    }

    if (nextStates.size === 0 && !flagFilter) {
      setReaderMode({ kind: "none" });
    } else {
      setReaderMode(
        flagFilter !== undefined
          ? { kind: "filter", selectedStates: nextStates, flagFilter }
          : { kind: "filter", selectedStates: nextStates }
      );
    }
  };

  const toggleFilterFlag = () => {
    const selectedStates = readerMode.kind === "filter" ? readerMode.selectedStates : new Set<number>();
    const nextFlag = readerMode.kind === "filter" ? !readerMode.flagFilter : true;

    if (selectedStates.size === 0 && !nextFlag) {
      setReaderMode({ kind: "none" });
    } else {
      setReaderMode({ kind: "filter", selectedStates, flagFilter: nextFlag });
    }
  };

  const handleReach = (nodeId: string, direction: ReachDirection | "off") => {
    if (direction === "off") {
      setReaderMode({ kind: "none" });
    } else {
      setReaderMode({ kind: "reach", startNodeId: nodeId, direction });
    }
  };

  const clearReaderMode = () => {
    setReaderMode({ kind: "none" });
  };

  const openFinder = () => {
    setReaderMode({ kind: "finder", query: "" });
  };

  const handleReaderKeyDown = (
    e: ReactKeyboardEvent<HTMLElement>,
    isInlineEditing?: boolean
  ): boolean => {
    if (e.key === "Escape") {
      if (readerMode.kind !== "none") {
        e.preventDefault();
        e.stopPropagation();
        setReaderMode({ kind: "none" });
        return true;
      }
    }

    if (e.key === "/" && !isInlineEditing) {
      e.preventDefault();
      e.stopPropagation();
      setReaderMode({ kind: "finder", query: "" });
      return true;
    }

    return false;
  };

  return {
    readerMode,
    setReaderMode,
    dimmedIds,
    toggleFilterState,
    toggleFilterFlag,
    hoveredTarget,
    setHoveredTarget,
    hoveredState: typeof hoveredTarget === "number" ? hoveredTarget : null,
    setHoveredState: (st: number | null) => setHoveredTarget(st),
    handleReach,
    clearReaderMode,
    openFinder,
    handleReaderKeyDown,
  };
}
