import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../i18n/t";
import { fetchPing } from "./mobileApi";

const ONLINE_POLL_MS = 60_000;
const OFFLINE_POLL_MS = 15_000;

/**
 * Shell-level reachability of the desktop sync server (GET /api/v1/ping).
 * Renders nothing until the first check fails — no flash on a healthy boot.
 */
export function MobileOfflineBanner() {
  const [offline, setOffline] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);

  const check = useCallback(async () => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setOffline(true);
      return false;
    }
    const ping = await fetchPing();
    if (cancelledRef.current) return true;
    const ok = ping !== null;
    setOffline(!ok);
    return ok;
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    const loop = async () => {
      const ok = await check();
      if (cancelledRef.current) return;
      timerRef.current = setTimeout(loop, ok ? ONLINE_POLL_MS : OFFLINE_POLL_MS);
    };
    void loop();
    const onOnline = () => void check();
    const onOffline = () => setOffline(true);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      cancelledRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [check]);

  if (!offline) return null;

  return (
    <div className="mobile-offline-banner" data-testid="mobile-offline-banner" role="status">
      <span className="mobile-offline-banner-text">{t("mobile.offline_banner")}</span>
      <button type="button" className="mobile-text-btn mobile-text-btn--accent" onClick={() => void check()}>
        {t("mobile.offline_retry")}
      </button>
    </div>
  );
}
