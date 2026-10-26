/**
 * FlowCanvas — the React Flow render/manipulate layer for a structured flowchart, and (since the
 * 2026-09-04 JSON IR rebuild, commit 88195857) the ONLY diagram renderer left in the app.
 *
 * HISTORY: this file used to sit alongside DiagramCanvas, a mermaid-SVG renderer for diagram types
 * FlowCanvas couldn't draw (sequenceDiagram/mindmap, an unparseable connector). DiagramCanvas,
 * mermaidRender.ts and diagramSvgTarget.ts were all deleted in the JSON IR rebuild — the storage
 * format is now a JSON IR (diagramSchema.ts), which only models flowchart-shaped graphs, so there is
 * nothing left for a second renderer to draw. `canFlowRender` (flowLayout.ts) no longer picks between
 * two renderers; it now gates the toolbar's interactive zoom/pan controls, and this component itself
 * renders the malformed-JSON error state too (see the `error` prop) rather than falling back to a
 * different component. Before the rebuild, mermaid owned every coordinate, so there was no pixel
 * dragging and boxes went wherever the auto-layout put them. Now the user can place a box, and where
 * they put it is remembered — as a `pos: [x, y]` field on the node in the JSON IR.
 * The underlying CONTRACT survived the format swap even though the bytes
 * didn't: it is still one string per section, still what FTS/sync/backup/the AI presets read. A
 * coordinate is one more structured field riding along, exactly like the node's own `link`.
 *
 * WHAT DID NOT CHANGE, and must not:
 *  • Every gesture is still ONE diagramModel mutation handed to DiagramSection's single write path
 *    (`actions.*` → applyMutation → one 되돌리기 step + debounced save). This file never
 *    string-appends onto the JSON source by hand.
 *  • Every bubble item and every mobile-sheet verb calls the same `actions.*` function, so "삭제"
 *    never becomes two things. (The node bubble is deliberately a shorter list than the phone sheet
 *    since 2026-10-19 — GRILL R6; connecting is the border-handle drag below, not a verb.)
 *  • `Selection` is unchanged (`{kind:'node',id}` / `{kind:'edge',line,hop}`), so diagramActions,
 *    DiagramControls and the AI bridge all keep working with no translation layer.
 *
 * Positions are optional data, never required: a node with no `pos` line is laid out by dagre
 * (flowLayout.ts). That is what keeps an AI-generated diagram tidy on first paint and what makes
 * 자동 정렬 a one-press, one-undo-step reset.
 *
 * PLACEMENT AIDS (2026-08-12) all obey the same one-write rule: drags snap to SNAP_GRID, and a
 * multi-selection (React Flow's own Shift-box / Ctrl-click — nothing custom) gets a 정렬/분배 bar
 * whose arithmetic is flowLayout's pure alignPositions/distributePositions and whose result is ONE
 * setNodePositions. PNG 내보내기 lives in flowPng.ts, including where the file lands and why.
 *
 * OVERLAY PLACEMENT RULE, learned the hard way: a `<Panel>` lives INSIDE the flow container and is
 * CLIPPED BY THE STAGE — a bottom-anchored one gets sliced off at the canvas's bottom edge. Anything
 * that belongs to a SELECTION hangs off a body-portal bubble (bubbles/DiagramBubble) measured from a
 * client rect instead; only the fixed corner furniture (Controls, MiniMap, the top-right tools)
 * stays in a Panel, where the corner it sits in is the whole point.
 *
 * SUBGRAPHS (2026-08-12, READ-ONLY) are drawn as React Flow parent nodes. Two coordinate systems
 * meet here and only here:
 *   • the SOURCE is always ABSOLUTE — `%% brise:pos` never stores a parent-relative number, so a
 *     node's coordinate means the same thing whether or not it is ever grouped;
 *   • React Flow wants a CHILD's position RELATIVE to its parent.
 * The conversion lives at this boundary (`toRelative` / the drag handler's inverse) and nowhere
 * else. A group's own rectangle is DERIVED from its members (flowLayout.groupBoxes), so it is not
 * stored at all and dragging one is just a translation written across its members in ONE batch.
 *
 * GROUP VERBS (2026-08-12) make the frame a real subject: it is selectable, it carries a bubble
 * (이름 변경 / 그룹 해제 — no 삭제, see verbs.tsx), a multi-selection can be turned into one, and
 * dropping a box inside a frame moves it in. That last gesture writes TWO things — a coordinate and
 * a membership — and they go through ONE `setNodePositions` call so the drop stays one 되돌리기
 * press, exactly like every other gesture here.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
} from "react";
import {
  Background,
  ConnectionLineType,
  ConnectionMode,
  Controls,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  ViewportPortal,
  type Connection,
  type Edge,
  type EdgeTypes,
  type FitViewOptions,
  type NodeTypes,
  type OnConnectEnd,
  type OnNodeDrag,
  type OnReconnect,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { t } from "../../i18n/t";
import { emitNotice } from "../../lib/invoke";
import { fetchNoteSummariesMap } from "../../lib/noteSummaries";
import type { DiagramModel } from "./diagramModel";
import type { DiagramActions, Selection } from "./diagramActions";
import { useDiagramGestures } from "./diagramGestures";
import type { DiagramCanvasApi } from "./diagramCanvasApi";
import {
  layoutFor,
  quadrantAxes,
  groupBoxes,
  groupMembers,
  layoutPositions,
  nodeSize,
  nodeSizes,
  NODE_H,
  NODE_W,
  type LayoutBox,
  type XY,
} from "./flowLayout";
import { exportFlowPngAttachment, exportFlowPngToFile } from "./flowPng";
import { type Rect } from "./flowEdgePath";
import { ARROW_ID, buildFlowEdges, buildFlowGroups, buildObstacles } from "./flowElements";

// canFlowRender now LIVES in flowLayout.ts (no React, no @xyflow import) — DiagramSection needs the
// answer before it decides whether to even lazy-load this file, so it cannot import it from here.
// Re-exported so this file's own test (FlowCanvas.test.tsx) keeps its existing import line.
export { canFlowRender } from "./flowLayout";
import {
  useFlowInlineEdit,
  InlineEditCtx,
  type InlineEdit,
  type InlineEditContextValue,
} from "./useFlowInlineEdit";
import { useFlowKeybindings } from "./useFlowKeybindings";

import { DiagramFinder } from "./DiagramFinder";

import { DiagramLegend, type DiagramLegendProps } from "./DiagramLegend";
import { DiagramReachBanner, type DiagramReachBannerProps } from "./DiagramReachBanner";
import { useDiagramReader, type DiagramReaderMode } from "./useDiagramReader";
import { BriseFlowNode, type BriseNode, type BriseNodeData } from "./FlowNode";
import { BriseFlowGroup, type BriseGroupNode, GROUP_PREFIX, groupNodeId } from "./FlowGroup";
import { BriseFlowEdge, strokeOf } from "./FlowEdge";
import { DiagramInlineInput } from "./DiagramInlineInput";
import { DiagramFloatingBubble } from "./DiagramFloatingBubble";

export {
  InlineEditCtx,
  type InlineEditContextValue,
  type InlineEdit,
  DiagramLegend,
  type DiagramLegendProps,
  DiagramReachBanner,
  type DiagramReachBannerProps,
  useDiagramReader,
  type DiagramReaderMode,
  BriseFlowNode,
  type BriseNode,
  type BriseNodeData,
  BriseFlowGroup,
  type BriseGroupNode,
  GROUP_PREFIX,
  groupNodeId,
  BriseFlowEdge,
  strokeOf,
};

export type BriseAnyNode = BriseNode | BriseGroupNode;

export const edgeId = (e: { id: string }): string => e.id;

// Module scope, not a useMemo: React Flow warns (and remounts every node) if this object identity
// changes between renders.
const nodeTypes: NodeTypes = { brise: BriseFlowNode, briseGroup: BriseFlowGroup };
const edgeTypes: EdgeTypes = { brise: BriseFlowEdge };

/** Drag snapping. HALF the Background dot spacing (gap={20}) on purpose: every second stop lands
 *  exactly on a dot, so the grid is a readable ruler rather than decoration, and the in-between
 *  stop is still there for the tighter nudge. Only DRAGS snap — dagre's own numbers and any
 *  coordinate already in a note's source are untouched (this is not a migration). */
