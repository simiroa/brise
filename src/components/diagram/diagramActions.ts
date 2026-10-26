/**
 * diagramActions — ONE set of verbs, called from both places the user can reach them.
 */
import { t } from "../../i18n/t";
import { emitNotice } from "../../lib/invoke";
import {
  addEdge,
  addGroup,
  addNode,
  hasIdenticalEdge,
  edgeStyleOf,
  deleteEdge,
  deleteNode,
  dissolveGroup,
  moveNodeToGroup,
  parseDiagram,
  renameGroup,
  renameNode,
  setDirection,
  setEdgeLabel,
  setEdgeSource,
  setEdgeStyle,
  setEdgeLine,
  setEdgeArrow,
  setEdgeTone,
  edgeTone,
  setGroupTone,
  groupTone,
  setDiagramRoute,
  setEdgeTarget,
  setNodeLink,
  setNodeMeta,
  setNodePos,
  setNodePositions,
  setNodeShape,
  setNodeState,
  setNodeFlag,
  toggleNodeFlag,
  setNodeTag,
  setNodeRows,
  setDiagramStates,
  setLayout,
  type Direction,
  type DiagramNodeMeta,
  type EdgeStyle,
  type EdgeLine,
  type EdgeArrow,
  type DiagramRoute,
  type NodeShape,
  type DiagramLayout,
  type Selection,
} from "./diagramModel";
import { nodeTone, setNodeMark, setNodesMark, setNodeTone, type DiagramTone, type NodeMark } from "./diagramStyles";
import { parseDiagramText } from "./diagramText";

export type { Selection };

export interface AddFromTextResult {
  ok: boolean;
  error?: string;
  line?: number;
}

export interface DiagramActions {
  /** Current toolbar defaults — also what a drag/handle-created edge or node is made with. */
  shape: NodeShape;
  style: EdgeStyle;
  setShapeDefault: (s: NodeShape) => void;
  setStyleDefault: (s: EdgeStyle) => void;
  /** Adds a free-standing node and selects it. Optionally places it at pos. Returns the created node id. */
  addNode: (label: string, shape?: NodeShape, pos?: { x: number; y: number }) => string | undefined;
  /** Adds `from → to` in the current line style and selects the new edge (its label input). */
  connect: (from: string, to: string, label?: string, sourceHandle?: string, targetHandle?: string) => void;
  connectBatch: (fromIds: string[], toId: string, label?: string, sourceHandle?: string, targetHandle?: string) => void;
  /** New node + the edge to it in ONE mutation = ONE 되돌리기 step (Tab, the `+` handle). */
  createChild: (from: string, label: string) => void;
  /** Drag-to-empty-canvas: createChild + the drop coordinate, still composed into ONE apply so
   *  되돌리기 removes node, edge and position together in a single press. Returns the created node id. */
  addConnected: (from: string, label: string, pos: { x: number; y: number }) => string | undefined;
  /** Creates multiple children nodes and connects them with edges from parent in a single batch mutation. */
  expandChildren: (from: string, labels: string[]) => string[];
  /** 텍스트 문법(D4) → 병합. 같은 라벨은 기존 노드/그룹을 재사용(중복 생성 0), 새 라벨만 추가.
   *  전부 ONE apply(변화가 없으면 apply 자체를 안 한다 — 되돌리기 스택을 더럽히지 않는다). */
  addFromText: (text: string) => AddFromTextResult;
  /** Drag-to-reparent: re-points an existing edge's source. */
  reparent: (edge: string, from: string) => void;
  /** The mirror: drags of an arrow's HEAD re-point its target. Same one-mutation write path. */
  retarget: (edge: string, to: string) => void;
  setNodeShape: (id: string, shape: NodeShape) => void;
  /** 아이콘·설명 — an empty icon AND desc removes the data. */
  setNodeMeta: (id: string, meta: DiagramNodeMeta | null) => void;
  /** Where a box sits on the React Flow canvas (pos). */
  setNodePos: (id: string, pos: { x: number; y: number } | null) => void;
  /** 자동 정렬: every box at once. */
  setNodePositions: (
    positions: Record<string, { x: number; y: number } | null>,
    groups?: Record<string, string | null>,
  ) => void;
  /** 그룹 만들기 */
  addGroup: (title: string, memberIds: string[]) => void;
  renameGroup: (id: string, title: string) => void;
  setGroupTone: (id: string, tone: DiagramTone) => void;
  groupTone: (id: string) => DiagramTone;
  /** 그룹 해제 */
  dissolveGroup: (id: string) => void;
  setEdgeStyle: (edge: string, style: EdgeStyle) => void;
  setEdgeLine: (edge: string, line: EdgeLine) => void;
  setEdgeArrow: (edge: string, arrow: EdgeArrow) => void;
  setEdgeTone: (edge: string, tone: DiagramTone) => void;
  edgeTone: (edge: string) => DiagramTone;
  setRoute: (route: DiagramRoute) => void;
  rename: (id: string, label: string) => void;
  setEdgeLabel: (edge: string, label: string) => void;
  deleteNode: (id: string) => void;
  deleteEdge: (edge: string) => void;
  setDirection: (d: Direction) => void;
  /** 배치 바꾸기(베타, PLAN-2026-09-21 W4/D4) — layout 교체 + 전체 pos 제거, ONE apply. */
  setLayout: (layout: DiagramLayout) => void;
  setNodeTone: (id: string, tone: DiagramTone) => void;
  nodeTone: (id: string) => DiagramTone;
  /** 색 칩 한 줄(버블) — 강조 또는 상태 하나로, 다른 표시는 지운다. ONE apply. */
  setNodeMark: (id: string, mark: NodeMark) => void;
  /** 다중 선택의 색 칩 — 선택한 노드 전부에 같은 표시, ONE apply(되돌리기 한 단계). */
  setNodesMark: (ids: string[], mark: NodeMark) => void;
  setNodeState: (id: string, state?: number) => void;
  setNodeFlag: (id: string, flag: boolean) => void;
  toggleNodeFlag: (id: string) => void;
  setNodeTag: (id: string, tag: string | null) => void;
  /** 구획(rows) — 빈 배열이나 null 이면 필드를 지운다. */
  setNodeRows: (id: string, rows: string[] | null) => void;
  setStates: (states: string[], flagLabel?: string) => void;
  pickNote: (id: string) => void;
  unlinkNote: (id: string) => void;
  openNote: (noteId: string) => void;
}

