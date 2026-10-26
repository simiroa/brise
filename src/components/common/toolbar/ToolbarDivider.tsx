export interface ToolbarDividerProps {
  className?: string;
  testid?: string;
  testId?: string;
}

export function ToolbarDivider({
  className,
  testid,
  testId,
}: ToolbarDividerProps) {
  return (
    <div
      className={className ? `toolbar-divider ${className}` : "toolbar-divider"}
      data-testid={testid ?? testId}
      style={{
        width: 1,
        height: 16,
        margin: "0 var(--space-1)",
        background: "var(--line)",
        flex: "none",
      }}
      aria-hidden="true"
    />
  );
}
