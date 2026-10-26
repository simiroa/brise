/**
 * Wave 3 — shared plumbing behind both "/" slash commands and "[[" wiki-links: a tiptap
 * `Suggestion` popup rendered as a real React tree (ReactRenderer) inside a `position: fixed`
 * div appended straight to `document.body`.
 *
 * Why manual positioning instead of tippy.js (the usual community pairing for Suggestion):
 * tippy isn't an existing dependency, and BubbleMenu just above in EditorPanel.tsx already hit
 * the same wall — a backdrop-filter ancestor (acrylic surfaces) creates a containing block for
 * `position: fixed` descendants, so anything meant to float above the whole window has to escape
 * that subtree via `document.body` and compute its own screen position. Same fix, reused here.
 *
 * `closed` guards onUpdate/onKeyDown/onExit against acting on an already-torn-down popup: Escape
 * destroys the popup immediately, but the Suggestion plugin itself keeps running (the trigger
 * text is still under the cursor) and will call onUpdate again on the very next keystroke unless
 * every handler checks this flag first.
 */
import { ReactRenderer } from "@tiptap/react";
import type { SuggestionOptions, SuggestionKeyDownProps } from "@tiptap/suggestion";
import { flipMenuPos } from "../../lib/ui";

/** What every popup list component (SlashMenuList, WikiLinkMenuList) must expose via ref. */
export interface SuggestionListRef {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
}

export function createSuggestionRender<TItem>(
  ListComponent: React.ComponentType<{ items: TItem[]; command: (item: TItem) => void }>
): SuggestionOptions<TItem>["render"] {
  return () => {
    let component: ReactRenderer<SuggestionListRef> | null = null;
    let popup: HTMLDivElement | null = null;
    let closed = false;

    const reposition = (clientRect: (() => DOMRect | null) | null | undefined) => {
      if (!popup) return;
      const rect = clientRect?.();
      if (!rect) return;
      // popup is already attached to document.body at this point, so its real rendered size
      // (not a guessed constant) is available — flip up above the caret (rect.top - 6, same gap
      // as the default 6px below) when there isn't room to open downward.
      const { width, height } = popup.getBoundingClientRect();
      const { x, y } = flipMenuPos(rect.left, rect.bottom + 6, width, height, 8, rect.top - 6);
      popup.style.left = `${x}px`;
      popup.style.top = `${y}px`;
    };

    const teardown = () => {
      if (closed) return;
      closed = true;
      popup?.remove();
      component?.destroy();
    };

    return {
      onStart: (props) => {
        closed = false;
        component = new ReactRenderer(ListComponent, { props, editor: props.editor });
        popup = document.createElement("div");
        popup.className = "overlay";
        Object.assign(popup.style, {
          position: "fixed",
          zIndex: "var(--z-dropdown)",
          minWidth: "220px",
          border: "2px solid var(--divider)",
          borderRadius: "var(--radius-md)",
          boxShadow: "var(--shadow-lg)",
          padding: "5px",
        });
        popup.appendChild(component.element);
        document.body.appendChild(popup);
        reposition(props.clientRect);
      },
      onUpdate: (props) => {
        if (closed || !component || !popup) return;
        component.updateProps(props);
        reposition(props.clientRect);
      },
      onKeyDown: (props) => {
        if (closed || !component) return false;
        if (props.event.key === "Escape") {
          teardown();
          return true;
        }
        return component.ref?.onKeyDown(props) ?? false;
      },
      onExit: () => {
        teardown();
      },
    };
  };
}
