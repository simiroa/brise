import { useState, useRef, useCallback, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emitNotice } from "../invoke";
import { t } from "../../i18n/t";

export async function minimizeWindow() {
  try {
    await getCurrentWindow().minimize();
  } catch {}
}

export async function toggleMaximizeWindow() {
  try {
    await getCurrentWindow().toggleMaximize();
  } catch {}
}

export async function closeWindow() {
  try {
    await getCurrentWindow().close();
  } catch {}
}

export async function setWindowAlwaysOnTop(next: boolean): Promise<boolean> {
  const win = getCurrentWindow();
  await win.setAlwaysOnTop(next);
  return win.isAlwaysOnTop();
}

export function windowErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useWindowControls(browser: boolean) {
  const [alwaysOnTop, setAlwaysOnTopState] = useState(false);
  const [alwaysOnTopBusy, setAlwaysOnTopBusy] = useState(false);
  const alwaysOnTopBusyRef = useRef(false);

  const toggleAlwaysOnTop = useCallback(async () => {
    if (alwaysOnTopBusyRef.current) return;
    alwaysOnTopBusyRef.current = true;
    setAlwaysOnTopBusy(true);
    try {
      const current = await getCurrentWindow().isAlwaysOnTop();
      setAlwaysOnTopState(current);
      const requested = !current;
      const actual = await setWindowAlwaysOnTop(requested);
      setAlwaysOnTopState(actual);
      if (actual !== requested) {
        emitNotice(
          t("window.always_on_top_failed", {
            msg: t("window.always_on_top_not_applied"),
          }),
        );
      }
    } catch (error) {
      emitNotice(
        t("window.always_on_top_failed", {
          msg: windowErrorMessage(error),
        }),
      );
    } finally {
      alwaysOnTopBusyRef.current = false;
      setAlwaysOnTopBusy(false);
    }
  }, []);

  useEffect(() => {
    if (browser) return; // no native window to query — pin stays hidden below
    let cancelled = false;
    void (async () => {
      try {
        const actual = await getCurrentWindow().isAlwaysOnTop();
        if (!cancelled) setAlwaysOnTopState(actual);
      } catch (error) {
        if (!cancelled) {
          emitNotice(
            t("window.always_on_top_failed", {
              msg: windowErrorMessage(error),
            }),
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [browser]);

  return {
    alwaysOnTop,
    alwaysOnTopBusy,
    toggleAlwaysOnTop,
    minimizeWindow,
    toggleMaximizeWindow,
    closeWindow,
  };
}