const SNAP_GRID: [number, number] = [10, 10];

/** Stable empty set — a fresh `new Set()` per render would re-run every memo that depends on it. */
const NO_IDS: ReadonlySet<string> = new Set<string>();

/**
 * Below this many boxes the MiniMap is not drawn at all.
 *
 * ponytail: a flat threshold, no measuring. Owner screenshot 2026-08-12 — a five-node diagram whose
 * whole graph is on screen at once, with the minimap eating the bottom-right corner to show a
 * shrunk copy of exactly what was already visible. A minimap earns its corner only when there is
 * something off-screen to point at, and node count is the cheap proxy for that. 12 is roughly where
 * dagre's default layout stops fitting a panel-sized viewport at 1× — it is a taste number, not a
 * measurement. Upgrade path if it ever feels wrong: compare the graph's bounding box against the
 * viewport (useReactFlow's getNodesBounds + the flow's own rect) and show it when it overflows.
 */
const MINIMAP_MIN_NODES = 12;

/**
 * 범례 알약(DiagramLegend)이 열려 있을 때 그래프 **전체** 맞춤이 위쪽에 비워 두는 띠(px).
 *
 * 알약은 캔버스 위에 떠 있는 오버레이라(캔버스 높이를 먹지 않는다) 기본 fitView 패딩(뷰포트의 몇 %)만 주면 맨 위
 * 상자가 알약 밑으로 들어갔다(2026-10-18 화면 보드 12-note-diagram — "상자 4 · 관계 6 | …" 가 맨 위 노드를 덮음).
 * 숫자 = 알약 자리 `.diagram-canvas-float{top:var(--space-4)}`(10px) + 알약 한 줄 ≈ 34px + 숨 쉴 틈 12px.
 * 34px 는 tokens.css 의 `.diagram-flow-legend ~ .diagram-reach-banner{top:calc(var(--space-4) + 34px)}` 와 같은 가정이다 —
 * 한쪽을 바꾸면 다른 쪽도 같이.
 *
 * ponytail: 고정값이다. 알약이 두 줄로 접히면(캔버스 폭이 알약 한 줄보다 좁을 때만 — `.diagram-canvas-float` 의
 * `width:max-content` 가 그 전까지는 한 줄을 지킨다) 이 띠를 넘는다. 업그레이드 경로 = 알약 요소의 실제 bottom 을
 * 재서(ResizeObserver) 넘기고, 첫 그리기는 `fitView` prop 대신 useNodesInitialized 뒤에 직접 맞춘다.
 */
export const LEGEND_FIT_TOP_PX = 56;

/** React Flow 가 옵션 없이 fitView 할 때 쓰는 패딩(뷰포트 비율) — 첫 그리기·Controls·툴바가 원래 쓰던 값. */
const RF_DEFAULT_FIT_PADDING = 0.1;

/**
 * 그래프 전체를 맞출 때의 패딩. 범례가 열려 있으면 위쪽만 알약 띠(px)로 바꾸고 나머지 세 변은 원래 비율 그대로,
 * 닫혀 있으면 원래 비율 하나. 전체 맞춤은 **전부** 이걸 지난다 — 첫 그리기(`fitViewOptions`)·Controls 의 맞춤 버튼·
 * 툴바(api.fitView)·단축키. 선택/노드 확대(zoomToSelection·focusNode)는 대상이 가운데에 오므로 해당 없다.
 */
export function wholeGraphFitPadding(
  legendOpen: boolean,
  base: number = RF_DEFAULT_FIT_PADDING,
): NonNullable<FitViewOptions["padding"]> {
  return legendOpen ? { top: `${LEGEND_FIT_TOP_PX}px`, x: base, bottom: base } : base;
}

