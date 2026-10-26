/**
 * flowLayout — where a box sits on the React Flow canvas, and nothing else.
 *
 * Two sources of position, in this order:
 *   1. the node's own `pos: [x, y]` field in the JSON IR — the user dragged
 *      it there.
 *   2. the layout function for `model.layout` (`layouts/`, via `layoutFor`; dagre when there is
 *      none) — for every node that has never been dragged.
 * So a fresh (or AI-written) diagram is tidy on first paint without anyone having to press
 * anything, and a diagram the user has arranged by hand stays exactly where they left it. Mixing
 * the two per-node rather than "all or nothing" is deliberate: adding one box to an arranged
 * diagram must not re-shuffle the twenty boxes around it. dagre only runs when source 2 is actually
 * needed — a fully arranged diagram skips it entirely (layoutPositions).
 *
 * Kept out of FlowCanvas.tsx on purpose — this is arithmetic with no React and no @xyflow import,
 * so the placement rules can be tested without mounting a canvas (React Flow measures real DOM;
 * jsdom would report every box as 0×0 and prove nothing).
 */
import { Graph, layout } from "@dagrejs/dagre";
import type { DiagramGroup, DiagramLayout, DiagramModel, Direction } from "./diagramModel";
import type { LayoutFn, LayoutResult } from "./layouts/_types";
import { radialLayout } from "./layouts/radial";
import { lanesLayout } from "./layouts/lanes";
import { gridLayout } from "./layouts/grid";
import { quadrantLayout } from "./layouts/quadrant";
import { stackLayout } from "./layouts/stack";
import { circleLayout } from "./layouts/circle";
import { fishboneLayout } from "./layouts/fishbone";
import { sequenceLayout } from "./layouts/sequence";

export type { LayoutFn, LayoutResult } from "./layouts/_types";

/**
 * Can this diagram be drawn as a graph at all?
 *
 * HISTORY (pre 2026-09-04 JSON IR rebuild, commit 88195857): `structured` used to rule out mermaid
 * diagram kinds FlowCanvas couldn't draw (sequenceDiagram/mindmap/etc) and a separate `edgesComplete`
 * check ruled out a flowchart with a connector line the model refused to address (`A --> B & C`, an
 * arrow pointing AT a subgraph) — drawing those as a node/edge graph would silently DROP the
 * relations we couldn't parse, so both cases fell back to DiagramCanvas, a mermaid-SVG renderer.
 *
 * Neither case exists any more. The JSON IR only models flowchart-shaped graphs, so `edgesComplete`
 * is gone and DiagramCanvas was deleted with it. `structured` now means only "the JSON parsed and
 * validated" (diagramSchema.parseDiagramJson/validateDiagramModel) — false for malformed JSON, not
 * for a diagram "shape". A `subgraph`/group is still not a reason to decline — its body is modeled
 * (diagramModel) and drawn as a React Flow parent node in FlowCanvas, the only renderer left.
 *
 * MOVED HERE from FlowCanvas.tsx (2026-09-01): DiagramSection needs this decision BEFORE it knows
 * whether to show FlowCanvas's interactive toolbar controls (zoom/pan — see DiagramToolbar's
 * `useFlow` prop), so it cannot live inside the file that only the flow renderer's lazy chunk loads
 * — importing it from FlowCanvas.tsx would drag the whole @xyflow/react chunk into every mobile note
 * that merely opens a diagram section. flowLayout.ts is already "no React, no @xyflow import" by
 * convention (see file banner), so it is the correct home. FlowCanvas.tsx re-exports it for its own
 * test file's `import ... from "./FlowCanvas"`.
 */
export function canFlowRender(model: DiagramModel): boolean {
  return model.structured && !model.empty;
}

export interface XY {
  x: number;
  y: number;
}

/** The SMALLEST box, and the one every short label gets — a diagram of one-word boxes stays a grid
 *  of identical tiles. Must match the CSS in tokens.css (`.diagram-flow-node`) or the gaps dagre
 *  reserves stop matching the boxes actually drawn. */
export const NODE_W = 144;
export const NODE_H = 36;
/** A long label grows the box sideways to here; past it the label wraps to a second line (and past
 *  TWO lines the CSS ellipsis takes over). Wider than this and a diagram of sentences stops looking
 *  like a diagram. */
export const NODE_MAX_W = 216;
/** The second line's worth of height. */
export const NODE_LINE_H = 16;
/** The `%% brise:meta` description line under the label — smaller type, one line, never wraps. */
export const NODE_DESC_H = 15;
/** How much narrower the description's type is than the label's, for the width estimate. */
const DESC_SCALE = 0.85;

