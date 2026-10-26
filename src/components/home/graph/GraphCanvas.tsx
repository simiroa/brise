import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BaseEdge,
  ConnectionMode,
  EdgeLabelRenderer,
  getStraightPath,
  Handle,
  Position,
  ReactFlow,
  useInternalNode,
  useReactFlow,
  useStore,
  type Connection,
  type Edge,
  type EdgeProps,
  type NodeProps,
} from "@xyflow/react";
import type { Folder } from "../../../lib/commands.gen";
import { folderColorCss } from "../../../lib/ui";
import { IconClose } from "../../icons";
import { t } from "../../../i18n/t";
import { displayTitle } from "../../../stores/notes";
import { randomId } from "../../../lib/ids";
import { GraphLaserOverlay } from "./GraphLaserOverlay";
import { GraphMultiDragOverlay } from "./GraphMultiDragOverlay";
import { GraphCutBurstsOverlay } from "./GraphCutBurstsOverlay";
import {
  boxesIntersect,
  constellationNodes,
  declutterLabels,
  egoGraph,
  estimateLabelWidth,
  getLabelBoundingBox,
  orderFoldersByLinkDensity,
  pairKey,
  resetNodePositionCacheForTests,
  stabilizePositions,
  stringHash,
  type DashboardGraphEdge,
  type DashboardGraphNode,
  type DashboardGraphResult,
  type GraphFlowNode,
  type GraphNodeData,
  type LabelBoundingBox,
} from "./graphSimulation";
import {
  graphEdges,
  isNodeJustConnected,
  isPairJustCreated,
  NODE_HALF,
  segmentIntersection,
  type CustomEdgeData,
  type Pt,
} from "./graphRenderer";

export {
  boxesIntersect,
  constellationNodes,
  declutterLabels,
  egoGraph,
  estimateLabelWidth,
  getLabelBoundingBox,
  orderFoldersByLinkDensity,
  resetNodePositionCacheForTests,
  stabilizePositions,
  stringHash,
  type DashboardGraphEdge,
  type DashboardGraphNode,
  type DashboardGraphResult,
  type GraphFlowNode,
  type GraphNodeData,
  type LabelBoundingBox,
};

export {
  graphEdges,
  isNodeJustConnected,
  isPairJustCreated,
  NODE_HALF,
  segmentIntersection,
  type CustomEdgeData,
  type Pt,
};

export interface GraphCanvasProps {
  result: DashboardGraphResult;
  folders: Folder[];
  selectedId: string | null;
  selectedIds?: Set<string>;
  searchHits: Set<string> | null;
  /** 선택이 없을 때만 쓰인다 — 이 노드들만 밝게 두고 나머지를 흐린다(이웃 확장 없음). 관계 탭
   *  우측 연결 제안 카드 호버가 그 쌍을 가리킬 때 쓴다. 참조가 안정적이어야 한다(useMemo). */
  highlightIds?: Set<string> | null;
  justCreatedKeys?: Set<string>;
  justCreatedPair?: { source: string; target: string } | null;
  onSelect: (id: string, isMulti?: boolean) => void;
  onOpen: (id: string) => void;
  onConnectNote?: (sourceId: string, targetId: string) => void;
  onConnectMultipleNotes?: (sourceIds: string[], targetId: string) => void;
  onCreateNoteAndConnect?: (sourceIds: string[], position?: { x: number; y: number }) => void;
  onCutEdge?: (edge: DashboardGraphEdge) => void;
  /** 레이저 스트로크 시작/종료 통보 — 스트로크 도중 그래프를 다시 그리면 움직이는 엣지가 아직
   *  살아 있는 레이저를 스쳐 "자르지도 않은 곳에서 컷이 터지는" 연쇄가 난다(disarmLaser 주석). */
  onLaserActiveChange?: (active: boolean) => void;
}

/** 얕은비교 — canvasPageNodes.ts:32 의 reuseData 와 같은 패턴. 두 객체의 모든 키가 값으로
 *  같으면 true. React.memo 의 기본 얕은비교(props 자체)와 별개로, 여기서는 props *안의* 객체
 *  (data, style)를 값으로 비교하는 데 쓴다 — 그 객체들은 호출부에서 매번 새로 만들어지기 때문. */
