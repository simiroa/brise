import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { popoverRoot, useDismiss, useMenuPos } from "../lib/ui";
import { FluidHoverHighlight, useFluidHover } from "./common/FluidHover";
import { IconClose } from "./icons";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** Optional hover hint — e.g. why a row is disabled (AskAiActionBar's 위치 dropdown). */
  title?: string;
  /** Optional per-option style (e.g. font-family preview in the appearance picker). */
  style?: CSSProperties;
  /** Optional secondary remove action (e.g. for user-created eras/tags) */
  onRemove?: () => void;
  removeLabel?: string;
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  ariaLabel?: string;
  disabled?: boolean;
  /** e.g. "settings-phrase-pack-select" — trigger gets this id, listbox gets `${testid}-list`. */
  testid?: string;
  /** Trigger class — defaults to the existing native-select-lookalike contract. */
  className?: string;
  style?: CSSProperties;
}

/**
 * 인앱 리스트박스 — 네이티브 `<select>` 전면 대체 (W7-b, docs/PLAN-2026-08-04-w7.md §D). 네이티브
 * select 가 펼치는 옵션 목록은 OS 가 그려서 앱 CSS·`--fs`·`var(--font-body)`가 닿지 않고, OS 의
 * 스크립트별 폰트 폴백 때문에 한글/라틴 표기가 서로 다르게 보였다(owner 신고, 2026-08-04).
 * `NodePicker`(diagram/DiagramControls.tsx)·`ContextMenu`·`SearchHistoryDropdown` 이 이미 쓰던
 * `useMenuPos`+`useDismiss`+`.overlay`+`.menu-row .menu-item` 조합을 그대로 재사용한다 — 새 시각
 * 언어 없음. 닫힌 트리거는 기존 `.field-select` 크기/모양 계약을 그대로 쓴다(className 기본값).
 *
 * NodePicker 와 통합하지 않은 이유: NodePicker 는 "아직 안 고름" 빈 행을 항상 맨 앞에 붙이는
 * 도메인 규칙이 있고(어느 쪽에서/어느 쪽으로), 이 컴포넌트는 그 규칙이 없는 범용 폼 컨트롤이다 —
 * 옵션 하나 끼워 넣는 조건부 프롭 하나로 합치는 대신 두 개로 둔다(VerbMenu 의 헤더 주석과 같은
 * 판단: 두 콜사이트를 억지로 하나의 컴포넌트로 접으면 프레젠테이션 프롭만 늘어난다).
 */
export function Select({ value, onChange, options, ariaLabel, disabled, testid, className = "field-select", style }: SelectProps) {
  const [anchor, setAnchor] = useState<{ x: number; y: number; width: number } | null>(null);
  const { ref: listRef, x, y } = useMenuPos(anchor);
  // 열리자마자 하이라이트가 현재 값 행에 놓였다가 커서를 따라간다 — "지금 값 → 새 값" 이 한 번의 이동.
  const hover = useFluidHover(listRef, {
    axis: "y",
    from: () => listRef.current?.querySelector('[data-selected="true"]'),
  });
  const btnRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const open = anchor !== null;

  const close = (refocus = true) => {
    setAnchor(null);
    if (refocus) btnRef.current?.focus();
  };

  const updateAnchor = useCallback(() => {
    if (!btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    setAnchor({ x: r.left, y: r.bottom, width: r.width });
  }, []);

  useEffect(() => {
    if (!open) return;
    document.addEventListener("scroll", updateAnchor, true);
    window.addEventListener("resize", updateAnchor);
    return () => {
      document.removeEventListener("scroll", updateAnchor, true);
      window.removeEventListener("resize", updateAnchor);
    };
  }, [open, updateAnchor]);

  // Escape is handled locally by onListKey below (stops propagation) — outside-click only here,
  // same split as NodePicker/VerbMenu.
  useDismiss(open, [listRef, btnRef], () => setAnchor(null), { escape: false });

  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    (list?.querySelector<HTMLElement>('[aria-selected="true"]') ?? list?.querySelector<HTMLElement>('[role="option"]'))?.focus();
  }, [open, listRef]);

  /** Roving focus: Up/Down/Home/End move it, Enter/Space are the focused row's own activation, Esc closes. */
  const onListKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
    if (rows.length === 0) return;
    if (e.key === "Home") {
      e.preventDefault();
      rows[0]?.focus();
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      rows[rows.length - 1]?.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? at + 1 : at - 1;
    rows[(next + rows.length) % rows.length]?.focus();
  };

  const current = options.find((o) => o.value === value);

  return (
    <>
      <button
        type="button"
        ref={btnRef}
        className={className}
        data-testid={testid}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => {
          if (open) return close(false);
          updateAnchor();
        }}
        style={{
          width: "var(--settings-ctrl-w, 220px)",
          minWidth: "var(--settings-ctrl-w, 220px)",
          textAlign: "left",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          cursor: disabled ? "not-allowed" : "pointer",
          ...current?.style,
          ...style,
        }}
      >
        {current?.label ?? value}
      </button>
      {open &&
        createPortal(
          <div
            ref={listRef}
            id={listboxId}
            className="overlay fh-host"
            role="listbox"
            aria-label={ariaLabel}
            data-testid={testid ? `${testid}-list` : undefined}
            onKeyDown={onListKey}
            {...hover.handlers}
            style={{
              position: "fixed",
              left: x,
              top: y,
              zIndex: "var(--z-dropdown)",
              minWidth: Math.max(anchor?.width ?? 0, 100),
              maxWidth: "calc(100vw - 16px)",
              maxHeight: 280,
              overflowY: "auto",
              padding: "var(--space-1)",
              boxShadow: "var(--shadow-lg)",
            }}
          >
            <FluidHoverHighlight hover={hover} />
            {options.map((o) => {
              const selected = o.value === value;
              return (
                <div
                  key={o.value}
                  className="menu-row menu-item"
                  role="option"
                  tabIndex={-1}
                  aria-selected={selected}
                  data-selected={selected}
                  data-value={o.value}
                  aria-disabled={o.disabled}
                  title={o.title}
                  onClick={() => {
                    if (o.disabled) return;
                    onChange(o.value);
                    close();
                  }}
                  onKeyDown={(e) => {
                    if (o.disabled) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onChange(o.value);
                      close();
                    }
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "var(--space-2)",
                    width: "100%",
                    cursor: o.disabled ? "not-allowed" : "pointer",
                    opacity: o.disabled ? 0.5 : 1,
                    textAlign: "left",
                    userSelect: "none",
                    ...o.style,
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
                    {o.label}
                  </span>
                  {o.onRemove && (
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={o.removeLabel}
                      title={o.removeLabel}
                      onClick={(e) => {
                        e.stopPropagation();
                        o.onRemove?.();
                      }}
                      style={{
                        border: "none",
                        background: "none",
                        padding: "var(--space-2xs) 4px",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        opacity: 0.6,
                        cursor: "pointer",
                        color: "inherit",
                        flexShrink: 0,
                      }}
                    >
                      <IconClose size={11} strokeWidth={2} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>,
          // SettingsModal 등 <dialog>.showModal() 안의 콜사이트는 top layer에 올라가 바깥이
          // inert가 된다 — body로 포털하면 드롭다운이 백드롭 뒤에서 안 눌린다(popoverRoot 주석 참고).
          popoverRoot(btnRef.current),
        )}
    </>
  );
}
