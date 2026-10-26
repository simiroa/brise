/**
 * diagramSchema — JSON IR v1 interfaces, default values, validation helpers,
 * parser, serializer, and selection types.
 */

export type NodeShape = "rect" | "round" | "stadium" | "circle" | "diamond";
export type EdgeLine = "solid" | "dotted" | "dashed" | "thick" | "double";
export type EdgeArrow = "end" | "both" | "none";
export type DiagramRoute = "curve" | "orthogonal";
export type Direction = "TD" | "TB" | "LR" | "RL" | "BT";
/** 배치 문법(PLAN-2026-09-20 §2.1). 없으면 dagre. `sequence` 는 enum 에만 있고 배치 함수는 W2b — 그 전까지
 *  `layoutFor` 가 dagre 로 폴백한다. */
export type DiagramLayout = "dagre" | "radial" | "lanes" | "grid" | "quadrant" | "stack" | "circle" | "fishbone" | "sequence";
export const DIAGRAM_LAYOUTS: readonly DiagramLayout[] = [
  "dagre",
  "radial",
  "lanes",
  "grid",
  "quadrant",
  "stack",
  "circle",
  "fishbone",
  "sequence",
];
/** quadrant 전용 축 라벨 — x: [왼쪽, 오른쪽], y: [아래, 위]. */
export interface DiagramAxes {
  x: [string, string];
  y: [string, string];
}

/** The edge styles the UI offers in menu order (compatibility mapping with line x arrow). */
export type EdgeStyle = "solid" | "dotted" | "bidirectional" | "thick" | "open";
export const EDGE_STYLES: readonly EdgeStyle[] = ["solid", "dotted", "bidirectional", "thick", "open"];

export const NODE_SHAPES: readonly NodeShape[] = ["rect", "round", "stadium", "circle", "diamond"];
export const DIRECTIONS: readonly Direction[] = ["TD", "TB", "LR", "RL", "BT"];
export const EDGE_LINES: readonly EdgeLine[] = ["solid", "dotted", "dashed", "thick", "double"];
export const EDGE_ARROWS: readonly EdgeArrow[] = ["end", "both", "none"];

export const DIAGRAM_TONES = ["default", "accent", "warn", "done", "muted"] as const;
export type DiagramTone = (typeof DIAGRAM_TONES)[number];

export function isDiagramTone(t: unknown): t is DiagramTone {
  return typeof t === "string" && (DIAGRAM_TONES as readonly string[]).includes(t);
}

export const SHAPES: [NodeShape, string, string][] = [
  ["circle", "((", "))"],
  ["stadium", "([", "])"],
  ["rect", "[", "]"],
  ["round", "(", ")"],
  ["diamond", "{", "}"],
];

export interface DiagramNode {
  id: string;
  label: string;
  shape?: NodeShape;
  icon?: string;
  desc?: string;
  tag?: string;
  state?: number;
  flag?: boolean;
  pos?: [number, number];
  group?: string;
  link?: string;
  /** 구획 목록(ER 의 컬럼, 클래스의 멤버) — 라벨 아래 구획선으로 한 줄씩. */
  rows?: string[];
}

export interface DiagramEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  line?: EdgeLine;
  arrow?: EdgeArrow;
  /** UI presentation style compatibility field */
  style?: EdgeStyle;
  tone?: DiagramTone;
  sourceHandle?: string;
  targetHandle?: string;
}

export interface DiagramGroup {
  id: string;
  title: string;
  parent?: string | null;
  tone?: DiagramTone;
}

export interface DiagramJson {
  v: 1;
  /** 레지스트리 타입 id — 메타. 렌더는 보지 않는다(타입 파일을 지워도 본문은 `layout` 만으로 열린다). */
  type?: string;
  layout?: DiagramLayout;
  axes?: DiagramAxes;
  direction?: Direction;
  route?: DiagramRoute;
  states?: string[];
  flagLabel?: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups?: DiagramGroup[];
}

export interface DiagramNodeMeta {
  icon?: string;
  desc?: string;
}

/**
 * 노드의 `pos`·`link`·`icon`·`desc` 는 **노드 필드가 유일한 진실**이다. 예전에는 같은 값을 담는
 * `positions`/`links`/`metas` 맵이 나란히 있었고(mermaid `%% brise:` 라이더 시절의 잔재), 변경은
 * 둘 다에 쓰고 읽기는 맵만 봤다 — 한쪽만 고치면 화면과 저장이 갈라지는 구조였다(2026-09-20 제거).
 * 노드에 필드를 더할 때 옆에 맵을 만들지 마라. `edgesComplete` 도 같은 날 나갔다(mermaid 파서 개념).
 */
