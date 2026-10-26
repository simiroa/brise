/**
 * diagramModel — pure immutable JSON IR mutation functions for diagram sections.
 *
 * Every mutation receives a JSON string or DiagramModel, modifies a cloned model,
 * and serializes it back to JSON. Untouched fields and reference integrity are preserved.
 */

export * from "./diagramSchema";
import {
  parseDiagramJson,
  serializeDiagram,
  styleToLineArrow,
  edgeStyleOf,
  type DiagramEdge,
  type DiagramGroup,
  type DiagramModel,
  type DiagramNode,
  type DiagramNodeMeta,
  type Direction,
  type EdgeStyle,
  type EdgeLine,
  type EdgeArrow,
  type DiagramRoute,
  type NodeShape,
  type DiagramTone,
  type DiagramLayout,
} from "./diagramSchema";

export { parseDiagramJson as parseDiagram };

export function nextNodeId(nodes: DiagramNode[]): string {
  let max = 0;
  for (const n of nodes) {
    const m = /^n(\d+)$/.exec(n.id);
    if (m) {
      const num = parseInt(m[1], 10);
      if (num > max) max = num;
    }
  }
  return `n${max + 1}`;
}

export function nextEdgeId(edges: DiagramEdge[]): string {
  let max = 0;
  for (const e of edges) {
    const m = /^e(\d+)$/.exec(e.id);
    if (m) {
      const num = parseInt(m[1], 10);
      if (num > max) max = num;
    }
  }
  return `e${max + 1}`;
}

export function nextGroupId(groups: DiagramGroup[]): string {
  let max = 0;
  for (const g of groups) {
    const m = /^g(\d+)$/.exec(g.id);
    if (m) {
      const num = parseInt(m[1], 10);
      if (num > max) max = num;
    }
  }
  return `g${max + 1}`;
}

export function hasIdenticalEdge(
  model: DiagramModel,
  from: string,
  to: string,
  label: string,
  style: EdgeStyle,
  sourceHandle?: string,
  targetHandle?: string,
): boolean {
  return model.edges.some((e) => {
    const eStyle = e.style ?? edgeStyleOf(e.line, e.arrow);
    const sameHandles =
      (e.sourceHandle ?? undefined) === (sourceHandle ?? undefined) &&
      (e.targetHandle ?? undefined) === (targetHandle ?? undefined);
    return e.from === from && e.to === to && (e.label ?? "") === label && eStyle === style && sameHandles;
  });
}

export function canConnect(
  sourceOrModel: string | DiagramModel,
  from: string,
  to: string,
  label = "",
  style: EdgeStyle = "solid",
  sourceHandle?: string,
  targetHandle?: string,
): boolean {
  const model = typeof sourceOrModel === "string" ? parseDiagramJson(sourceOrModel) : sourceOrModel;
  if (!model.structured) return false;
  if (!model.nodes.some((n) => n.id === from) || !model.nodes.some((n) => n.id === to)) return false;
  if (hasIdenticalEdge(model, from, to, label, style, sourceHandle, targetHandle)) return false;
  return true;
}

export function addNode(
  source: string,
  label: string,
  shape: NodeShape = "rect",
  pos?: { x: number; y: number },
): { source: string; id: string } {
  const model = parseDiagramJson(source);
  if (!model.structured && !model.empty) {
    return { source, id: "" };
  }
  const id = nextNodeId(model.nodes);
  const newNode: DiagramNode = {
    id,
    label,
    shape,
    ...(pos ? { pos: [pos.x, pos.y] } : {}),
  };
  model.nodes.push(newNode);
  model.empty = false;
  return { source: serializeDiagram(model), id };
}

export function addEdge(
  source: string,
  from: string,
  to: string,
  label = "",
  style: EdgeStyle = "solid",
  sourceHandle?: string,
  targetHandle?: string,
): string {
  const model = parseDiagramJson(source);
  if (!model.structured) return source;
  if (!model.nodes.some((n) => n.id === from) || !model.nodes.some((n) => n.id === to)) return source;
  if (hasIdenticalEdge(model, from, to, label, style, sourceHandle, targetHandle)) return source;

  const id = nextEdgeId(model.edges);
  const { line, arrow } = styleToLineArrow(style);
  const newEdge: DiagramEdge = {
    id,
    from,
    to,
    label: label || undefined,
    line,
    arrow,
    style,
    sourceHandle: sourceHandle || undefined,
    targetHandle: targetHandle || undefined,
  };
  model.edges.push(newEdge);
  model.empty = false;
  return serializeDiagram(model);
}

