import { createContext, useRef, useState } from "react";
import type { DiagramModel } from "./diagramSchema";
import type { DiagramActions } from "./diagramActions";
import { nodeSize, type XY } from "./flowLayout";

/**
 * 그림 위 인라인 필드 종류. 배지(tag)·아이콘·설명(meta)·구획(rows) 필드는 2026-10-19 버블 간소화
 * (GRILL R6)로 여는 곳이 없어져 지웠다 — 그 데이터는 FlowNode 가 계속 그리고, 편집은 소스 보기에서 한다.
 */
export type InlineEdit =
  | { kind: "rename"; id: string; value: string }
  | { kind: "create"; left: number; top: number; from?: string; flow?: XY }
  | { kind: "label"; edgeId: string; value: string }
  | { kind: "createGroup"; members: string[]; left: number; top: number }
  | { kind: "renameGroup"; id: string; value: string };

export interface InlineEditContextValue {
  edit: InlineEdit | null;
  commit: (v: string) => void;
  cancel: () => void;
  openRelabel?: (edgeId: string) => void;
}

export const InlineEditCtx = createContext<InlineEditContextValue | null>(null);

export interface UseFlowInlineEditOptions {
  model: DiagramModel;
  actions: DiagramActions;
}

export function useFlowInlineEdit({ model, actions }: UseFlowInlineEditOptions) {
  const [inline, setInline] = useState<InlineEdit | null>(null);
  const inlineRef = useRef<InlineEdit | null>(null);

  const openInline = (edit: InlineEdit) => {
    inlineRef.current = edit;
    setInline(edit);
  };

  const closeInline = () => {
    inlineRef.current = null;
    setInline(null);
  };

  const openRename = (id: string, defaultLabel?: string) => {
    const node = model.nodes.find((n) => n.id === id);
    const label = node ? node.label : (defaultLabel ?? "새 노드");
    openInline({ kind: "rename", id, value: label });
  };

  const openAddNode = () => openInline({ kind: "create", left: 16, top: 16 });

  const openRelabel = (edgeId: string) => {
    const found = model.edges.find((e) => e.id === edgeId);
    openInline({ kind: "label", edgeId, value: found?.label ?? "" });
  };

  const openGroupRename = (id: string) => {
    const group = model.groups.find((g) => g.id === id);
    if (!group) return;
    openInline({
      kind: "renameGroup",
      id,
      value: group.title,
    });
  };

  const commitInline = (raw: string) => {
    const value = raw.trim();
    const edit = inlineRef.current;
    closeInline();
    if (!edit) return;
    // Clearing an edge's label is a legitimate edit, so the empty guard below must not swallow it.
    if (edit.kind === "label") {
      const current = model.edges.find((e) => e.id === edit.edgeId);
      if (value !== (current?.label ?? "")) actions.setEdgeLabel(edit.edgeId, value);
      return;
    }
    if (!value) return;
    if (edit.kind === "rename") {
      if (value !== model.nodes.find((n) => n.id === edit.id)?.label) actions.rename(edit.id, value);
      return;
    }
    if (edit.kind === "createGroup") {
      actions.addGroup(value, edit.members);
      return;
    }
    if (edit.kind === "renameGroup") {
      if (value !== model.groups.find((g) => g.id === edit.id)?.title) actions.renameGroup(edit.id, value);
      return;
    }
    if (edit.from && edit.flow) {
      const size = nodeSize({ label: value });
      actions.addConnected(edit.from, value, {
        x: Math.round(edit.flow.x - size.width / 2),
        y: Math.round(edit.flow.y - size.height / 2),
      });
      return;
    }
    actions.addNode(value);
  };

  return {
    inline,
    inlineRef,
    openInline,
    closeInline,
    openRename,
    openAddNode,
    openRelabel,
    openGroupRename,
    commitInline,
  };
}
