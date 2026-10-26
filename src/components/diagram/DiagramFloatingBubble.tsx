/**
 * DiagramFloatingBubble — archify-grade Floating Context Pill for Diagram Objects.
 *
 * 노드, 엣지, 그룹이 선택되었을 때 대상 바로 근처에 자연스럽게 플로팅되어,
 * 상단 툴바까지 마우스를 멀리 이동하지 않고도 핵심 기능들을 초고속으로 조작할 수 있는 인스펙터.
 *
 * 이 파일은 셸이다 — 위치 계산·바깥 클릭 닫기·선택 도출·조기 반환·AskAiModal 수명만 쥔다.
 * 선택 종류별 항목은 DiagramBubble{Multi,Node,Edge,Group}.tsx, 아이콘 버튼 + 드롭다운 뼈대는
 * DiagramBubbleMenu.tsx, 톤 색 항목은 ToneSwatches.tsx (PLAN-2026-09-13 책임분리, 동작 변경 0).
 */
import { useEffect, useRef, useState, Suspense } from "react";
import type { DiagramActions, Selection } from "./diagramActions";
import type { DiagramCanvasApi } from "./diagramCanvasApi";
import type { DiagramModel } from "./diagramModel";
import { groupNodeId } from "./FlowGroup";
import { selectedEdgeOf } from "./verbs";
import { AskAiModal } from "../../lazySurfaces";
import type { BubbleMenuCtl, BubbleMenuId } from "./DiagramBubbleMenu";
import { DiagramBubbleMulti } from "./DiagramBubbleMulti";
import { DiagramBubbleNode } from "./DiagramBubbleNode";
import { DiagramBubbleEdge } from "./DiagramBubbleEdge";
import { DiagramBubbleGroup } from "./DiagramBubbleGroup";

