import { useState, type ComponentType } from "react";
import { IconHelp, type IconProps } from "../icons";

/**
 * A rule is either the legacy literal string (rendered as a monospace `<code>` chip — EditorPanel's
 * markdown cheatsheet still uses this, it has no gestures/keys to distinguish) or a token list that
 * renders as a mix of the three vocabularies this popover speaks:
 *   - gesture chip: icon + short label (mouse/drag actions — icon alone is too ambiguous, so the
 *     label stays)
 *   - key cap: a `<kbd>`-styled box for a literal keyboard key (Shift, Ctrl, Delete, F2, ...)
 *   - sep: a plain connector glyph ("+" combines a chord, "·"/"/" lists alternatives)
 * Build a token list with the Gesture/Key/Sep helpers below.
 */
export type RuleToken =
  | { kind: "gesture"; icon: ComponentType<IconProps>; label: string }
  | { kind: "key"; label: string }
  | { kind: "sep"; ch: string };

export function Gesture(icon: ComponentType<IconProps>, label: string): RuleToken {
  return { kind: "gesture", icon, label };
}
export function Key(label: string): RuleToken {
  return { kind: "key", label };
}
export function Sep(ch: string): RuleToken {
  return { kind: "sep", ch };
}

/** 한 행: 왼쪽 키/제스처 칩, 오른쪽 설명. */
export interface CheatsheetRow {
  rule: string | RuleToken[];
  desc: string;
}

/** 구획 제목 한 줄. 아래 행들을 묶는다. */
export interface CheatsheetHeading {
  heading: string;
}

export type CheatsheetItem = CheatsheetRow | CheatsheetHeading;

/** Exported so hand-built status bars (SheetSection's footer hint) can render the same three-token
 *  vocabulary without going through the popover shell. */
export function RuleCell({ rule }: { rule: CheatsheetRow["rule"] }) {
  if (typeof rule === "string") {
    return (
      <code style={{ fontFamily: "monospace", color: "var(--accent)", background: "var(--hover)", padding: "1px 4px", borderRadius: 3 }}>
        {rule}
      </code>
    );
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end", gap: 3 }}>
      {rule.map((token, i) => {
        if (token.kind === "sep") {
          return <span key={i} style={{ color: "var(--muted)" }}>{token.ch}</span>;
        }
        if (token.kind === "key") {
          return (
            <kbd
              key={i}
              style={{
                fontFamily: "monospace",
                fontSize: "var(--text-2xs)",
                color: "var(--text)",
                background: "var(--hover)",
                border: "1px solid var(--divider)",
                borderRadius: 3,
                padding: "1px 4px",
                lineHeight: 1.4,
              }}
            >
              {token.label}
            </kbd>
          );
        }
        const Icon = token.icon;
        return (
          <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: "var(--space-2xs)" }}>
            <Icon size={11} strokeWidth={2} style={{ color: "var(--accent)" }} />
            <span style={{ color: "var(--text)" }}>{token.label}</span>
          </span>
        );
      })}
    </span>
  );
}

/**
 * The '?' popover that sits at the right end of a bottom bar (프로즈 통계바 · 관계도 힌트바).
 *
 * Extracted from EditorPanel (2026-08-12) when the 관계도 hint bar became the second caller. Both
 * surfaces carry the SAME contract the markdown cheatsheet was written under: only rules/gestures
 * that are proven to work go in the list — EditorPanel's come from inputRules.test.ts, the
 * diagram's from a line-by-line read of FlowCanvas's own handlers. A cheatsheet that documents a
 * gesture the code doesn't have is worse than no cheatsheet.
 *
 * hover 로 열리고 click 으로 고정된다(owner). 예전엔 `open` state 가 하나 더 있었지만 mouseenter
 * 에서만 true 가 되고 false 로 돌아가는 곳이 없어, 첫 hover 이후로는 항상 참인 죽은 조건이었다 —
 * hovered 하나로 같은 동작이다.
 */
export function CheatsheetPopover({ title, items }: { title: string; items: CheatsheetItem[] }) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);

  const isOpen = pinned || hovered;

  return (
    <div
      style={{ position: "relative", display: "inline-flex", alignItems: "center" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        className="icon-btn icon-btn--sm icon-btn--glow"
        data-testid="cheatsheet-toggle"
        data-pinned={pinned ? "true" : undefined}
        onClick={() => setPinned((p) => !p)}
        // 20×20, inline: this button predates icon-btn--sm (26px) and lives in a text-height bar —
        // the class is here for the shared hover/focus skin, the size stays as it was drawn.
        style={{
          width: 18,
          height: 18,
          fontSize: "var(--text-xs)",
          fontWeight: 600,
          borderRadius: "50%",
          padding: 0,
          display: "grid",
          placeItems: "center",
          background: "transparent",
          border: "none",
          boxShadow: "none",
          color: pinned ? "var(--accent)" : hovered ? "var(--text)" : "var(--muted)",
          opacity: pinned || hovered ? 1 : 0.7,
          filter: pinned
            ? "drop-shadow(0 0 3px color-mix(in srgb, var(--accent) 60%, transparent))"
            : hovered
            ? "drop-shadow(0 0 2px color-mix(in srgb, var(--accent) 45%, transparent))"
            : "none",
          transition: "color var(--dur-fast), filter var(--dur-fast), opacity var(--dur-fast)",
        }}
        title={title}
      >
        <IconHelp size={12} strokeWidth={2.2} />
      </button>
      {isOpen && (
        <div
          className="overlay"
          data-testid="cheatsheet-panel"
          style={{
            position: "absolute",
            bottom: "calc(100% + 8px)",
            right: 0,
            zIndex: "var(--z-dropdown)",
            width: "min(260px, calc(100vw - var(--space-6)))",
            padding: "var(--space-3)",
            border: "2px solid var(--divider)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-lg)",
            fontSize: "var(--text-xs)",
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: "var(--space-2)", color: "var(--text)" }}>{title}</div>
          {/* className="scroll" 병기 — noscroll 은 쓰지 않는다 (여기서는 스크롤 가능하다는 시각적 단서 필요).
              제목 줄은 상단에 고정된 채 목록만 스크롤되도록 목록 컨테이너에 maxHeight 및 overflowY 적용. */}
          <div
            className="scroll"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
              maxHeight: "min(46vh, 360px)",
              overflowY: "auto",
            }}
          >
            {items.map((item, i) => {
              if ("heading" in item) {
                return (
                  <div
                    key={i}
                    style={{
                      fontSize: "var(--text-2xs)",
                      color: "var(--muted)",
                      fontWeight: 600,
                      marginTop: i === 0 ? 0 : "var(--space-2)",
                      padding: "var(--space-1) var(--space-1)",
                    }}
                  >
                    {item.heading}
                  </div>
                );
              }
              return (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <RuleCell rule={item.rule} />
                  <span style={{ color: "var(--muted)" }}>{item.desc}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
