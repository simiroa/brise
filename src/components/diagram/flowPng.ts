/**
 * flowPng — the 관계도 캔버스 → PNG 내보내기, and nothing else.
 *
 * WHY IT CAPTURES THE VIEWPORT AND NOT THE SCREEN: the user's viewport shows whatever they last
 * panned to, at whatever zoom. An export that reproduced that would clip half the diagram. So this
 * measures the NODES' own bounding box (React Flow's getNodesBounds) and hands html-to-image a
 * one-off size + transform for the clone only — the live canvas is never touched, never re-fit, and
 * the user's viewport is exactly where they left it when the file lands.
 *
 * WHERE THE FILE GOES — TWO DESTINATIONS, ONE RASTER. `renderPng` is the single producer; the two
 * exported functions are only "where do the bytes land":
 *
 *   - `exportFlowPngToFile` (the primary button): plugin-dialog `save()` → `export_diagram_png
 *     { dest_path, data_base64 }`. For handing the picture to someone outside the app.
 *   - `exportFlowPngAttachment`: `attachment_add_bytes { note_id, name, data_base64 }`. The copy
 *     that travels WITH the note — synced, searchable, listed on the 첨부 카드.
 *
 * (History, because it constrains both: the original answer was `<a download>`, i.e. hand the data
 * URL to the WebView and let WebView2's download UI take it. It worked, and it was invisible — no
 * toast, no entry anywhere in the app. Owner: "저장됐는지 알 수가 없다". Whatever the destination,
 * an export that ends without a notice naming WHERE the file went did not export anything. Both
 * paths below end in an emitNotice carrying the filename or the full path.)
 */
import { getNodesBounds, type Node } from "@xyflow/react";
import { t } from "../../i18n/t";
import { call, emitNotice } from "../../lib/invoke";
import { useNotesStore } from "../../stores/notes";
import type { ExportDiagramPngOutput } from "../../lib/commands.gen";

/** Breathing room around the diagram, in diagram px. Also absorbs the bits that live OUTSIDE the
 *  node bounding box — a self-loop's bulge, an edge label chip that overhangs the outermost box. */
const PAD = 48;
/** Ceiling on the exported image, before pixelRatio. A 60-box diagram at 1:1 is already large; past
 *  this the browser's own canvas limits start to bite and a silent blank PNG is the failure mode. */
const MAX_SIDE = 4000;
/** Retina-ish. 1× labels look soft next to the crisp box borders. */
const PIXEL_RATIO = 2;

/** `YYYY-MM-DD`, the same slice the backup filename uses (DataManagementSection). */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function pngFilename(date = today()): string {
  return `brise-diagram-${date}.png`;
}

/**
 * The raster, as raw base64 — never the `data:image/png;base64,` prefix, because both destinations
 * feed a Rust side that decodes raw base64 and rejects the prefix (VALIDATION).
 *
 * `host` is FlowCanvas's own `.diagram-flow` div. Returns null when there is nothing to draw or the
 * canvas isn't mounted yet; throws whatever html-to-image throws (the caller already owns a
 * failure notice for both).
 */
async function renderPng(host: HTMLElement, nodes: Node[], background: string): Promise<string | null> {
  const viewport = host.querySelector<HTMLElement>(".react-flow__viewport");
  if (!viewport || nodes.length === 0) return null;

  const bounds = getNodesBounds(nodes);
  const width = Math.min(Math.round(bounds.width) + PAD * 2, MAX_SIDE);
  const height = Math.min(Math.round(bounds.height) + PAD * 2, MAX_SIDE);

  // The arrowheads live in FlowCanvas's own <defs>, which is a SIBLING of the viewport — every
  // `marker-end: url(#brise-flow-arrow)` in the clone would dangle and the PNG would come out with
  // lines but no arrows. Cheapest honest fix: lend the viewport a copy for the duration of the
  // capture. The duplicate id is live for those few ms only, and both copies are identical.
  const defs = host.querySelector(".diagram-flow-defs");
  const lent = defs ? viewport.appendChild(defs.cloneNode(true) as HTMLElement) : null;

  // The lent <defs> is given back the instant the raster exists — the save that follows is an IPC
  // round trip (and possibly a modal file dialog), and a duplicate marker id has no business being
  // live for that long.
  let dataUrl: string;
  try {
    // Dynamic import: html-to-image is only ever needed by this one button, and it is not small.
    const { toPng } = await import("html-to-image");
    dataUrl = await toPng(viewport, {
      backgroundColor: background,
      width,
      height,
      pixelRatio: PIXEL_RATIO,
      style: {
        width: `${width}px`,
        height: `${height}px`,
        // Diagram coords → image coords at 1:1. Not getViewportForBounds: we sized the image to fit
        // the content, so there is nothing left to zoom to, and zoom 1 keeps the text crisp.
        transform: `translate(${PAD - bounds.x}px, ${PAD - bounds.y}px)`,
      },
    });
  } finally {
    lent?.remove();
  }

  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

/**
 * Renders the canvas and writes it to a path the user picks (plugin-dialog `save()`).
 *
 * Returns false ONLY when the caller should say "그건 안 됐다" — nothing to draw, or no canvas.
 * A cancelled dialog returns true: the user asked for nothing to happen, and a failure toast for
 * their own Esc is noise. (Import failure — plugin-dialog outside Tauri, e.g. the remote browser
 * tab, where export_diagram_png is http:false anyway — throws, and FlowCanvas's catch shows the
 * failure notice, which is the truthful answer there.)
 */
export async function exportFlowPngToFile(
  host: HTMLElement,
  nodes: Node[],
  background: string
): Promise<boolean> {
  const data = await renderPng(host, nodes, background);
  if (data === null) return false;

  const { save } = await import("@tauri-apps/plugin-dialog");
  const dest = await save({
    defaultPath: pngFilename(),
    filters: [{ name: "PNG", extensions: ["png"] }],
  });
  if (!dest) return true;

  const out = await call<ExportDiagramPngOutput>("export_diagram_png", {
    dest_path: dest,
    data_base64: data,
  });
  emitNotice(t("editor.diagram_export_png_written", { path: out.written_path }));
  return true;
}

/**
 * Renders the canvas and saves it as an attachment on the active note.
 *
 * Returns false when there is nothing to draw, the canvas isn't mounted yet, or there is no active
 * note to attach to — the caller shows the failure notice, this never throws at it. (A 관계도 섹션
 * always sits inside a note, so the last case is a belt-and-braces guard rather than a reachable
 * state; failing loudly beats silently writing nowhere.)
 */
export async function exportFlowPngAttachment(
  host: HTMLElement,
  nodes: Node[],
  background: string
): Promise<boolean> {
  const noteId = useNotesStore.getState().activeNote?.note.id;
  if (!noteId) return false;
  const data = await renderPng(host, nodes, background);
  if (data === null) return false;

  // Same payload shape the clipboard-image paste sends (EditorPanel's pasteImageFile).
  const name = pngFilename();
  await call("attachment_add_bytes", { note_id: noteId, name, data_base64: data });
  // The attachment card reads `activeNote.attachments`, so without this the file exists on disk and
  // nowhere on screen — which is the exact complaint that got `<a download>` deleted. reloadActive()
  // also bumps attachmentRevision, so the thumbnail refetches (stores/notesActive.ts).
  await useNotesStore.getState().reloadActive();
  emitNotice(t("editor.diagram_export_png_saved", { name }));
  return true;
}