export function makeDiagramActions(opts: {
  source: () => string;
  apply: (next: string) => void;
  select: (s: Selection) => void;
  shape: NodeShape;
  style: EdgeStyle;
  setShapeDefault: (s: NodeShape) => void;
  setStyleDefault: (s: EdgeStyle) => void;
  pickNote: (id: string) => void;
  openNote: (noteId: string) => void;
}): DiagramActions {
  const { source, apply, select } = opts;
  return {
    shape: opts.shape,
    style: opts.style,
    setShapeDefault: opts.setShapeDefault,
    setStyleDefault: opts.setStyleDefault,
    pickNote: opts.pickNote,
    openNote: opts.openNote,

    addNode: (label, shape = opts.shape, pos) => {
      const { source: next, id } = addNode(source(), label, shape, pos);
      if (!id) return undefined;
      apply(next);
      select({ kind: "node", id });
      return id;
    },

    connect: (from, to, label = "", sourceHandle?: string, targetHandle?: string) => {
      const src = source();
      const next = addEdge(src, from, to, label, opts.style, sourceHandle, targetHandle);
      if (next === src) {
        if (hasIdenticalEdge(parseDiagram(src), from, to, label, opts.style, sourceHandle, targetHandle)) {
          emitNotice(t("editor.diagram_edge_duplicate"));
        }
        return;
      }
      apply(next);
      const created = parseDiagram(next).edges.filter((e) => e.from === from && e.to === to).pop();
      select(created ? { kind: "edge", id: created.id } : null);
    },

    connectBatch: (fromIds, toId, label = "", sourceHandle?: string, targetHandle?: string) => {
      let cur = source();
      let changed = false;
      for (const from of fromIds) {
        if (from === toId) continue;
        const next = addEdge(cur, from, toId, label, opts.style, sourceHandle, targetHandle);
        if (next !== cur) {
          cur = next;
          changed = true;
        }
      }
      if (changed) {
        apply(cur);
      }
    },

    createChild: (from, label) => {
      const added = addNode(source(), label, opts.shape);
      if (!added.id) return;
      apply(addEdge(added.source, from, added.id, "", opts.style));
      select({ kind: "node", id: added.id });
    },

    addConnected: (from, label, pos) => {
      const added = addNode(source(), label, opts.shape, pos);
      if (!added.id) return undefined;
      apply(addEdge(added.source, from, added.id, "", opts.style));
      select({ kind: "node", id: added.id });
      return added.id;
    },

    expandChildren: (from, labels) => {
      if (!labels.length) return [];
      let currentSource = source();
      const parsed = parseDiagram(currentSource);
      const parentNode = parsed.nodes.find((n) => n.id === from);
      const parentPos = parentNode?.pos ? { x: parentNode.pos[0], y: parentNode.pos[1] } : { x: 0, y: 0 };

      const count = labels.length;
      const dir = parsed.direction;
      const createdIds: string[] = [];

      for (let i = 0; i < count; i++) {
        const label = labels[i];
        const offsetIdx = i - (count - 1) / 2;
        let pos: { x: number; y: number };
        if (dir === "LR") {
          pos = { x: Math.round(parentPos.x + 220), y: Math.round(parentPos.y + offsetIdx * 80) };
        } else if (dir === "RL") {
          pos = { x: Math.round(parentPos.x - 220), y: Math.round(parentPos.y + offsetIdx * 80) };
        } else if (dir === "BT") {
          pos = { x: Math.round(parentPos.x + offsetIdx * 160), y: Math.round(parentPos.y - 100) };
        } else {
          // TB
          pos = { x: Math.round(parentPos.x + offsetIdx * 160), y: Math.round(parentPos.y + 100) };
        }

        const added = addNode(currentSource, label, opts.shape, pos);
        if (added.id) {
          createdIds.push(added.id);
          currentSource = addEdge(added.source, from, added.id, "", opts.style);
        }
      }

      if (createdIds.length > 0) {
        apply(currentSource);
        select({ kind: "node", id: createdIds[0] });
      }
      return createdIds;
    },

    addFromText: (text) => {
      const parsed = parseDiagramText(text);
      if (!parsed.ok) return { ok: false, error: parsed.error, line: parsed.line };

      let cur = source();
      let changed = false;

      // 라벨 → 기존(또는 방금 만든) 노드 id. 시작은 현재 모델에 이미 있는 라벨들로 채운다.
      const idByLabel = new Map(parseDiagram(cur).nodes.map((n) => [n.label, n.id] as const));
      const idMap = new Map<string, string>(); // 텍스트가 매긴 임시 id -> 실제 모델 id

      for (const pn of parsed.json.nodes) {
        const existing = idByLabel.get(pn.label);
        if (existing) {
          idMap.set(pn.id, existing);
          continue;
        }
        const added = addNode(cur, pn.label, "rect");
        if (!added.id) continue;
        cur = added.source;
        idMap.set(pn.id, added.id);
        idByLabel.set(pn.label, added.id);
        changed = true;
      }

      // 제목 → 기존(또는 방금 만든) 그룹 id.
      const groupIdByTitle = new Map(parseDiagram(cur).groups.map((g) => [g.title, g.id] as const));
      const groupIdMap = new Map<string, string>();
      for (const pg of parsed.json.groups ?? []) {
        const existing = groupIdByTitle.get(pg.title);
        if (existing) {
          groupIdMap.set(pg.id, existing);
          continue;
        }
        const memberIds = parsed.json.nodes
          .filter((n) => n.group === pg.id)
          .map((n) => idMap.get(n.id))
          .filter((id): id is string => Boolean(id));
        if (memberIds.length === 0) continue;
        const added = addGroup(cur, pg.title, memberIds);
        if (!added.id) continue;
        cur = added.source;
        groupIdMap.set(pg.id, added.id);
        groupIdByTitle.set(pg.title, added.id);
        changed = true;
      }

      // 이미 있던 노드가 텍스트에서는 그룹 소속으로 나온 경우 소속을 옮긴다(새로 만든 노드는
      // addGroup 이 이미 반영했다).
      for (const pn of parsed.json.nodes) {
        if (!pn.group) continue;
        const nodeId = idMap.get(pn.id);
        const groupId = groupIdMap.get(pn.group);
        if (!nodeId || !groupId) continue;
        const currentNode = parseDiagram(cur).nodes.find((n) => n.id === nodeId);
        if (currentNode && currentNode.group !== groupId) {
          cur = moveNodeToGroup(cur, nodeId, groupId);
          changed = true;
        }
      }

      for (const pe of parsed.json.edges) {
        const from = idMap.get(pe.from);
        const to = idMap.get(pe.to);
        if (!from || !to) continue;
        const style = edgeStyleOf(pe.line, pe.arrow);
        const next = addEdge(cur, from, to, pe.label ?? "", style);
        if (next !== cur) {
          cur = next;
          changed = true;
        }
      }

      if (changed) apply(cur);
      return { ok: true };
    },

    reparent: (edge, from) => apply(setEdgeSource(source(), edge, from)),
    retarget: (edge, to) => apply(setEdgeTarget(source(), edge, to)),
    setNodeShape: (id, shape) => apply(setNodeShape(source(), id, shape)),
    setNodeMeta: (id, meta) => apply(setNodeMeta(source(), id, meta)),
    setNodePos: (id, pos) => apply(setNodePos(source(), id, pos)),
    setNodePositions: (positions, groups) => {
      let next = setNodePositions(source(), positions);
      for (const [id, group] of Object.entries(groups ?? {})) next = moveNodeToGroup(next, id, group);
      apply(next);
    },

    addGroup: (title, memberIds) => {
      const { source: next, id } = addGroup(source(), title, memberIds);
      if (!id) return;
      apply(next);
      select({ kind: "group", id });
    },
    renameGroup: (id, title) => apply(renameGroup(source(), id, title)),
    setGroupTone: (id, tone) => apply(setGroupTone(source(), id, tone)),
    groupTone: (id) => groupTone(source(), id),
    dissolveGroup: (id) => {
      apply(dissolveGroup(source(), id));
      select(null);
    },

    setEdgeStyle: (edge, style) => apply(setEdgeStyle(source(), edge, style)),
    setEdgeLine: (edge, line) => apply(setEdgeLine(source(), edge, line)),
    setEdgeArrow: (edge, arrow) => apply(setEdgeArrow(source(), edge, arrow)),
    setEdgeTone: (edge, tone) => apply(setEdgeTone(source(), edge, tone)),
    edgeTone: (edge) => edgeTone(source(), edge),
    setRoute: (route) => apply(setDiagramRoute(source(), route)),
    rename: (id, label) => apply(renameNode(source(), id, label)),
    setEdgeLabel: (edge, label) => apply(setEdgeLabel(source(), edge, label)),
    setDirection: (d) => apply(setDirection(source(), d)),
    setLayout: (layout) => apply(setLayout(source(), layout)),
    setNodeTone: (id, tone) => apply(setNodeTone(source(), id, tone)),
    nodeTone: (id) => nodeTone(source(), id),
    setNodeMark: (id, mark) => apply(setNodeMark(source(), id, mark)),
    setNodesMark: (ids, mark) => apply(setNodesMark(source(), ids, mark)),
    setNodeState: (id, state) => apply(setNodeState(source(), id, state)),
    setNodeFlag: (id, flag) => apply(setNodeFlag(source(), id, flag)),
    toggleNodeFlag: (id) => apply(toggleNodeFlag(source(), id)),
    setNodeTag: (id, tag) => apply(setNodeTag(source(), id, tag)),
    setNodeRows: (id, rows) => apply(setNodeRows(source(), id, rows)),
    setStates: (states, flagLabel) => apply(setDiagramStates(source(), states, flagLabel)),
    unlinkNote: (id) => apply(setNodeLink(source(), id, null)),

    deleteNode: (id) => {
      apply(deleteNode(source(), id));
      select(null);
    },
    deleteEdge: (edge) => {
      apply(deleteEdge(source(), edge));
      select(null);
    },
  };
}