export const connect = addEdge;

export function deleteNode(source: string, id: string): string {
  const model = parseDiagramJson(source);
  if (!model.structured) return source;

  model.nodes = model.nodes.filter((n) => n.id !== id);
  model.edges = model.edges.filter((e) => e.from !== id && e.to !== id);
  model.empty = model.nodes.length === 0 && model.edges.length === 0;

  return serializeDiagram(model);
}

export function deleteEdge(source: string, edgeId: string): string {
  const model = parseDiagramJson(source);
  if (!model.structured) return source;

  model.edges = model.edges.filter((e) => e.id !== edgeId);
  model.empty = model.nodes.length === 0 && model.edges.length === 0;

  return serializeDiagram(model);
}

export function renameNode(source: string, id: string, label: string): string {
  const model = parseDiagramJson(source);
  if (!model.structured) return source;

  const node = model.nodes.find((n) => n.id === id);
  if (!node) return source;
  node.label = label;

  return serializeDiagram(model);
}

export function setNodeShape(source: string, id: string, shape: NodeShape): string {
  const model = parseDiagramJson(source);
  if (!model.structured) return source;

  const node = model.nodes.find((n) => n.id === id);
  if (!node) return source;
  node.shape = shape;

  return serializeDiagram(model);
}

export function setEdgeStyle(source: string, edgeId: string, style: EdgeStyle): string {
  const model = parseDiagramJson(source);
  if (!model.structured) return source;

  const edge = model.edges.find((e) => e.id === edgeId);
  if (!edge) return source;
  const { line, arrow } = styleToLineArrow(style);
  edge.line = line;
  edge.arrow = arrow;
  edge.style = style;

  return serializeDiagram(model);
}

export function setEdgeLine(source: string, edgeId: string, line: EdgeLine): string {
  const model = parseDiagramJson(source);
  if (!model.structured) return source;

  const edge = model.edges.find((e) => e.id === edgeId);
  if (!edge) return source;
  edge.line = line;
  edge.style = edgeStyleOf(line, edge.arrow);

  return serializeDiagram(model);
}

export function setEdgeArrow(source: string, edgeId: string, arrow: EdgeArrow): string {
  const model = parseDiagramJson(source);
  if (!model.structured) return source;

  const edge = model.edges.find((e) => e.id === edgeId);
  if (!edge) return source;
  edge.arrow = arrow;
  edge.style = edgeStyleOf(edge.line, arrow);

  return serializeDiagram(model);
}

export function setEdgeTone(source: string, edgeId: string, tone: DiagramTone): string {
  const model = parseDiagramJson(source);
  if (!model.structured) return source;

  const edge = model.edges.find((e) => e.id === edgeId);
  if (!edge) return source;
  if (tone === "default") {
    delete edge.tone;
  } else {
    edge.tone = tone;
  }

  return serializeDiagram(model);
}

export function edgeTone(source: string, edgeId: string): DiagramTone {
  const model = parseDiagramJson(source);
  if (!model.structured) return "default";
  const edge = model.edges.find((e) => e.id === edgeId);
  return edge?.tone ?? "default";
}

export function setDiagramRoute(source: string, route: DiagramRoute): string {
  const model = parseDiagramJson(source);
  if (!model.structured) return source;

  model.route = route;
  return serializeDiagram(model);
}

export function setEdgeLabel(source: string, edgeId: string, label: string): string {
  const model = parseDiagramJson(source);
  if (!model.structured) return source;

  const edge = model.edges.find((e) => e.id === edgeId);
  if (!edge) return source;
  edge.label = label || undefined;

  return serializeDiagram(model);
}

export function setEdgeSource(source: string, edgeId: string, from: string): string {
  const model = parseDiagramJson(source);
  if (!model.structured) return source;
  if (!model.nodes.some((n) => n.id === from)) return source;

  const edge = model.edges.find((e) => e.id === edgeId);
  if (!edge) return source;
  edge.from = from;

  return serializeDiagram(model);
}