function handlePositions(direction: DiagramModel["direction"]): { source: Position; target: Position } {
  if (direction === "LR") return { source: Position.Right, target: Position.Left };
  if (direction === "RL") return { source: Position.Left, target: Position.Right };
  if (direction === "BT") return { source: Position.Top, target: Position.Bottom };
  return { source: Position.Bottom, target: Position.Top };
}

/** React Flow child node position -> canvas absolute LayoutBox conversion.
 *  모듈 스코프 순수 함수다 — 예전에는 컴포넌트 본문 한가운데에 들여쓰기 0 으로 박혀 있어 최상위처럼
 *  보였지만 실제로는 FlowCanvasInner 안에 중첩돼 있었다. 클로저 값은 쓰지 않는다(`boxes` 는 인자). */
function nodeToAbsoluteBox(
  n: { id: string; position: { x: number; y: number }; width?: number; height?: number; parentId?: string },
  boxes: Record<string, Rect>
): LayoutBox {
  const origin = n.parentId ? boxes[n.parentId.slice(GROUP_PREFIX.length)] : undefined;
  return {
    id: n.id,
    x: n.position.x + (origin?.x ?? 0),
    y: n.position.y + (origin?.y ?? 0),
    width: n.width ?? NODE_W,
    height: n.height ?? NODE_H,
  };
}

export interface FlowCanvasProps {
  model: DiagramModel;
  selection: Selection;
  onSelect: (s: Selection) => void;
  actions: DiagramActions;
  onEditSource: () => void;
  canUndo: boolean;
  onUndo: () => void;
  canRedo: boolean;
  onRedo: () => void;
  /** Syntax error for the current source — fast check, and the one place this canvas ever shows
   *  only thing that tells the user their hand-typed source is broken. */
  error: string | null;
  bubbles?: boolean;
  pngBusy?: boolean;
  onSelectedBoxes?: (ids: string[]) => void;
  initialSelectedBoxIds?: string[];
  apiRef?: MutableRefObject<DiagramCanvasApi | null>;
  locked?: boolean;
  onToggleLock?: () => void;
}

/** useReactFlow (screenToFlowPosition) needs a provider ABOVE the component that calls it, so the
 *  export wraps the real component. Props contract unchanged — callers see the same FlowCanvas. */
