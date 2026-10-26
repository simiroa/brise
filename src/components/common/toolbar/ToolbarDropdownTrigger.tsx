import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { IconChevron } from "../../icons";

export interface ToolbarDropdownTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
  open?: boolean;
  label?: string;
  testid?: string;
  testId?: string;
  children?: ReactNode;
  icon?: ReactNode;
}

/**
 * Text/Label + chevron dropdown trigger button in toolbars (30×28px with dynamic text).
 */
export const ToolbarDropdownTrigger = forwardRef<HTMLButtonElement, ToolbarDropdownTriggerProps>(
  ({ active, open, label, testid, testId, title, "aria-label": ariaLabel, icon, className, children, ...rest }, ref) => {
    const computedTitle = title ?? label;
    const computedAria = ariaLabel ?? computedTitle;
    const computedTestId = testid ?? testId;
    const isActive = active || open;

    return (
      <button
        ref={ref}
        type="button"
        className={className ? `toolbar-btn toolbar-btn--text ${className}` : "toolbar-btn toolbar-btn--text"}
        data-testid={computedTestId}
        data-active={isActive || undefined}
        aria-pressed={active !== undefined ? active : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        title={computedTitle}
        aria-label={computedAria}
        {...rest}
      >
        {icon}
        <span>{children ?? label}</span>
        <IconChevron size={12} strokeWidth={1.8} style={{ opacity: 0.6, flex: "none" }} />
      </button>
    );
  }
);
ToolbarDropdownTrigger.displayName = "ToolbarDropdownTrigger";
