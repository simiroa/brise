// Progress toast: an in-place-updating toast for a long-running sequential batch (e.g. importing
// many files as sections one at a time — runBatch's onProgress callback had no listener before
// this). Modeled on undo.ts's onUndoToast/onUndoToastDismiss module-level handler pair — same
// "component subscribes, lib module emits" shape, no new plumbing invented.
//
// Unlike the undo toast, there is no ttl here: the toast does not expire on its own. The caller
// owns its lifecycle and MUST clear it (emitProgress(key, null)) when the batch ends, success or
// failure — see noteActions.ts's importFilesAsSections, which does this in a `finally`.

export interface ProgressToast {
  key: string;
  label: string;
}

let toastHandler: ((p: ProgressToast) => void) | null = null;
let dismissHandler: ((key: string) => void) | null = null;

/** onProgressToast: Toast.tsx subscribes to know when to show/update a progress toast. */
export const onProgressToast = (fn: (p: ProgressToast) => void) => {
  toastHandler = fn;
};

/** onProgressToastDismiss: Toast.tsx subscribes to know when to remove a progress toast by key. */
export const onProgressToastDismiss = (fn: (key: string) => void) => {
  dismissHandler = fn;
};

/**
 * emitProgress: show/update the progress toast for `key` with `label`, or remove it when `label`
 * is null. Repeated calls with the same key update the existing toast in place (Toast.tsx keys
 * its progress toasts by `key`, not by a fresh id each time) instead of stacking new ones.
 */
export function emitProgress(key: string, label: string | null): void {
  if (label === null) {
    if (dismissHandler) dismissHandler(key);
    return;
  }
  if (toastHandler) toastHandler({ key, label });
}
