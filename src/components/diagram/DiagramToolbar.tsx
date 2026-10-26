import { useState, type ReactNode } from "react";
import { t } from "../../i18n/t";
import { useToolbarRovingFocus } from "../common/useToolbarRovingFocus";
import { ToolbarButton, ToolbarDivider } from "../common/toolbar";
import {
  IconAlignBottom,
  IconAlignCenterX,
  IconAlignCenterY,
  IconAlignLeft,
  IconAlignRight,
  IconAlignTop,
  IconCheck,
  IconCode,
  IconDistributeX,
  IconDistributeY,
  IconFolderPlus,
  IconImageExport,
  IconLayoutGrid,
  IconListFilter,
  IconLock,
  IconPaperclip,
  IconPlus,
  IconRedo,
  IconSearch,
  IconTag,
  IconUndo,
  IconUnlock,
} from "../icons";
import { extractTodosFromDiagram, copyTodosToClipboard } from "./diagramAi";
import type { DiagramActions, Selection } from "./diagramActions";
import type { DiagramCanvasApi } from "./diagramCanvasApi";
import type { DiagramModel } from "./diagramModel";
import {
  alignPositions,
  distributePositions,
  type LayoutBox,
  type XY,
} from "./flowLayout";
import { canvasVerbs, selectedEdgeOf } from "./verbs";
import { VerbButtons } from "./VerbButtons";
import { DiagramStatesModal } from "./DiagramStatesModal";
import { DiagramTextForm } from "./DiagramSection";
import { ModalShell } from "../ModalShell";

export const ARRANGE_TOOLS: {
  id: string;
  labelKey: string;
  icon: ReactNode;
  plan: (boxes: LayoutBox[]) => Record<string, XY>;
}[] = [
  { id: "diagram-align-left", labelKey: "editor.diagram_align_left", icon: <IconAlignLeft size={15} strokeWidth={2} />, plan: (b) => alignPositions(b, "left") },
  { id: "diagram-align-center-x", labelKey: "editor.diagram_align_center_x", icon: <IconAlignCenterX size={15} strokeWidth={2} />, plan: (b) => alignPositions(b, "center-x") },
  { id: "diagram-align-right", labelKey: "editor.diagram_align_right", icon: <IconAlignRight size={15} strokeWidth={2} />, plan: (b) => alignPositions(b, "right") },
  { id: "diagram-align-top", labelKey: "editor.diagram_align_top", icon: <IconAlignTop size={15} strokeWidth={2} />, plan: (b) => alignPositions(b, "top") },
  { id: "diagram-align-center-y", labelKey: "editor.diagram_align_center_y", icon: <IconAlignCenterY size={15} strokeWidth={2} />, plan: (b) => alignPositions(b, "center-y") },
  { id: "diagram-align-bottom", labelKey: "editor.diagram_align_bottom", icon: <IconAlignBottom size={15} strokeWidth={2} />, plan: (b) => alignPositions(b, "bottom") },
  { id: "diagram-distribute-x", labelKey: "editor.diagram_distribute_x", icon: <IconDistributeX size={15} strokeWidth={2} />, plan: (b) => distributePositions(b, "x") },
  { id: "diagram-distribute-y", labelKey: "editor.diagram_distribute_y", icon: <IconDistributeY size={15} strokeWidth={2} />, plan: (b) => distributePositions(b, "y") },
];

export interface DiagramToolbarProps {
  model: DiagramModel;
  useFlow: boolean;
  selection: Selection;
  selectedBoxIds: string[];
  actions: DiagramActions;
  api?: DiagramCanvasApi | null;
  apiRef?: React.RefObject<DiagramCanvasApi | null>;
  canUndo: boolean;
  onUndo: () => void;
  canRedo: boolean;
  onRedo: () => void;
  onEditSource: () => void;
  zoom?: number | null;
  onZoom?: (next: (z: number | null) => number | null) => void;
  pngBusy: boolean;
  onOpenFinder?: () => void;
  locked?: boolean;
  onToggleLock?: () => void;
}

