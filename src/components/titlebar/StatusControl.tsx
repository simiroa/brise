import React, { useState, useRef, useEffect, useId } from "react";
import { createPortal } from "react-dom";
import { useDismiss, useMenuPos } from "../../lib/ui";
import { FluidHoverHighlight, useFluidHover } from "../common/FluidHover";
import {
  BUILT_IN_STATUSES,
  statusColorVar,
  customStatusName,
  statusOptions,
  statusOptionLabel,
} from "../../lib/status";
import type { StatusEntry } from "../../lib/commands.gen";
import { t } from "../../i18n/t";
import { FOLDER_BADGE_MAX_PX } from "./FolderBadge";

/** 상태 색점 — 아이콘이 아니라 색상 자체가 정보라서 lucide 아이콘 대신 순수 색 스와치를 쓴다
 * (FolderColorDialog의 색 미리보기 <span>과 동일한 관례). Shared with ContextMenu (size=15). */
export function StatusDot({ color, size = 9 }: { color: string; size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        flex: "none",
        transition: "background-color var(--dur-fast) ease, transform var(--dur-fast) cubic-bezier(0.34, 1.56, 0.64, 1)",
      }}
    />
  );
}

export function StatusControl({
  status,
  customStatuses,
  onChange,
}: {
  status: string | null;
  customStatuses: StatusEntry[];
  onChange: (status: string | null) => void;
}) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const listboxId = useId();
  const btnRef = useRef<HTMLButtonElement>(null);
  const { ref: listRef, x, y } = useMenuPos(anchor);
  const hover = useFluidHover(listRef, { axis: "y" });

  useDismiss(!!anchor, [btnRef, listRef], () => setAnchor(null), {
    onEscape: () => {
      setAnchor(null);
      btnRef.current?.focus();
    },
  });

  // Land initial focus on the selected row (or the first row) whenever the list opens.
  useEffect(() => {
    if (!anchor) return;
    const selected = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    const first = listRef.current?.querySelector<HTMLElement>("button");
    (selected ?? first)?.focus();
  }, [anchor, listRef]);

  const builtIn = BUILT_IN_STATUSES.find((s) => s.key === status);
  const customName = status ? customStatusName(status, customStatuses) : undefined;
  const label = builtIn ? t(builtIn.labelKey) : (customName ?? t("note.no_status"));
  const tooltip = `${t("note.status_label")}: ${label}`;
  const chooseStatus = (next: string | null) => {
    onChange(next);
    setAnchor(null);
    btnRef.current?.focus();
  };

  // width/textAlign/font/border 는 .menu-item 클래스가 담당(className="menu-row menu-item").
  const optionStyle: React.CSSProperties = {
    padding: "var(--space-2) var(--space-4)",
    display: "flex",
    alignItems: "center",
    gap: "var(--space-3)",
  };

  return (
    <div style={{ display: "flex", flex: "none", alignItems: "center" }}>
      <button
        type="button"
        ref={btnRef}
        className="tag-btn tb-quiet-chip"
        data-empty={!status || undefined}
        onClick={() => {
          if (anchor) {
            setAnchor(null);
          } else {
            const rect = btnRef.current?.getBoundingClientRect();
            if (rect) {
              setAnchor({ x: rect.left, y: rect.bottom + 4 });
            }
          }
        }}
        aria-label={tooltip}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-expanded={!!anchor}
        style={{
          flex: "none",
          maxWidth: FOLDER_BADGE_MAX_PX,
          boxSizing: "border-box",
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "var(--tb-chip-pt) var(--space-4) 0",
          borderRadius: "var(--radius-sm)",
          color: status ? "var(--text)" : "var(--muted)",
          fontFamily: "var(--font-body)",
          fontSize: "var(--text-xs)",
          fontWeight: 400,
          height: "var(--tb-chip-h)",
          cursor: "pointer",
          overflow: "hidden",
        }}
      >
        {status ? (
          <StatusDot color={statusColorVar(status)} />
        ) : (
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", border: "1.5px solid var(--faint)", flex: "none" }} />
        )}
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {label}
        </span>
      </button>
      {anchor &&
        createPortal(
          <div
            ref={listRef}
            id={listboxId}
            className="overlay fh-host"
            role="listbox"
            aria-label={t("note.status_label")}
            onMouseDown={(e) => e.stopPropagation()}
            {...hover.handlers}
            style={{
              position: "fixed",
              top: y,
              left: x,
              zIndex: "var(--z-dropdown)",
              display: "flex",
              flexDirection: "column",
              gap: 0,
              padding: "var(--space-1)",
              minWidth: 150,
              maxWidth: "calc(100vw - 16px)",
              boxShadow: "var(--shadow-lg)",
            }}
          >
            <FluidHoverHighlight hover={hover} />
            {statusOptions(customStatuses).map((opt) => {
              const selected = status === opt.key;
              const label = statusOptionLabel(opt, t);
              const isNone = opt.key === null;
              return (
                <button
                  key={opt.key ?? "__none__"}
                  type="button"
                  className="menu-row menu-item"
                  role="option"
                  aria-selected={selected}
                  data-selected={selected}
                  onClick={() => chooseStatus(opt.key)}
                  style={{
                    ...optionStyle,
                    ...(isNone ? { fontStyle: "italic", color: "var(--muted)" } : null),
                    ...(!isNone && "name" in opt ? { overflowWrap: "anywhere" as const } : null),
                  }}
                >
                  {opt.colorVar ? <StatusDot color={opt.colorVar} /> : null}
                  {label}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