/** Node chrome, in px: `padding: var(--space-1) var(--space-3)` on both sides + the 1px borders. */
const NODE_PAD = 10 * 2 + 2;
/** The 링크 icon and its gap, when a node carries one. */
const LINK_CHROME = 11 + 4;
/** The `%% brise:meta` icon (an emoji glyph) and its gap. */
const ICON_CHROME = 16 + 4;

/** CJK/Hangul/Kana/fullwidth — the ranges that draw twice as wide as Latin at the same size. */
const WIDE_RE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/;

/**
 * Label width in px, by character class rather than by canvas measureText.
 *
 * ponytail: a HEURISTIC, deliberately. measureText needs a real 2D context, which jsdom does not
 * have — the estimate would then be the one number in this file no test could check, and it is the
 * number both dagre's spacing and the edges' border intersections are built on. Calibrated for
 * `--text-sm` (12px) 본문 폰트; a user who scales `--fs` up gets boxes a few px tight, which the CSS
 * min-width absorbs. Upgrade path: measure once in FlowCanvas and pass the two constants in.
 */
export function labelWidth(label: string): number {
  let w = 0;
  for (const ch of label) w += WIDE_RE.test(ch) ? 12.4 : 7.1;
  return w;
}

/**
 * How big one box has to be for its label to fit: minimum size for short labels, growing sideways
 * to NODE_MAX_W, then a second line. Both dagre (so auto-arrange leaves real gaps) and the floating
 * edge paths (so a line stops at the border actually drawn) read this — an estimate used by only
 * one of them would put the arrows a few px inside or outside every wide box.
 */
export function nodeSize(node: {
  label: string;
  linked?: boolean;
  /** `%% brise:meta` — the icon widens the first row, the description adds a second one. */
  icon?: string;
  desc?: string;
  /** 구획 — one NODE_LINE_H per row under the label (ER columns, class members). */
  rows?: string[];
}): { width: number; height: number } {
  const chrome = NODE_PAD + (node.linked ? LINK_CHROME : 0) + (node.icon ? ICON_CHROME : 0);
  // The description and the rows sit UNDER the label, so they compete for width, not for the same row.
  const rows = node.rows ?? [];
  const wanted = Math.ceil(
    Math.max(
      labelWidth(node.label),
      node.desc ? labelWidth(node.desc) * DESC_SCALE : 0,
      ...rows.map((r) => labelWidth(r) * DESC_SCALE),
    ) + chrome,
  );
  const extra = (node.desc ? NODE_DESC_H : 0) + rows.length * NODE_LINE_H;
  if (wanted <= NODE_W) return { width: NODE_W, height: NODE_H + extra };
  if (wanted <= NODE_MAX_W) return { width: wanted, height: NODE_H + extra };
  return { width: NODE_MAX_W, height: NODE_H + NODE_LINE_H + extra };
}

/** Every node's box size, keyed by id — what FlowCanvas hands React Flow and what dagre plans with. */
export function nodeSizes(model: DiagramModel): Record<string, { width: number; height: number }> {
  const out: Record<string, { width: number; height: number }> = {};
  for (const node of model.nodes) {
    out[node.id] = nodeSize({ label: node.label, linked: !!node.link, icon: node.icon, desc: node.desc, rows: node.rows });
  }
  return out;
}

/** The JSON IR's `direction` values vs dagre's rankdir. `Direction` (diagramSchema.ts) still carries
 *  TD alongside TB — a holdover from mermaid's spelling of TB, kept so an old mermaid-derived
 *  diagram's direction still means the same thing after the JSON IR migration. The other four are
 *  the same tokens in both. */
const RANKDIR: Record<Direction, string> = { TD: "TB", TB: "TB", LR: "LR", RL: "RL", BT: "BT" };

export const DAGRE_NODESEP = 48;
export const DAGRE_RANKSEP = 72;

/** Generic box layout used by diagrams and canvas pages. */
export function layoutBoxes(
  nodes: { id: string; width: number; height: number }[],
  edges: { from: string; to: string }[],
  rankdir: "TB" | "LR" | "BT" | "RL" = "TB",
  nodesep = DAGRE_NODESEP,
  ranksep = DAGRE_RANKSEP,
): Record<string, XY> {
  const g = new Graph();
  g.setGraph({ rankdir, nodesep, ranksep, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: n.width, height: n.height });
  for (const e of edges) if (e.from !== e.to) g.setEdge(e.from, e.to);
  layout(g);
  const out: Record<string, XY> = {};
  for (const n of nodes) {
    const laid = g.node(n.id) as { x?: number; y?: number } | undefined;
    out[n.id] = {
      x: Math.round((laid?.x ?? 0) - n.width / 2),
      y: Math.round((laid?.y ?? 0) - n.height / 2),
    };
  }
  return out;
}