function shallowEqual<T extends object>(a: T | undefined | null, b: T | undefined | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const aKeys = Object.keys(a) as (keyof T)[];
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/** reuseData(canvasPageNodes.ts:32)의 그래프 버전 — 이 노드 자신의 선택/검색/포커스 소속이
 *  안 바뀌었으면 이전 data 참조를 그대로 돌려준다. 그래야 React.memo(NoteNode) 가 얕은비교로
 *  bail-out 할 수 있다(참조가 매번 새로 생기면 클릭/호버 한 번에 모든 노드가 다시 렌더된다). */
function reuseGraphNodeData(prev: GraphNodeData | undefined, next: GraphNodeData): GraphNodeData {
  if (prev && shallowEqual(prev, next)) return prev;
  return next;
}

const NoteNode = memo(function NoteNode({ data, selected }: NodeProps<GraphFlowNode>) {
  const { item, color, labelled, size, searchDim, searchHit, selectionIndex } = data;
  return (
    <div
      className="graph-note-node"
      data-selected={selected || undefined}
      data-labelled={labelled || undefined}
      data-search-dim={searchDim || undefined}
      data-search-hit={searchHit || undefined}
      data-isolated={item.degree === 0 || undefined}
      style={{
        "--graph-folder": color,
        "--graph-node-size": `${size}px`,
      } as React.CSSProperties}
    >
      <Handle
        type="target"
        position={Position.Left}
        aria-label={displayTitle(item.title)}
      />
      <Handle
        type="source"
        position={Position.Right}
        aria-label={displayTitle(item.title)}
      />
      {typeof selectionIndex === "number" && selectionIndex > 0 && (
        <span className="graph-node-selection-badge" data-testid="graph-node-selection-badge">
          {selectionIndex}
        </span>
      )}
      <span className="graph-note-node__title">{displayTitle(item.title)}</span>
    </div>
  );
});

/** GraphEdgeComponent 는 매 렌더 style/data 를 새 객체로 받는다(graphEdges, graphRenderer.ts —
 *  이 파일 범위 밖이라 호출부를 못 고친다). React.memo 의 기본 참조비교는 항상 "달라짐"으로 판정해
 *  아무 이득이 없으므로, style/data 를 값으로 비교하는 커스텀 비교자를 쓴다. */
function graphEdgePropsEqual(
  prev: EdgeProps<Edge<CustomEdgeData>>,
  next: EdgeProps<Edge<CustomEdgeData>>,
): boolean {
  return (
    prev.id === next.id &&
    prev.source === next.source &&
    prev.target === next.target &&
    prev.sourceX === next.sourceX &&
    prev.sourceY === next.sourceY &&
    prev.targetX === next.targetX &&
    prev.targetY === next.targetY &&
    shallowEqual(prev.style, next.style) &&
    shallowEqual(prev.data, next.data)
  );
}

const GraphEdgeComponent = memo(function GraphEdgeComponent({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  style,
  data,
}: EdgeProps<Edge<CustomEdgeData>>) {
  const [localHovered, setLocalHovered] = useState(false);
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);

  const sourceWidth = sourceNode?.measured?.width ?? sourceNode?.width ?? 0;
  const sourceHeight = sourceNode?.measured?.height ?? sourceNode?.height ?? 0;
  const targetWidth = targetNode?.measured?.width ?? targetNode?.width ?? 0;
  const targetHeight = targetNode?.measured?.height ?? targetNode?.height ?? 0;

  const sx = sourceNode?.internals?.positionAbsolute
    ? sourceNode.internals.positionAbsolute.x + sourceWidth / 2
    : sourceX;
  const sy = sourceNode?.internals?.positionAbsolute
    ? sourceNode.internals.positionAbsolute.y + sourceHeight / 2
    : sourceY;
  const tx = targetNode?.internals?.positionAbsolute
    ? targetNode.internals.positionAbsolute.x + targetWidth / 2
    : targetX;
  const ty = targetNode?.internals?.positionAbsolute
    ? targetNode.internals.positionAbsolute.y + targetHeight / 2
    : targetY;

  const [edgePath, labelX, labelY] = getStraightPath({
    sourceX: sx,
    sourceY: sy,
    targetX: tx,
    targetY: ty,
  });

  const isHovered = data?.hovered || localHovered;
  const isBacklink = data?.edge.kind === "backlink";

  return (
    <>
      {/* 2026-08-20 오너: 컷 트리거 정리 — 클릭 컷은 호버 ✕ 버튼 하나만. 수식키+클릭 컷은
          Alt(레이저 모드 키)와 겹쳐 실수 절단을 만들어 제거했다. */}
      <g
        onMouseEnter={() => setLocalHovered(true)}
        onMouseLeave={() => setLocalHovered(false)}
        style={{ cursor: "inherit" }}
      >
        <BaseEdge
          id={id}
          path={edgePath}
          style={style}
          interactionWidth={24}
          /* 그리기 애니메이션이 엣지 길이와 무관하게 0→1 로 진행하도록 정규화한다. */
          pathLength={data?.justCreated ? 1 : undefined}
        />
      </g>
      {isHovered && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: "all",
              zIndex: "var(--z-overlay)",
            }}
            onMouseEnter={() => setLocalHovered(true)}
            onMouseLeave={() => setLocalHovered(false)}
          >
            {isBacklink ? (
              <button
                type="button"
                data-testid="graph-edge-cut"
                className="graph-edge-cut-btn"
                title={t("ctx.remove")}
                aria-label={t("ctx.remove")}
                onClick={(e) => {
                  e.stopPropagation();
                  if (data?.edge && data.onCut) {
                    data.onCut(data.edge);
                  }
                }}
              >
                <IconClose size={11} strokeWidth={2.2} />
              </button>
            ) : (
              <div
                data-testid="graph-edge-related-hint"
                className="graph-edge-related-hint"
              >
                {t("home.graph_related")}
              </div>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}, graphEdgePropsEqual);

const nodeTypes = { note: NoteNode };
const edgeTypes = { graphEdge: GraphEdgeComponent };

export function GraphCanvas({
  result,
  folders,
  selectedId,
  selectedIds,
  searchHits,
  highlightIds,
  justCreatedKeys,
  justCreatedPair,
  onSelect,
  onOpen,
  onConnectNote,
  onConnectMultipleNotes,
  onCreateNoteAndConnect,
  onCutEdge,
  onLaserActiveChange,
}: GraphCanvasProps) {
  const { fitView, flowToScreenPosition } = useReactFlow();
  const zoom = useStore((s) => (s.transform ? s.transform[2] : 1));
  const currentZoom = typeof zoom === "number" && zoom > 0 ? zoom : 1;
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [laserPoints, setLaserPoints] = useState<{ x: number; y: number }[] | null>(null);
  // 궤적의 진짜 소유자 — state 는 렌더용 복사본이다(handlePointerMove 주석 참조).
  const laserPointsRef = useRef<{ x: number; y: number }[] | null>(null);
  // 포인터 핸들러가 이벤트 시점에 읽는 최신 노드 좌표. baseNodes memo 가 핸들러보다 아래에 있어
  // ref 로 건넨다(렌더 중 대입이 아니라 effect 에서 동기화 — concurrent 안전).
  const nodePosRef = useRef<GraphFlowNode[]>([]);
  const [isKnifeMode, setIsKnifeMode] = useState(false);
  const isKnifeModeRef = useRef(false);
  const [connectState, setConnectState] = useState<{ activeNodeId: string; sources: string[] } | null>(null);
  const connectStateRef = useRef<{ activeNodeId: string; sources: string[] } | null>(null);
  const [pointerCanvasPos, setPointerCanvasPos] = useState<{ x: number; y: number } | null>(null);
  const [cutBursts, setCutBursts] = useState<Array<{ id: string; x: number; y: number }>>([]);
  const cutEdgesInStrokeRef = useRef<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement>(null);
  // 이전 렌더의 노드별 data 참조 — reuseGraphNodeData 가 값이 안 바뀐 노드의 참조를 재사용하도록
  // 여기서 읽는다. 렌더 중에는 **읽기만** 하고, 실제 동기화는 아래 nodes 이펙트에서 한다
  // (nodePosRef 주석과 동일 이유: 렌더 중 대입은 concurrent 에 안전하지 않다).
  const prevNodeDataRef = useRef<Map<string, GraphNodeData>>(new Map());

  const triggerCutBurst = useCallback((x: number, y: number) => {
    const burstId = randomId("burst");
    setCutBursts((prev) => [...prev, { id: burstId, x, y }]);
    setTimeout(() => {
      setCutBursts((prev) => prev.filter((b) => b.id !== burstId));
    }, 550);
  }, []);

  // 레이저 컷 트리거는 하나만: Alt 홀드 + 좌클릭 드래그 (2026-08-20 오너 — "여러 행위에서
  // 발현" 정리). Meta(Windows 키)는 시작 메뉴와 충돌해서 뺐고, Alt 홀드 중에는 아래 ReactFlow
  // 의 panOnDrag 를 꺼서 패닝과 레이저가 동시에 도는 겹침도 없앴다.
  useEffect(() => {
    const handleKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Alt") {
        isKnifeModeRef.current = true;
        setIsKnifeMode(true);
      }
    };
    const handleKeyUp = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Alt") {
        isKnifeModeRef.current = false;
        setIsKnifeMode(false);
      }
    };
    // Alt+Tab 등으로 keyup 을 놓치면 모드가 끼인 채 남는다 — 창 블러에서 강제 해제.
    const handleBlur = () => {
      isKnifeModeRef.current = false;
      setIsKnifeMode(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  // 스트로크 시작/종료를 한 쌍의 함수로 모은다 — 해제 경로가 셋(버튼 놓침 가드·컨테이너
  // pointerup·window 안전망)이라 흩어두면 하나가 빠진다. 종료 통보(onLaserActiveChange)는
  // GraphTab 이 "스트로크 도중에는 그래프를 다시 안 그린다"를 지키는 근거다.
  const armLaser = useCallback((pt: Pt) => {
    laserPointsRef.current = [pt];
    setLaserPoints([pt]);
    cutEdgesInStrokeRef.current.clear();
    onLaserActiveChange?.(true);
  }, [onLaserActiveChange]);

  const disarmLaser = useCallback(() => {
    if (!laserPointsRef.current) return;
    laserPointsRef.current = null;
    setLaserPoints(null);
    cutEdgesInStrokeRef.current.clear();
    onLaserActiveChange?.(false);
  }, [onLaserActiveChange]);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button === 0 && (isKnifeMode || isKnifeModeRef.current || e.altKey)) {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        armLaser({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      }
    }
  }, [armLaser, isKnifeMode]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const pt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (connectState || connectStateRef.current) {
        setPointerCanvasPos(pt);
      }
    }

    // 기하는 **ref** 로 판단한다. pointermove 는 리렌더보다 훨씬 자주 발화하므로 state 의
    // laserPoints 를 읽으면 lastPt 가 여러 이벤트 동안 옛 점에 머문다 — 판정 선분이 실제 손놀림
    // 보다 길게 늘어나 엉뚱한 엣지를 자르고, 버스트도 커서에서 멀리 떨어진 곳에 찍혔다
    // (2026-08-20 오너: "잘리는 위치가 랜덤 등장"). state 는 궤적 렌더 용도로만 남긴다.
    const points = laserPointsRef.current;
    if (!points || points.length === 0 || !containerRef.current) return;

    // 버튼을 놓은 뒤에도 스트로크가 살아 있으면, 이후의 평범한 마우스 이동이 지나가는 링크를
    // 계속 잘라 "아무 데서나 컷이 튀어나오는" 것처럼 보인다. pointerup 을 놓치는 경로(창 밖에서
    // 릴리즈, 드래그 중 Alt 해제로 pane 이 포인터를 가져가는 경우 등)가 실제로 있으므로, 모든
    // move 가 지나가는 이 지점에서 버튼 상태로 한 번에 막는다.
    if (e.buttons === 0) {
      disarmLaser();
      return;
    }

    const rect = containerRef.current.getBoundingClientRect();
    const newPt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    const lastPt = points[points.length - 1]!;
    points.push(newPt);
    setLaserPoints([...points]);

    const centres = new Map<string, Pt>();
    for (const n of nodePosRef.current) {
      const p = flowToScreenPosition({ x: n.position.x + NODE_HALF, y: n.position.y + NODE_HALF });
      centres.set(n.id, { x: p.x - rect.left, y: p.y - rect.top });
    }

    for (const edge of result.edges) {
      if (edge.kind !== "backlink") continue;
      // 방향 무관 키 — refetch 사이에 source/target 이 뒤집혀도 한 스트로크에서 두 번 자르지 않는다.
      const edgeKey = pairKey(edge.source, edge.target);
      if (cutEdgesInStrokeRef.current.has(edgeKey)) continue;

      const p1 = centres.get(edge.source);
      const p2 = centres.get(edge.target);
      if (!p1 || !p2) continue;

      const hit = segmentIntersection(lastPt, newPt, p1, p2);
      if (hit) {
        cutEdgesInStrokeRef.current.add(edgeKey);
        triggerCutBurst(hit.x, hit.y); // 잘린 바로 그 지점
        onCutEdge?.(edge);
      }
    }
  }, [connectState, disarmLaser, flowToScreenPosition, onCutEdge, result.edges, triggerCutBurst]);

  // pointerup 을 놓쳐도 스트로크가 반드시 끝나도록 하는 안전망(위 buttons 가드의 짝).
  useEffect(() => {
    window.addEventListener("pointerup", disarmLaser);
    window.addEventListener("pointercancel", disarmLaser);
    window.addEventListener("blur", disarmLaser);
    return () => {
      window.removeEventListener("pointerup", disarmLaser);
      window.removeEventListener("pointercancel", disarmLaser);
      window.removeEventListener("blur", disarmLaser);
    };
  }, [disarmLaser]);

  const handlePointerUp = useCallback(() => {
    disarmLaser();
  }, [disarmLaser]);

  const handleConnectStart = useCallback(
    (_: any, params: { nodeId: string | null; handleType: string | null }) => {
      if (!params.nodeId) return;
      const activeId = params.nodeId;
      const sources =
        selectedIds && selectedIds.size > 1
          ? selectedIds.has(activeId)
            ? Array.from(selectedIds)
            : [activeId, ...Array.from(selectedIds)]
          : [activeId];
      const nextState = { activeNodeId: activeId, sources };
      connectStateRef.current = nextState;
      setConnectState(nextState);
    },
    [selectedIds],
  );

  const handleConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent) => {
      const targetEl = event.target as HTMLElement | null;
      const isNode = targetEl?.closest(".react-flow__node");
      const isHandle = targetEl?.classList.contains("react-flow__handle");

      const curState = connectStateRef.current ?? connectState;
      if (!isNode && !isHandle && curState && onCreateNoteAndConnect) {
        onCreateNoteAndConnect(curState.sources, pointerCanvasPos || undefined);
      }

      setTimeout(() => {
        connectStateRef.current = null;
        setConnectState(null);
      }, 0);
      setPointerCanvasPos(null);
    },
    [connectState, onCreateNoteAndConnect, pointerCanvasPos],
  );

  const colors = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder.color_hue == null ? "var(--muted)" : folderColorCss(folder.color_hue)])),
    [folders],
  );
  // 갱신마다 fresh 레이아웃을 계산하되 stabilizePositions(v2) 로 걸러 적용한다 — 기존 노드는
  // 제자리, 고립→연결 전환 노드만 파트너 곁으로 이동(그 이동을 .react-flow__node 의 transform
  // 0.65s 트랜지션이 애니메이션한다). 함수 헤더 주석에 왜 fresh 좌표를 그대로 쓰면 안 되는지
  // (인덱스 기반 좌표 → 전면 뒤섞임) 적혀 있다.
  const rawNodes = useMemo(() => {
    const fresh = constellationNodes(result.nodes, (id) => colors.get(id) ?? "var(--muted)", result.edges);
    return stabilizePositions(fresh, result.edges);
  }, [colors, result.edges, result.nodes]);

  const baseNodes = useMemo(() => {
    // declutter 는 위치 확정 뒤에, 현재 줌(zoom) 배율의 화면 좌표계 기준으로 평가한다.
    // 줌 변경이나 시뮬레이션 안정화 후 줌 조정 시 실시간으로 재계산되어 겹치는 라벨을 숨긴다.
    return declutterLabels(rawNodes, currentZoom);
  }, [rawNodes, currentZoom]);

  const focusedIds = useMemo(() => {
    if (!selectedId && (!selectedIds || selectedIds.size === 0)) {
      return highlightIds && highlightIds.size > 0 ? highlightIds : null;
    }
    const ids = new Set(selectedIds ? Array.from(selectedIds) : selectedId ? [selectedId] : []);
    for (const edge of result.edges) {
      if (ids.has(edge.source)) ids.add(edge.target);
      if (ids.has(edge.target)) ids.add(edge.source);
    }
    return ids;
  }, [highlightIds, result.edges, selectedId, selectedIds]);

  const selectedArray = useMemo(() => (selectedIds ? Array.from(selectedIds) : []), [selectedIds]);

  const nodes = useMemo(() => {
    const prevData = prevNodeDataRef.current;
    return baseNodes.map((node) => {
      const searchDim = searchHits !== null && !searchHits.has(node.id);
      const searchHit = searchHits !== null && searchHits.has(node.id);
      const selectDim = focusedIds !== null && !focusedIds.has(node.id);
      const isJustConnected = isNodeJustConnected(node.id, justCreatedKeys, justCreatedPair);
      const isSelected = (selectedIds && selectedIds.has(node.id)) || node.id === selectedId;
      const selectionIndex = selectedArray.length > 1 && isSelected ? selectedArray.indexOf(node.id) + 1 : undefined;

      const nextData: GraphNodeData = {
        ...node.data,
        searchDim,
        searchHit,
        justConnected: isJustConnected,
        selectionIndex,
      };

      return {
        ...node,
        className: [
          searchDim || selectDim ? "graph-flow-node--dimmed" : "",
          isJustConnected ? "graph-node--just-connected" : "",
        ].filter(Boolean).join(" ") || undefined,
        selected: isSelected,
        // 이 노드 자신의 검색/선택/포커스/방금연결 소속이 안 바뀌었으면 이전 data 참조를 그대로
        // 재사용한다(reuseGraphNodeData) — React.memo(NoteNode) 가 얕은비교로 bail-out 하려면
        // data 참조 안정성이 필요하다. 안 하면 selectedId/selectedIds/searchHits/focusedIds 중
        // 하나만 바뀌어도 이 map 이 전 노드의 data 를 새 객체로 만들어 전부 다시 렌더된다.
        data: reuseGraphNodeData(prevData.get(node.id), nextData),
      };
    });
  }, [baseNodes, focusedIds, searchHits, selectedId, selectedIds, selectedArray, justCreatedKeys, justCreatedPair]);

  // nodes 계산에 쓴 prevNodeDataRef 를 커밋 후 최신 data 로 동기화한다 — 렌더 중 대입이 아니라
  // 이펙트에서(concurrent 안전, nodePosRef 주석과 동일 원칙).
  useEffect(() => {
    const map = new Map<string, GraphNodeData>();
    for (const node of nodes) map.set(node.id, node.data);
    prevNodeDataRef.current = map;
  }, [nodes]);

  const handleCutEdgeInternal = useCallback((edge: DashboardGraphEdge) => {
    if (containerRef.current) {
      const srcEl = containerRef.current.querySelector(`.react-flow__node[data-id="${edge.source}"]`);
      const tgtEl = containerRef.current.querySelector(`.react-flow__node[data-id="${edge.target}"]`);
      if (srcEl && tgtEl) {
        const sR = srcEl.getBoundingClientRect();
        const tR = tgtEl.getBoundingClientRect();
        const cR = containerRef.current.getBoundingClientRect();
        const mx = (sR.left + sR.right + tR.left + tR.right) / 4 - cR.left;
        const my = (sR.top + sR.bottom + tR.top + tR.bottom) / 4 - cR.top;
        triggerCutBurst(mx, my);
      }
    }
    onCutEdge?.(edge);
  }, [onCutEdge, triggerCutBurst]);

  // 최신 좌표를 포인터 핸들러(레이저)에 넘긴다 — 선언 순서상 ref 경유(nodePosRef 주석 참조).
  useEffect(() => {
    nodePosRef.current = baseNodes;
  }, [baseNodes]);

  // 다중드래그 와이어의 출발점 — 활성 노드는 React Flow 가 직접 그리므로 뺀다. DOM 조회 없이
  // flow 좌표에서 바로 계산한다(GraphMultiDragOverlay 헤더 주석 참조).
  const multiDragSources = useMemo(() => {
    if (!connectState || connectState.sources.length <= 1 || !containerRef.current) return [];
    const rect = containerRef.current.getBoundingClientRect();
    const byId = new Map(baseNodes.map((n) => [n.id, n]));
    return connectState.sources.flatMap((id) => {
      if (id === connectState.activeNodeId) return [];
      const node = byId.get(id);
      if (!node) return [];
      const p = flowToScreenPosition({ x: node.position.x + NODE_HALF, y: node.position.y + NODE_HALF });
      return [{ id, x: p.x - rect.left, y: p.y - rect.top }];
    });
    // pointerCanvasPos: 드래그 중 매 프레임 갱신되므로, 뷰포트가 팬/줌 되어도 출발점이 따라온다.
  }, [baseNodes, connectState, flowToScreenPosition, pointerCanvasPos]);

  const edges = useMemo(
    () => graphEdges(result.edges, selectedId, searchHits, colors, result.nodes, hoveredEdgeId, hoveredNodeId, justCreatedKeys, justCreatedPair, handleCutEdgeInternal),
    [colors, result.edges, result.nodes, searchHits, selectedId, hoveredEdgeId, hoveredNodeId, justCreatedKeys, justCreatedPair, handleCutEdgeInternal],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      if (connection.source === connection.target) return; // Ignore self-loops

      const curState = connectStateRef.current ?? connectState;
      const sources =
        curState?.sources && curState.sources.length > 0
          ? curState.sources
          : [connection.source];

      const validSources = sources.filter((src) => {
        if (!src || src === connection.target) return false;
        const backlinkExists = result.edges.some(
          (e) =>
            e.kind === "backlink" &&
            ((e.source === src && e.target === connection.target) ||
             (e.source === connection.target && e.target === src)),
        );
        return !backlinkExists;
      });

      if (validSources.length === 0) return;

      if (onConnectMultipleNotes) {
        onConnectMultipleNotes(validSources, connection.target);
      } else if (onConnectNote) {
        for (const src of validSources) {
          onConnectNote(src, connection.target);
        }
      }
    },
    [onConnectNote, onConnectMultipleNotes, result.edges, connectState],
  );

  // Fit view ONLY on initial mount (duration 0).
  // Connecting/cutting notes keeps the camera fixed at user's current zoom/pan so nodes never jump out of the viewport.
  const hasMountedRef = useRef(false);
  useEffect(() => {
    if (baseNodes.length === 0) return;
    if (hasMountedRef.current) return;
    hasMountedRef.current = true;
    const frame = requestAnimationFrame(() => {
      setTimeout(() => {
        void fitView({ padding: 0.28, maxZoom: 1.1, duration: 0 });
      }, 0);
    });
    return () => cancelAnimationFrame(frame);
  }, [baseNodes, fitView]);

  return (
    <div
      ref={containerRef}
      className={`graph-canvas-container ${isKnifeMode ? "graph-canvas--knife-mode" : ""}`}
      style={{ position: "relative", width: "100%", height: "100%" }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionMode={ConnectionMode.Loose}
        connectionLineStyle={{
          stroke: "var(--accent)",
          strokeWidth: 1.5,
          strokeDasharray: "4 3",
        }}
        nodesDraggable={false}
        panOnDrag={!isKnifeMode}
        // 핸들이 노드 전면을 덮고 있어서(.graph-note-node .react-flow__handle { inset: 0 }) 나이프
        // 모드로 노드 위에서 드래그를 시작하면 레이저와 **연결 드래그가 동시에** 걸렸다. 그대로
        // 빈 캔버스에 놓으면 컷과 함께 새 노트까지 만들어져(handleConnectEnd) 그래프가 요동친다.
        nodesConnectable={!isKnifeMode}
        minZoom={0.25}
        maxZoom={1.5}
        fitView
        fitViewOptions={{ padding: 0.28, maxZoom: 1.1 }}
        onConnect={handleConnect}
        onConnectStart={handleConnectStart}
        onConnectEnd={handleConnectEnd}
        onEdgeMouseEnter={(_, edge) => setHoveredEdgeId(edge.id)}
        onEdgeMouseLeave={(_, edge) => {
          setHoveredEdgeId((prev) => (prev === edge.id ? null : prev));
        }}
        onNodeMouseEnter={(_, node) => setHoveredNodeId(node.id)}
        onNodeMouseLeave={() => setHoveredNodeId(null)}
        onNodeClick={(e, node) => onSelect(node.id, e.shiftKey || e.ctrlKey || e.metaKey)}
        onNodeDoubleClick={(_, node) => onOpen(node.id)}
        onPaneClick={() => onSelect("")}
        proOptions={{ hideAttribution: true }}
      />
      <GraphLaserOverlay laserPoints={laserPoints} />
      <GraphMultiDragOverlay sources={multiDragSources} pointerCanvasPos={pointerCanvasPos} />
      <GraphCutBurstsOverlay cutBursts={cutBursts} />
    </div>
  );
}
