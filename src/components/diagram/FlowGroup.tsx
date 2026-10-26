import { useContext } from "react";
import type { Node, NodeProps } from "@xyflow/react";
import { InlineEditCtx } from "./useFlowInlineEdit";
import { DiagramInlineInput } from "./DiagramInlineInput";
import { IconFolder } from "../icons";

import type { DiagramTone } from "./diagramStyles";

/** React Flow node id for a group. PREFIXED because React Flow keeps groups and nodes in ONE id
 *  space while the JSON IR keeps them in two SEPARATE sets. This prefix keeps them from colliding
 *  once both land in React Flow's single namespace. */
export const GROUP_PREFIX = "group:";
export const groupNodeId = (id: string): string => `${GROUP_PREFIX}${id}`;

export interface BriseGroupData {
  title: string;
  tone?: DiagramTone;
  step?: number;
  members?: string[];
  onSelectMembers?: (memberIds: string[]) => void;
  /** React Flow v12's `Node<T>` requires `T extends Record<string, unknown>`; an `interface`
   *  (unlike a `type` object literal) needs an explicit index signature to satisfy that. */
  [key: string]: unknown;
}

export type BriseGroupNode = Node<BriseGroupData, "briseGroup">;

/**
 * BriseFlowGroup
 *
 * 세련된 모던 컨테이너 프레임 렌더링 컴포넌트 (Archify급 Phase / Boundary Frame):
 * - 상단 좌측 글래스모피즘 헤더 칩 (아이콘 + 스텝 넘버링 뱃지 + 그룹 타이틀 + 편집 인풋)
 * - 톤별(accent, warn, done, info, muted) 부드러운 배경 틴트와 헤더 테두리
 * - 헤더 더블클릭 시 내부 자식 노드 일괄 다중 선택
 */
export function BriseFlowGroup({ id, data, selected }: NodeProps<BriseGroupNode>) {
  const inlineCtx = useContext(InlineEditCtx);
  const edit = inlineCtx?.edit;
  const commit = inlineCtx?.commit;
  const cancel = inlineCtx?.cancel;
  const groupId = id.startsWith(GROUP_PREFIX) ? id.slice(GROUP_PREFIX.length) : id;
  const isEditing = edit?.kind === "renameGroup" && edit.id === groupId;

  const handleBadgeDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (data.members && data.members.length > 0 && data.onSelectMembers) {
      data.onSelectMembers(data.members);
    }
  };

  return (
    <div
      className="diagram-flow-group"
      data-selected={selected || undefined}
      data-tone={data.tone || undefined}
      data-testid={`diagram-group-${groupId}`}
    >
      <div
        className="diagram-flow-group-chip"
        data-tone={data.tone || undefined}
      >
        {data.step !== undefined && (
          <span
            className="diagram-flow-group-step-badge"
            onDoubleClick={handleBadgeDoubleClick}
            title={data.members?.length ? `더블클릭 시 내부 노드 ${data.members.length}개 일괄 선택` : undefined}
          >
            {String(data.step).padStart(2, "0")}
          </span>
        )}
        <IconFolder size={12} strokeWidth={2} className="diagram-flow-group-icon" />
        {isEditing ? (
          <DiagramInlineInput
            className="diagram-flow-group-title diagram-flow-group-title-input"
            testId="diagram-inline-rename-group"
            defaultValue={edit.value}
            onCommit={(val) => commit?.(val)}
            onCancel={() => cancel?.()}
          />
        ) : (
          <span className="diagram-flow-group-title">{data.title}</span>
        )}
        {data.members && data.members.length > 0 && (
          <span
            className="diagram-flow-group-count"
            onDoubleClick={handleBadgeDoubleClick}
            title={`더블클릭 시 내부 노드 ${data.members.length}개 일괄 선택`}
          >
            {data.members.length}
          </span>
        )}
      </div>
    </div>
  );
}