/**
 * Runs dagre over the WHOLE model and returns a top-left corner per node.
 *
 * dagre reports node CENTRES; React Flow positions the top-left corner. Every caller would
 * otherwise repeat that subtraction, and the one that forgot would draw the diagram half a box off.
 */
export function dagreLayout(model: DiagramModel): Record<string, XY> {
  // `compound` so a `subgraph`'s members land TOGETHER (dagre's own cluster support, via setParent)
  // instead of being scattered by rank alone — the picture then matches the box FlowCanvas draws
  // around them. It costs nothing on a diagram with no groups.
  const g = new Graph({ compound: true });
  const sizes = nodeSizes(model);
  g.setGraph({ rankdir: RANKDIR[model.direction] ?? "TB", nodesep: 48, ranksep: 72, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const node of model.nodes) g.setNode(node.id, { ...sizes[node.id] });
  // A cluster with nothing in it would leave dagre a dimensionless node, so only the groups that
  // actually hold something are declared.
  const used = new Set(model.groups.filter((group) => hasMembers(model, group.id)).map((group) => group.id));
  for (const id of used) g.setNode(id, {});
  for (const group of model.groups) {
    if (used.has(group.id) && group.parent && used.has(group.parent)) g.setParent(group.id, group.parent);
  }
  for (const node of model.nodes) if (node.group && used.has(node.group)) g.setParent(node.id, node.group);
  // Parallel edges collapse to one here — dagre only needs to know the ranks are connected, and a
  // second edge between the same pair would not move either box.
  for (const edge of model.edges) if (edge.from !== edge.to) g.setEdge(edge.from, edge.to);
  layout(g);

  const out: Record<string, XY> = {};
  for (const node of model.nodes) {
    const laid = g.node(node.id) as { x?: number; y?: number } | undefined;
    out[node.id] = {
      x: Math.round((laid?.x ?? 0) - sizes[node.id].width / 2),
      y: Math.round((laid?.y ?? 0) - sizes[node.id].height / 2),
    };
  }
  return out;
}

/**
 * Saved positions where they exist, dagre's slot everywhere else.
 *
 * A diagram the user has finished arranging by hand has a `%% brise:pos` for every node, so dagre's
 * whole result would be overwritten line for line — it used to run anyway, on every drag, undo and
 * re-parse. When nothing is missing there is nothing to plan, so it doesn't run at all.
 *
 * The MIXED case is unchanged and stays deliberate (see this file's header): one new box in an
 * arranged diagram is placed by dagre and the arranged twenty keep their coordinates. Zero nodes
 * takes the same early return — `{}`, which is what dagre returned for an empty model too.
 * A node's own `pos` is the only coordinate store, so the count is simply over model.nodes — there
 * is no separate map that could still name a node which no longer exists.
 */
export function layoutPositions(model: DiagramModel): Record<string, XY> {
  const saved: Record<string, XY> = {};
  for (const node of model.nodes) {
    if (node.pos) saved[node.id] = { x: node.pos[0], y: node.pos[1] };
  }
  if (Object.keys(saved).length === model.nodes.length) return saved;
  return { ...layoutFor(model, nodeSizes(model)).positions, ...saved };
}

/**
 * 배치 문법 dispatch (PLAN-2026-09-20 §2.1). `model.layout` 이 없거나 모르는 값이면 dagre — 본문은 언제나
 * 열린다. 배치 함수는 `layouts/` 의 순수 함수(React·xyflow 없음)고 타입(`model.type`)을 모른다.
 * `sequence` 만 `edgeAnchors`·`lifelineH` 를 함께 돌려준다 — 그대로 흘려보낸다.
 */
const LAYOUT_FNS: Partial<Record<DiagramLayout, LayoutFn>> = {
  radial: radialLayout,
  lanes: lanesLayout,
  grid: gridLayout,
  quadrant: quadrantLayout,
  stack: stackLayout,
  circle: circleLayout,
  fishbone: fishboneLayout,
  sequence: sequenceLayout,
};

export function layoutFor(model: DiagramModel, sizes: Record<string, { width: number; height: number }>): LayoutResult {
  const fn = model.layout ? LAYOUT_FNS[model.layout] : undefined;
  return fn ? fn(model, sizes) : { positions: dagreLayout(model) };
}

/**
 * quadrant 의 축 십자 — 그룹 상자 4개(좌상·우상·좌하·우하)의 틈 한가운데를 지난다. 그룹 상자에서 파생되므로
 * 캔버스(`FlowCanvas` 배경 레이어)와 정적 SVG 가 같은 자리에 같은 선을 긋는다. 4개 미만이면 null.
 */
export function quadrantAxes(
  model: DiagramModel,
  boxes: Record<string, LayoutBox>,
): { x: number; y: number; left: number; right: number; top: number; bottom: number } | null {
  if (model.layout !== "quadrant") return null;
  const quads = model.groups.slice(0, 4).map((g) => boxes[g.id]);
  if (quads.length < 4 || quads.some((b) => !b)) return null;
  const [tl, tr, bl] = quads as LayoutBox[];
  const all = quads as LayoutBox[];
  return {
    x: Math.round((tl.x + tl.width + tr.x) / 2),
    y: Math.round((tl.y + tl.height + bl.y) / 2),
    left: Math.min(...all.map((b) => b.x)),
    right: Math.max(...all.map((b) => b.x + b.width)),
    top: Math.min(...all.map((b) => b.y)),
    bottom: Math.max(...all.map((b) => b.y + b.height)),
  };
}

// ── subgraph boxes ─────────────────────────────────────────────────────────────────────────────
// A group's rectangle is DERIVED, never stored. `%% brise:pos` has one line per NODE and none per
// group on purpose: the members' coordinates are the whole truth, so a box can never disagree with
// what is inside it, and dragging a group is just a translation applied to its members.

/** Padding between a group's border and the boxes inside it. */
export const GROUP_PAD = 20;
/** Extra height at the top for the group's own title. */
export const GROUP_TITLE_H = 24;

/**
 * Every node that ends up inside this group, however deeply nested (walks the parent chain
 * outward from `id`, collecting descendant group ids, then returns every node whose own group
 * is in that set).
 *
 * MOVED HERE from FlowCanvas.tsx (docs/PLAN-2026-09-13-separation-of-concerns.md §4-j) — the same
 * algorithm existed twice in that file (`membersOfGroup`/`membersOf`, one `useCallback`-wrapped for
 * the group-node data prop, one a plain function for drag-move), byte-for-byte identical. Pure
 * (model.groups/model.nodes in, string[] out) so it belongs next to `groupBoxes`/`hasMembers`
 * rather than in the component that only consumes it.
 */
export function groupMembers(model: DiagramModel, id: string): string[] {
  const ids = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const g of model.groups) {
      if (g.parent && ids.has(g.parent) && !ids.has(g.id)) {
        ids.add(g.id);
        grew = true;
      }
    }
  }
  return model.nodes.filter((n) => n.group && ids.has(n.group)).map((n) => n.id);
}

