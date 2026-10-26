import type { RefObject } from "react";
import { useNotesStore } from "../../stores/notes";
import { emitNotice } from "../../lib/invoke";
import { t } from "../../i18n/t";
import { useFileDropZone } from "../../lib/useFileDropZone";

/** Real file-path drag & drop (Tauri-level, not HTML5 — HTML5 DnD never exposes filesystem
 * paths inside a webview). Guarded for non-Tauri dev (plain `vite` / tests) — useFileDropZone
 * no-ops outside Tauri. Depends on addOneFile (extraction-policy routing, owned by
 * useAttachmentActions) and setBusy (shared busy flag, also owned by useAttachmentActions) —
 * this hook does not own either. */
export function useAttachmentsDragDrop(
  barRef: RefObject<HTMLDivElement | null>,
  addOneFile: (noteId: string, path: string) => Promise<void>,
  setBusy: (busy: boolean) => void,
) {
  return useFileDropZone(() => barRef.current, {
    onDrop: (paths, _pos, inside) => {
      if (!inside) return;
      void (async () => {
        setBusy(true);
        try {
          const id = await useNotesStore.getState().ensureMaterialized();
          if (!id) {
            emitNotice(t("attachments.drop_requires_note"));
            return;
          }
          for (const path of paths) {
            await addOneFile(id, path);
          }
          await useNotesStore.getState().reloadActive();
        } catch {
          /* call() 이 AppError 토스트를 이미 표출함 */
        } finally {
          setBusy(false);
        }
      })();
    },
  });
}
