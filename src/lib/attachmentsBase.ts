import { createBaseDirCache } from "./baseDirCache";
import { isBrowser, getBrowserToken } from "./env";

/**
 * Shared module-level cache for the attachments base directory + the Tauri
 * convertFileSrc helper. Both PreviewAttachment.tsx and AttachmentsBar.tsx
 * need this (thumbnails / previews resolve real file paths to asset URLs),
 * so it lives here once instead of being duplicated per-component.
 *
 * Browser mode: "attachments_base_dir" is a local-FS path command, excluded over HTTP, so the
 * Tauri hook below would just 404 and leave baseDir null forever. Instead of going through
 * commands.gen at all, short-circuit to the sync server's dedicated read route
 * (/api/v1/attachments/{note_id}/{*file}?token=..., verified against src-tauri/src/sync_server —
 * attachments.rel_path is already stored as "{note_id}/{file}", the exact shape that route
 * expects). baseDir doubles as the URL prefix so callers' existing `convert(\`${baseDir}/${rel_path}\`)`
 * pattern (PreviewAttachment.tsx, AttachmentsBar.tsx, Toolbar.tsx) needs no changes.
 */
const ATTACHMENTS_HTTP_BASE = "/api/v1/attachments";

function encodePathSegments(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

const useTauriAttachmentsBase = createBaseDirCache("attachments_base_dir");

export function useAttachmentsBase(): { baseDir: string | null; convert: ((path: string) => string) | null } {
  const tauri = useTauriAttachmentsBase();
  if (!isBrowser()) return tauri;
  const token = getBrowserToken() ?? "";
  return {
    baseDir: ATTACHMENTS_HTTP_BASE,
    convert: (path: string) => `${encodePathSegments(path)}?token=${encodeURIComponent(token)}`,
  };
}
