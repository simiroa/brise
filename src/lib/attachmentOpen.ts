import { call, emitNotice } from "./invoke";
import { isBrowser } from "./env";
import { t } from "../i18n/t";

/**
 * attachment_open/attachment_reveal open the OS file shell (default app / file explorer) — a
 * local-FS action with no HTTP equivalent, so it's excluded from the sync server's command
 * surface entirely. Calling it in browser mode 404s (unavailable_in_browser) and toasts an error
 * the user can't act on. AttachmentsBar.tsx::onOpenAttachment had the right guard; this file
 * centralizes it so the other 7 call sites (preview panels, gallery) stop drifting from it.
 */
export function openAttachmentExternal(id: string): void {
  if (isBrowser()) {
    emitNotice(t("common.desktop_only"));
    return;
  }
  void call("attachment_open", { id });
}

export function revealAttachmentExternal(id: string): void {
  if (isBrowser()) {
    emitNotice(t("common.desktop_only"));
    return;
  }
  void call("attachment_reveal", { id });
}
