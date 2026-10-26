/**
 * Calendar drag-to-create session — extracted from CalendarTab (pure move, same behavior).
 * Live drag is tracked in a ref so pointermove doesn't thrash React until paint is needed.
 * Esc cancels an in-progress drag; the create popover (once open) owns its own Esc-to-close
 * via the shared CreatePopover component.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { orderIsoRange } from "../calendarLayout";

export type DragSession = {
  startDay: string;
  endDay: string;
  /** True once the pointer leaves the start cell — distinguishes click vs drag. */
  moved: boolean;
};

export type CreatePopoverState = {
  startDay: string;
  endDay: string;
  x: number;
  y: number;
};

/** `onRangeDropped` — PLAN-2026-09-10 D3: 드래그를 놓는 **그 순간** 노트를 만든다(팝오버는 그
 *  노트를 고치는 자리다). 이벤트 핸들러로 넘기는 이유는 effect 가 StrictMode 이중 발화로 노트를
 *  둘 만들기 때문이다. */
export function useCalendarDrag(onPick: (day: string) => void, onRangeDropped?: (lo: string, hi: string) => void) {
  const [drag, setDrag] = useState<DragSession | null>(null);
  const [popover, setPopover] = useState<CreatePopoverState | null>(null);
  const dragRef = useRef<DragSession | null>(null);

  const cancelDrag = useCallback(() => {
    dragRef.current = null;
    setDrag(null);
  }, []);

  const closePopover = useCallback(() => {
    setPopover(null);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (dragRef.current) {
        e.preventDefault();
        cancelDrag();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancelDrag]);

  const extendDragTo = useCallback((day: string) => {
    const cur = dragRef.current;
    if (!cur) return;
    const moved = cur.moved || day !== cur.startDay;
    if (day === cur.endDay && moved === cur.moved) return;
    const next: DragSession = { startDay: cur.startDay, endDay: day, moved };
    dragRef.current = next;
    setDrag(next);
  }, []);

  const onCellPointerDown = useCallback(
    (day: string, e: React.PointerEvent) => {
      if (e.button !== 0) return;
      // Don't start drag while a confirm popover is open — close it first.
      if (popover) {
        closePopover();
        return;
      }
      e.preventDefault();
      const session: DragSession = { startDay: day, endDay: day, moved: false };
      dragRef.current = session;
      setDrag(session);

      const onUp = (ev: PointerEvent) => {
        window.removeEventListener("pointerup", onUp);
        const cur = dragRef.current;
        dragRef.current = null;
        setDrag(null);
        if (!cur) return;
        if (cur.moved) {
          const [lo, hi] = orderIsoRange(cur.startDay, cur.endDay);
          setPopover({ startDay: lo, endDay: hi, x: ev.clientX, y: ev.clientY });
          onRangeDropped?.(lo, hi);
        } else {
          // Pure click → detail panel (toggle).
          onPick(cur.startDay);
        }
      };

      window.addEventListener("pointerup", onUp);
    },
    [closePopover, onPick, onRangeDropped, popover],
  );

  const onCellPointerEnter = useCallback(
    (day: string) => {
      if (!dragRef.current) return;
      extendDragTo(day);
    },
    [extendDragTo],
  );

  const dragHighlight = useCallback(
    (day: string | null) => {
      if (!day || !drag || !drag.moved) return false;
      const [lo, hi] = orderIsoRange(drag.startDay, drag.endDay);
      return day >= lo && day <= hi;
    },
    [drag],
  );

  return {
    popover,
    setPopover,
    closePopover,
    isDragHighlighted: dragHighlight,
    onCellPointerDown,
    onCellPointerEnter,
  };
}
