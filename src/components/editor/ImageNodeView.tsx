import { useCallback, useMemo, useRef } from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { formatImageWidth, parseImageWidth, widthFromDrag } from "./imageResize";
import { isSafeRelPath, isSafeImgSrc } from "./imageExtension";
import { useAttachmentsBase } from "../../lib/attachmentsBase";
import { t } from "../../i18n/t";

/**
 * Desktop D5 resize: a drag handle on the image itself (not 40/70/100 buttons).
 *
 * Why NodeView: stock Image renders a plain <img>; free-drag needs a sibling handle and
 * pointer listeners that write the `width` attr. Mobile keeps the 3-step buttons and hides
 * this handle via CSS (`.mobile-app .brise-image-resize-handle { display:none }`) so one
 * node view serves both surfaces without branching the extension.
 *
 * Display-src resolution lives HERE, at render time, not at insert time. Root-cause fix
 * (2026-08): the persisted/parsed form is always `relPath` (a portable note-relative path,
 * imageExtension.ts); resolving it to a paintable asset:// URL requires the attachments base
 * dir, which is only available async (useAttachmentsBase, a Tauri IPC round trip). Insert paths
 * (Toolbar.tsx's ImageButton, EditorPanel.tsx's pasteImageFile) used to pre-resolve that URL
 * once at insert time and stuff it into the `src` attr — but the very next setContent() (the
 * post-insert reloadActive() round-trip, or any later note reload) re-parses body_md fresh via
 * parseMarkdown, which only ever produces the raw relPath in `src` (never resolved) — so the
 * good insert-time src was replaced by a broken one almost immediately, and every reload of a
 * note with a saved image showed it broken. Resolving here instead means insert-time and
 * reload-time paint through the exact same code path — nothing to go stale.
 */

/** Exported for testing. Pure resolution decision behind the `src` useMemo below: relPath (if
 *  present and safe, isSafeRelPath in imageExtension.ts) resolved via convert() once the
 *  attachments base dir is ready; otherwise the raw `src` attr, itself gated by isSafeImgSrc.
 *  Covers three cases in one function: a local attachment image (relPath wins), a remote
 *  http(s) image (relPath is null, falls back to the real src URL), and the cold-cache window
 *  before baseDir/convert resolve (also falls back to src, self-corrects on the next render
 *  once useAttachmentsBase resolves). The isSafeImgSrc gate on the fallback matters because
 *  parseMarkdown sets `src` to the same unvalidated href relPath comes from — a body containing
 *  `![](file:///etc/passwd)` must not reach `<img src>` via this fallback just because relPath
 *  was (correctly) rejected. */
export function resolveImageDisplaySrc(
  relPath: string | null,
  rawSrc: string,
  baseDir: string | null,
  convert: ((path: string) => string) | null,
): string {
  if (isSafeRelPath(relPath) && baseDir && convert) {
    return convert(`${baseDir}/${relPath}`);
  }
  return isSafeImgSrc(rawSrc) ? rawSrc : "";
}

export function ImageNodeView({ node, updateAttributes, selected }: NodeViewProps) {
  // Owner QA 6, item 7 (multiple images per line): a <span>, not a <div> — the outer
  // ReactNodeViewRenderer wrapper already auto-switches to <span> once the node is inline
  // (`this.node.isInline ? "span" : "div"`, @tiptap/react's ReactNodeView), and nesting a <div>
  // inside it would be invalid HTML for no benefit — `display: inline-block` (tokens.css) makes a
  // <span> just as capable of carrying an explicit width as a div would.
  const wrapRef = useRef<HTMLSpanElement>(null);
  const width = (node.attrs.width as string) || "40%";
  const rawSrc = (node.attrs.src as string) || "";
  const alt = (node.attrs.alt as string) || "";
  const relPath = (node.attrs.relPath as string | null) || null;
  const title = (node.attrs.title as string | null) || null;
  const widthPct = parseImageWidth(width);

  // relPath (safe) is primary — resolved live via the attachments base dir. Falls back to the
  // raw `src` attr when relPath is absent/unsafe, or while the base dir is still resolving on a
  // cold cache (useBaseDirCache re-renders this component once it lands, self-healing within the
  // same session instead of staying broken until a full reload — see baseDirCache.ts).
  const { baseDir, convert } = useAttachmentsBase();
  const src = useMemo(
    () => resolveImageDisplaySrc(relPath, rawSrc, baseDir, convert),
    [relPath, rawSrc, baseDir, convert]
  );

  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLSpanElement>) => {
      // Stop the editor from starting a node drag / text selection while we resize.
      e.preventDefault();
      e.stopPropagation();

      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);

      const startClientX = e.clientX;
      const startWidthPct = parseImageWidth(width);
      // Content column = ProseMirror root. The wrap is only as wide as the image, so using
      // it as the denominator would make the same pixel drag change % more as the image shrinks.
      const parentWidthPx =
        wrapRef.current?.closest(".ProseMirror")?.clientWidth ||
        wrapRef.current?.parentElement?.clientWidth ||
        0;

      const onMove = (ev: PointerEvent) => {
        const next = widthFromDrag({
          startWidthPct,
          startClientX,
          clientX: ev.clientX,
          parentWidthPx,
        });
        updateAttributes({ width: next });
      };

      const onUp = (ev: PointerEvent) => {
        if (handle.hasPointerCapture(ev.pointerId)) {
          handle.releasePointerCapture(ev.pointerId);
        }
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
      };

      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    },
    [updateAttributes, width],
  );

  const nudge = (delta: number) => {
    updateAttributes({ width: formatImageWidth(widthPct + delta) });
  };

  return (
    <NodeViewWrapper
      as="span"
      className={`brise-image-node${selected ? " brise-image-node--selected" : ""}`}
      data-drag-handle
    >
      <span
        ref={wrapRef}
        className="brise-image-wrap"
        // Absolute pixel cap (--editor-img-max, tokens.css) on top of the percent-of-column
        // width — owner: images must not balloon in full-width mode ("fixed feel"). min()
        // composes both constraints in one declaration; the stored width attr keeps meaning
        // "% of column" either way (resize still writes a %), display just clamps it.
        style={{ width, maxWidth: "min(100%, var(--editor-img-max))" }}
      >
        <img
          src={src}
          alt={alt}
          title={title || undefined}
          data-rel-path={relPath || undefined}
          draggable={false}
          className="brise-image-img"
        />
        {/* Desktop-only free-drag handle — see tokens.css + mobile hide rule. */}
        <span
          className="brise-image-resize-handle"
          role="slider"
          aria-label={t("editor.image_resize_handle")}
          aria-valuemin={10}
          aria-valuemax={100}
          aria-valuenow={widthPct}
          aria-valuetext={width}
          tabIndex={0}
          onPointerDown={onHandlePointerDown}
          onKeyDown={(e) => {
            // Keyboard fallback: arrow keys nudge 5% (shift = 10%) so the control isn't mouse-only.
            const step = e.shiftKey ? 10 : 5;
            if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
              e.preventDefault();
              nudge(-step);
            } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
              e.preventDefault();
              nudge(step);
            }
          }}
        />
      </span>
    </NodeViewWrapper>
  );
}
