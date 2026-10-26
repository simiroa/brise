import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useSectionEditor } from "./useSectionEditor";

// Data-loss bug: unmounting the host component (e.g. clicking the Home tab, which swaps
// EditorPanel out without going through flushAll — see App.tsx/TabBar.tsx) used to
// clearTimeout() the pending 700ms autosave debounce WITHOUT flushing it, silently dropping
// whatever was typed in the last 700ms. The fix calls flushRef.current() from the unmount
// cleanup instead of just clearing the timer.
describe("useSectionEditor unmount", () => {
  it("flushes a pending save instead of only clearing its timer", () => {
    const { result, unmount } = renderHook(() => useSectionEditor());
    const flush = vi.fn().mockResolvedValue(undefined);
    result.current.flushRef.current = flush;
    result.current.timeoutRef.current = setTimeout(() => {}, 700);

    unmount();

    expect(flush).toHaveBeenCalledTimes(1);
  });
});
