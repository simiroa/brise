/**
 * useDiagramGestures — the rules a diagram canvas must agree with itself on, stated once (2026-08-12).
 *
 * HISTORY: this existed because there were two picture surfaces — FlowCanvas (React Flow), drawing a
 * flowchart every line of which the model could address, and DiagramCanvas (mermaid SVG), drawing
 * everything else (sequenceDiagram/mindmap, and a flowchart carrying a connector line the model
 * refused to model, e.g. `A --> B & C`). DiagramCanvas was deleted in the 2026-09-04 JSON IR rebuild
 * (commit 88195857) along with the mermaid diagram kinds it existed to draw, so FlowCanvas is now the
 * only consumer of this hook. The rules stay centralized here rather than folded back into
 * FlowCanvas: the reason they were pulled out in the first place — a rule stated once instead of
 * copy-pasted per canvas — is exactly the property that protects against the next renderer this
 * codebase grows, and the 2026-08-12 self-loop incident is the shape of the bug that centralizing
 * prevents: one rule about `A --> A` lived in three files, one of them was fixed, and the other paths
 * quietly kept the old answer. The rules below are the ones that are about MEANING rather than
 * presentation — precedence of a node click, what a background click clears, which keys are
 * 되돌리기/삭제 — so they are the ones that must never be typed twice:
 *
 *   • clickNode  — open the linked note (second click on an already-selected linked box) → plain select.
 *     The click-to-connect step that used to come first (arming [+ 관계] / 여기서 연결) is gone
 *     (2026-10-19, GRILL R6): desktop connects by dragging a node's border handle (FlowCanvas
 *     onConnect / onConnectEnd — a drag from one handle to another handle of the SAME box is how
 *     `A --> A` is said now), the phone by DiagramControls' 관계 추가 form (from/to pickers).
 *   • clickOther — an edge or a `subgraph` frame click is a plain select.
 *   • clear      — background/pane: the selection goes. Never 소스 편집
 *     (2026-08-01 owner reversal; that lives on explicit buttons only).
 *   • handleKey  — Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y and Delete/Backspace on the selection. Returns
 *     true when it consumed the event, so a canvas with extra keys of its own (the deleted
 *     DiagramCanvas's Tab/Enter/F2 were the original example) keeps them without re-implementing these.
 *
 * What is deliberately NOT here: anything that depends on how a canvas is DRAWN — hit-testing (the
 * deleted DiagramCanvas used mermaid `g.node` ids; FlowCanvas uses React Flow's `data-id`), where an
 * inline field is positioned, drag/pan. Those differences are presentation, not meaning, and
 * pretending otherwise would buy a parameter for every difference. The verbs themselves were already
 * shared (bubbles/verbs.tsx → diagramActions.ts); this file is the gesture half of the same contract.
 */
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { DiagramActions, Selection } from "./diagramActions";
import type { DiagramEdge, DiagramGroup, DiagramModel, DiagramNode } from "./diagramModel";
import { selectedEdgeOf } from "./verbs";

export interface DiagramGestures {
  /** What the current `Selection` actually resolves to — a selection can outlive its object. */
  selectedNode: DiagramNode | undefined;
  selectedEdge: DiagramEdge | undefined;
  selectedGroup: DiagramGroup | undefined;
  nodeLabel: (id: string) => string;
  clear: () => void;
  clickNode: (id: string) => void;
  clickOther: (s: Selection) => void;
  /** true = handled here; the caller must not run its own extra key verbs. */
  handleKey: (e: ReactKeyboardEvent<HTMLElement>) => boolean;
}

export function useDiagramGestures(opts: {
  model: DiagramModel;
  selection: Selection;
  onSelect: (s: Selection) => void;
  actions: DiagramActions;
  onUndo: () => void;
  onRedo: () => void;
}): DiagramGestures {
  const { model, selection, onSelect, actions, onUndo, onRedo } = opts;

  const clear = () => {
    onSelect(null);
  };

  const clickNode = (id: string) => {
    // Second click on an already-selected linked node opens its note.
    const link =
      selection?.kind === "node" && selection.id === id ? model.nodes.find((n) => n.id === id)?.link : undefined;
    if (link) {
      actions.openNote(link);
      return;
    }
    onSelect({ kind: "node", id });
  };

  const clickOther = (s: Selection) => {
    onSelect(s);
  };

  const handleKey = (e: ReactKeyboardEvent<HTMLElement>): boolean => {
    if (e.ctrlKey || e.metaKey) {
      const key = e.key.toLowerCase();
      if (key === "z") {
        e.preventDefault();
        if (e.shiftKey) onRedo();
        else onUndo();
      } else if (key === "y") {
        e.preventDefault();
        onRedo();
      }
      // Every OTHER Ctrl/⌘ combo is somebody else's (the app's, the browser's) — consumed here so a
      // canvas's plain-key verbs can't fire off Ctrl+Tab.
      return true;
    }
    if (e.key !== "Delete" && e.key !== "Backspace") return false;
    if (selection?.kind === "node") {
      e.preventDefault();
      actions.deleteNode(selection.id);
      return true;
    }
    if (selection?.kind === "edge") {
      e.preventDefault();
      actions.deleteEdge(selection.id);
      return true;
    }
    // ponytail: single selection only, on both canvases. A multi-select delete needs the mutations
    // sequenced into ONE 되돌리기 step — add `deleteMany` to diagramModel the day someone asks.
    return false;
  };

  return {
    selectedNode: selection?.kind === "node" ? model.nodes.find((n) => n.id === selection.id) : undefined,
    selectedEdge: selectedEdgeOf(model, selection),
    selectedGroup: selection?.kind === "group" ? model.groups.find((g) => g.id === selection.id) : undefined,
    nodeLabel: (id: string) => model.nodes.find((n) => n.id === id)?.label ?? id,
    clear,
    clickNode,
    clickOther,
    handleKey,
  };
}
