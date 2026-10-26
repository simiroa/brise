/**
 * DiagramControls — since the 2026-07-30 bubble redesign this is the TOUCH surface (and one desktop
 * fallback), not the desktop toolbar. Desktop's verbs now live in bubbles anchored to the object
 * they act on, inside the picture; DiagramSection only mounts this file when `touch` is set, or
 * when the diagram is not a flowchart (the early return below is the 소스 편집 footnote, the only
 * escape hatch for a type the structured verbs can't edit).
 *
 * A phone keeps a persistent path because it has none of what makes the bubbles work: no hover, and
 * a bar anchored to a finger-sized node would be under the finger. What it does NOT keep is a
 * second implementation — the selection rows below render `nodeVerbs`/`edgeVerbs` through the same
 * `VerbButtons` the bubble renders, so a verb added there appears here for free and both call the
 * identical function on the shared `actions` object (diagramActions.ts). No component here
 * string-appends to the source; every verb is one diagramModel mutation on DiagramSection's single
 * write path (draft → 300ms render / 700ms save / one 되돌리기 step).
 *
 * WHAT WAS DELETED, and why it can't come back: this file used to carry 도형 and 선 as two
 * `disabled={!selectedNode}` / `disabled={!selectedEdge}` <select>s. With nothing selected they were
 * visible, inert and unexplained — the owner clicked them and nothing happened. They are gone in
 * both surfaces: a shape menu now only EXISTS as a verb of a node (verbs.tsx takes the node as an
 * argument), so "present but dead" is no longer a state this UI can be in.
 *
 * Built from the app's existing vocabulary (.icon-btn / .field / .field-select, and the sidebar
 * filter's aria-pressed segment) — no new visual language, and no background of its own
 * (single-sheet surface contract).
 */
import { useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { t } from "../../i18n/t";
import { type DiagramModel } from "./diagramModel";
import type { DiagramActions, Selection } from "./diagramActions";
import { VerbButtons } from "./VerbButtons";
import { canvasVerbs, edgeVerbs, groupVerbs, nodeVerbs, selectedEdgeOf } from "./verbs";
import { DiagramTextForm } from "./DiagramSection";
import { NodePicker } from "./NodePicker";
import { IconClose, IconPlus } from "../icons";

export type { Selection };

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  flexWrap: "wrap",
};

const textBtnStyle: CSSProperties = { width: "auto", padding: "0 8px", fontSize: "var(--text-sm)" };

export interface DiagramControlsProps {
  model: DiagramModel;
  selection: Selection;
  /** The ONE verb set — the picture's drag/handle/menu gestures call these very same functions,
   *  so an action that exists in both places can never become two implementations. Each verb is
   *  one diagramModel mutation through DiagramSection's write path = one 되돌리기 step. */
  actions: DiagramActions;
  onEditSource: () => void;
  /** Undo of the last structured edit — see DiagramSection for why this exists instead of Ctrl+Z. */
  canUndo: boolean;
  onUndo: () => void;
  /** 앞으로 — the mirror. Empty (and disabled) after any new mutation or hand-typed source. */
  canRedo: boolean;
  onRedo: () => void;
}

