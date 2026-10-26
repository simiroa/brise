/**
 * Shared "confirm note create" popover — unifies the 3 near-identical inline implementations
 * that used to live in CalendarTab, TimelineTab and MapCreatePopover (title/subtitle/confirm/
 * cancel slots, position anchor via useMenuPos, Esc-to-cancel). Surface: `.overlay` (floating
 * content per the single-sheet contract — see tokens.css) instead of each caller hand-rolling
 * its own inline background.
 *
 * Portal/backdrop are NOT part of this component — only the map tab needs them (its own
 * click-through-to-canvas problem), so MapCreatePopover wraps this in a portal + backdrop
 * itself rather than pushing that concern onto Calendar/Timeline, which already guard
 * "click elsewhere while popover is open" in their own pointer handlers.
 */
import { useEffect, type ReactNode, type Ref } from "react";
import { useMenuPos } from "../../lib/ui";

export interface CreatePopoverProps {
  testId: string;
  anchor: { x: number; y: number } | null;
  title: ReactNode;
  subtitle?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  confirmTestId: string;
  cancelTestId: string;
  creating?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Forwarded to the confirm <button> — lets a caller (e.g. Map) autofocus it. */
  confirmRef?: Ref<HTMLButtonElement>;
  ariaLabel?: string;
  /** Extra attributes spread on the outer container (e.g. Timeline's `data-tl-popover` marker
   *  its own canvas mousedown handler greps for via closest()). */
  containerProps?: Record<string, string>;
  /** Optional extra content between the title block and the confirm/cancel row (e.g. Timeline's
   *  auto-focused title input — Enter there should call onConfirm directly, this component only
   *  wires the global Escape-to-cancel). */
  children?: ReactNode;
}

export function CreatePopover({
  testId,
  anchor,
  title,
  subtitle,
  confirmLabel,
  cancelLabel,
  confirmTestId,
  cancelTestId,
  creating = false,
  onConfirm,
  onCancel,
  confirmRef,
  ariaLabel,
  containerProps,
  children,
}: CreatePopoverProps) {
  const { ref, x, y } = useMenuPos(anchor);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      {...containerProps}
      ref={ref}
      data-testid={testId}
      className="overlay"
      role="dialog"
      aria-label={ariaLabel}
      style={{
        position: "fixed",
        left: x,
        top: y,
        zIndex: "var(--z-modal)",
        minWidth: 220,
        padding: "var(--space-5)",
        boxShadow: "var(--shadow-lg)",
        fontSize: "var(--text-sm)",
        color: "var(--text)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-4)",
      }}
    >
      <div>
        <div style={{ fontWeight: 600 }}>{title}</div>
        {subtitle != null && (
          <div style={{ marginTop: 4, color: "var(--faint)", fontSize: "var(--text-xs)" }}>
            {subtitle}
          </div>
        )}
      </div>
      {children}
      <div style={{ display: "flex", gap: "var(--space-3)", justifyContent: "flex-end" }}>
        <button
          type="button"
          data-testid={cancelTestId}
          onClick={onCancel}
          disabled={creating}
          className="btn"
        >
          {cancelLabel}
        </button>
        <button
          ref={confirmRef}
          type="button"
          data-testid={confirmTestId}
          onClick={onConfirm}
          disabled={creating}
          className="btn btn-primary"
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}
