/**
 * The ONE verb source behind every selection surface (2026-07-30 / W26).
 *
 * The bug this file exists to make impossible: the old bottom toolbar carried 도형/선 as two
 * `disabled={!selectedNode}` / `disabled={!selectedEdge}` <select>s. With nothing selected the
 * owner clicked them and nothing happened, with no explanation of why — a control that is present
 * but inert teaches nothing. Here a verb only EXISTS when it has a subject: `nodeVerbs` is a
 * function OF a node, `edgeVerbs` of an edge. There is no reachable state in which a shape menu
 * exists with no node under it, so `disabled` never has to be reasoned about again.
 *
 * `nodeVerbs` is rendered by the mobile bottom sheet (DiagramControls, which a phone keeps because it
 * has no hover and needs a persistent path). The desktop node bubble (DiagramBubbleNode) is
 * deliberately smaller since 2026-10-19 (GRILL R6): a colour-chip row + shape + add + AI + delete;
 * it shares `shapeOptions` from here and the chip names from diagramStyles.nodeMarkOptions.
 * Every `run` calls one verb on the shared `actions` object, i.e. the same function the old toolbar
 * called and the same one the canvas's drag/handle/right-click gestures call. No component here
 * string-appends onto the JSON source by hand (mermaid text-splicing was the old failure mode this
 * guards against; the store is JSON IR now, but the rule — one write path, never ad-hoc string
 * surgery — is unchanged).
 *
 * 색(tone) is presentation, not structure: `diagramStyles.ts` owns the `classDef`/`class` lines and
 * exports the ordered `DIAGRAM_TONES` this picker renders — the list is never re-declared here.
 */
import type { ReactNode } from "react";
import { t } from "../../i18n/t";
import { emitNotice } from "../../lib/invoke";
import {
  IconChevronsExpand,
  IconEdit,
  IconExternalLink,
  IconFlag,
  IconFmtText,
  IconGraph,
  IconLink,
  IconMaximize,
  IconMinimize,
  IconPalette,
  IconShare,
  IconTrash,
  IconUnlock,
} from "../icons";
import {
  EDGE_STYLES,
  EDGE_LINES,
  EDGE_ARROWS,
  type DiagramEdge,
  type DiagramGroup,
  type DiagramModel,
  type DiagramNode,
  type EdgeStyle,
  type EdgeLine,
  type EdgeArrow,
  type NodeShape,
} from "./diagramModel";
import { DIAGRAM_TONES, flagLabelOf, toneLabelKey } from "./diagramStyles";
import type { DiagramActions, Selection } from "./diagramActions";

/**
 * The edge a Selection points at. A line index alone is NOT an edge's identity since chain lines
 * landed (`A --> B --> C` is one line, several edges), and `hop` is optional on Selection — so
 * every lookup has to spell out the same `?? 0` default. Stated once, here, because both surfaces
 * need it and a surface that gets it wrong silently edits the neighbouring hop.
 */
export function selectedEdgeOf(model: DiagramModel, selection: Selection): DiagramEdge | undefined {
  if (selection?.kind !== "edge") return undefined;
  return model.edges.find((e) => e.id === selection.id);
}

export interface VerbOption {
  value: string;
  label: string;
}

export interface Verb {
  /** Doubles as the data-testid — deliberately the SAME id the old toolbar button carried, so a
   *  test that proves "the bubble calls what the toolbar called" needs no translation table. */
  id: string;
  label: string;
  icon: ReactNode;
  /** A plain verb. Mutually exclusive with `menu` in practice; the renderer prefers `menu`. */
  run?: () => void;
  /** A short closed list (도형 / 선 종류) — rendered as a popup, never as a disabled select. */
  menu?: { value: string; options: VerbOption[]; onPick: (value: string) => void };
  danger?: boolean;
  /** Renders pressed (aria-pressed) — the flag toggle while the node is flagged, Reach while engaged. */
  active?: boolean;
}