export interface DiagramModel {
  v: 1;
  empty: boolean;
  structured: boolean;
  type?: string;
  layout?: DiagramLayout;
  axes?: DiagramAxes;
  /** 파싱 때 enum 밖이던 `layout` 원문 — 렌더는 dagre 로 폴백하고 `validateDiagramModel` 이 오류로
   *  올려 AI 자동수리 루프가 고친다. */
  unknownLayout?: string;
  route: DiagramRoute;
  states: string[];
  flagLabel?: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups: DiagramGroup[];
  direction: Direction;
  raw?: string;
  error?: string;
}

/**
 * Selection contract:
 * { kind: 'node', id } | { kind: 'edge', id } | { kind: 'group', id } | null
 */
export type Selection =
  | { kind: "node"; id: string }
  | { kind: "edge"; id: string }
  | { kind: "group"; id: string }
  | null;

export function isNodeShape(val: unknown): val is NodeShape {
  return typeof val === "string" && (NODE_SHAPES as readonly string[]).includes(val as NodeShape);
}

export function isEdgeStyle(val: unknown): val is EdgeStyle {
  return typeof val === "string" && (EDGE_STYLES as readonly string[]).includes(val as EdgeStyle);
}

export function isEdgeLine(val: unknown): val is EdgeLine {
  return typeof val === "string" && (EDGE_LINES as readonly string[]).includes(val as EdgeLine);
}

export function isEdgeArrow(val: unknown): val is EdgeArrow {
  return typeof val === "string" && (EDGE_ARROWS as readonly string[]).includes(val as EdgeArrow);
}

export function isDirection(val: unknown): val is Direction {
  return typeof val === "string" && (DIRECTIONS as readonly string[]).includes(val as Direction);
}

export function isDiagramRoute(val: unknown): val is DiagramRoute {
  return val === "curve" || val === "orthogonal";
}

export function isDiagramLayout(val: unknown): val is DiagramLayout {
  return typeof val === "string" && (DIAGRAM_LAYOUTS as readonly string[]).includes(val);
}

function parseAxes(raw: unknown): DiagramAxes | undefined {
  const obj = (raw && typeof raw === "object" ? raw : null) as Record<string, unknown> | null;
  if (!obj) return undefined;
  const pair = (v: unknown): [string, string] | undefined =>
    Array.isArray(v) && v.length >= 2 && typeof v[0] === "string" && typeof v[1] === "string" ? [v[0], v[1]] : undefined;
  const x = pair(obj.x);
  const y = pair(obj.y);
  return x && y ? { x, y } : undefined;
}

export function edgeStyleOf(line?: EdgeLine, arrow?: EdgeArrow): EdgeStyle {
  if (arrow === "both") return "bidirectional";
  if (arrow === "none") return "open";
  if (line === "dotted") return "dotted";
  if (line === "thick") return "thick";
  return "solid";
}

export function styleToLineArrow(style: EdgeStyle): { line: EdgeLine; arrow: EdgeArrow } {
  switch (style) {
    case "dotted":
      return { line: "dotted", arrow: "end" };
    case "thick":
      return { line: "thick", arrow: "end" };
    case "bidirectional":
      return { line: "solid", arrow: "both" };
    case "open":
      return { line: "solid", arrow: "none" };
    case "solid":
    default:
      return { line: "solid", arrow: "end" };
  }
}

export function createEmptyDiagramModel(direction: Direction = "TD"): DiagramModel {
  return {
    v: 1,
    empty: true,
    structured: true,
    route: "curve",
    states: [],
    nodes: [],
    edges: [],
    groups: [],
    direction,
  };
}

