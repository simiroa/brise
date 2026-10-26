import { Suspense, useCallback, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { useEditor } from "@tiptap/react";
import { t } from "../../i18n/t";
import { IconSmile } from "../icons";
import { ToolbarButton } from "./toolbar/buttons";
import { useDismiss } from "../../lib/ui";
import { EmojiGrid } from "../../lazySurfaces";
import { preloadIntentProps } from "../../lib/lazyPreload";



const POP_W = 300;

export function EmojiPicker({ editor }: { editor: NonNullable<ReturnType<typeof useEditor>> }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number }>({ top: 0, left: 0, maxHeight: 360 });
  const btnRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const updatePos = useCallback(() => {
    if (!btnRef.current) return;
    const btnRect = btnRef.current.getBoundingClientRect();
    const inset = 8;
    const cardEl = btnRef.current.closest(".content-canvas");
    if (cardEl) {
      const containerRect = cardEl.getBoundingClientRect();
      const rightLimit = Math.min(window.innerWidth - inset, containerRect.right - inset);
      const leftLimit = Math.max(inset, containerRect.left + inset);
      let left = btnRect.left;
      if (left + POP_W > rightLimit) {
        left = rightLimit - POP_W;
      }
      if (left < leftLimit) {
        left = leftLimit;
      }
      left = Math.max(inset, Math.min(left, Math.max(inset, window.innerWidth - POP_W - inset)));

      const top = btnRect.bottom + 6;
      const bottomLimit = Math.min(window.innerHeight - inset, containerRect.bottom - inset);
      const maxHeight = Math.max(150, bottomLimit - top);
      setPos({ top, left, maxHeight });
    } else {
      const left = Math.max(inset, Math.min(btnRect.left, window.innerWidth - POP_W - inset));
      const top = btnRect.bottom + 6;
      const maxHeight = Math.max(150, window.innerHeight - top - inset);
      setPos({ top, left, maxHeight });
    }
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePos();
    window.addEventListener("resize", updatePos);
    document.addEventListener("scroll", updatePos, true);
    return () => {
      window.removeEventListener("resize", updatePos);
      document.removeEventListener("scroll", updatePos, true);
    };
  }, [open, updatePos]);

  // close on outside click / Escape
  useDismiss(open, [popRef, btnRef], () => setOpen(false));

  return (
    <div ref={btnRef} style={{ display: "inline-flex" }}>
      <ToolbarButton
        title={t("editor.emoji")}
        onClick={() => {
          setOpen((v) => !v);
        }}
        active={open}
        {...preloadIntentProps(EmojiGrid)}
      >
        <IconSmile size={15} strokeWidth={1.9} />
      </ToolbarButton>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="overlay emoji-pop"
            role="dialog"
            aria-label={t("editor.emoji")}
            style={{ top: pos.top, left: pos.left, width: POP_W, maxWidth: "calc(100vw - 16px)", maxHeight: pos.maxHeight }}
          >
            <Suspense fallback={<div className="emoji-grid-root" style={{ minHeight: 180 }} />}>
              <EmojiGrid onPick={(g) => editor.chain().focus().insertContent(g).run()} />
            </Suspense>
          </div>,
          document.body
        )}
    </div>
  );
}

