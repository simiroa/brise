import { useRef } from "react";
import { useEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import { NodeSelection } from "@tiptap/pm/state";
import { t } from "../../../i18n/t";
import { emitNotice } from "../../../lib/invoke";
import { IconCopy, IconTrash } from "../../icons";
import { createStableRectAnchor } from "../stableAnchor";
import { copyImageToClipboard } from "../imageClipboard";
import { parseImageWidth, widthFromDrag } from "../imageResize";

/**
 * Desktop image selection bubble — width readout, copy, delete.
 * Why no 40/70/100 buttons: D5 moved desktop resize to the NodeView drag handle
 * (ImageNodeView). The bubble keeps remove so users still have a discoverable delete
 * without relying on Backspace alone. Width is free-drag; no snap presets on desktop.
 */
/** 스크롤 지문 — ProseMirror 콘텐츠 엘리먼트의 top. 안쪽 컨테이너가 스크롤되면 콘텐츠가
 *  밀려 이 값이 변하고(창 스크롤이 아니므로 window.scrollY 로는 안 잡힌다), 서식 토글로는
 *  변하지 않는다. 소수점은 버려 서브픽셀 요동으로 매번 재계산하지 않게 한다.
 *  TableMenu.tsx's TableBubbleMenu keeps its own copy of this (3 lines) rather than importing it
 *  from here — kept as separate small per-file copies rather than a shared helper (same tradeoff
 *  as isInsertStillOnTarget/isPasteStillOnTarget elsewhere in this codebase). */
function viewportEpochOf(editor: { view: { dom: HTMLElement } }): number {
  return Math.round(editor.view.dom.getBoundingClientRect().top);
}

export function ImageBubbleMenu({
  editor,
  scrollEl,
}: {
  editor: NonNullable<ReturnType<typeof useEditor>>;
  // N1-3: the editor's own scroll container (EditorPanel's `.scroll.editor-desktop` div) — passed
  // through as `options.scrollTarget` below so this bubble's floating-ui plugin listens to THAT
  // element's scroll events instead of defaulting to `window` (see the header comment on
  // EditorPanel's `scrollEl` state declaration for the full root-cause writeup).
  scrollEl: HTMLElement | null;
}) {
  const width = (editor.getAttributes("image").width as string) || "40%";
  // N1-2: same jitter as the text BubbleMenu, different trigger — dragging the NodeView resize
  // handle changes the SAME node's pixel width continuously without changing the NodeSelection's
  // (from,to). Recompute only when a different image node gets selected (see stableAnchor.ts).
  const anchorRef = useRef(createStableRectAnchor());
  const getReferencedVirtualElement = () => {
    const { selection } = editor.state;
    if (!(selection instanceof NodeSelection)) return null;
    const { from, to } = selection;
    const rect = anchorRef.current(
      from,
      to,
      () => {
        const node = editor.view.nodeDOM(from) as HTMLElement | null;
        // Owner QA 6, item 2 ("이미지 바로 근처가 아니라 멀리 있음"): anchor to `.brise-image-wrap`
        // — the element that actually carries the image's `width` style (tokens.css) — not the
        // full-column-width `[data-node-view-wrapper]` node (`.brise-image-node{display:block}`
        // spans the whole content column). `placement:"top"` centers over whatever rect it's
        // given, so anchoring to the column-wide wrapper centered the bubble over the WHOLE
        // column instead of the visibly narrower (often left-aligned) image, reading as "floats
        // far away" for anything less than 100% width.
        const wrap = node?.querySelector<HTMLElement>(".brise-image-wrap");
        return (wrap ?? node ?? editor.view.dom).getBoundingClientRect();
      },
      viewportEpochOf(editor),
    );
    return { getBoundingClientRect: () => rect, getClientRects: () => [rect] };
  };
  const copyImage = async () => {
    const node = editor.view.nodeDOM(editor.state.selection.from) as HTMLElement | null;
    // Reads the SAME `<img>` the user sees — ImageNodeView already resolved relPath → the real
    // asset:// display src at render time (see its own header comment); no need to re-derive
    // that resolution here.
    const img = node?.querySelector<HTMLImageElement>(".brise-image-img");
    if (!img?.src) {
      emitNotice(t("editor.image_copy_unsupported"));
      return;
    }
    try {
      await copyImageToClipboard(img.src);
    } catch (err) {
      // Honest degradation (owner spec) — WebView2's image-clipboard support is genuinely
      // uncertain (see imageClipboard.ts header), and a remote pasted image's fetch() is blocked
      // by CSP's connect-src allowlist. Never claim success that didn't happen.
      console.warn("image copy failed", err);
      emitNotice(t("editor.image_copy_unsupported"));
    }
  };

  const onWidthPointerDown = (e: React.PointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {}

    const startClientX = e.clientX;
    const startWidthPct = parseImageWidth(width);
    const { selection } = editor.state;
    const node = selection instanceof NodeSelection ? (editor.view.nodeDOM(selection.from) as HTMLElement | null) : null;
    const parentWidthPx =
      node?.closest(".ProseMirror")?.clientWidth ||
      editor.view.dom.clientWidth ||
      0;

    const onMove = (ev: PointerEvent) => {
      const next = widthFromDrag({
        startWidthPct,
        startClientX,
        clientX: ev.clientX,
        parentWidthPx,
      });
      editor.commands.updateAttributes("image", { width: next });
    };

    const onUp = (ev: PointerEvent) => {
      try {
        el.releasePointerCapture(ev.pointerId);
      } catch {}
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  return (
    <BubbleMenu
      editor={editor}
      appendTo={() => document.body}
      // N1-3: scrollTarget wires this bubble's floating-ui positioning to the ACTUAL scrolling
      // element instead of @tiptap/extension-bubble-menu's `window` default (see BubbleMenuPlugin
      // constructor: `this.scrollTarget = options?.scrollTarget ?? window`) — our editor scrolls
      // inside `.scroll.editor-desktop`, never the window, so without this the plugin's own
      // `scrollTarget.addEventListener("scroll", ...)` never fires and the bubble stays frozen at
      // its last screen position while the content flows underneath it.
      options={{ strategy: "fixed", placement: "top", offset: 8, scrollTarget: scrollEl ?? undefined }}
      shouldShow={({ editor: ed }) => ed.isActive("image")}
      getReferencedVirtualElement={getReferencedVirtualElement}
      className="overlay"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: 4,
        borderRadius: "var(--radius-pill)", // 가로 툴바형 — 외곽선·배경은 .overlay 레시피
        boxShadow: "var(--shadow-lg)",
        zIndex: "var(--z-dropdown)",
      }}
    >
      <span
        onPointerDown={onWidthPointerDown}
        style={{
          fontSize: "var(--text-xs)",
          padding: "var(--space-2xs) 6px",
          color: "var(--muted)",
          fontVariantNumeric: "tabular-nums",
          cursor: "col-resize",
          userSelect: "none",
        }}
        title={t("editor.image_resize_handle")}
      >
        {width}
      </span>
      <div style={{ width: 1, height: 14, background: "var(--divider)" }} />
      <button
        type="button"
        className="toolbar-btn"
        onClick={() => void copyImage()}
        title={t("editor.image_copy")}
        style={{ fontSize: "var(--text-xs)", padding: "var(--space-2xs) 6px" }}
      >
        <IconCopy size={13} strokeWidth={1.8} />
      </button>
      <div style={{ width: 1, height: 14, background: "var(--divider)" }} />
      <button
        type="button"
        className="toolbar-btn"
        onClick={() => editor.chain().focus().deleteSelection().run()}
        title={t("ctx.remove")}
        aria-label={t("ctx.remove")}
        style={{ fontSize: "var(--text-xs)", padding: "var(--space-2xs) 6px", color: "var(--danger)" }}
      >
        <IconTrash size={13} strokeWidth={1.8} />
      </button>
    </BubbleMenu>
  );
}
