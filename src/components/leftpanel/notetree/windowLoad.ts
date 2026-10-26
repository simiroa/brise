/**
 * Explicit per-key page-offset claims for scroll load-more.
 *
 * Inferring "already loaded" from list length is wrong: an append changes that
 * length and can re-trigger the same window. Claiming an offset once (release
 * only on hard failure so a retry is possible) makes a given window ask-once.
 */
export type OffsetTracker = {
  clear: () => void;
  clearKey: (key: string) => void;
  /** True if this offset was not yet claimed; marks it claimed. */
  claim: (key: string, offset: number) => boolean;
  has: (key: string, offset: number) => boolean;
  /** Drop a claim so the same offset may be requested again (e.g. after network error). */
  release: (key: string, offset: number) => void;
};

export function createOffsetTracker(): OffsetTracker {
  const requested = new Map<string, Set<number>>();

  return {
    clear() {
      requested.clear();
    },
    clearKey(key: string) {
      requested.delete(key);
    },
    claim(key: string, offset: number): boolean {
      let set = requested.get(key);
      if (!set) {
        set = new Set();
        requested.set(key, set);
      }
      if (set.has(offset)) return false;
      set.add(offset);
      return true;
    },
    has(key: string, offset: number): boolean {
      return requested.get(key)?.has(offset) ?? false;
    },
    release(key: string, offset: number) {
      requested.get(key)?.delete(offset);
    },
  };
}

/** Favourites strip uses a single synthetic key in the same tracker. */
export const FAVORITES_OFFSET_KEY = "__favorites__";