/** Does anything at all live in this group (directly or through a nested one)? */
function hasMembers(model: DiagramModel, id: string): boolean {
  return (
    model.nodes.some((n) => n.group === id) ||
    model.groups.some((g) => g.parent === id && hasMembers(model, g.id))
  );
}

/** How deeply a group is nested — the sort key that lets one pass compute inner boxes before the
 *  outer boxes that have to contain them. Cycle-guarded: a malformed source must not hang the UI. */
function groupDepth(groups: DiagramGroup[], group: DiagramGroup): number {
  let depth = 0;
  let cur: DiagramGroup | undefined = group;
  while (cur?.parent && depth < groups.length) {
    cur = groups.find((g) => g.id === cur!.parent);
    depth += 1;
  }
  return depth;
}

/**
 * One absolute rectangle per `subgraph` that holds anything: the bounding box of its members, grown
 * by GROUP_PAD on every side and by GROUP_TITLE_H at the top for the name.
 *
 * Deepest group first, so a nested box is already known when its parent's bounding box is taken.
 * ponytail: a group with NO members gets no box and is simply not drawn — there is nothing to
 * derive a position from. That is why `addGroup` refuses an empty group outright (diagramModel).
 * It is still reachable by dragging the LAST member out: the `subgraph` lines survive in the source
 * but the frame stops being drawn until something is put back in it. Ceiling accepted — nothing is
 * lost and 되돌리기 brings it back. Upgrade path if it ever confuses anyone: give an empty group a
 * fixed-size placeholder box anchored at its last known origin.
 */
