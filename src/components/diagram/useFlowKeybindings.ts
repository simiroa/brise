import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { DiagramModel, Direction } from "./diagramModel";
import type { DiagramActions, Selection } from "./diagramActions";
import { layoutPositions } from "./flowLayout";

export interface UseFlowKeybindingsOptions {
  model?: DiagramModel;
  selection?: Selection;
  selectedBoxIds?: string[];
  actions?: DiagramActions;
  openRename?: (id: string, initial?: string) => void;
  fitView?: () => void;
  zoomToSelection?: () => void;
  handleKey: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  locked?: boolean;
}

export function useFlowKeybindings({
  model,
  selection,
  selectedBoxIds,
  actions,
  openRename,
  fitView,
  zoomToSelection,
  handleKey,
  locked,
}: UseFlowKeybindingsOptions) {
  /**
   * Delete / undo / redo are diagramGestures' — centralized there so a second canvas would share
   * them instead of re-deriving them.
   *
   * Added high-speed diagram authoring:
   * - Tab: create & connect a new downstream node and immediately enter rename editing
   * - Enter: create a sibling node (sharing the same parent) or adjacent node and enter rename editing
   * - Ctrl+G: group selected nodes
   * - Ctrl+Shift+G: dissolve selected group
   * - Shift+1: Zoom to Fit (전체 맞춤)
   * - Shift+2: Zoom to Selection (선택 노드 줌/포커스)
   */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // 인라인 입력(input, textarea) 중에는 캔버스 키바인딩을 가로채지 않음
    if ((e.target as HTMLElement).closest("input, textarea")) return;

    // Shift+1: 전체 맞춤 (Zoom to Fit)
    if (e.shiftKey && (e.key === "!" || e.key === "1") && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      fitView?.();
      return;
    }

    // Shift+2: 선택된 노드로 줌/포커스 (Zoom to Selection)
    if (e.shiftKey && (e.key === "@" || e.key === "2") && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      zoomToSelection?.();
      return;
    }

    // 캔버스가 잠겨있을 때는 노드/그룹/관계 생성 및 편집 단축키 차단
    if (locked) return;

    // Ctrl+Shift+G: 선택된 그룹 해제 (dissolveGroup)
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "G" || e.key === "g")) {
      e.preventDefault();
      e.stopPropagation();
      if (selection?.kind === "group" && actions) {
        actions.dissolveGroup(selection.id);
        return;
      }
      if (selection?.kind === "node" && model && actions) {
        const node = model.nodes.find((n) => n.id === selection.id);
        if (node?.group) {
          actions.dissolveGroup(node.group);
          return;
        }
      }
      return;
    }

    // Ctrl+G: 다중 선택된 노드들을 그룹화 (addGroup)
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "G" || e.key === "g")) {
      e.preventDefault();
      e.stopPropagation();
      const targetIds =
        selectedBoxIds && selectedBoxIds.length >= 2
          ? selectedBoxIds
          : selection?.kind === "node"
            ? [selection.id]
            : [];
      if (targetIds.length > 0 && actions) {
        actions.addGroup("새 그룹", targetIds);
      }
      return;
    }

    // F 키: 선택된 노드(들)를 프레임으로 묶기 (단일 노드 또는 다중 선택)
    if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "F" || e.key === "f")) {
      const targetIds =
        selectedBoxIds && selectedBoxIds.length > 0
          ? selectedBoxIds
          : selection?.kind === "node"
            ? [selection.id]
            : [];
      if (targetIds.length > 0 && actions) {
        e.preventDefault();
        e.stopPropagation();
        actions.addGroup("새 단계", targetIds);
        return;
      }
    }

    // Tab 키: 하류(downstream) 방향에 새 노드를 즉시 생성하고 연결한 뒤 인라인 편집 진입
    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (selection?.kind === "node" && model && actions && openRename) {
        const currentNode = model.nodes.find((n) => n.id === selection.id);
        if (currentNode) {
          e.preventDefault();
          e.stopPropagation();

          const positions = layoutPositions(model);
          const curPos = positions[currentNode.id] ?? { x: 0, y: 0 };
          const direction: Direction = model.direction;

          let offset = { x: 0, y: 100 };
          if (direction === "LR") {
            offset = { x: 220, y: 0 };
          } else if (direction === "RL") {
            offset = { x: -220, y: 0 };
          } else if (direction === "BT") {
            offset = { x: 0, y: -100 };
          } else {
            // TB
            offset = { x: 0, y: 100 };
          }

          const defaultLabel = "새 노드";
          const newPos = {
            x: Math.round(curPos.x + offset.x),
            y: Math.round(curPos.y + offset.y),
          };

          const newNodeId = actions.addConnected(currentNode.id, defaultLabel, newPos);
          if (newNodeId) {
            openRename(newNodeId, defaultLabel);
          }
          return;
        }
      }
    }

    // Enter 키: 같은 부모를 공유하는 형제(sibling) 노드 생성 또는 인근에 새 노드 생성
    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      if (selection?.kind === "node" && model && actions && openRename) {
        const currentNode = model.nodes.find((n) => n.id === selection.id);
        if (currentNode) {
          e.preventDefault();
          e.stopPropagation();

          const positions = layoutPositions(model);
          const curPos = positions[currentNode.id] ?? { x: 0, y: 0 };
          const direction: Direction = model.direction;

          // 형제 노드 배치를 위한 직교 방향 오프셋 (가로 흐름이면 세로로, 세로 흐름이면 가로로)
          let offset = { x: 200, y: 0 };
          if (direction === "LR" || direction === "RL") {
            offset = { x: 0, y: 70 };
          } else {
            offset = { x: 200, y: 0 };
          }

          const defaultLabel = "새 노드";
          const newPos = {
            x: Math.round(curPos.x + offset.x),
            y: Math.round(curPos.y + offset.y),
          };

          // 같은 부모가 있는지 확인 (선택된 노드로 들어오는 엣지 탐색)
          const incomingEdge = model.edges.find((edge) => edge.to === currentNode.id);
          let newNodeId: string | undefined;
          if (incomingEdge) {
            newNodeId = actions.addConnected(incomingEdge.from, defaultLabel, newPos);
          } else {
            newNodeId = actions.addNode(defaultLabel, undefined, newPos);
          }

          if (newNodeId) {
            openRename(newNodeId, defaultLabel);
          }
          return;
        }
      }
    }

    handleKey(e);
  };

  return { onKeyDown };
}