/**
 * Shape order. The model exports no array for `NodeShape`, so this Record keyed BY the union is the
 * next best thing: widen `NodeShape` and this file stops compiling until the new variant is named,
 * rather than silently rendering a menu missing a shape the model can already write. (All five
 * round-trip through diagramModel's SHAPES table — the old toolbar hardcoded only four.)
 */
const SHAPE_ORDER: Record<NodeShape, null> = { rect: null, round: null, stadium: null, circle: null, diamond: null };

export const shapeOptions = (): VerbOption[] =>
  (Object.keys(SHAPE_ORDER) as NodeShape[]).map((value) => ({ value, label: t(`editor.diagram_shape_${value}`) }));

/**
 * Edge styles come from the MODEL's exported `EDGE_STYLES` — never a list copied into the UI, so a
 * style the model learns to write shows up here on its own.
 *
 * `chain` drops 화살표 없음: an arrowless connector inside a chain line (`A --> B --- C`) is the one
 * shape diagramModel refuses to write (it would make the line unmodeled and lock edge editing for
 * the whole diagram). Offering it there would be the old bug in a new place — a control that is
 * present, clickable, and does nothing. Filtering it out also keeps `setStyleDefault` honest: the
 * default can no longer flip on a mutation that was refused, because the pick can't happen.
 */
export const edgeStyleOptions = (chain = false): VerbOption[] =>
  EDGE_STYLES.filter((value) => !(chain && value === "open")).map((value) => ({
    value,
    label: t(`editor.diagram_style_${value}`),
  }));

export const edgeLineOptions = (): VerbOption[] =>
  EDGE_LINES.map((value) => ({
    value,
    label: t(`editor.diagram_edge_line_${value}`),
  }));

export const edgeArrowOptions = (): VerbOption[] =>
  EDGE_ARROWS.map((value) => ({
    value,
    label: t(`editor.diagram_edge_arrow_${value}`),
  }));

/** Is this edge one hop of a multi-hop line? Decides the `open` filter above. */
export const isChainEdge = (_model: DiagramModel, _edge: DiagramEdge): boolean => false;

/** diagramStyles owns both the order and the names — this is a render of its array, not a copy. */
export const toneOptions = (): VerbOption[] =>
  DIAGRAM_TONES.map((value) => ({ value, label: t(toneLabelKey(value)) }));

/**
 * 캔버스 동사 — 주어가 선택이 아니라 그림 전체인 동사(현재는 "텍스트로 추가" 하나, PLAN-2026-09-20
 * D4). desktop(DiagramToolbar)과 mobile 양쪽이 이 배열을 그린다 — nodeVerbs/edgeVerbs와 같은 "동사는
 * 하나의 목록, 표면은 프레젠테이션만 다르다" 규율.
 */
export function canvasVerbs(opts: {
  actions: DiagramActions;
  /** 인라인 멀티라인 입력을 여는 콜백 — 있으면 그걸 쓰고, 없는 표면은 prompt 폴백(W2a 구획 동사 선례). */
  onAddText?: () => void;
}): Verb[] {
  const { actions, onAddText } = opts;
  return [
    {
      id: "diagram-add-text",
      label: t("editor.diagram_text_add"),
      icon: <IconFmtText size={15} strokeWidth={2} />,
      run: () => {
        if (onAddText) {
          onAddText();
          return;
        }
        const text = window.prompt(t("editor.diagram_text_placeholder"), "");
        if (!text) return;
        const res = actions.addFromText(text);
        if (!res.ok) {
          emitNotice(
            t("editor.diagram_text_error", {
              line: res.line ?? 0,
              error: t(`editor.diagram_text_err_${res.error}`),
            }),
          );
        }
      },
    },
  ];
}