export interface DiagramFloatingBubbleProps {
  model: DiagramModel;
  selection: Selection;
  selectedBoxIds?: string[];
  actions: DiagramActions;
  apiRef?: React.MutableRefObject<DiagramCanvasApi | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

interface Pos {
  x: number;
  y: number;
  visible: boolean;
  isFlippedToBottom: boolean;
}

export function DiagramFloatingBubble({
  model,
  selection,
  selectedBoxIds,
  actions,
  apiRef,
  containerRef,
}: DiagramFloatingBubbleProps) {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Pos>({ x: 0, y: 0, visible: false, isFlippedToBottom: false });
  const [showAskAi, setShowAskAi] = useState(false);
  const [activeMenu, setActiveMenu] = useState<BubbleMenuId | null>(null);

  const isMulti = Boolean(selectedBoxIds && selectedBoxIds.length >= 2);
  const selectedNode = !isMulti && selection?.kind === "node" ? model.nodes.find((n) => n.id === selection.id) : undefined;
  const selectedEdge = !isMulti ? selectedEdgeOf(model, selection) : undefined;
  const selectedGroup = !isMulti && selection?.kind === "group" ? model.groups.find((g) => g.id === selection.id) : undefined;

  // 선택 대상이 없으면 렌더링하지 않음
  const hasSelection = isMulti || Boolean(selectedNode || selectedEdge || selectedGroup);

  // 대상 엘리먼트의 위치를 측정하여 컨테이너 기준 좌표 계산
  useEffect(() => {
    if (!hasSelection || !containerRef.current) {
      setPos((prev) => (prev.visible ? { ...prev, visible: false } : prev));
      return;
    }

    let rafId: number;

    const updatePosition = () => {
      const container = containerRef.current;
      if (!container) return;
      const cRect = container.getBoundingClientRect();

      if (isMulti && selectedBoxIds && selectedBoxIds.length >= 2) {
        let minLeft = Infinity;
        let minTop = Infinity;
        let maxRight = -Infinity;
        let maxBottom = -Infinity;
        let foundCount = 0;

        for (const id of selectedBoxIds) {
          const el = container.querySelector(`[data-id="${id}"]`);
          if (el) {
            const r = el.getBoundingClientRect();
            minLeft = Math.min(minLeft, r.left);
            minTop = Math.min(minTop, r.top);
            maxRight = Math.max(maxRight, r.right);
            maxBottom = Math.max(maxBottom, r.bottom);
            foundCount++;
          }
        }

        if (foundCount > 0) {
          let x = minLeft - cRect.left + (maxRight - minLeft) / 2;
          let y = minTop - cRect.top - 18;
          let isFlippedToBottom = false;
          if (y < 48) {
            y = maxBottom - cRect.top + 18;
            isFlippedToBottom = true;
          }
          x = Math.max(80, Math.min(cRect.width - 80, x));
          setPos({ x, y, visible: true, isFlippedToBottom });
          rafId = requestAnimationFrame(updatePosition);
          return;
        }
      }

      let targetEl: Element | null = null;

      if (selectedNode) {
        targetEl = container.querySelector(`[data-id="${selectedNode.id}"]`);
      } else if (selectedGroup) {
        targetEl = container.querySelector(`[data-id="${groupNodeId(selectedGroup.id)}"]`);
      } else if (selectedEdge) {
        const labelEl = container.querySelector(
          `.diagram-flow-edge-label[data-edge-id="${selectedEdge.id}"]`
        );
        const isEmptyLabel = !labelEl || labelEl.getAttribute("data-empty") === "true";

        if (labelEl && !isEmptyLabel) {
          const lRect = labelEl.getBoundingClientRect();
          let x = lRect.left - cRect.left + lRect.width / 2;
          let y = lRect.top - cRect.top - 18;
          let isFlippedToBottom = false;
          if (y < 48) {
            y = lRect.bottom - cRect.top + 18;
            isFlippedToBottom = true;
          }
          x = Math.max(80, Math.min(cRect.width - 80, x));
          setPos({ x, y, visible: true, isFlippedToBottom });
          rafId = requestAnimationFrame(updatePosition);
          return;
        }

        // 라벨이 없거나 비어있는 엣지: path 요소 중심 좌표 계산
        const pathEl = (container.querySelector(
          `.react-flow__edge[data-id="${selectedEdge.id}"] path.react-flow__edge-path`
        ) ??
          container.querySelector(
            `.react-flow__edge[data-id="${selectedEdge.id}"] path`
          )) as SVGPathElement | null;

        if (pathEl) {
          let midX: number;
          let midY: number;
          const pRect = pathEl.getBoundingClientRect();
          midX = (pRect.left + pRect.right) / 2;
          midY = (pRect.top + pRect.bottom) / 2;

          try {
            if (
              typeof pathEl.getTotalLength === "function" &&
              typeof pathEl.getPointAtLength === "function"
            ) {
              const totalLen = pathEl.getTotalLength();
              if (totalLen > 0) {
                const pt = pathEl.getPointAtLength(totalLen / 2);
                const ctm = pathEl.getScreenCTM?.();
                if (ctm) {
                  const screenPt = pt.matrixTransform(ctm);
                  midX = screenPt.x;
                  midY = screenPt.y;
                }
              }
            }
          } catch {
            // fallback to pRect center
          }

          let x = midX - cRect.left;
          let y = midY - cRect.top - 18;
          let isFlippedToBottom = false;
          if (y < 48) {
            y = midY - cRect.top + 18;
            isFlippedToBottom = true;
          }
          x = Math.max(80, Math.min(cRect.width - 80, x));
          setPos({ x, y, visible: true, isFlippedToBottom });
          rafId = requestAnimationFrame(updatePosition);
          return;
        }

        targetEl =
          labelEl ??
          container.querySelector(`.react-flow__edge[data-id="${selectedEdge.id}"]`);
      }

      if (!targetEl) {
        // DOM 엘리먼트가 아직 마운트되지 않았거나 보이지 않을 때
        rafId = requestAnimationFrame(updatePosition);
        return;
      }

      const tRect = targetEl.getBoundingClientRect();
      if (cRect.width === 0 && cRect.height === 0 && tRect.width === 0 && tRect.height === 0) {
        // jsdom / 테스트 환경: getBoundingClientRect가 0을 반환할 때 즉시 가시화하여 인터랙션 허용
        setPos({ x: 100, y: 100, visible: true, isFlippedToBottom: false });
        return;
      }

      // 컨테이너 기준 대상의 상단 중앙 좌표
      let x = tRect.left - cRect.left + tRect.width / 2;
      let y = tRect.top - cRect.top - 18;
      let isFlippedToBottom = false;

      // 만약 상단 공간이 너무 좁다면 하단으로 플립
      if (y < 48) {
        y = tRect.bottom - cRect.top + 18;
        isFlippedToBottom = true;
      }

      // 좌우 경계 클램프
      x = Math.max(80, Math.min(cRect.width - 80, x));

      setPos({ x, y, visible: true, isFlippedToBottom });
      rafId = requestAnimationFrame(updatePosition);
    };

    updatePosition();

    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [hasSelection, isMulti, selectedBoxIds, selectedNode, selectedEdge, selectedGroup, containerRef]);

  // 메뉴 바깥 클릭 시 서브메뉴 닫기
  useEffect(() => {
    const handleDown = (e: PointerEvent) => {
      if (!bubbleRef.current?.contains(e.target as Node)) {
        setActiveMenu(null);
      }
    };
    window.addEventListener("pointerdown", handleDown);
    return () => window.removeEventListener("pointerdown", handleDown);
  }, []);

  if (!hasSelection || !pos.visible) return null;

  const menu: BubbleMenuCtl = {
    active: activeMenu,
    setActive: setActiveMenu,
    flipped: pos.isFlippedToBottom,
  };

  return (
    <div
      ref={bubbleRef}
      className="diagram-floating-bubble"
      data-testid="diagram-floating-bubble"
      data-flipped={pos.isFlippedToBottom ? "true" : undefined}
      style={{
        left: `${pos.x}px`,
        top: `${pos.y}px`,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* ── MULTI-SELECTION CONTEXT ─────────────────────────── */}
      {isMulti && selectedBoxIds && (
        <DiagramBubbleMulti
          model={model}
          selectedBoxIds={selectedBoxIds}
          actions={actions}
          apiRef={apiRef}
          menu={menu}
        />
      )}

      {/* ── NODE CONTEXT ─────────────────────────── */}
      {!isMulti && selectedNode && (
        <DiagramBubbleNode
          node={selectedNode}
          model={model}
          actions={actions}
          apiRef={apiRef}
          menu={menu}
          onAskAi={() => setShowAskAi(true)}
        />
      )}

      {/* ── EDGE CONTEXT ─────────────────────────── */}
      {selectedEdge && (
        <DiagramBubbleEdge edge={selectedEdge} actions={actions} apiRef={apiRef} menu={menu} />
      )}

      {/* ── GROUP CONTEXT ────────────────────────── */}
      {selectedGroup && (
        <DiagramBubbleGroup group={selectedGroup} actions={actions} apiRef={apiRef} menu={menu} />
      )}

      {showAskAi && selectedNode && (
        <Suspense fallback={null}>
          <AskAiModal
            target={{
              kind: "diagram",
              label: selectedNode.label,
              id: selectedNode.id,
            }}
            onClose={() => setShowAskAi(false)}
          />
        </Suspense>
      )}
    </div>
  );
}
