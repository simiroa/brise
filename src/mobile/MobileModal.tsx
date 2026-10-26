import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useBackClosable } from "./useBackClosable";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The box the user can actually SEE, in layout-viewport coordinates.
 *
 *  This is the whole keyboard fix. A bottom sheet (`.mobile-sheet`, `bottom: 0`) puts its input
 *  fields and its action row exactly where the on-screen keyboard lands, which is the owner's
 *  report ("모달이 화면 맨 아래에 있어 입력하기 어렵다"). Centering alone does NOT fix it: on iOS
 *  Safari the keyboard does not resize the layout viewport, so `100vh`, `100dvh` and `%` all keep
 *  reporting the full screen height and a "centered" card centers itself behind the keyboard.
 *  `window.visualViewport` is the only API that reports the region left over above the keyboard.
 *
 *  `offsetTop` (not `pageTop`) is the right field: the backdrop is `position: fixed`, i.e. anchored
 *  to the LAYOUT viewport, and `offsetTop`/`height` describe the visual viewport's offset+size
 *  inside exactly that box. Returns null where the API is missing (jsdom, old Android WebView) —
 *  the CSS `inset: 0` fallback then applies and behaves like any other centered modal. */
function viewportBox(): { top: number; height: number } | null {
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  return vv ? { top: vv.offsetTop, height: vv.height } : null;
}

interface MobileModalProps {
  title: string;
  onClose: () => void;
  /** Action row pinned to the bottom of the CARD (never the screen), so it survives the keyboard. */
  footer?: React.ReactNode;
  /** "bottom" = full-width bottom sheet (long lists: filter, folder, region). Default "center" stays
   *  for short confirmations/inputs. Both dock inside the visualViewport box, so a bottom sheet
   *  sits ABOVE the keyboard, never behind it. */
  placement?: "center" | "bottom";
  children: React.ReactNode;
}

/**
 * The one overlay primitive for the mobile surface — centered card, not a bottom sheet.
 *
 * Layout contract (the sizing lives in CSS, `.mobile-modal*` in styles/mobile.css): the BACKDROP is
 * the visible-viewport box (px `top`/`height` from `visualViewport`, re-synced on its resize+scroll
 * events) and centers the card inside itself; the card is `max-height: 100%` of that box, splitting
 * into a fixed title, a scrolling body, and a fixed footer. So when the keyboard opens and the
 * visual viewport shrinks to ~300px, the card shrinks with it — the footer cannot be pushed under
 * the keyboard, and the focused field stays inside a scrollable area. No `dvh` math, no
 * `scrollIntoView` timers.
 *
 * API is deliberately four props (`title`/`onClose`/`footer`/`children`) so every sheet on this
 * surface — including the ones agent B owns (MobileAiSheet, node/edge action sheets) — can migrate
 * without a per-call-site decision.
 *
 * ponytail: `.mobile-sheet` (bottom-anchored) stays in mobile.css for the not-yet-migrated sheets;
 * delete it once MobileAiSheet/MobileHome/MobileNoteBadges are on this primitive too.
 */
export function MobileModal({ title, onClose, footer, placement = "center", children }: MobileModalProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState(viewportBox);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () => setBox(viewportBox());
    // resize = keyboard opened/closed or browser chrome changed; scroll = the visual viewport was
    // panned inside the layout viewport (iOS does this when focusing a field near the bottom).
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
    };
  }, []);

  // Focus into the dialog on open, back to the trigger on close (same contract as desktop's
  // ModalShell — a11y basic, not re-litigated here).
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const card = cardRef.current;
    (card?.querySelector<HTMLElement>(FOCUSABLE) ?? card)?.focus();
    return () => previouslyFocused?.focus?.();
  }, []);

  // Esc closes; Tab wraps inside the card (only while focus is actually in here, so a stacked
  // dialog can't have its focus stolen by the one underneath).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const card = cardRef.current;
      if (!card || !card.contains(document.activeElement)) return;
      const items = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const idx = items.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey && idx <= 0) {
        e.preventDefault();
        items[items.length - 1].focus();
      } else if (!e.shiftKey && idx === items.length - 1) {
        e.preventDefault();
        items[0].focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Android back gesture. One throwaway history entry is pushed on open so the system back button
  // pops THAT (closing the modal) instead of falling through to MobileApp's screen stack, which
  // would dump the user off the screen entirely with the modal still on top. Any other close path
  // pops the entry back off, so the stack is left exactly as we found it.
  // ponytail: popping our entry makes MobileApp's own popstate handler re-run for the unchanged
  // screen, which replays its 200ms slide once. Cosmetic; fixing it needs a marker MobileApp reads,
  // and MobileApp is another agent's file.
  // Logic lives in useBackClosable (shared with the bottom sheets and tree overlays).
  useBackClosable(true, onClose);

  return createPortal(
    <div
      className={`mobile-modal-backdrop${placement === "bottom" ? " mobile-modal-backdrop--bottom" : ""}`}
      data-testid="mobile-modal-backdrop"
      onClick={onClose}
      // Only geometry is inline — the scrim colour stays class-owned (SURFACE PRESET CONTRACT).
      // `bottom: auto` releases the CSS `inset: 0` fallback so the px height actually applies.
      style={box ? { top: box.top, height: box.height, bottom: "auto" } : undefined}
    >
      <div
        ref={cardRef}
        className={`mobile-modal overlay${placement === "bottom" ? " mobile-modal--bottom" : ""}`}
        data-testid="mobile-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mobile-modal-title label-caps">{title}</div>
        <div className="mobile-modal-body scroll">{children}</div>
        {footer && (
          <div className="mobile-modal-footer" data-testid="mobile-modal-footer">
            {footer}
          </div>
        )}
      </div>
    </div>,
    // Into `.mobile-app`, not <body>: the phone's type ramp (--m-*/--text-*), the per-device text
    // size (--fs, set inline on .mobile-app by mobilePrefs.ts) and the gutter (--m-gutter) are all
    // defined on that element. Portaled to <body>, every dialog fell back to desktop sizes and an
    // undefined gutter (title flush against the card edge — red-team 2026-10-05). position:fixed
    // still escapes the screen layout: .mobile-app has no transform/filter/contain.
    document.querySelector(".mobile-app") ?? document.body
  );
}