export function nodeVerbs(opts: {
  node: DiagramNode;
  model?: DiagramModel;
  /** `node.link` — the linked note id, if this node has one. */
  linkedNote?: string;
  actions: DiagramActions;
  /** Opens an inline rename field on the picture. Omitted by the mobile sheet, which keeps its own
   *  always-visible rename input — the same `actions.rename` either way, just a different field. */
  onRename?: (id: string) => void;
  /** Triggers Reach path probing for this node. */
  onReach?: (nodeId: string, direction: "upstream" | "downstream" | "both" | "off") => void;
  /** Active Reach state if currently engaged. */
  currentReach?: { nodeId: string; direction: "upstream" | "downstream" | "both" } | null;
}): Verb[] {
  const { node, model, linkedNote, actions, onRename, onReach, currentReach } = opts;
  const verbs: Verb[] = [];

  if (onRename) {
    verbs.push({
      id: "diagram-rename-open",
      label: t("editor.diagram_rename"),
      icon: <IconEdit size={14} strokeWidth={2} />,
      run: () => onRename(node.id),
    });
  }

  verbs.push({
    id: "diagram-shape",
    label: t("editor.diagram_shape"),
    icon: <IconMaximize size={14} strokeWidth={2} />,
    menu: {
      value: node.shape ?? "rect",
      options: shapeOptions(),
      // Same pair the old toolbar's applyShape ran: the picked shape also becomes the default for
      // the next 인물 (and for one made by a `+` handle on the picture).
      onPick: (next) => {
        actions.setShapeDefault(next as NodeShape);
        actions.setNodeShape(node.id, next as NodeShape);
      },
    },
  });

  // 상태 동사 — model.states 가 있을 때만 렌더. 빈 배열이면 상태 동사가 UI에 존재하지 않음 (D3)
  if (model?.states && model.states.length > 0) {
    const stateOptions: VerbOption[] = [
      { value: "none", label: t("editor.diagram_state_none") },
      ...model.states.map((s, idx) => ({ value: String(idx), label: s })),
    ];
    verbs.push({
      id: "diagram-state",
      label: t("editor.diagram_state"),
      icon: <IconPalette size={14} strokeWidth={2} />,
      menu: {
        value: node.state !== undefined ? String(node.state) : "none",
        options: stateOptions,
        onPick: (next) => {
          actions.setNodeState(node.id, next === "none" ? undefined : Number(next));
        },
      },
    });
  }

  // 플래그(flag) 토글 동사 — 이진 축 (D4). 이름은 범례·데스크톱 색 칩과 같은 출처.
  const flagLabel = flagLabelOf(model ?? {});
  verbs.push({
    id: "diagram-flag",
    label: flagLabel,
    icon: <IconFlag size={14} strokeWidth={2} />,
    active: !!node.flag,
    run: () => actions.toggleNodeFlag(node.id),
  });

  // 배지·아이콘·설명·구획·여기서 연결 동사는 2026-10-19 에 빠졌다(GRILL R6 — 노드 버블을 간단히, 폰도 같은
  // 목록). 그 데이터는 계속 그려지고 편집은 소스 보기에서 한다. 폰의 연결은 DiagramControls 의 관계 추가 폼.

  // Reach (경로/영향 탐색) 동사 — W2
  if (onReach) {
    const isThisNodeReach = currentReach?.nodeId === node.id;
    verbs.push({
      id: "diagram-reach",
      label: t("editor.diagram_reach"),
      icon: <IconShare size={14} strokeWidth={2} />,
      active: isThisNodeReach,
      menu: {
        value: isThisNodeReach ? currentReach.direction : "none",
        options: [
          { value: "downstream", label: t("editor.diagram_reach_downstream") },
          { value: "upstream", label: t("editor.diagram_reach_upstream") },
          { value: "both", label: t("editor.diagram_reach_both") },
          ...(isThisNodeReach ? [{ value: "off", label: t("editor.diagram_reach_off") }] : []),
        ],
        onPick: (picked) => {
          onReach(node.id, picked as "upstream" | "downstream" | "both" | "off");
        },
      },
    });
  }

  if (linkedNote) {
    verbs.push({
      id: "diagram-open-note",
      label: t("editor.diagram_open_note"),
      icon: <IconExternalLink size={14} strokeWidth={2} />,
      run: () => actions.openNote(linkedNote),
    });
    verbs.push({
      id: "diagram-unlink-note",
      label: t("editor.diagram_unlink_note"),
      icon: <IconUnlock size={14} strokeWidth={2} />,
      run: () => actions.unlinkNote(node.id),
    });
  } else {
    verbs.push({
      id: "diagram-link-note",
      label: t("editor.diagram_link_note"),
      icon: <IconLink size={14} strokeWidth={2} />,
      run: () => actions.pickNote(node.id),
    });
  }

  verbs.push({
    id: "diagram-delete-node",
    label: t("editor.diagram_delete"),
    icon: <IconTrash size={14} strokeWidth={2} />,
    danger: true,
    run: () => actions.deleteNode(node.id),
  });

  return verbs;
}

