import { useEffect, useRef } from "react";
import { useUiStore, type HomeInnerTab } from "../../stores/ui";

/**
 * Shared consumer for `useUiStore`'s `dashboardReveal` signal (search-hit "go to this note on the
 * dashboard" navigation). All 5 home panes (board/calendar/timeline/map/graph) used to each copy
 * the same `prevRevealSeqRef` guard inline — extracted here after a bug: every copy checked the
 * pane's own `homeInnerTab === tab` guard BEFORE recording that the seq had been seen, so a reveal
 * that arrived while the pane was inactive was never marked consumed and replayed stale the next
 * time that tab was opened. Fix is two-fold:
 *
 * 1. Record consumption (`prevSeqRef.current = dashboardReveal.seq`) BEFORE the tab-active guard —
 *    every pane sees every reveal exactly once, active or not, and only the pane that was active
 *    at that moment actually runs `onReveal`.
 * 2. Lazily seed `prevSeqRef` with whatever seq already existed at mount time, not `null`. Graph
 *    isn't kept alive (unmount on tab-away to avoid a React Flow node leak) — a plain `null` start
 *    would treat any pre-existing reveal as "new" on every fresh mount and re-select a stale node
 *    each time the tab is reopened. Seeding with the current seq means "anything already sitting
 *    in the store when I was born is not my concern."
 */
export function useDashboardReveal(tab: HomeInnerTab, onReveal: (noteId: string) => void): void {
  const homeInnerTab = useUiStore((s) => s.homeInnerTab);
  const dashboardReveal = useUiStore((s) => s.dashboardReveal);
  const prevSeqRef = useRef<number | null>(useUiStore.getState().dashboardReveal?.seq ?? null);

  useEffect(() => {
    if (!dashboardReveal) return;
    if (prevSeqRef.current === dashboardReveal.seq) return;
    prevSeqRef.current = dashboardReveal.seq;
    if (homeInnerTab !== tab) return;
    onReveal(dashboardReveal.noteId);
    // onReveal deliberately excluded from deps: every call site passes an inline closure (matches
    // every pre-extraction handler), and re-running on its identity change would refire this
    // effect on every render of the host pane for no reason — the seq guard above already makes
    // this effect idempotent, so the only deps that matter are the ones the guard reads.
  }, [dashboardReveal, homeInnerTab, tab]);
}
