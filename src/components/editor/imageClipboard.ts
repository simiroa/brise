/**
 * "이미지 복사" (copy image) — owner QA 6, item 2.
 *
 * Route chosen: fetch the image's already-resolved display `src` (ImageNodeView already paints
 * the real asset:// URL into the live `<img>`, so the bubble just reads that DOM element instead
 * of re-deriving it) → re-encode to PNG via a canvas round-trip → `navigator.clipboard.write`.
 *
 * Why not the Tauri clipboard-manager plugin's `writeImage` (already a project dependency, and
 * already imported in EditorPanel.tsx for text): checked first, since an already-installed native
 * API beats a browser one. It's gated behind a capability
 * (`clipboard-manager:allow-write-image`) that isn't granted in
 * src-tauri/capabilities/default.json — only allow-read-text/allow-write-text are. Granting it is
 * a src-tauri change, out of this agent's frontend-only scope (no cargo). So the standard
 * Clipboard API is the only frontend-only option, which is what the owner's ticket specified in
 * the first place.
 *
 * WebView2's support for writing image ClipboardItems is genuinely uncertain — callers must
 * treat a thrown error as "not supported here" and degrade with a notice, never claim success
 * that didn't happen (see EditorPanel.tsx's ImageBubbleMenu for the catch site).
 *
 * CSP note: `connect-src` (src-tauri/tauri.conf.json) allows `fetch()` of local attachment images
 * (`asset:`/`http(s)://asset.localhost`) but NOT arbitrary remote origins — a pasted-from-the-web
 * image's `fetch()` will reject under CSP before it ever reaches the clipboard step. That surfaces
 * as the same "couldn't copy" notice, which is honest (it really can't be copied via this path)
 * rather than a bug to chase.
 */

/** Exported for testing. Re-encodes an arbitrary image Blob to PNG via a canvas round-trip —
 *  ClipboardItem requires the declared MIME to match the actual bytes, and the source (a pasted
 *  screenshot, a jpg/webp/gif/svg attachment, whatever) is never guaranteed to already be PNG.
 *  Always re-encoding (rather than only "if needed") keeps this to one code path with no MIME
 *  sniffing to get wrong. */
export async function blobToPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas context unavailable");
    ctx.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((out) => (out ? resolve(out) : reject(new Error("PNG encode failed"))), "image/png");
    });
  } finally {
    bitmap.close?.();
  }
}

/** Exported for testing. Fetches `imgSrc` (the resolved display src already painted into the
 *  live `<img>`), re-encodes it to PNG, and writes it to the system clipboard. Rejects on any
 *  failure — fetch (network/CSP), decode, or an unsupported/rejected clipboard write; callers
 *  decide how to surface that (see module header). */
export async function copyImageToClipboard(imgSrc: string): Promise<void> {
  const res = await fetch(imgSrc);
  if (!res.ok) throw new Error(`image fetch failed: ${res.status}`);
  const blob = await res.blob();
  const png = await blobToPng(blob);
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}
