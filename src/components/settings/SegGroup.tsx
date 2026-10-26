/**
 * Generic pill-style N-way segmented control (role="radiogroup"/"radio"). Extracted from
 * AppearanceSection.tsx (originally a private 2-way theme/surface-style toggle) when
 * AiCapabilityCatalog needed a second use site — the AI policy level 3-way ladder (W11,
 * docs/PLAN-2026-08-30-ai-surface-and-clients.md §6-A). CLAUDE.md 코드 방침: 새 추상화는 두 번째
 * 사용처가 실제로 있을 때만 — 지금이 그 시점이다.
 *
 * Behavior is unchanged for the original two call sites (click/Enter/Space on any option), plus
 * roving Left/Right/Up/Down/Home/End arrow-key navigation added here — each option was already
 * its own tab stop (tabIndex=0), arrow keys now also move focus+selection between them the way a
 * native radiogroup does.
 */
import { useRef } from "react";
import { SETTINGS_CTRL_WIDTH } from "./shared";

export function SegGroup<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  /** disabled: 이 기기에서 고를 수 없는 칸(예: Windows 10 의 아크릴) — 보이되 선택되지 않는다.
   *  title 에 이유를 적는다. */
  options: { value: T; label: string; disabled?: boolean; title?: string }[];
  ariaLabel: string;
}) {
  const itemRefs = useRef<Array<HTMLDivElement | null>>([]);
  const activeIdx = options.findIndex((opt) => opt.value === value);

  const focusAndSelect = (idx: number) => {
    const clamped = ((idx % options.length) + options.length) % options.length;
    itemRefs.current[clamped]?.focus();
    if (!options[clamped].disabled) onChange(options[clamped].value);
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      style={{
        position: "relative",
        display: "flex",
        width: SETTINGS_CTRL_WIDTH,
        minWidth: SETTINGS_CTRL_WIDTH,
        minHeight: "var(--ctrl-h-lg)",
        boxSizing: "border-box",
        border: "1px solid var(--divider)",
        borderRadius: "var(--radius-sm)",
        overflow: "hidden",
      }}
    >
      {activeIdx >= 0 && (
        <div
          aria-hidden
          data-testid="seg-indicator"
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            width: `${100 / options.length}%`,
            transform: `translateX(${activeIdx * 100}%)`,
            background: "var(--accent)",
            zIndex: 0,
            pointerEvents: "none",
            transition: "transform var(--dur-fast) cubic-bezier(0.2, 0, 0, 1)",
          }}
        />
      )}
      {options.map((opt, idx) => {
        const on = value === opt.value;
        const pick = () => {
          if (!opt.disabled) onChange(opt.value);
        };
        return (
          <div
            key={opt.value}
            ref={(el) => {
              itemRefs.current[idx] = el;
            }}
            role="radio"
            aria-checked={on}
            aria-disabled={opt.disabled || undefined}
            title={opt.title}
            tabIndex={0}
            onClick={pick}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                pick();
              } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                e.preventDefault();
                focusAndSelect(idx + 1);
              } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                e.preventDefault();
                focusAndSelect(idx - 1);
              } else if (e.key === "Home") {
                e.preventDefault();
                focusAndSelect(0);
              } else if (e.key === "End") {
                e.preventDefault();
                focusAndSelect(options.length - 1);
              }
            }}
            style={{
              position: "relative",
              zIndex: 1,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              // 항목은 스트립을 균등 분할한다 — 글자 길이가 칸 너비를 정하면 같은 스트립 안에서도
              // 칸이 들쭉날쭉해진다.
              flex: "1 1 0",
              minWidth: 0,
              minHeight: "var(--ctrl-h-lg)",
              boxSizing: "border-box",
              padding: "0 var(--space-5)",
              fontSize: "var(--text-sm)",
              fontWeight: 600,
              cursor: opt.disabled ? "not-allowed" : "pointer",
              opacity: opt.disabled ? "var(--dim-disabled)" : undefined,
              borderLeft: idx > 0 ? "1px solid var(--divider)" : undefined,
              background: "transparent",
              color: on ? "var(--on-accent)" : "var(--muted)",
              transition: "color var(--dur-fast) ease",
            }}
          >
            {opt.label}
          </div>
        );
      })}
    </div>
  );
}
