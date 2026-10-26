import { useEffect, useRef } from "react";

/** Monotonic id stamped into each marker entry. A layer's marker is always above (greater than)
 *  the markers of every layer opened before it that is still open. */
let lastSeq = 0;
/** Marker entries whose layer closed programmatically and that nobody has re-used yet. */
let pendingPops = 0;

type Marker = { mobileModal: true; layerSeq: number };

function markerSeq(state: unknown): number {
  const m = state as Partial<Marker> | null;
  return m?.mobileModal ? m.layerSeq ?? 0 : 0;
}

function markerOnTop(): boolean {
  return !!(history.state as { mobileModal?: boolean } | null)?.mobileModal;
}

function flushPendingPops() {
  while (pendingPops > 0) {
    pendingPops--;
    // Re-check at flush time: if something pushed over the marker meanwhile, popping would undo it.
    if (markerOnTop()) history.back();
  }
}

/**
 * Android hardware back (WebView `history.back()`) closes the layer instead of falling through to
 * MobileApp's screen stack. While `active`, one throwaway `{mobileModal:true}` entry sits on the
 * history stack; popstate closes the TOP layer only (nested layers close top-first); any other
 * close path pops the entry again — but only if it is still on top, so a navigation pushed over it
 * (tab bar tap) is never reversed.
 *
 * Close-A-and-open-B in one commit (action sheet → "select" turns on selection mode): `history.back()`
 * is asynchronous, so a naive pop-then-push would have the late traversal eat B's fresh entry. A
 * layer that closes programmatically therefore leaves its entry "pending" for one microtask, and a
 * layer that opens in that window adopts it instead of pushing.
 *
 * ponytail: popping our entry makes MobileApp's popstate handler re-run for the unchanged screen
 * (one replayed slide). If a layer refuses to close on back (onClose no-ops) its entry is already
 * gone — it then stays open without a marker until closed by hand.
 */
export function useBackClosable(active: boolean, onClose: () => void): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!active) return;
    let mySeq: number;
    if (pendingPops > 0 && markerOnTop()) {
      // Adopt the entry a layer closed in this same tick left behind (see header).
      pendingPops--;
      mySeq = markerSeq(history.state);
    } else {
      mySeq = ++lastSeq;
      history.pushState({ mobileModal: true, layerSeq: mySeq } satisfies Marker, "");
    }
    let popped = false;
    // Every popstate says where history LANDED. A layer is closed by it exactly when its own marker
    // is no longer on the stack, i.e. it sat above the landing point. That one rule covers: hardware
    // back closes only the top layer (the next layer's marker is the landing point); a layer closed
    // by hand pops its own marker, which lands on the layer below — so that layer stays open
    // (counting "our own back() calls" instead would leak if a popstate ever went missing).
    const onPop = (e: PopStateEvent) => {
      if (popped || mySeq <= markerSeq(e.state)) return;
      popped = true;
      onCloseRef.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (!popped && markerOnTop()) {
        pendingPops++;
        queueMicrotask(flushPendingPops);
      }
    };
  }, [active]);
}