export function setEdgeTarget(source: string, edgeId: string, to: string): string {
  const model = parseDiagramJson(source);
  if (!model.structured) return source;
  if (!model.nodes.some((n) => n.id === to)) return source;

  const edge = model.edges.find((e) => e.id === edgeId);
  if (!edge) return source;
  edge.to = to;

  return serializeDiagram(model);
}

export function setNodeLink(source: string, id: string, link: string | null): string {
  const model = parseDiagramJson(source);
  if (!model.structured) return source;

  const node = model.nodes.find((n) => n.id === id);
  if (!node) return source;
  if (link) node.link = link;
  else delete node.link;

  return serializeDiagram(model);
}

export function setNodeMeta(source: string, id: string, meta: DiagramNodeMeta | null): string {
  const model = parseDiagramJson(source);
  if (!model.structured) return source;

  const node = model.nodes.find((n) => n.id === id);
  if (!node) return source;

  if (meta?.icon) {
    node.icon = meta.icon;
  } else {
    delete node.icon;
  }

  if (meta?.desc) {
    node.desc = meta.desc;
  } else {
    delete node.desc;
  }

  return serializeDiagram(model);
}

export function setNodePos(source: string, id: string, pos: { x: number; y: number } | null): string {
  const model = parseDiagramJson(source);
  if (!model.structured) return source;

  const node = model.nodes.find((n) => n.id === id);
  if (!node) return source;

  if (pos) node.pos = [pos.x, pos.y];
  else delete node.pos;

  return serializeDiagram(model);
}

export function setNodePositions(
  source: string,
  positions: Record<string, { x: number; y: number } | null>,
  groups?: Record<string, string | null>,
): string {
  const model = parseDiagramJson(source);
  if (!model.structured) return source;

  for (const [id, pos] of Object.entries(positions)) {
    const node = model.nodes.find((n) => n.id === id);
    if (!node) continue;
    if (pos) node.pos = [pos.x, pos.y];
    else delete node.pos;
  }

  if (groups) {
    for (const [id, group] of Object.entries(groups)) {
      const node = model.nodes.find((n) => n.id === id);
      if (!node) continue;
      if (group) {
        node.group = group;
      } else {
        delete node.group;
      }
    }
  }

  return serializeDiagram(model);
}

export function addGroup(
  source: string,
  title: string,
  memberIds: string[],
): { source: string; id: string } {
  if (memberIds.length === 0) return { source, id: "" };
  const model = parseDiagramJson(source);
  if (!model.structured) return { source, id: "" };

  const id = nextGroupId(model.groups);
  model.groups.push({ id, title, parent: null });

  for (const memberId of memberIds) {
    const node = model.nodes.find((n) => n.id === memberId);
    if (node) {
      node.group = id;
    }
  }

  return { source: serializeDiagram(model), id };
}

export function renameGroup(source: string, id: string, title: string): string {
  const model = parseDiagramJson(source);
  if (!model.structured) return source;

  const group = model.groups.find((g) => g.id === id);
  if (!group) return source;
  group.title = title;

  return serializeDiagram(model);
}

export function setGroupTone(source: string, id: string, tone: DiagramTone): string {
  const model = parseDiagramJson(source);
  if (!model.structured) return source;

  const group = model.groups.find((g) => g.id === id);
  if (!group) return source;
  if (tone === "default") {
    delete group.tone;
  } else {
    group.tone = tone;
  }

  return serializeDiagram(model);
}

export function groupTone(sourceOrModel: string | DiagramModel, id: string): DiagramTone {
  const model = typeof sourceOrModel === "string" ? parseDiagramJson(sourceOrModel) : sourceOrModel;
  if (!model.structured) return "default";
  const group = model.groups.find((g) => g.id === id);
  return group?.tone ?? "default";
}

export function dissolveGroup(source: string, id: string): string {
  const model = parseDiagramJson(source);
  if (!model.structured) return source;

  model.groups = model.groups.filter((g) => g.id !== id);
  for (const node of model.nodes) {
    if (node.group === id) {
      delete node.group;
    }
  }
  for (const group of model.groups) {
    if (group.parent === id) {
      group.parent = null;
    }
  }

  return serializeDiagram(model);
}

