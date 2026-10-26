/**
 * VerbButtons & VerbMenu — verb renderer for diagram toolbar and mobile sheet.
 *
 * The verbs as buttons — the shared RENDERER, so the toolbar, desktop canvas and the mobile sheet
 * cannot drift into two different ideas of what a verb looks like or which handler it calls.
 * Returns a bare fragment: the caller owns the container (.section-toolbar, or a 48px-sized action
 * row in DiagramControls).
 */
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { useDismiss, useMenuPos } from "../../lib/ui";
import type { Verb } from "./verbs";
import { FluidHoverHighlight, useFluidHover } from "../common/FluidHover";

/**
 * A verb's short closed list (도형 / 선 종류). Assembled from the repo's three existing pieces the
 * same way NodePicker / StatusControl / TabBar each do locally: useMenuPos for viewport-flipping
 * placement, `.overlay` for the always-opaque floating surface, `.menu-row .menu-item` for the rows.
 */
function VerbMenu({ verb }: { verb: Verb }) {
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

  return (
    <>
      <button
        type="button"
        ref={btnRef}
        className="icon-btn icon-btn--sm"
        data-testid={verb.id}
        title={verb.label}
        aria-label={verb.label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => {
          if (open) return close(false);
          const r = btnRef.current?.getBoundingClientRect();
          setAnchor({ x: r?.left ?? 0, y: (r?.bottom ?? 0) + 4 });
        }}
      >
        {verb.icon}
      </button>
      {open &&
        createPortal(
          <div
            ref={listRef}
            id={listboxId}
            className="overlay diagram-bubble-menu fh-host"
            role="listbox"
            aria-label={verb.label}
            data-testid={`${verb.id}-list`}
            onKeyDown={onListKey}
            {...hover.handlers}
            style={{ left: x, top: y }}
          >
            <FluidHoverHighlight hover={hover} />
            {verb.menu?.options.map((o) => {
              const selected = o.value === verb.menu?.value;
              return (
                <button
                  key={o.value}
                  type="button"
                  className="menu-row menu-item"
                  role="option"
                  aria-selected={selected}
                  data-selected={selected}
                  data-value={o.value}
                  onClick={() => {
                    verb.menu?.onPick(o.value);
                    close();
                  }}
                >
                  {o.label}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * The verbs as buttons — the shared RENDERER, so the desktop toolbar and the mobile sheet cannot
 * drift into two different ideas of what a verb looks like or which handler it calls. Returns a
 * bare fragment: the caller owns the container (.section-toolbar, or a 48px-sized action row in
 * DiagramControls).
 */
export function VerbButtons({ verbs }: { verbs: Verb[] }) {
  return (
    <>
      {verbs.map((verb) =>
        verb.menu ? (
          <VerbMenu key={verb.id} verb={verb} />
        ) : (
          <button
            key={verb.id}
            type="button"
            className={verb.danger ? "icon-btn icon-btn--sm diagram-bubble-danger" : "icon-btn icon-btn--sm"}
            data-testid={verb.id}
            title={verb.label}
            aria-label={verb.label}
            aria-pressed={verb.active}
            data-active={verb.active || undefined}
            onClick={verb.run}
          >
            {verb.icon}
          </button>
        ),
      )}
    </>
  );
}
