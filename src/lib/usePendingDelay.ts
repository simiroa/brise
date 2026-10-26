import { useEffect, useState } from "react";

/**
 * Delays showing a pending/working state by `delayMs` (default 150ms)
 * to prevent flashing on fast operations.
 */
export function usePendingDelay(isPending: boolean, delayMs = 150): boolean {
  const [showPending, setShowPending] = useState(false);

  useEffect(() => {
    if (!isPending) {
      setShowPending(false);
      return;
    }
    const timer = setTimeout(() => {
      setShowPending(true);
    }, delayMs);

    return () => {
      clearTimeout(timer);
    };
  }, [isPending, delayMs]);

  return showPending;
}
