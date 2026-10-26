import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { DRAG_THRESHOLD_PX } from "../../lib/pointerContract";
import { t } from "../../i18n/t";

export interface ReorderItem {
  id: string;
  label: string;
  icon?: ReactNode;
  enabled?: boolean;
}

interface ReorderListProps<T extends ReorderItem> {
  items: T[];
  onReorder: (items: T[]) => void;
  onToggle?: (id: string, enabled: boolean) => void;
  testIdPrefix?: string;
}

/**
 * One-line chip strip: click = toggle, drag = reorder, ←/→ = reorder, Space/Enter = toggle.
 * 키보드 조작은 칩 아래 힌트 한 줄이 말한다. 마지막으로 켜진 칩은 끌 수 없다(전부 꺼지면 보일 탭이
 * 없다) — 흔들기만으로는 이유가 안 보이므로 같은 순간 aria-live 줄이 이유를 말한다.
 *
 * Pointer DnD (not HTML5 draggable): the settings webview has pet-asset OS file drop
 * (`onDragDropEvent` + `dragDropEnabled`). HTML5 dragover/drop is swallowed there —
 * same reason BoardPane uses noteDrag. Threshold matches DRAG_THRESHOLD_PX.
 * 놓을 자리 표시는 끌어 온 방향을 따른다 — 오른쪽으로 끌면 대상의 오른쪽 가장자리(그 뒤에 놓인다).
 */