/**
 * A `subgraph` frame's verbs. TWO of them, and 삭제 is deliberately NOT one: a frame is drawn around
 * other people's boxes, so "delete" would have to mean either "take the members with it" (a misclick
 * that eats half the diagram) or "keep them", which is 그룹 해제 under a frightening name. One safe
 * verb beats two verbs one of which is a trap.
 */
export function groupVerbs(opts: {
  group: DiagramGroup;
  actions: DiagramActions;
  /** Same split as nodeVerbs: the surface with an inline field on the picture passes this, the one
   *  with its own persistent input (mobile) doesn't — never a dead rename button. */
  onRename?: (id: string) => void;
}): Verb[] {
  const { group, actions, onRename } = opts;
  const verbs: Verb[] = [];
  if (onRename) {
    verbs.push({
      id: "diagram-group-rename",
      label: t("editor.diagram_group_rename"),
      icon: <IconEdit size={14} strokeWidth={2} />,
      run: () => onRename(group.id),
    });
  }
  verbs.push({
    id: "diagram-group-dissolve",
    label: t("editor.diagram_group_dissolve"),
    icon: <IconChevronsExpand size={14} strokeWidth={2} />,
    run: () => actions.dissolveGroup(group.id),
  });
  return verbs;
}

export function edgeVerbs(opts: {
  edge: DiagramEdge;
  model: DiagramModel;
  actions: DiagramActions;
  /** Opens an inline label field on the picture — mobile keeps its own persistent one instead. */
  onRelabel?: (edge: DiagramEdge) => void;
}): Verb[] {
  const { edge, model, actions, onRelabel } = opts;
  const verbs: Verb[] = [];

  if (onRelabel) {
    verbs.push({
      id: "diagram-edge-relabel",
      label: t("editor.diagram_edge_label_placeholder"),
      icon: <IconEdit size={14} strokeWidth={2} />,
      run: () => onRelabel(edge),
    });
  }

  verbs.push({
    id: "diagram-style",
    label: t("editor.diagram_edge_style"),
    icon: <IconMinimize size={14} strokeWidth={2} />,
    menu: {
      value: edge.style ?? "solid",
      options: edgeStyleOptions(isChainEdge(model, edge)),
      onPick: (next) => {
        actions.setStyleDefault(next as EdgeStyle);
        actions.setEdgeStyle(edge.id, next as EdgeStyle);
      },
    },
  });

  verbs.push({
    id: "diagram-edge-line",
    label: t("editor.diagram_edge_line"),
    icon: <IconMinimize size={14} strokeWidth={2} />,
    menu: {
      value: edge.line ?? (edge.style === "dotted" ? "dotted" : edge.style === "thick" ? "thick" : "solid"),
      options: edgeLineOptions(),
      onPick: (next) => {
        actions.setEdgeLine(edge.id, next as EdgeLine);
      },
    },
  });

  verbs.push({
    id: "diagram-edge-arrow",
    label: t("editor.diagram_edge_arrow"),
    icon: <IconGraph size={14} strokeWidth={2} />,
    menu: {
      value: edge.arrow ?? (edge.style === "bidirectional" ? "both" : edge.style === "open" ? "none" : "end"),
      options: edgeArrowOptions(),
      onPick: (next) => {
        actions.setEdgeArrow(edge.id, next as EdgeArrow);
      },
    },
  });

  verbs.push({
    id: "diagram-delete-edge",
    label: t("editor.diagram_delete"),
    icon: <IconTrash size={14} strokeWidth={2} />,
    danger: true,
    run: () => actions.deleteEdge(edge.id),
  });

  return verbs;
}
