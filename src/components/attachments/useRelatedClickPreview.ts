import { useEffect, useRef } from "react";
import { useNotesStore } from "../../stores/notes";
import { useUiStore } from "../../stores/ui";

/** Task 3/4: single click previews a related note (debounced ~250ms so a double
 * click does not flash the preview before opening); double click / Enter opens
 * as a real tab and cancels any pending preview. Keyed by note id. */
export function useRelatedClickPreview() {
  const selectNote = useNotesStore((s) => s.selectNote);
  const setPreviewItem = useUiStore((s) => s.setPreviewItem);

  const relatedClickTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const timers = relatedClickTimers.current;
    return () => {
      timers.forEach((tm) => clearTimeout(tm));
      timers.clear();
    };
  }, []);

  const cancelRelatedPreview = (id: string) => {
    const tm = relatedClickTimers.current.get(id);
    if (tm !== undefined) {
      clearTimeout(tm);
      relatedClickTimers.current.delete(id);
    }
  };

  const scheduleRelatedPreview = (id: string) => {
    cancelRelatedPreview(id);
    const tm = setTimeout(() => {
      relatedClickTimers.current.delete(id);
      setPreviewItem({ kind: "note", id });
    }, 250);
    relatedClickTimers.current.set(id, tm);
  };

  const openRelatedNote = (id: string) => {
    cancelRelatedPreview(id);
    setPreviewItem({ kind: "note", id });
    void selectNote(id);
  };

  return { openRelatedNote, scheduleRelatedPreview };
}

/** While the preview pane is showing a related note, a real navigation (tab click) should
 *  follow — peek stays until the user actually opens something. */
export function followPreviewToNote(id: string) {
  const { previewItem, setPreviewItem } = useUiStore.getState();
  if (previewItem?.kind === "note") setPreviewItem({ kind: "note", id });
}