export function DiagramControls({
  model,
  selection,
  actions,
  onEditSource,
  canUndo,
  onUndo,
  canRedo,
  onRedo,
}: DiagramControlsProps) {
  const [nodeLabel, setNodeLabel] = useState("");
  const [edgeFrom, setEdgeFrom] = useState("");
  const [edgeTo, setEdgeTo] = useState("");
  const [edgeLabel, setEdgeLabelDraft] = useState("");
  /** Which add-form is expanded. Only ever one, and adding collapses it again. */
  const [openForm, setOpenForm] = useState<"node" | "edge" | "text" | null>(null);

  const selectedNode = selection?.kind === "node" ? model.nodes.find((n) => n.id === selection.id) : undefined;
  const selectedEdge = selectedEdgeOf(model, selection);
  // A phone can select a `subgraph` frame on the flow canvas too (that canvas is mounted here with
  // bubbles off), so this surface needs its row — otherwise tapping a frame would select something
  // with nowhere to act on it, which is the dead-control state this file exists to prevent.
  const selectedGroup = selection?.kind === "group" ? model.groups.find((g) => g.id === selection.id) : undefined;
  const linkedNote = selectedNode?.link;

  // Not a flowchart (sequenceDiagram, mindmap, …). The structured verbs are unavailable.
  // So this is a quiet footnote, not an error: muted, centered, one calm line.
  // (An EMPTY body never reaches here — DiagramSection shows its own empty state instead.)
  if (!model.structured) {
    return (
      <div className="diagram-unstructured" data-testid="diagram-unstructured">
        <span>{t("editor.diagram_structured_unavailable")}</span>
        <button type="button" className="icon-btn icon-btn--sm" style={textBtnStyle} data-testid="diagram-edit-source" onClick={onEditSource}>
          {t("editor.diagram_edit_source")}
        </button>
      </div>
    );
  }

  const label = (id: string) => model.nodes.find((n) => n.id === id)?.label ?? id;

  const submitNode = () => {
    const nextLabel = nodeLabel.trim();
    if (!nextLabel) return;
    actions.addNode(nextLabel);
    setNodeLabel("");
    setOpenForm(null);
  };

  const submitEdge = () => {
    // `edgeFrom === edgeTo` is a self-loop, which the model writes now — only an unfilled pair is
    // nothing to submit.
    if (!edgeFrom || !edgeTo) return;
    actions.connect(edgeFrom, edgeTo, edgeLabel.trim());
    setEdgeLabelDraft("");
    setOpenForm(null);
  };

  // Keyboard flow for both add-forms: Enter submits (never mid-IME-composition — Korean typing),
  // Esc collapses back to the two quiet buttons.
  const onFormKey = (e: ReactKeyboardEvent<HTMLElement>, submit: () => void) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpenForm(null);
      return;
    }
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      data-testid="diagram-controls"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        padding: "var(--space-3) var(--space-4)",
        borderTop: "1px solid var(--divider)",
        flex: "none",
      }}
    >
      {/* ④ ONE toolbar row — 되돌리기 / 앞으로 / 소스 편집. The 도형/선 selects that used to sit
          here are gone: they are verbs OF a node/edge now (see the header note) and appear in the
          selection row below only when there is something to apply them to.
          The ↓/→ direction segment is gone too (2026-07-30 owner decision, do not restore — same
          note as DiagramCanvasBubble): vertical is now the unchangeable default because it fills
          the tall section area, while horizontal forced a horizontal scrollbar and made the panel's
          used height differ per note. setDirection survives in the model layer for existing
          `flowchart LR` notes and for hand editing in 소스 편집. */}
      <div style={rowStyle}>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          style={textBtnStyle}
          data-testid="diagram-undo"
          disabled={!canUndo}
          onClick={onUndo}
        >
          {t("editor.diagram_undo")}
        </button>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          style={textBtnStyle}
          data-testid="diagram-redo"
          disabled={!canRedo}
          onClick={onRedo}
        >
          {t("editor.diagram_redo")}
        </button>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          style={textBtnStyle}
          data-testid="diagram-edit-source"
          onClick={onEditSource}
        >
          {t("editor.diagram_edit_source")}
        </button>
      </div>

      {/* ② add — two quiet buttons until one is opened; adding collapses it again. */}
      {openForm === null && (
        <div style={rowStyle}>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            style={textBtnStyle}
            data-testid="diagram-add-node-toggle"
            onClick={() => setOpenForm("node")}
          >
            {t("editor.diagram_add_node_open")}
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            style={textBtnStyle}
            data-testid="diagram-add-edge-toggle"
            onClick={() => setOpenForm("edge")}
          >
            {t("editor.diagram_add_edge_open")}
          </button>
          {/* 캔버스 동사(텍스트로 추가 등) — 데스크톱 툴바와 같은 canvasVerbs 목록. 폰은 모달 대신
              아래 행에 폼을 펼친다(이 파일의 "persistent input" 원칙). */}
          <VerbButtons verbs={canvasVerbs({ actions, onAddText: () => setOpenForm("text") })} />
        </div>
      )}

      {openForm === "text" && (
        <div style={{ ...rowStyle, flexDirection: "column", alignItems: "stretch" }} data-testid="diagram-add-text-form">
          <DiagramTextForm onSubmit={actions.addFromText} onDone={() => setOpenForm(null)} />
          <button type="button" className="icon-btn icon-btn--sm" data-testid="diagram-add-text-close" title={t("common.close")} onClick={() => setOpenForm(null)} style={{ alignSelf: "flex-end" }}>
            <IconClose size={14} strokeWidth={2} />
          </button>
        </div>
      )}

      {openForm === "node" && (
        <div style={rowStyle} data-testid="diagram-add-node-form">
          <input
            className="field"
            autoFocus
            data-testid="diagram-node-label"
            value={nodeLabel}
            placeholder={t("editor.diagram_add_node_placeholder")}
            onChange={(e) => setNodeLabel(e.target.value)}
            onKeyDown={(e) => onFormKey(e, submitNode)}
            style={{ flex: "1 1 160px", minWidth: 120, padding: "4px 8px", fontSize: "var(--text-sm)" }}
          />
          <button type="button" className="icon-btn icon-btn--sm" data-testid="diagram-add-node" title={t("editor.diagram_add_node")} onClick={submitNode}>
            <IconPlus size={14} strokeWidth={2} />
          </button>
          <button type="button" className="icon-btn icon-btn--sm" data-testid="diagram-add-node-close" title={t("common.close")} onClick={() => setOpenForm(null)}>
            <IconClose size={14} strokeWidth={2} />
          </button>
        </div>
      )}

      {/* ② relation — both endpoints come from the model, so no id is ever typed. This form is the
          phone's ONE way to connect since 여기서 연결 (tap a box, then tap the other) left the node
          verbs (2026-10-19, GRILL R6) — React Flow's border handles are hover-only, so a finger
          never sees them. */}
      {openForm === "edge" && (
        <div style={rowStyle} data-testid="diagram-add-edge-form" onKeyDown={(e) => onFormKey(e, submitEdge)}>
          <NodePicker
            nodes={model.nodes}
            value={edgeFrom}
            onChange={setEdgeFrom}
            label={t("editor.diagram_edge_from")}
            testid="diagram-edge-from"
          />
          <input
            className="field"
            data-testid="diagram-edge-label"
            value={edgeLabel}
            placeholder={t("editor.diagram_edge_label_placeholder")}
            onChange={(e) => setEdgeLabelDraft(e.target.value)}
            style={{ flex: "1 1 100px", minWidth: 90, padding: "4px 8px", fontSize: "var(--text-sm)" }}
          />
          <NodePicker
            nodes={model.nodes}
            value={edgeTo}
            onChange={setEdgeTo}
            label={t("editor.diagram_edge_to")}
            testid="diagram-edge-to"
          />
          <button type="button" className="icon-btn icon-btn--sm" data-testid="diagram-add-edge" title={t("editor.diagram_add_edge")} onClick={submitEdge}>
            <IconPlus size={14} strokeWidth={2} />
          </button>
          <button type="button" className="icon-btn icon-btn--sm" data-testid="diagram-add-edge-close" title={t("common.close")} onClick={() => setOpenForm(null)}>
            <IconClose size={14} strokeWidth={2} />
          </button>
        </div>
      )}

      {/* ③⑥ actions for whatever the user tapped on the picture — mobile.css promotes these two rows
          into a real bottom sheet. The buttons come from the SAME verb list the desktop bubble
          renders; only the rename/label FIELD is local, because a phone wants a persistent input
          rather than the desktop's inline-on-the-picture one (both call actions.rename /
          actions.setEdgeLabel, so it is one verb with two fields, not two implementations). */}
      {selectedNode && (
        <div style={rowStyle} data-testid="diagram-node-actions">
          <span style={{ fontSize: "var(--text-sm)", color: "var(--muted)" }}>{selectedNode.label}</span>
          <input
            className="field"
            data-testid="diagram-rename"
            defaultValue={selectedNode.label}
            key={selectedNode.id}
            aria-label={t("editor.diagram_rename")}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
              e.preventDefault();
              const value = (e.target as HTMLInputElement).value.trim();
              if (value && value !== selectedNode.label) actions.rename(selectedNode.id, value);
            }}
            onBlur={(e) => {
              const value = e.target.value.trim();
              if (value && value !== selectedNode.label) actions.rename(selectedNode.id, value);
            }}
            style={{ flex: "1 1 120px", minWidth: 100, padding: "4px 8px", fontSize: "var(--text-sm)" }}
          />
          <VerbButtons
            verbs={nodeVerbs({
              node: selectedNode,
              model,
              linkedNote,
              actions,
              // No onRename: the persistent field above already is this surface's rename.
            })}
          />
        </div>
      )}

      {/* 그룹 — the same shape the node row has: a persistent rename field (no inline-on-the-picture
          field on this surface) plus the shared verb list. */}
      {selectedGroup && (
        <div style={rowStyle} data-testid="diagram-group-actions">
          <span style={{ fontSize: "var(--text-sm)", color: "var(--muted)" }}>{selectedGroup.title}</span>
          <input
            className="field"
            data-testid="diagram-group-rename-input"
            key={selectedGroup.id}
            defaultValue={selectedGroup.title}
            aria-label={t("editor.diagram_group_rename")}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
              e.preventDefault();
              const value = (e.target as HTMLInputElement).value.trim();
              if (value && value !== selectedGroup.title) actions.renameGroup(selectedGroup.id, value);
            }}
            onBlur={(e) => {
              const value = e.target.value.trim();
              if (value && value !== selectedGroup.title) actions.renameGroup(selectedGroup.id, value);
            }}
            style={{ flex: "1 1 120px", minWidth: 100, padding: "4px 8px", fontSize: "var(--text-sm)" }}
          />
          <VerbButtons verbs={groupVerbs({ group: selectedGroup, actions })} />
        </div>
      )}

      {selectedEdge && (
        <div style={rowStyle} data-testid="diagram-edge-actions">
          <span className="diagram-multi-count" data-testid="diagram-subject-chip" style={{ fontSize: "var(--text-sm)", color: "var(--muted)" }}>
            {`${label(selectedEdge.from)} → ${label(selectedEdge.to)}`}
          </span>
          <input
            className="field"
            data-testid="diagram-edge-rename"
            key={selectedEdge.id}
            defaultValue={selectedEdge.label}
            aria-label={t("editor.diagram_edge_label_placeholder")}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
              e.preventDefault();
              const value = (e.target as HTMLInputElement).value.trim();
              if (value !== (selectedEdge.label ?? "")) actions.setEdgeLabel(selectedEdge.id, value);
            }}
            onBlur={(e) => {
              const value = e.target.value.trim();
              if (value !== (selectedEdge.label ?? "")) actions.setEdgeLabel(selectedEdge.id, value);
            }}
            style={{ flex: "1 1 120px", minWidth: 100, padding: "4px 8px", fontSize: "var(--text-sm)" }}
          />
          <VerbButtons verbs={edgeVerbs({ edge: selectedEdge, model, actions })} />
        </div>
      )}
    </div>
  );
}
