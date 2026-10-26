import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

export type ToolbarPress = boolean | "mixed";

export interface ToolbarButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "active"> {
  active?: ToolbarPress;
  label?: string;
  testid?: string;
  testId?: string;
  children: ReactNode;
}

/**
 * Standard Toolbar Button (30×28px, icon 15px).
 * Shared across Editor, Sheet, and Diagram toolbars.
 */
export const ToolbarButton = forwardRef<HTMLButtonElement, ToolbarButtonProps>(
  ({ active, label, testid, testId, title, "aria-label": ariaLabel, className, children, ...rest }, ref) => {
    const computedTitle = title ?? label;
    const computedAria = ariaLabel ?? computedTitle;
    const computedTestId = testid ?? testId;

    const dataActive =
      active === "mixed" ? "partial" : typeof active === "boolean" ? String(active) : undefined;
    const computedAriaPressed =
      active === "mixed" ? "mixed" : typeof active === "boolean" ? active : undefined;
    const finalAriaPressed = rest["aria-pressed"] !== undefined ? (rest["aria-pressed"] as boolean | "mixed") : computedAriaPressed;

    return (
      <button
        ref={ref}
        type="button"
        className={className ? `toolbar-btn ${className}` : "toolbar-btn"}
        data-testid={computedTestId}
        data-active={dataActive}
        aria-pressed={finalAriaPressed}
        title={computedTitle}
        aria-label={computedAria}
        {...rest}
      >
        {children}
      </button>
    );
  }
);
ToolbarButton.displayName = "ToolbarButton";
