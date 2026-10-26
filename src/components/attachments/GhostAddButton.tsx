import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMenuPos, useDismiss } from "../../lib/ui";
import { IconPlus } from "../icons";

export interface GhostAddItem {
  testid: string;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}

/**
 * W22 ⑥: 첨부 탭 고스트 + — 클릭(또는 Enter/Space, 버튼 네이티브 동작)으로 포털 오버레이를
 * 띄운다. 선례 SheetToolbar.tsx의 FormatPicker와 동일한 골격(createPortal + .overlay +
 * useMenuPos + useDismiss).
 */
export function GhostAddButton({ items, label }: { items: GhostAddItem[]; label: string }) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const { ref: listRef, x, y } = useMenuPos(anchor);
  const btnRef = useRef<HTMLButtonElement>(null);
  const open = anchor !== null;

  useDismiss(open, [listRef, btnRef], () => setAnchor(null));

  return (
    <>
      <button
        type="button"
        ref={btnRef}
        className="ghost-add"
        data-testid="attachments-ghost-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        aria-label={label}
        onClick={() => {
          const r = btnRef.current?.getBoundingClientRect();
          setAnchor((prev) => (prev ? null : { x: r?.left ?? 0, y: r?.bottom ?? 0 }));
        }}
      >
        <IconPlus size={16} strokeWidth={1.8} />
      </button>
      {open &&
        createPortal(
          <div
            ref={listRef}
            className="overlay attach-add-menu"
            role="menu"
            aria-label={label}
            onMouseLeave={() => setAnchor(null)}
            style={{
              position: "fixed",
              left: x,
              top: y,
              zIndex: "var(--z-dropdown)",
              display: "grid",
              gridTemplateColumns: items.length > 2 ? "repeat(2, 1fr)" : "1fr",
              gap: "var(--space-1)",
              padding: "var(--space-2)",
              borderRadius: "var(--radius-md)",
              boxShadow: "var(--shadow-lg)",
              border: "1px solid var(--divider)",
            }}
          >
            {items.map((item) => (
              <button
                key={item.testid}
                type="button"
                role="menuitem"
                className="toolbar-btn"
                data-testid={item.testid}
                title={item.label}
                aria-label={item.label}
                onClick={() => {
                  setAnchor(null);
                  item.onClick();
                }}
                style={{
                  width: 32,
                  height: 32,
                  display: "grid",
                  placeItems: "center",
                  borderRadius: "var(--radius-sm)",
                  cursor: "pointer",
                  color: "var(--accent)",
                }}
              >
                {item.icon}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