export function parseDiagramJson(body: string): DiagramModel {
  const trimmed = body.trim();
  if (!trimmed) {
    return createEmptyDiagramModel();
  }

  try {
    const json = JSON.parse(trimmed);
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      return {
        ...createEmptyDiagramModel(),
        empty: false,
        structured: false,
        raw: body,
        error: "Root must be an object",
      };
    }

    const rawNodes = Array.isArray(json.nodes) ? json.nodes : [];
    const nodes: DiagramNode[] = rawNodes.map((n: unknown, idx: number) => {
      const nodeObj = (n && typeof n === "object" ? n : {}) as Record<string, unknown>;
      const id = typeof nodeObj.id === "string" && nodeObj.id ? nodeObj.id : `n${idx + 1}`;
      const label = typeof nodeObj.label === "string" ? nodeObj.label : id;
      const shape: NodeShape = isNodeShape(nodeObj.shape) ? nodeObj.shape : "rect";
      const icon = typeof nodeObj.icon === "string" ? nodeObj.icon : undefined;
      const desc = typeof nodeObj.desc === "string" ? nodeObj.desc : undefined;
      const tag = typeof nodeObj.tag === "string" ? nodeObj.tag : undefined;
      const state = typeof nodeObj.state === "number" ? nodeObj.state : undefined;
      const flag = typeof nodeObj.flag === "boolean" ? nodeObj.flag : undefined;
      let pos: [number, number] | undefined = undefined;
      if (
        Array.isArray(nodeObj.pos) &&
        nodeObj.pos.length >= 2 &&
        typeof nodeObj.pos[0] === "number" &&
        typeof nodeObj.pos[1] === "number"
      ) {
        pos = [nodeObj.pos[0], nodeObj.pos[1]];
      }
      const group = typeof nodeObj.group === "string" ? nodeObj.group : undefined;
      const link = typeof nodeObj.link === "string" ? nodeObj.link : undefined;
      const rows = Array.isArray(nodeObj.rows)
        ? nodeObj.rows.filter((r: unknown): r is string => typeof r === "string")
        : [];

      return {
        id,
        label,
        shape,
        icon,
        desc,
        tag,
        state,
        flag,
        pos,
        group,
        link,
        ...(rows.length ? { rows } : {}),
      };
    });

    const rawEdges = Array.isArray(json.edges) ? json.edges : [];
    const edges: DiagramEdge[] = rawEdges.map((e: unknown, idx: number) => {
      const edgeObj = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
      const id = typeof edgeObj.id === "string" && edgeObj.id ? edgeObj.id : `e${idx + 1}`;
      const from = typeof edgeObj.from === "string" ? edgeObj.from : "";
      const to = typeof edgeObj.to === "string" ? edgeObj.to : "";
      const label = typeof edgeObj.label === "string" && edgeObj.label ? edgeObj.label : undefined;
      const line: EdgeLine = isEdgeLine(edgeObj.line) ? edgeObj.line : "solid";
      const arrow: EdgeArrow = isEdgeArrow(edgeObj.arrow) ? edgeObj.arrow : "end";
      const style = edgeStyleOf(line, arrow);
      const tone = isDiagramTone(edgeObj.tone) && edgeObj.tone !== "default" ? edgeObj.tone : undefined;
      const sourceHandle = typeof edgeObj.sourceHandle === "string" ? edgeObj.sourceHandle : undefined;
      const targetHandle = typeof edgeObj.targetHandle === "string" ? edgeObj.targetHandle : undefined;

      return {
        id,
        from,
        to,
        label,
        line,
        arrow,
        style,
        ...(tone ? { tone } : {}),
        ...(sourceHandle ? { sourceHandle } : {}),
        ...(targetHandle ? { targetHandle } : {}),
      };
    });

    const rawGroups = Array.isArray(json.groups) ? json.groups : [];
    const groups: DiagramGroup[] = rawGroups.map((g: unknown, idx: number) => {
      const groupObj = (g && typeof g === "object" ? g : {}) as Record<string, unknown>;
      const id = typeof groupObj.id === "string" && groupObj.id ? groupObj.id : `g${idx + 1}`;
      const title = typeof groupObj.title === "string" ? groupObj.title : id;
      const parent = typeof groupObj.parent === "string" ? groupObj.parent : null;
      const tone = isDiagramTone(groupObj.tone) && groupObj.tone !== "default" ? groupObj.tone : undefined;
      return { id, title, parent, ...(tone ? { tone } : {}) };
    });

    const direction: Direction = isDirection(json.direction) ? json.direction : "TD";
    const route: DiagramRoute = json.route === "orthogonal" ? "orthogonal" : "curve";
    const states: string[] = Array.isArray(json.states)
      ? json.states.filter((s: unknown): s is string => typeof s === "string")
      : [];
    const flagLabel = typeof json.flagLabel === "string" ? json.flagLabel : undefined;
    const empty = nodes.length === 0 && edges.length === 0;
    const type = typeof json.type === "string" && json.type ? json.type : undefined;
    const layout = isDiagramLayout(json.layout) ? json.layout : undefined;
    const unknownLayout = json.layout !== undefined && !layout ? String(json.layout) : undefined;
    const axes = parseAxes(json.axes);

    return {
      v: 1,
      empty,
      structured: true,
      ...(type ? { type } : {}),
      ...(layout ? { layout } : {}),
      ...(unknownLayout !== undefined ? { unknownLayout } : {}),
      ...(axes ? { axes } : {}),
      route,
      states,
      flagLabel,
      nodes,
      edges,
      groups,
      direction,
    };
  } catch (err) {
    return {
      ...createEmptyDiagramModel(),
      empty: false,
      structured: false,
      raw: body,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function serializeDiagram(model: DiagramModel): string {
  if (model.raw && !model.structured) {
    return model.raw;
  }

  const json: DiagramJson = {
    v: 1,
    ...(model.type ? { type: model.type } : {}),
    ...(model.layout && model.layout !== "dagre" ? { layout: model.layout } : {}),
    ...(model.axes ? { axes: model.axes } : {}),
    ...(model.direction && model.direction !== "TD" ? { direction: model.direction } : {}),
    ...(model.route && model.route !== "curve" ? { route: model.route } : {}),
    ...(model.states && model.states.length > 0 ? { states: model.states } : {}),
    ...(model.flagLabel ? { flagLabel: model.flagLabel } : {}),
    nodes: model.nodes.map((n) => {
      const nodeObj: DiagramNode = {
        id: n.id,
        label: n.label,
        ...(n.shape && n.shape !== "rect" ? { shape: n.shape } : {}),
        ...(n.icon ? { icon: n.icon } : {}),
        ...(n.desc ? { desc: n.desc } : {}),
        ...(n.tag ? { tag: n.tag } : {}),
        ...(n.state !== undefined ? { state: n.state } : {}),
        ...(n.flag !== undefined ? { flag: n.flag } : {}),
        ...(n.pos ? { pos: n.pos } : {}),
        ...(n.group ? { group: n.group } : {}),
        ...(n.link ? { link: n.link } : {}),
        ...(n.rows && n.rows.length ? { rows: n.rows } : {}),
      };
      return nodeObj;
    }),
    edges: model.edges.map((e) => {
      const line = e.line ?? "solid";
      const arrow = e.arrow ?? "end";
      return {
        id: e.id,
        from: e.from,
        to: e.to,
        ...(e.label ? { label: e.label } : {}),
        ...(line !== "solid" ? { line } : {}),
        ...(arrow !== "end" ? { arrow } : {}),
        ...(e.tone && e.tone !== "default" ? { tone: e.tone } : {}),
        ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
        ...(e.targetHandle ? { targetHandle: e.targetHandle } : {}),
      };
    }),
    ...(model.groups && model.groups.length > 0
      ? {
          groups: model.groups.map((g) => ({
            id: g.id,
            title: g.title,
            parent: g.parent ?? null,
            ...(g.tone && g.tone !== "default" ? { tone: g.tone } : {}),
          })),
        }
      : {}),
  };

  return JSON.stringify(json, null, 2);
}

export interface DiagramValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateDiagramModel(model: DiagramModel): DiagramValidationResult {
  const errors: string[] = [];
  if (!model.structured) {
    errors.push(model.error || "Invalid JSON syntax");
    return { valid: false, errors };
  }

  if (model.unknownLayout !== undefined) {
    errors.push(`Unknown layout: "${model.unknownLayout}" (use one of ${DIAGRAM_LAYOUTS.join("|")})`);
  }
  if (model.axes && model.layout !== "quadrant") {
    errors.push('"axes" is only valid with layout "quadrant"');
  }

  const nodeIds = new Set<string>();
  for (const n of model.nodes) {
    if (!n.id) {
      errors.push("Node missing id");
    } else if (nodeIds.has(n.id)) {
      errors.push(`Duplicate node id: "${n.id}"`);
    } else {
      nodeIds.add(n.id);
    }
  }

  const groupIds = new Set<string>();
  for (const g of model.groups) {
    if (!g.id) {
      errors.push("Group missing id");
    } else if (groupIds.has(g.id)) {
      errors.push(`Duplicate group id: "${g.id}"`);
    } else {
      groupIds.add(g.id);
    }
  }

  // Cross-namespace duplicate check: node id colliding with group id
  for (const gid of groupIds) {
    if (nodeIds.has(gid)) {
      errors.push(`Node and group share duplicate id: "${gid}"`);
    }
  }

  for (const n of model.nodes) {
    if (n.group && !groupIds.has(n.group)) {
      errors.push(`Node "${n.id}" references non-existent group: "${n.group}"`);
    }
    if (n.state !== undefined) {
      if (!Array.isArray(model.states) || model.states.length === 0) {
        errors.push(`Node "${n.id}" specifies state ${n.state} but no states are defined`);
      } else if (n.state < 0 || n.state >= model.states.length) {
        errors.push(`Node "${n.id}" state index ${n.state} out of bounds (0..${model.states.length - 1})`);
      }
    }
  }

  for (const e of model.edges) {
    if (!e.from || !nodeIds.has(e.from)) {
      errors.push(`Edge "${e.id}" references non-existent from node: "${e.from}"`);
    }
    if (!e.to || !nodeIds.has(e.to)) {
      errors.push(`Edge "${e.id}" references non-existent to node: "${e.to}"`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Remove pos and coordinates generated by AI so auto-layout lays out nodes cleanly.
 * If existingDiagram or existingNodes is provided, any node whose id exists in the original
 * will preserve its existing pos({x, y}), while new nodes will have pos removed for auto-layout.
 */
export function sanitizeDiagramAiOutput(
  model: DiagramModel,
  existingModelOrNodes?: DiagramModel | DiagramNode[] | null,
): DiagramModel {
  const existingNodes = Array.isArray(existingModelOrNodes)
    ? existingModelOrNodes
    : (existingModelOrNodes?.nodes ?? []);

  const existingPosMap = new Map<string, [number, number]>();
  for (const n of existingNodes) {
    if (Array.isArray(n.pos) && n.pos.length >= 2 && typeof n.pos[0] === "number" && typeof n.pos[1] === "number") {
      existingPosMap.set(n.id, [n.pos[0], n.pos[1]]);
    } else if (n.pos && typeof (n.pos as unknown as { x?: number; y?: number }).x === "number" && typeof (n.pos as unknown as { x?: number; y?: number }).y === "number") {
      const obj = n.pos as unknown as { x: number; y: number };
      existingPosMap.set(n.id, [obj.x, obj.y]);
    }
  }

  return {
    ...model,
    nodes: model.nodes.map((n) => {
      const copy = { ...n };
      const preservedPos = existingPosMap.get(n.id);
      if (preservedPos) {
        copy.pos = [preservedPos[0], preservedPos[1]];
      } else {
        delete copy.pos;
      }
      return copy;
    }),
  };
}

/** Verify that two models have identical structural elements (nodes, edges, groups, states). */
export function isDiagramStructureEqual(a: DiagramModel, b: DiagramModel): boolean {
  if (a.nodes.length !== b.nodes.length) return false;
  if (a.edges.length !== b.edges.length) return false;
  if (a.groups.length !== b.groups.length) return false;

  const aStates = a.states ?? [];
  const bStates = b.states ?? [];
  if (aStates.length !== bStates.length) return false;
  for (let i = 0; i < aStates.length; i++) {
    if (aStates[i] !== bStates[i]) return false;
  }

  const aNodesMap = new Map<string, DiagramNode>();
  for (const n of a.nodes) {
    aNodesMap.set(n.id, n);
  }
  for (const bNode of b.nodes) {
    const aNode = aNodesMap.get(bNode.id);
    if (!aNode) return false;
    if (aNode.label !== bNode.label) return false;
    if ((aNode.desc ?? "") !== (bNode.desc ?? "")) return false;
    if ((aNode.group ?? "") !== (bNode.group ?? "")) return false;
    if ((aNode.shape ?? "") !== (bNode.shape ?? "")) return false;
    if ((aNode.icon ?? "") !== (bNode.icon ?? "")) return false;
    const aRows = aNode.rows ?? [];
    const bRows = bNode.rows ?? [];
    if (aRows.length !== bRows.length) return false;
    for (let i = 0; i < aRows.length; i++) {
      if (aRows[i] !== bRows[i]) return false;
    }
  }

  const aGroupMap = new Map<string, DiagramGroup>();
  for (const g of a.groups) {
    aGroupMap.set(g.id, g);
  }
  for (const bGroup of b.groups) {
    const aGroup = aGroupMap.get(bGroup.id);
    if (!aGroup) return false;
    if (aGroup.title !== bGroup.title) return false;
  }

  const aEdgesMap = new Map<string, DiagramEdge>();
  for (const e of a.edges) {
    aEdgesMap.set(e.id, e);
  }
  for (const bEdge of b.edges) {
    const aEdge = aEdgesMap.get(bEdge.id);
    if (!aEdge) return false;
    if (aEdge.from !== bEdge.from || aEdge.to !== bEdge.to) return false;
    if ((aEdge.label ?? "") !== (bEdge.label ?? "")) return false;
  }

  return true;
}

