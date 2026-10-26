import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useDismiss, useMenuPos } from "../../lib/ui";
import { FluidHoverHighlight, useFluidHover } from "../common/FluidHover";

export interface NodePickerProps {
  nodes: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  testid: string;
}

export function NodePicker({
  nodes,
  value,
  onChange,
  label,
  testid,
}: NodePickerProps) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const { ref: listRef, x, y } = useMenuPos(anchor);
  const hover = useFluidHover(listRef, { axis: "y" });
  const btnRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const open = anchor !== null;

  const close = (refocus = true) => {
    setAnchor(null);
    if (refocus) btnRef.current?.focus();
  };

  useDismiss(open, [listRef, btnRef], () => setAnchor(null), { escape: false });

  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    (list?.querySelector<HTMLElement>('[aria-selected="true"]') ?? list?.querySelector<HTMLElement>("button"))?.focus();
  }, [open, listRef]);

  const onListKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>("button") ?? []);
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? at + 1 : at - 1;
    rows[(next + rows.length) % rows.length]?.focus();
  };

  const rows = [{ id: "", label }, ...nodes];
  const current = nodes.find((n) => n.id === value);

  return (
    <>
      <button
        type="button"
        ref={btnRef}
        className="field-select"
        data-testid={testid}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => {
          if (open) return close(false);
          const r = btnRef.current?.getBoundingClientRect();
          setAnchor({ x: r?.left ?? 0, y: r?.bottom ?? 0 });
        }}
        style={{
          flex: "1 1 100px",
          minWidth: 90,
          padding: "4px var(--space-6) 4px var(--space-3)",
          backgroundPositionX: "calc(100% - 5px)",
          fontSize: "var(--text-sm)",
          textAlign: "left",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          cursor: "pointer",
          color: current ? "var(--text)" : "var(--muted)",
        }}
      >
        {current?.label ?? label}
      </button>
      {open &&
        createPortal(
          <div
            ref={listRef}
            id={listboxId}
            className="overlay diagram-node-list fh-host"
            role="listbox"
            aria-label={label}
            data-testid={`${testid}-list`}
            onKeyDown={onListKey}
            {...hover.handlers}
            style={{
              position: "fixed",
              left: x,
              top: y,
              zIndex: "var(--z-dropdown)",
              minWidth: 140,
              maxWidth: "calc(100vw - 16px)",
              maxHeight: 240,
              overflowY: "auto",
              padding: "var(--space-1)",
              boxShadow: "var(--shadow-lg)",
            }}
          >
            <FluidHoverHighlight hover={hover} />
            {rows.map((n) => {
              const selected = n.id === value;
              return (
                <button
                  key={n.id || "__none__"}
                  type="button"
                  className="menu-row menu-item"
                  role="option"
                  aria-selected={selected}
                  data-selected={selected}
                  data-value={n.id}
                  onClick={() => {
                    onChange(n.id);
                    close();
                  }}
                  style={{
                    padding: "var(--space-2) var(--space-4)",
                    fontSize: "var(--text-sm)",
                    color: selected ? "var(--accent)" : "var(--text)",
                    whiteSpace: "nowrap",
                    textAlign: "left",
                    cursor: "pointer",
                  }}
                >
                  {n.label}
                </button>
              );
            })}
          </div>,
          document.body
        )}
    </>
  );
}