export function FlowCanvas(props: FlowCanvasProps) {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function FlowCanvasInner({
  model,
  selection,
  onSelect,
  actions,
  canUndo: _canUndo,
  onUndo: _onUndo,
  canRedo: _canRedo,
  onRedo: _onRedo,
  error,
  bubbles = true,
  pngBusy: controlledPngBusy,
  onSelectedBoxes,
  initialSelectedBoxIds,
  apiRef,
  locked: controlledLocked,
  onToggleLock: controlledToggleLock,
}: FlowCanvasProps) {
  const [localLocked, setLocalLocked] = useState(false);
  const locked = controlledLocked ?? localLocked;
  const toggleLock = controlledToggleLock ?? (() => setLocalLocked((v) => !v));
  const hostRef = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition, fitView, zoomIn, zoomOut } = useReactFlow();
  const {
    inline,
    openInline,
    closeInline,
    openRename,
    openAddNode,
    openRelabel,
    openGroupRename,
    commitInline,
  } = useFlowInlineEdit({ model, actions });
  const { clear, clickNode, clickOther, handleKey } =
    useDiagramGestures({
      model,
      selection,
      onSelect,
      actions,
      onUndo: _onUndo,
      onRedo: _onRedo,
    });

  // W2: 흐림(Dimming) 상태의 단일 소유자 (Single Owner)
  const {
    readerMode,
    setReaderMode,
    dimmedIds,
    toggleFilterState,
    toggleFilterFlag,
    hoveredTarget,
    setHoveredTarget,
    handleReach,
    clearReaderMode,
    handleReaderKeyDown,
  } = useDiagramReader({ model });

  const [legendOpen, setLegendOpen] = useState(true);
  /** 그래프 전체 맞춤 옵션 — 첫 그리기(ReactFlow `fitViewOptions`)와 Controls 의 맞춤 버튼이 받는다. 객체 정체성이
   *  렌더마다 바뀌지 않게 memo(React Flow 가 prop 을 스토어로 옮긴다). 범례 띠는 `wholeGraphFitPadding` 주석. */
  const wholeFitOptions = useMemo<FitViewOptions>(
    () => ({ padding: wholeGraphFitPadding(legendOpen) }),
    [legendOpen],
  );

  const handleCanvasKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (handleReaderKeyDown(e, Boolean(inline))) return;
    handleKey(e);
  };

  const [localPngBusy, setLocalPngBusy] = useState(false);
  const pngBusy = controlledPngBusy ?? localPngBusy;

  /**
   * BROKEN NOTE LINKS — which `%% brise:link` targets no longer exist, so the icon can be dimmed
   * BEFORE the click instead of the click producing an apology (openNote's fetchNoteSummary guard).
   *
   * ONE batched IPC (`note_summaries_map`, the same call fetchNoteSummary wraps), not one per node
   * and not one per render: the effect is keyed on the SET of linked note ids, so it re-runs when
   * a link is added/removed/repointed and at no other time.
   * ponytail: that key is also the whole cache-invalidation story. A note deleted or restored in
   * ANOTHER pane while this canvas is open keeps its stale answer until the section is remounted
   * (a note/tab switch already does that — this component is mounted per section) or a link is
   * edited. Getting it live would need a note-deleted event channel, which does not exist yet;
   * upgrade path is to subscribe to one here and drop the id from `missingNotes`.
   * A FAILED lookup leaves every link looking fine — an IPC hiccup must not paint the diagram
   * with a problem the user does not have.
   */
  const linkKey = model.nodes.map((n) => n.link).filter((l): l is string => !!l).sort().join(",");
  const [missingNotes, setMissingNotes] = useState<ReadonlySet<string>>(NO_IDS);
  useEffect(() => {
    const ids = linkKey ? linkKey.split(",") : [];
    if (!ids.length) return setMissingNotes(NO_IDS);
    let alive = true;
    void fetchNoteSummariesMap(ids)
      .then((found) => {
        if (alive) setMissingNotes(new Set(ids.filter((id) => !found[id])));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [linkKey]);

  const positions = useMemo(() => layoutPositions(model), [model]);
  /** Estimated from the label (flowLayout) rather than measured: dagre plans the gaps with the same
   *  numbers, so a long name widens its box AND the space reserved for it in one go. */
  const sizes = useMemo(() => nodeSizes(model), [model]);

  /** Every `subgraph`'s ABSOLUTE rectangle, derived from the members inside it. */
  const boxes = useMemo(() => groupBoxes(model, positions, sizes), [model, positions, sizes]);
  /** quadrant 의 축 십자 — 그룹 상자 4개에서 파생. 다른 배치면 null. */
  const axes = useMemo(() => quadrantAxes(model, boxes), [model, boxes]);
  /** sequence 의 메시지 선 y(`edgeAnchors`)와 라이프라인 아래 끝(`lifelineH`) — 배치 함수가 정한다. 다른 배치면 null.
   *  ponytail: 드래그된 노드의 라이프라인은 그 x 를 따라가지만 앵커 y 는 재계산하지 않는다(배치 결과 그대로). */
  const seq = useMemo(() => (model.layout === "sequence" ? layoutFor(model, sizes) : null), [model, sizes]);
  /** ABSOLUTE → the parent-relative number React Flow wants. The one conversion, stated once. */
  const toRelative = useMemo(
    () =>
      (at: XY, group: string | undefined): XY => {
        const box = group ? boxes[group] : undefined;
        return box ? { x: at.x - box.x, y: at.y - box.y } : at;
      },
    [boxes],
  );

  /** 그룹 안에 들어가는 모든 노드 — 그룹 노드의 `members` prop 용(산수는 flowLayout). */
  const membersOfGroup = useCallback((id: string): string[] => groupMembers(model, id), [model.groups, model.nodes]);

  const onSelectMembersRef = useRef<(memberIds: string[]) => void>(() => {});
  onSelectMembersRef.current = (memberIds: string[]) => {
    if (memberIds.length === 0) return;
    setNodes((current) =>
      current.map((n) => ({
        ...n,
        selected: memberIds.includes(n.id),
      }))
    );
    onSelectedBoxes?.(memberIds);
    if (memberIds.length === 1) {
      clickNode(memberIds[0]);
    } else {
      onSelect(null);
    }
  };

  const flowGroups = useMemo<BriseGroupNode[]>(
    () =>
      buildFlowGroups(model.groups, boxes, toRelative, selection, membersOfGroup, (mIds) =>
        onSelectMembersRef.current(mIds),
      ),
    [model.groups, boxes, toRelative, selection, membersOfGroup],
  );

  const flowNodes = useMemo<BriseAnyNode[]>(() => {
    const sides = handlePositions(model.direction);
    const inGroup = (n: (typeof model.nodes)[number]) => (n.group && boxes[n.group] ? n.group : undefined);
    return [
      ...flowGroups,
      ...model.nodes.map((n) => {
        const isDimmed = dimmedIds !== null && !dimmedIds.has(n.id);
        return {
          id: n.id,
          type: "brise" as const,
          position: toRelative(positions[n.id] ?? { x: 0, y: 0 }, inGroup(n)),
          ...(inGroup(n) ? { parentId: groupNodeId(n.group!) } : {}),
          ...(sizes[n.id] ?? { width: NODE_W, height: NODE_H }),
          selected: (selection?.kind === "node" && selection.id === n.id) || (initialSelectedBoxIds?.includes(n.id) ?? false),
          data: {
            label: n.label,
            shape: n.shape ?? "rect",
            // Read through the action: tone lives in diagramStyles' class lines, which are not part of
            // DiagramNode. `model` is a fresh object on every source change (including a tone edit), so
            // this memo re-runs exactly when it must.
            tone: actions.nodeTone(n.id),
            tag: n.tag,
            state: n.state,
            flag: n.flag,
            linked: !!n.link,
            linkBroken: !!n.link && missingNotes.has(n.link),
            icon: n.icon,
            desc: n.desc,
            rows: n.rows,
            dimmed: isDimmed,
            layout: model.layout,
            ...sides,
          },
        };
      }),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, positions, sizes, selection, flowGroups, boxes, toRelative, missingNotes, dimmedIds]);

  const obstacles = useMemo<Rect[]>(
    () => buildObstacles(model.nodes, positions, sizes),
    [model.nodes, positions, sizes],
  );

  const flowEdges = useMemo<Edge[]>(
    () => buildFlowEdges(model.edges, model.route, selection, dimmedIds, obstacles, seq),
    [model.edges, model.route, selection, dimmedIds, obstacles, seq],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<BriseAnyNode>(flowNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(flowEdges);
  // A MULTI-selection survives the re-projection; a single one is left exactly as it was. Without
  // this, the first 정렬 press rebuilds every node from `flowNodes` (whose `selected` comes from the
  // app's single `Selection`) and the set the user just picked evaporates — so "왼쪽 정렬 그리고
  // 가로 분배" would mean picking the same five boxes twice. `prev` is React Flow's own live truth
  // about what is picked, which is the only place a set is ever recorded (see selectedBoxes below).
  useEffect(() => {
    setNodes((prev) => {
      const picked = new Set(prev.filter((n) => n.selected).map((n) => n.id));
      return picked.size === 0 ? flowNodes : flowNodes.map((n) => (picked.has(n.id) ? { ...n, selected: true } : n));
    });
  }, [flowNodes, setNodes]);
  useEffect(() => setEdges(flowEdges), [flowEdges, setEdges]);

  /**
   * MULTI-SELECTION lives HERE, in React Flow's own node state, and is deliberately NOT in
   * `Selection`. That type is the contract diagramActions, DiagramControls, the mobile sheet and
   * the AI bridge all speak; widening it to "or a set" would make every one of them handle a case
   * only this canvas can produce. A box-drag (Shift + drag on empty canvas, React Flow's own
   * default) or Ctrl+click marks nodes selected in `nodes`, and that is the whole state — it dies
   * with the next pane click, exactly like the picture suggests.
   */
  const selectedBoxes = useMemo<LayoutBox[]>(
    () =>
      nodes
        // Groups are never selectable, but the filter is explicit: 정렬 writes `%% brise:pos` lines
        // and a group has none — a derived box has no coordinate to align.
        .filter((n) => n.selected && n.type === "brise")
        .map((n) => nodeToAbsoluteBox(n, boxes)),
    [nodes, boxes],
  );

  const selectedBoxIdsKey = useMemo(
    () => nodes.filter((n) => n.selected && n.type === "brise").map((n) => n.id).sort().join(","),
    [nodes],
  );
  const prevSelectedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevSelectedKeyRef.current === null) {
      prevSelectedKeyRef.current = selectedBoxIdsKey;
      if (selectedBoxIdsKey) {
        onSelectedBoxes?.(selectedBoxIdsKey.split(","));
      }
      return;
    }
    if (prevSelectedKeyRef.current !== selectedBoxIdsKey) {
      prevSelectedKeyRef.current = selectedBoxIdsKey;
      const ids = selectedBoxIdsKey ? selectedBoxIdsKey.split(",") : [];
      onSelectedBoxes?.(ids);
    }
  }, [selectedBoxIdsKey, onSelectedBoxes]);

  const selectedBoxIds = useMemo(
    () => nodes.filter((n) => n.selected && n.type === "brise").map((n) => n.id),
    [nodes],
  );

  const zoomToSelection = () => {
    const selectedNodes = nodes.filter((n) => n.selected);
    if (selectedNodes.length > 0) {
      /* type-scale-exempt: React Flow fitView's padding is a viewport-fraction API argument, not a CSS spacing value */
      fitView({ nodes: selectedNodes, duration: 250, padding: 0.3 });
    } else if (selection?.kind === "node") {
      /* type-scale-exempt: React Flow fitView's padding is a viewport-fraction API argument, not a CSS spacing value */
      fitView({ nodes: [{ id: selection.id }], duration: 250, padding: 0.3 });
    }
  };

  const { onKeyDown } = useFlowKeybindings({
    model,
    selection,
    selectedBoxIds,
    actions,
    openRename,
    // 단축키 맞춤은 원래 0.2 비율 — 범례 띠만 위쪽에 더한다(wholeGraphFitPadding).
    fitView: () => fitView({ duration: 250, padding: wholeGraphFitPadding(legendOpen, 0.2) }),
    zoomToSelection,
    handleKey: handleCanvasKey,
    locked,
  });

  // ── gestures ──────────────────────────────────────────────────────────────────────────────────
  /** Every node that ends up inside this group, however deeply nested. */
  const membersOf = (id: string): string[] => groupMembers(model, id);

  /** The INNERMOST frame whose rectangle contains this point — where a drop lands. Smallest area
   *  wins, which is nesting order without walking the parent chain. */
  const groupAt = (x: number, y: number): string | null => {
    let best: { id: string; area: number } | null = null;
    for (const [id, b] of Object.entries(boxes)) {
      if (x < b.x || x > b.x + b.width || y < b.y || y > b.y + b.height) continue;
      const area = b.width * b.height;
      if (!best || area < best.area) best = { id, area };
    }
    return best?.id ?? null;
  };

  /**
   * A drop is the ONLY thing that writes a coordinate. Multi-select drags arrive as one batch, so
   * they cost one 되돌리기 step, not one per box.
   *
   * A GROUP has no coordinate of its own — its frame is derived from what is inside it — so
   * dragging one is recorded as the same translation applied to every member. React Flow has
   * already moved the children on screen (their positions are relative to the frame, so they never
   * changed); this is what makes that visible move survive into the source.
   *
   * A BOX dropped inside a frame it does not belong to (or dragged out of its own) also changes
   * house. The frame's own drag is exempt: it carries its members with it, so nobody crossed a
   * border. Coordinates and membership go out together in ONE call = one 되돌리기 press.
   */
  const onNodeDragStop: OnNodeDrag<BriseAnyNode> = (_e, node, dragged) => {
    const batch: Record<string, { x: number; y: number }> = {};
    const moves: Record<string, string | null> = {};
    for (const n of dragged.length ? dragged : [node]) {
      if (n.type === "briseGroup") {
        const id = n.id.slice(GROUP_PREFIX.length);
        const box = boxes[id];
        if (!box) continue;
        const was = toRelative({ x: box.x, y: box.y }, model.groups.find((g) => g.id === id)?.parent ?? undefined);
        const dx = n.position.x - was.x;
        const dy = n.position.y - was.y;
        if (!dx && !dy) continue;
        for (const member of membersOf(id)) {
          const at = positions[member];
          if (at) batch[member] = { x: Math.round(at.x + dx), y: Math.round(at.y + dy) };
        }
        continue;
      }
      const origin = n.parentId ? boxes[n.parentId.slice(GROUP_PREFIX.length)] : undefined;
      const at = {
        x: Math.round(n.position.x + (origin?.x ?? 0)),
        y: Math.round(n.position.y + (origin?.y ?? 0)),
      };
      batch[n.id] = at;
      // The box's CENTRE decides, not its corner: a box straddling a border reads as belonging to
      // whichever side most of it is on, which is what the picture already suggests.
      const size = sizes[n.id] ?? { width: NODE_W, height: NODE_H };
      const into = groupAt(at.x + size.width / 2, at.y + size.height / 2);
      const was = model.nodes.find((m) => m.id === n.id)?.group ?? null;
      if (into !== was) moves[n.id] = into;
    }
    if (Object.keys(batch).length) {
      actions.setNodePositions(batch, Object.keys(moves).length ? moves : undefined);
    }
  };

  const onConnect = (c: Connection) => {
    if (!c.source || !c.target) return;
    const selectedIds = selectedBoxes.map((b) => b.id);
    if (selectedIds.length >= 2 && selectedIds.includes(c.source)) {
      actions.connectBatch(selectedIds, c.target, undefined, c.sourceHandle ?? undefined, c.targetHandle ?? undefined);
    } else {
      actions.connect(c.source, c.target, undefined, c.sourceHandle ?? undefined, c.targetHandle ?? undefined);
    }
  };

  /**
   * A connection line dropped on EMPTY canvas creates the node it was reaching for immediately
   * with default label "새 노드", selects it and opens inline rename editing for instant focus.
   */
  const onConnectEnd: OnConnectEnd = (event, connectionState) => {
    if (connectionState.isValid || connectionState.toNode || !connectionState.fromNode) return;
    const { clientX, clientY } = "changedTouches" in event ? event.changedTouches[0] : event;
    let flow: XY = { x: clientX ?? 0, y: clientY ?? 0 };
    try {
      if (typeof screenToFlowPosition === "function") {
        flow = screenToFlowPosition({ x: clientX ?? 0, y: clientY ?? 0 });
      }
    } catch {
      flow = { x: clientX ?? 0, y: clientY ?? 0 };
    }
    const defaultLabel = "새 노드";
    const size = nodeSize({ label: defaultLabel });
    const pos = {
      x: Math.round((flow.x || 0) - size.width / 2),
      y: Math.round((flow.y || 0) - size.height / 2),
    };

    const selectedIds = selectedBoxes.map((b) => b.id);
    const isMultiSource =
      selectedIds.length >= 2 && selectedIds.includes(connectionState.fromNode.id);

    if (isMultiSource) {
      const newNodeId = actions.addNode(defaultLabel, undefined, pos);
      if (newNodeId) {
        actions.connectBatch(selectedIds, newNodeId);
        openRename(newNodeId, defaultLabel);
      }
    } else {
      const newNodeId = actions.addConnected(connectionState.fromNode.id, defaultLabel, pos);
      if (newNodeId) {
        openRename(newNodeId, defaultLabel);
      }
    }
  };

  /**
   * Double clicking on EMPTY canvas creates a new node at the cursor position
   * and enters inline rename editing immediately.
   */
  const onPaneDoubleClick = (event: ReactMouseEvent) => {
    let flow: XY = { x: event.clientX ?? 0, y: event.clientY ?? 0 };
    try {
      if (typeof screenToFlowPosition === "function") {
        flow = screenToFlowPosition({ x: event.clientX ?? 0, y: event.clientY ?? 0 });
      }
    } catch {
      flow = { x: event.clientX ?? 0, y: event.clientY ?? 0 };
    }
    const defaultLabel = "새 노드";
    const size = nodeSize({ label: defaultLabel });
    const pos = {
      x: Math.round((flow.x || 0) - size.width / 2),
      y: Math.round((flow.y || 0) - size.height / 2),
    };
    const newNodeId = actions.addNode(defaultLabel, undefined, pos);
    if (newNodeId) {
      openRename(newNodeId, defaultLabel);
    }
  };

  /**
   * Dragging an arrow's END onto another box. Only ONE end moves per drag, so exactly one of the
   * two mutations fires — and both are the ordinary verbs, i.e. one 되돌리기 step like every other
   * gesture. A drop that makes `A --> A` is WRITTEN (2026-08-12): the canvas has always drawn a
   * self-loop, so refusing to create one only meant the picture could show what the UI could not
   * make. diagramModel refuses the real no-op (nothing moved) on its own.
   * ponytail: React Flow puts its grab anchors at the HANDLE, while the line now ends at the box's
   * BORDER — on a hand-arranged sideways relation those are not the same point, so the widened
   * `reconnectRadius` below is what keeps the two overlapping. Upgrade path if it ever feels off:
   * per-side handles picked from `positions`, which needs no change to the stored source.
   */
  const onReconnect: OnReconnect = (edge, c) => {
    if (!edge.id || !c.source || !c.target) return;
    if (c.source !== edge.source) actions.reparent(edge.id, c.source);
    else if (c.target !== edge.target) actions.retarget(edge.id, c.target);
  };

  const onNodeClick = (e: ReactMouseEvent, node: BriseAnyNode) => {
    // A frame is a subject of its own now (이름 변경 / 그룹 해제). Its click clears any armed
    // connection first, exactly like an edge click does — the frame is not a connection endpoint.
    if (node.type === "briseGroup") {
      clickOther({ kind: "group", id: node.id.slice(GROUP_PREFIX.length) });
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      setNodes((currentNodes) => {
        const nextNodes = currentNodes.map((n) => (n.id === node.id ? { ...n, selected: !n.selected } : n));
        const selected = nextNodes
          .filter((n) => n.selected && n.type === "brise")
          .map((n) => n.id);
        onSelectedBoxes?.(selected);
        return nextNodes;
      });
      return;
    }
    // 노트 열기 → 선택. 그 순서는 diagramGestures 가 소유한다
    setNodes((current) => current.map((n) => ({ ...n, selected: n.id === node.id })));
    onSelectedBoxes?.([]);
    clickNode(node.id);
  };

  const onEdgeClick = (_e: unknown, edge: Edge) => {
    if (!edge.id) return;
    clickOther({ kind: "edge", id: edge.id });
  };

  const onPaneClick = () => {
    clear();
    closeInline();
    setNodes((current) => current.map((n) => (n.selected ? { ...n, selected: false } : n)));
    onSelectedBoxes?.([]);
  };

  /** 자동 정렬 — `model.layout` 의 배치(없으면 dagre)로 EVERY node, written in one mutation so 되돌리기 puts the user's own
   *  arrangement back in a single press. */
  const autoLayout = () => actions.setNodePositions(layoutFor(model, sizes).positions);

  const arrange = (plan: (boxes: LayoutBox[]) => Record<string, XY>, ids?: string[]) => {
    const targetIds = ids && ids.length >= 2 ? new Set(ids) : null;
    const targets = targetIds
      ? nodes
          .filter((n) => targetIds.has(n.id) && n.type === "brise")
          .map((n) => nodeToAbsoluteBox(n, boxes))
      : selectedBoxes;
    if (targets.length < 2) return;
    const next = plan(targets);
    if (Object.keys(next).length) actions.setNodePositions(next);
  };

  /** PNG 내보내기 — two destinations, one raster (flowPng.ts owns both and emits their success
   *  notices, since only it knows the path/filename). This keeps only the failure half, so
   *  "nothing to export" and a thrown raster read the same, and it is shared by both buttons —
   *  the only difference between them is which `save` they hand over to. */
  const exportPng = async (save: typeof exportFlowPngToFile) => {
    const host = hostRef.current;
    if (!host || pngBusy) return;
    setLocalPngBusy(true);
    try {
      // The exported picture must not be a light-on-light or dark-on-dark blur: a transparent PNG
      // of the dark theme is unreadable anywhere it gets pasted, so the current canvas colour is
      // baked in as a real background.
      const background = getComputedStyle(host).getPropertyValue("--app-canvas").trim() || "#ffffff";
      const ok = await save(host, nodes, background);
      if (!ok) emitNotice(t("editor.diagram_export_png_failed"));
    } catch {
      emitNotice(t("editor.diagram_export_png_failed"));
    } finally {
      setLocalPngBusy(false);
    }
  };

  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = {
      addNode: openAddNode,
      openRename,
      openRelabel: (edge) => openRelabel(edge.id),
      openGroupRename,
      createGroup: (members) =>
        openInline({ kind: "createGroup", members, left: 16, top: 16 }),
      addFrame: () => {
        const targetIds =
          selectedBoxIds && selectedBoxIds.length > 0
            ? selectedBoxIds
            : selection?.kind === "node"
            ? [selection.id]
            : model.nodes.length > 0
            ? [model.nodes[0].id]
            : [];
        if (targetIds.length > 0) {
          actions.addGroup("새 프레임", targetIds);
        }
      },
      focusNode: (id) => {
        const targetNodeId = model.groups.some((g) => g.id === id) ? groupNodeId(id) : id;
        fitView({ nodes: [{ id: targetNodeId }], duration: 200 });
      },
      arrange: (plan, ids) => arrange(plan, ids),
      autoLayout,
      exportPng: () => void exportPng(exportFlowPngToFile),
      exportPngAttach: () => void exportPng(exportFlowPngAttachment),
      zoomIn: () => zoomIn(),
      zoomOut: () => zoomOut(),
      fitView: () => fitView(wholeFitOptions),
      reach: handleReach,
      getReach: () => (readerMode.kind === "reach" ? { nodeId: readerMode.startNodeId, direction: readerMode.direction } : null),
      openFinder: () => setReaderMode({ kind: "finder", query: "" }),
      clearDimming: () => setReaderMode({ kind: "none" }),
      toggleLegend: () => setLegendOpen((v) => !v),
      isLegendOpen: () => legendOpen,
      toggleLock: () => toggleLock(),
      isLocked: () => locked,
    };
  });



  const handleHostDoubleClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (locked) return;
    const target = e.target as HTMLElement;
    if (
      target.closest(
        ".react-flow__node, .react-flow__edge, .react-flow__controls, .react-flow__minimap, button, input, textarea",
      )
    ) {
      return;
    }
    onPaneDoubleClick(e);
  };

  return (
    <div
      ref={hostRef}
      className="diagram-flow"
      data-testid="diagram-flow"
      onKeyDown={onKeyDown}
      onDoubleClick={handleHostDoubleClick}
    >
      {error && (
        <div className="diagram-flow-error" data-testid="diagram-flow-error">
          {t("editor.diagram_parse_error", { message: error })}
        </div>
      )}
      <InlineEditCtx.Provider value={{ edit: inline, commit: commitInline, cancel: closeInline, openRelabel }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeDragStop={onNodeDragStop}
          onConnect={onConnect}
          onConnectEnd={onConnectEnd}
          onReconnect={onReconnect}
          connectionRadius={48}
          reconnectRadius={32}
          connectionMode={ConnectionMode.Loose}
          connectionLineType={ConnectionLineType.SmoothStep}
          connectionLineStyle={{ stroke: "var(--accent, #6366f1)", strokeWidth: 2, strokeDasharray: "4 2" }}
          onlyRenderVisibleElements={true}
          panActivationKeyCode="Space"
          panOnDrag={[1, 2]}
          selectionKeyCode="Shift"
          nodesDraggable={!locked}
          nodesConnectable={!locked}
          elementsSelectable={true}
          onNodeClick={onNodeClick}
          onNodeDoubleClick={(_e, n) => {
            if (locked) return;
            n.type === "briseGroup" ? openGroupRename(n.id.slice(GROUP_PREFIX.length)) : openRename(n.id);
          }}
          onEdgeClick={onEdgeClick}
          onEdgeDoubleClick={(_e, edge) => {
            if (locked) return;
            if (edge.id) openRelabel(edge.id);
          }}
          onPaneClick={onPaneClick}
          snapToGrid
          snapGrid={SNAP_GRID}
          fitView
          fitViewOptions={wholeFitOptions}
          minZoom={0.25}
          maxZoom={4}
          proOptions={{ hideAttribution: true }}
          deleteKeyCode={null} /* 삭제 goes through actions (one undo step); RF's own delete would bypass it */
          aria-label={t("editor.diagram_canvas")}
        >
          <Background gap={20} size={1} bgColor="transparent" />
          {/* quadrant 축 십자 + axes 라벨. 배경 레이어(뷰포트 좌표계, 노드 아래) — Panel 이 아니다(파일 헤더
              OVERLAY PLACEMENT RULE). 자리는 그룹 상자에서 파생(`quadrantAxes`) — 정적 SVG 와 같은 산수. */}
          {axes && (
            <ViewportPortal>
              <svg className="diagram-flow-axes" data-testid="diagram-quadrant-axes" aria-hidden="true">
                <line x1={axes.left} y1={axes.y} x2={axes.right} y2={axes.y} />
                <line x1={axes.x} y1={axes.top} x2={axes.x} y2={axes.bottom} />
                <text x={axes.left} y={axes.y - 6} textAnchor="start">{model.axes?.x[0]}</text>
                <text x={axes.right} y={axes.y - 6} textAnchor="end">{model.axes?.x[1]}</text>
                <text x={axes.x + 6} y={axes.bottom} textAnchor="start">{model.axes?.y[0]}</text>
                <text x={axes.x + 6} y={axes.top + 12} textAnchor="start">{model.axes?.y[1]}</text>
              </svg>
            </ViewportPortal>
          )}
          {/* sequence 라이프라인 — 같은 배경 레이어(Panel 아님). 상자 x 중심에서 상자 아래 → `lifelineH` 까지의
              점선. 정적 SVG 와 같은 산수(`layoutFor` 의 `lifelineH` + `positions`/`sizes`). */}
          {seq?.lifelineH !== undefined && (
            <ViewportPortal>
              <svg className="diagram-flow-axes" data-testid="diagram-sequence-lifelines" strokeDasharray="4 3" aria-hidden="true">
                {model.nodes.map((n) => {
                  const at = positions[n.id];
                  const sz = sizes[n.id];
                  if (!at || !sz) return null;
                  const x = at.x + sz.width / 2;
                  return <line key={n.id} x1={x} y1={at.y + sz.height} x2={x} y2={seq.lifelineH} />;
                })}
              </svg>
            </ViewportPortal>
          )}
          <Controls showInteractive={false} position="bottom-right" fitViewOptions={wholeFitOptions} />
          {model.nodes.length >= MINIMAP_MIN_NODES && <MiniMap pannable zoomable ariaLabel={null} />}
          {/* Our arrowheads. Inside the canvas so they live and die with it; referenced by id, so the
              position in the DOM is irrelevant. */}
          <svg className="diagram-flow-defs" aria-hidden="true">
            <defs>
              <marker
                id={ARROW_ID}
                markerWidth="14"
                markerHeight="14"
                markerUnits="userSpaceOnUse" /* not strokeWidth units — a 3px 굵은 선 would otherwise
                                                get a 3× arrowhead */
                viewBox="-10 -10 20 20"
                orient="auto-start-reverse"
                refX="0"
                refY="0"
              >
                <polyline points="-5,-4 0,0 -5,4" />
              </marker>
              {(["accent", "warn", "done", "muted"] as const).map((tone) => (
                <marker
                  key={tone}
                  id={`brise-flow-arrow-${tone}`}
                  markerWidth="14"
                  markerHeight="14"
                  markerUnits="userSpaceOnUse"
                  viewBox="-10 -10 20 20"
                  orient="auto-start-reverse"
                  refX="0"
                  refY="0"
                >
                  <polyline points="-5,-4 0,0 -5,4" />
                </marker>
              ))}
            </defs>
          </svg>
        </ReactFlow>
      </InlineEditCtx.Provider>

      {legendOpen && (
        <DiagramLegend
          model={model}
          selectedStates={readerMode.kind === "filter" ? readerMode.selectedStates : null}
          onToggleState={toggleFilterState}
          flagFilter={readerMode.kind === "filter" ? readerMode.flagFilter : false}
          onToggleFlag={toggleFilterFlag}
          hoveredTarget={hoveredTarget}
          onHoverTarget={setHoveredTarget}
          onClearFilter={clearReaderMode}
        />
      )}

      {readerMode.kind === "reach" && (
        <DiagramReachBanner
          nodeLabel={model.nodes.find((n) => n.id === readerMode.startNodeId)?.label ?? readerMode.startNodeId}
          direction={readerMode.direction}
          onChangeDirection={(dir) => setReaderMode({ kind: "reach", startNodeId: readerMode.startNodeId, direction: dir })}
          onClose={() => setReaderMode({ kind: "none" })}
        />
      )}

      {readerMode.kind === "finder" && (
        <DiagramFinder
          nodes={model.nodes}
          query={readerMode.query}
          onQueryChange={(query) => setReaderMode({ kind: "finder", query })}
          onSelectNode={(nodeId) => {
            if (apiRef?.current?.focusNode) {
              apiRef.current.focusNode(nodeId);
            } else {
              const targetNodeId = model.groups.some((g) => g.id === nodeId) ? groupNodeId(nodeId) : nodeId;
              fitView({ nodes: [{ id: targetNodeId }], duration: 200 });
            }
            onSelect({ kind: "node", id: nodeId });
            setReaderMode({ kind: "none" });
          }}
          onClose={() => setReaderMode({ kind: "none" })}
        />
      )}

      {inline && (inline.kind === "create" || inline.kind === "createGroup") && (
        <DiagramInlineInput
          className="field diagram-flow-inline"
          testId={inline.kind === "createGroup" ? "diagram-inline-create-group" : "diagram-inline-create"}
          ariaLabel={inline.kind === "createGroup" ? t("editor.diagram_group_create") : t("editor.diagram_add_node")}
          placeholder={
            inline.kind === "createGroup"
              ? t("editor.diagram_group_title_placeholder")
              : t("editor.diagram_inline_label")
          }
          defaultValue=""
          style={{ left: inline.left, top: inline.top }}
          onCommit={commitInline}
          onCancel={closeInline}
        />
      )}

      {/* Floating Context Pill for Instant Manipulation */}
      {bubbles && !locked && (
        <DiagramFloatingBubble
          model={model}
          selection={selection}
          selectedBoxIds={selectedBoxIds}
          actions={actions}
          apiRef={apiRef}
          containerRef={hostRef}
        />
      )}
    </div>
  );
}