export function ReorderList<T extends ReorderItem>({
  items,
  onReorder,
  onToggle,
  testIdPrefix = "reorder",
}: ReorderListProps<T>) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  const [shakeId, setShakeId] = useState<string | null>(null);
  // 마지막 켜진 칩을 끄려 했을 때의 안내 — 흔들기와 함께 보이고 aria-live 로 읽힌다.
  const [lastNotice, setLastNotice] = useState(false);
  const shakeTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (shakeTimer.current !== null) window.clearTimeout(shakeTimer.current);
    },
    [],
  );
  const dragRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    moved: boolean;
    pointerId: number;
  } | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const enabledCount = items.filter((item) => item.enabled !== false).length;

  const move = (fromIndex: number, toIndex: number) => {
    if (toIndex < 0 || toIndex >= items.length || fromIndex === toIndex) return;
    const next = [...items];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    onReorder(next);
  };

  const shake = (id: string) => {
    setShakeId(id);
    if (shakeTimer.current !== null) window.clearTimeout(shakeTimer.current);
    shakeTimer.current = window.setTimeout(() => {
      shakeTimer.current = null;
      setShakeId((cur) => (cur === id ? null : cur));
    }, 280);
  };

  const toggle = (item: T) => {
    if (!onToggle) return;
    const isEnabled = item.enabled !== false;
    if (isEnabled && enabledCount <= 1) {
      shake(item.id);
      setLastNotice(true);
      return;
    }
    setLastNotice(false);
    onToggle(item.id, !isEnabled);
  };

  const chipAtPoint = (x: number, y: number): string | null => {
    const el = document.elementFromPoint?.(x, y);
    const chip = el?.closest<HTMLElement>("[data-reorder-chip]");
    return chip?.dataset.reorderChip ?? null;
  };

  const onPointerDown = (item: T, e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    dragRef.current = {
      id: item.id,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
      pointerId: e.pointerId,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* jsdom */
    }
  };

  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    if (draggingId !== drag.id) setDraggingId(drag.id);
    const over = chipAtPoint(e.clientX, e.clientY);
    if (over && over !== dropId) setDropId(over);
  };

  const onPointerUp = (item: T, e: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* jsdom */
    }
    const wasDragging = drag?.moved === true;
    const fromId = drag?.id ?? item.id;
    const targetId = wasDragging ? (dropId ?? chipAtPoint(e.clientX, e.clientY)) : null;
    setDraggingId(null);
    setDropId(null);
    if (wasDragging) {
      if (targetId && targetId !== fromId) {
        const list = itemsRef.current;
        const from = list.findIndex((i) => i.id === fromId);
        const to = list.findIndex((i) => i.id === targetId);
        if (from >= 0 && to >= 0) {
          const next = [...list];
          const [moved] = next.splice(from, 1);
          next.splice(to, 0, moved);
          onReorder(next);
        }
      }
      return;
    }
    toggle(item);
  };

  const onPointerCancel = () => {
    dragRef.current = null;
    setDraggingId(null);
    setDropId(null);
  };

  const dragIndex = draggingId ? items.findIndex((i) => i.id === draggingId) : -1;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      <div
        data-testid={`${testIdPrefix}-list`}
        role="group"
        style={{
          display: "flex",
          flexDirection: "row",
          flexWrap: "nowrap",
          gap: "var(--space-2)",
          overflowX: "auto",
        }}
      >
        {items.map((item, index) => {
          const isEnabled = item.enabled !== false;
          const isDragging = draggingId === item.id;
          // 놓을 자리 표시의 쪽: 앞에서 끌어 오면(dragIndex < index) 이 칩 **뒤**에 놓이므로 오른쪽.
          const dropSide: DropSide =
            dropId === item.id && draggingId !== item.id ? (dragIndex >= 0 && dragIndex < index ? "after" : "before") : null;
          const shaking = shakeId === item.id;
          return (
            <button
              key={item.id}
              type="button"
              data-reorder-chip={item.id}
              data-testid={`${testIdPrefix}-item-${item.id}`}
              data-enabled={isEnabled ? "true" : "false"}
              data-shake={shaking ? "true" : undefined}
              aria-pressed={isEnabled}
              aria-label={item.label}
              onPointerDown={(e) => onPointerDown(item, e)}
              onPointerMove={onPointerMove}
              onPointerUp={(e) => onPointerUp(item, e)}
              onPointerCancel={onPointerCancel}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggle(item);
                } else if (e.key === "ArrowLeft") {
                  e.preventDefault();
                  move(index, index - 1);
                } else if (e.key === "ArrowRight") {
                  e.preventDefault();
                  move(index, index + 1);
                }
              }}
              data-drop={dropSide ?? undefined}
              style={chipStyle(isEnabled, isDragging, dropSide, shaking)}
            >
              {item.icon && (
                <span
                  style={{
                    display: "grid",
                    placeItems: "center",
                    flex: "none",
                    width: 18,
                    height: 18,
                    color: isEnabled ? "var(--accent)" : "var(--faint)",
                  }}
                >
                  {item.icon}
                </span>
              )}
              <span
                style={{
                  fontSize: "var(--text-sm)",
                  fontWeight: 400,
                  color: isEnabled ? "var(--text)" : "var(--faint)",
                }}
              >
                {item.label}
              </span>
            </button>
          );
        })}
      </div>
      <div style={{ fontSize: "var(--text-xs)", color: "var(--muted)" }}>
        <span data-testid={`${testIdPrefix}-keyboard-hint`}>{t("settings.reorder_keyboard_hint")}</span>
        <span role="status" aria-live="polite" data-testid={`${testIdPrefix}-last-notice`}>
          {lastNotice ? ` ${t("settings.reorder_last_enabled")}` : ""}
        </span>
      </div>
    </div>
  );
}

type DropSide = "before" | "after" | null;

function chipStyle(
  enabled: boolean,
  dragging: boolean,
  drop: DropSide,
  shaking: boolean,
): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--space-2)",
    padding: "var(--space-1) var(--space-2)",
    border: "1px solid var(--divider)",
    borderRadius: "var(--radius-sm)",
    background: enabled ? "color-mix(in srgb, var(--text) 4%, transparent)" : "transparent",
    opacity: dragging ? 0.5 : enabled ? 1 : "var(--dim-disabled)",
    cursor: dragging ? "grabbing" : "grab",
    whiteSpace: "nowrap",
    flex: "none",
    userSelect: "none",
    touchAction: "none",
    transform: shaking ? "translateX(3px)" : undefined,
    transition: shaking ? "transform var(--dur-fast)" : "opacity var(--dur-fast)",
    boxShadow:
      drop === "before" ? "inset 2px 0 0 var(--accent)" : drop === "after" ? "inset -2px 0 0 var(--accent)" : undefined,
  };
}