export function moveNodeToGroup(source: string, nodeId: string, groupId: string | null): string {
  const model = parseDiagramJson(source);
  if (!model.structured) return source;

  const node = model.nodes.find((n) => n.id === nodeId);
  if (!node) return source;

  if (groupId) {
    node.group = groupId;
  } else {
    delete node.group;
  }

  return serializeDiagram(model);
}

export function setDirection(source: string, direction: Direction): string {
  const model = parseDiagramJson(source);
  if (!model.structured) return source;
  model.direction = direction;
  return serializeDiagram(model);
}

/** 배치 바꾸기(PLAN-2026-09-21 W4, D4, 베타) — `layout` 교체 + 모든 노드 `pos` 제거를 ONE apply 로
 *  (되돌리기 1스텝). pos 를 지우지 않으면 아무 것도 안 바뀐다(flowLayout.ts:layoutPositions — 저장된
 *  pos 가 배치를 덮는다). dagre 로 돌아갈 땐 필드 자체를 지운다(직렬화가 dagre 를 생략하는 규칙과
 *  일치, diagramSchema.ts::serializeDiagram). */
export function setLayout(source: string, layout: DiagramLayout): string {
  const model = parseDiagramJson(source);
  if (!model.structured) return source;
  if (layout === "dagre") delete model.layout;
  else model.layout = layout;
  for (const node of model.nodes) delete node.pos;
  return serializeDiagram(model);
}

export function soleIncomingEdge(model: DiagramModel, id: string): DiagramEdge | null {
  if (!model.structured) return null;
  const incoming = model.edges.filter((e) => e.to === id);
  return incoming.length === 1 ? incoming[0] : null;
}

export function setNodeState(source: string, id: string, state?: number): string {
  const model = parseDiagramJson(source);
  if (!model.structured) return source;
  const node = model.nodes.find((n) => n.id === id);
  if (!node) return source;

  if (state === undefined || state === null || state < 0) {
    delete node.state;
  } else {
    node.state = state;
  }
  return serializeDiagram(model);
}

export function setNodeFlag(source: string, id: string, flag?: boolean): string {
  const model = parseDiagramJson(source);
  if (!model.structured) return source;
  const node = model.nodes.find((n) => n.id === id);
  if (!node) return source;

  if (flag) {
    node.flag = true;
  } else {
    delete node.flag;
  }
  return serializeDiagram(model);
}

export function toggleNodeFlag(source: string, id: string): string {
  const model = parseDiagramJson(source);
  if (!model.structured) return source;
  const node = model.nodes.find((n) => n.id === id);
  if (!node) return source;

  if (!node.flag) {
    node.flag = true;
  } else {
    delete node.flag;
  }
  return serializeDiagram(model);
}

export function setNodeTag(source: string, id: string, tag?: string | null): string {
  const model = parseDiagramJson(source);
  if (!model.structured) return source;
  const node = model.nodes.find((n) => n.id === id);
  if (!node) return source;

  const trimmed = typeof tag === "string" ? tag.trim() : "";
  if (trimmed) {
    node.tag = trimmed;
  } else {
    delete node.tag;
  }
  return serializeDiagram(model);
}

/** 구획(rows) — 빈 줄은 버리고, 남는 게 없으면 필드를 지운다(노드 필드만, 맵 없음). */
export function setNodeRows(source: string, id: string, rows: string[] | null): string {
  const model = parseDiagramJson(source);
  if (!model.structured) return source;
  const node = model.nodes.find((n) => n.id === id);
  if (!node) return source;

  const cleaned = (rows ?? []).map((r) => r.trim()).filter((r) => r.length > 0);
  if (cleaned.length) node.rows = cleaned;
  else delete node.rows;
  return serializeDiagram(model);
}

export function setDiagramStates(source: string, states: string[], flagLabel?: string): string {
  const model = parseDiagramJson(source);
  if (!model.structured) return source;

  model.states = states.map((s) => s.trim()).filter((s) => s.length > 0);
  const trimmedFlag = typeof flagLabel === "string" ? flagLabel.trim() : "";
  if (trimmedFlag) {
    model.flagLabel = trimmedFlag;
  } else {
    delete model.flagLabel;
  }
  return serializeDiagram(model);
}