export function groupBoxes(
  model: DiagramModel,
  positions: Record<string, XY>,
  sizes: Record<string, { width: number; height: number }>,
): Record<string, LayoutBox> {
  const out: Record<string, LayoutBox> = {};
  const order = [...model.groups].sort((a, b) => groupDepth(model.groups, b) - groupDepth(model.groups, a));
  for (const group of order) {
    const inner: LayoutBox[] = [];
    for (const node of model.nodes) {
      const at = positions[node.id];
      const size = sizes[node.id];
      if (node.group === group.id && at && size) inner.push({ id: node.id, ...at, ...size });
    }
    for (const child of model.groups) {
      if (child.parent === group.id && out[child.id]) inner.push(out[child.id]);
    }
    if (!inner.length) continue;
    const left = Math.min(...inner.map((b) => b.x));
    const top = Math.min(...inner.map((b) => b.y));
    const right = Math.max(...inner.map((b) => b.x + b.width));
    const bottom = Math.max(...inner.map((b) => b.y + b.height));
    out[group.id] = {
      id: group.id,
      x: left - GROUP_PAD,
      y: top - GROUP_PAD - GROUP_TITLE_H,
      width: right - left + GROUP_PAD * 2,
      height: bottom - top + GROUP_PAD * 2 + GROUP_TITLE_H,
    };
  }
  return out;
}

// ── 정렬 / 분배 (multi-selection) ───────────────────────────────────────────────────────────────
// dagre arranges the WHOLE graph and owns every coordinate; these tidy a HANDFUL of boxes the user
// picked and leave the rest alone. Both take the boxes' current rectangles and return the corners
// that changed — FlowCanvas hands the whole record to setNodePositions ONCE, so a nudge of nine
// boxes is still one 되돌리기 step, exactly like 자동 정렬.
//
// Sizes matter, not just corners: aligning by top-left would leave a wide box and a narrow one
// visibly off-centre from each other under a "가운데" that claimed otherwise.

/** One box as these functions see it: React Flow's top-left corner plus its measured size. */
export interface LayoutBox extends XY {
  id: string;
  width: number;
  height: number;
}

/** Six edges/centres, named for the axis the user is thinking about, not for x/y. */
export type AlignMode = "left" | "center-x" | "right" | "top" | "center-y" | "bottom";

/** Aligns to the SELECTION'S OWN bounding box, never to the canvas: the group keeps its place on
 *  the diagram and only its inner scatter collapses, which is what makes the result predictable
 *  when it is undone or repeated. Fewer than 2 boxes = nothing to align to. */
export function alignPositions(boxes: LayoutBox[], mode: AlignMode): Record<string, XY> {
  const out: Record<string, XY> = {};
  if (boxes.length < 2) return out;
  const horizontal = mode === "left" || mode === "center-x" || mode === "right";
  const min = Math.min(...boxes.map((b) => (horizontal ? b.x : b.y)));
  const max = Math.max(...boxes.map((b) => (horizontal ? b.x + b.width : b.y + b.height)));
  for (const b of boxes) {
    const size = horizontal ? b.width : b.height;
    const at =
      mode === "left" || mode === "top"
        ? min
        : mode === "right" || mode === "bottom"
          ? max - size
          : (min + max) / 2 - size / 2;
    out[b.id] = horizontal ? { x: Math.round(at), y: b.y } : { x: b.x, y: Math.round(at) };
  }
  return out;
}

/**
 * Equal GAPS between neighbours (not equal centres): the boxes here have different widths, and
 * equal centres would leave a wide box crowding its neighbour while the narrow pair sat in a void —
 * the eye reads the whitespace, so that is what gets evened out. The two outermost boxes never
 * move, so the group's footprint is unchanged; with fewer than 3 there is no gap to even out.
 */
export function distributePositions(boxes: LayoutBox[], axis: "x" | "y"): Record<string, XY> {
  const out: Record<string, XY> = {};
  if (boxes.length < 3) return out;
  const size = (b: LayoutBox) => (axis === "x" ? b.width : b.height);
  const sorted = [...boxes].sort((a, b) => a[axis] + size(a) / 2 - (b[axis] + size(b) / 2));
  const start = Math.min(...sorted.map((b) => b[axis]));
  const end = Math.max(...sorted.map((b) => b[axis] + size(b)));
  const gap = (end - start - sorted.reduce((sum, b) => sum + size(b), 0)) / (sorted.length - 1);
  let at = start;
  for (const b of sorted) {
    out[b.id] = axis === "x" ? { x: Math.round(at), y: b.y } : { x: b.x, y: Math.round(at) };
    at += size(b) + gap;
  }
  return out;
}
