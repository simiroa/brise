import React from "react";

export interface TreeRowInlineEditorProps {
  id: string;
  isFolder: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onCommit: (id: string, isFolder: boolean, draft: string) => void;
  onBlur: (id: string, isFolder: boolean, draft: string) => void;
  onCancel: () => void;
  fontSize?: string;
  fontWeight?: number | string;
  style?: React.CSSProperties;
}

export const TreeRowInlineEditor = React.memo(function TreeRowInlineEditor({
  id,
  isFolder,
  draft,
  onDraftChange,
  onCommit,
  onBlur,
  onCancel,
  fontSize = "var(--text-md)",
  fontWeight = 500,
  style,
}: TreeRowInlineEditorProps) {
  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => onDraftChange(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={() => onBlur(id, isFolder, draft)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(id, isFolder, draft);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      style={{
        font: "inherit",
        fontSize,
        fontWeight,
        flex: 1,
        minWidth: 0,
        color: "inherit",
        background: "transparent",
        border: "none",
        outline: "1px solid var(--accent)",
        outlineOffset: -1,
        padding: 0,
        ...style,
      }}
    />
  );
});