export function DiagramToolbar({
  model,
  useFlow,
  selection,
  selectedBoxIds,
  actions,
  api,
  apiRef,
  canUndo,
  onUndo,
  canRedo,
  onRedo,
  onEditSource,
  zoom: _zoom,
  onZoom: _onZoom,
  pngBusy,
  onOpenFinder,
  locked: controlledLocked,
  onToggleLock: controlledToggleLock,
}: DiagramToolbarProps) {
  const [localLocked, setLocalLocked] = useState(false);
  const [statesModalOpen, setStatesModalOpen] = useState(false);
  const [addTextOpen, setAddTextOpen] = useState(false);
  const structured = model.structured;
  const isMulti = selectedBoxIds.length >= 2;
  const getApi = () => api ?? apiRef?.current ?? null;

  const isLocked = controlledLocked ?? getApi()?.isLocked?.() ?? localLocked;
  const handleToggleLock = () => {
    if (controlledToggleLock) controlledToggleLock();
    else if (getApi()?.toggleLock) getApi()?.toggleLock?.();
    else setLocalLocked((v) => !v);
  };

  const selectedNode = selection?.kind === "node" ? model.nodes.find((n) => n.id === selection.id) : undefined;
  const selectedEdge = selectedEdgeOf(model, selection);
  const selectedGroup = selection?.kind === "group" ? model.groups.find((g) => g.id === selection.id) : undefined;

  const nodeLabel = (id: string) => model.nodes.find((n) => n.id === id)?.label ?? id;

  const renderContextSlot = () => {
    if (!structured) return null;

    if (isMulti) {
      return (
        <span data-testid="diagram-align-tools" style={{ display: "contents" }}>
          <span className="diagram-multi-count" data-testid="diagram-multi-count" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "14ch" }}>
            {t("editor.diagram_n_selected", { n: selectedBoxIds.length })}
          </span>
          <ToolbarButton
            className="diagram-multi-group"
            testId="diagram-group-create"
            title={t("editor.diagram_group_create")}
            onClick={() => getApi()?.createGroup?.(selectedBoxIds)}
          >
            <IconFolderPlus size={15} strokeWidth={2} />
            {t("editor.diagram_group_create")}
          </ToolbarButton>
          <ToolbarDivider testid="diagram-toolbar-divider" />
          {ARRANGE_TOOLS.map((tool) => (
            <ToolbarButton
              key={tool.id}
              testId={tool.id}
              title={t(tool.labelKey)}
              onClick={() => getApi()?.arrange?.(tool.plan, selectedBoxIds)}
            >
              {tool.icon}
            </ToolbarButton>
          ))}
        </span>
      );
    }

    if (selectedNode) {
      return (
        <span
          role="button"
          tabIndex={0}
          className="diagram-multi-count"
          data-testid="diagram-subject-chip"
          title={selectedNode.label}
          aria-label={t("editor.diagram_selection", { name: selectedNode.label })}
          style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "14ch", cursor: "pointer" }}
          onClick={() => getApi()?.focusNode?.(selectedNode.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter") getApi()?.focusNode?.(selectedNode.id);
          }}
        >
          {selectedNode.label}
        </span>
      );
    }

    if (selectedEdge) {
      const label = `${nodeLabel(selectedEdge.from)} → ${nodeLabel(selectedEdge.to)}`;
      return (
        <span
          className="diagram-multi-count"
          data-testid="diagram-subject-chip"
          title={label}
          aria-label={t("editor.diagram_selection", { name: label })}
          style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "14ch", cursor: "default" }}
        >
          {label}
        </span>
      );
    }

    if (selectedGroup) {
      return (
        <span
          role="button"
          tabIndex={0}
          className="diagram-multi-count"
          data-testid="diagram-subject-chip"
          title={selectedGroup.title}
          aria-label={t("editor.diagram_selection", { name: selectedGroup.title })}
          style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "14ch", cursor: "pointer" }}
          onClick={() => getApi()?.focusNode?.(selectedGroup.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter") getApi()?.focusNode?.(selectedGroup.id);
          }}
        >
          {selectedGroup.title}
        </span>
      );
    }

    return null;
  };

  const roving = useToolbarRovingFocus<HTMLDivElement>();

  return (
    <div
      className="section-toolbar"
      data-testid="diagram-view-tools"
      role="toolbar"
      aria-label={t("editor.diagram_canvas_tools")}
      ref={roving.ref}
      onKeyDown={roving.onKeyDown}
      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-2)" }}
    >
      {/* Leading Zone */}
      {structured ? (
        <div style={{ flex: "none", display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
          <ToolbarButton
            testId="diagram-undo"
            disabled={!canUndo}
            title={t("editor.diagram_undo")}
            onClick={onUndo}
          >
            <IconUndo size={15} strokeWidth={2} />
          </ToolbarButton>
          <ToolbarButton
            testId="diagram-redo"
            disabled={!canRedo}
            title={t("editor.diagram_redo")}
            onClick={onRedo}
          >
            <IconRedo size={15} strokeWidth={2} />
          </ToolbarButton>
          <ToolbarDivider />
          <ToolbarButton
            testId="diagram-add-node-toggle"
            title={t("editor.diagram_add_node_tooltip")}
            onClick={() => getApi()?.addNode?.()}
          >
            <IconPlus size={15} strokeWidth={2} />
          </ToolbarButton>
          <ToolbarButton
            testId="diagram-add-frame-toggle"
            title={t("editor.diagram_add_frame")}
            onClick={() => getApi()?.addFrame?.()}
          >
            <IconFolderPlus size={15} strokeWidth={2} />
          </ToolbarButton>
          <VerbButtons verbs={canvasVerbs({ actions, onAddText: () => setAddTextOpen(true) })} />
          <ToolbarButton
            testId="diagram-lock-toggle"
            active={isLocked}
            title={isLocked ? t("editor.diagram_unlock") : t("editor.diagram_lock")}
            onClick={handleToggleLock}
          >
            {isLocked ? <IconLock size={15} strokeWidth={2} /> : <IconUnlock size={15} strokeWidth={2} />}
          </ToolbarButton>
          {useFlow && (
            <>
              <ToolbarDivider />
              <ToolbarButton
                testId="diagram-search-trigger"
                title={t("editor.diagram_search_nodes") || "노드 검색 (/)"}
                onClick={() => (onOpenFinder ? onOpenFinder() : getApi()?.openFinder?.())}
              >
                <IconSearch size={15} strokeWidth={2} />
              </ToolbarButton>
              <ToolbarButton
                testId="diagram-auto-layout"
                title={t("editor.diagram_auto_layout")}
                onClick={() => getApi()?.autoLayout?.()}
              >
                <IconLayoutGrid size={15} strokeWidth={2} />
              </ToolbarButton>
              <ToolbarButton
                testId="diagram-states-config"
                title={t("editor.diagram_states_config")}
                onClick={() => setStatesModalOpen(true)}
              >
                <IconTag size={15} strokeWidth={2} />
              </ToolbarButton>
              {model.states && model.states.length > 0 && (
                <ToolbarButton
                  testId="diagram-toggle-legend"
                  title={t("editor.diagram_legend_toggle") || "상태 필터링 및 범례"}
                  onClick={() => getApi()?.toggleLegend?.()}
                >
                  <IconListFilter size={15} strokeWidth={2} />
                </ToolbarButton>
              )}
              <ToolbarButton
                testId="diagram-toolbar-extract-todos"
                title={t("editor.diagram_extract_todos") || "할일(체크리스트) 추출"}
                onClick={async () => {
                  const text = extractTodosFromDiagram(model);
                  if (text) {
                    await copyTodosToClipboard(text);
                  }
                }}
              >
                <IconCheck size={15} strokeWidth={2} />
              </ToolbarButton>
            </>
          )}
        </div>
      ) : (
        <div style={{ flex: "none" }} />
      )}

      {/* Contextual Zone */}
      {structured && (
        <div
          className="scroll noscroll"
          style={{
            flex: "1 1 auto",
            minWidth: 0,
            overflowX: "auto",
            display: "flex",
            alignItems: "center",
            gap: "var(--space-1)",
          }}
        >
          {renderContextSlot()}
        </div>
      )}

      {/* Trailing Zone */}
      <div style={{ flex: "none", display: "flex", alignItems: "center", gap: "var(--space-1)" }}>
        {useFlow && (
          <ToolbarButton
            testId="diagram-export-png"
            disabled={pngBusy}
            title={t("editor.diagram_export_png")}
            onClick={() => getApi()?.exportPng?.()}
          >
            <IconImageExport size={15} strokeWidth={2} />
          </ToolbarButton>
        )}
        {useFlow && (
          <ToolbarButton
            testId="diagram-export-png-attach"
            disabled={pngBusy}
            title={t("editor.diagram_export_png_attach")}
            onClick={() => getApi()?.exportPngAttach?.()}
          >
            <IconPaperclip size={15} strokeWidth={2} />
          </ToolbarButton>
        )}
        <ToolbarDivider />
        <ToolbarButton
          testId="diagram-edit-source"
          title={t("editor.diagram_edit_source")}
          onClick={onEditSource}
        >
          <IconCode size={15} strokeWidth={2} />
        </ToolbarButton>
      </div>

      {statesModalOpen && (
        <DiagramStatesModal
          open={statesModalOpen}
          onClose={() => setStatesModalOpen(false)}
          model={model}
          actions={actions}
        />
      )}
      {addTextOpen && (
        <ModalShell title={t("editor.diagram_text_add")} onClose={() => setAddTextOpen(false)} width={460}>
          <DiagramTextForm onSubmit={actions.addFromText} onDone={() => setAddTextOpen(false)} />
        </ModalShell>
      )}
    </div>
  );
}
