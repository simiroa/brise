/**
 * Google-style recent-search panel shared by sidebar SearchBox and dashboard HomeTab search.
 * Both read/write the same useSearchStore.recentSearches list.
 */
import { useEffect, useMemo, useRef } from "react";
import {
  filterRecentSearches,
  useSearchStore,
} from "../stores/search";
import { IconClose } from "./icons";
import { t } from "../i18n/t";
import { useDismiss } from "../lib/ui";
import { FluidHoverHighlight, useFluidHover } from "./common/FluidHover";

export interface SearchHistoryDropdownProps {
  /** Parent input's current value — filters the list by substring. */
  query: string;
  open: boolean;
  /** Highlighted row (-1 = none). Parent owns keyboard index. */
  activeIndex: number;
  onActiveIndexChange: (i: number) => void;
  onPick: (q: string) => void;
  onClose: () => void;
  /** Optional test id prefix (defaults to "search-history"). */
  testId?: string;
  /** listbox id for aria-controls on the input. */
  listboxId?: string;
}

export function SearchHistoryDropdown({
  query,
  open,
  activeIndex,
  onActiveIndexChange,
  onPick,
  onClose,
  testId = "search-history",
  listboxId = "brise-search-history",
}: SearchHistoryDropdownProps) {
  const recentSearches = useSearchStore((s) => s.recentSearches);
  const removeRecentSearch = useSearchStore((s) => s.removeRecentSearch);
  const clearRecentSearches = useSearchStore((s) => s.clearRecentSearches);
  const wrapRef = useRef<HTMLDivElement>(null);
  const hover = useFluidHover(wrapRef, { axis: "y" });

  const items = useMemo(
    () => filterRecentSearches(recentSearches, query),
    [recentSearches, query],
  );

  // Clamp highlight when the filtered list shrinks.
  useEffect(() => {
    if (activeIndex >= items.length) {
      onActiveIndexChange(items.length > 0 ? items.length - 1 : -1);
    }
  }, [items.length, activeIndex, onActiveIndexChange]);

  // Outside mousedown closes (× / clear-all still work — they're inside wrapRef).
  useDismiss(open, [wrapRef], onClose, { escape: false });

  if (!open || items.length === 0) return null;

  return (
    <div
      ref={wrapRef}
      id={listboxId}
      role="listbox"
      data-testid={testId}
      className="overlay scroll fh-host"
      {...hover.handlers}
      style={{
        position: "absolute",
        top: "calc(100% + 4px)",
        left: 0,
        right: 0,
        maxHeight: 280,
        overflowY: "auto",
        borderRadius: "var(--radius-sm)",
        border: "1px solid var(--divider)",
        boxShadow: "var(--shadow-lg)",
        zIndex: "var(--z-dropdown)",
        padding: 4,
      }}
    >
      <FluidHoverHighlight hover={hover} />
      {items.map((item, idx) => {
        const active = idx === activeIndex;
        return (
          <div
            key={item}
            role="option"
            aria-selected={active}
            id={`${listboxId}-opt-${idx}`}
            data-testid={`${testId}-item-${idx}`}
            data-selected={active}
            className="menu-row menu-item"
            onMouseEnter={() => onActiveIndexChange(idx)}
            onMouseDown={(e) => {
              // Prevent input blur before pick.
              e.preventDefault();
            }}
            onClick={() => onPick(item)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-3)",
              width: "100%",
              textAlign: "left",
              padding: "var(--space-2) var(--space-4)",
              fontSize: "var(--text-sm)",
              borderRadius: "var(--radius-sm)",
              color: "var(--text)",
              cursor: "pointer",
            }}
          >
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {item}
            </span>
            <button
              type="button"
              data-testid={`${testId}-remove-${idx}`}
              title={t("search.history_remove")}
              aria-label={t("search.history_remove")}
              className="icon-btn icon-btn--sm"
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                removeRecentSearch(item);
              }}
              style={{ flex: "none", color: "var(--faint)" }}
            >
              <IconClose size={12} strokeWidth={2} />
            </button>
          </div>
        );
      })}
      <div className="menu-sep" />
      <button
        type="button"
        data-testid={`${testId}-clear-all`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          clearRecentSearches();
          onClose();
        }}
        style={{
          display: "block",
          width: "100%",
          marginTop: 0,
          padding: "var(--space-2) var(--space-3)",
          textAlign: "center",
          fontSize: "var(--text-xs)",
          color: "var(--muted)",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          borderRadius: "0 0 var(--radius-sm) var(--radius-sm)",
        }}
      >
        {t("search.history_clear_all")}
      </button>
    </div>
  );
}

/** Keyboard handler for history list when open. Returns true if the event was handled. */
export function handleSearchHistoryKeyDown(
  e: { key: string; preventDefault: () => void },
  opts: {
    open: boolean;
    items: string[];
    activeIndex: number;
    setActiveIndex: (i: number) => void;
    onPick: (q: string) => void;
    onClose: () => void;
  },
): boolean {
  const { open, items, activeIndex, setActiveIndex, onPick, onClose } = opts;
  if (!open || items.length === 0) return false;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    const next = activeIndex < items.length - 1 ? activeIndex + 1 : 0;
    setActiveIndex(next);
    return true;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    const next = activeIndex <= 0 ? items.length - 1 : activeIndex - 1;
    setActiveIndex(next);
    return true;
  }
  if (e.key === "Enter" && activeIndex >= 0 && activeIndex < items.length) {
    e.preventDefault();
    onPick(items[activeIndex]!);
    return true;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    onClose();
    return true;
  }
  return false;
}
