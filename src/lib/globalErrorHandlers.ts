import { emitNotice, isErrorHandled } from "./invoke";
import { reportDiag } from "./diag";
import { t } from "../i18n/t";

/**
 * globalErrorHandlers.ts — W13 (에러 격리 보완, 갭 2).
 *
 * Catches two classes of failure that used to only ever reach the dev console:
 *  - an async rejection from a fire-and-forgotten async call, e.g. `void someAsyncFn()` with no `.catch()` attached
 *  - a synchronous throw that never reached a React render, so no ErrorBoundary sees it either
 * Without this, "I clicked the button and nothing happened" had no user-visible signal at all —
 * the failure was real, just silent.
 *
 * ⚠️ Double-toast trap: lib/invoke.ts's call() ALREADY shows a toast on failure and rethrows —
 * a `void call(...)` call site turns that rethrow into exactly the kind of unhandled rejection
 * this file listens for. Reacting to it here too would toast the same failure twice. invoke.ts
 * marks every call()/callSilent() failure (via logError()) with a hidden marker; isErrorHandled()
 * below is how this file recognizes and skips those — call() failures because they're already
 * toasted, callSilent() failures because they're intentionally silent by design.
 *
 * Register exactly once per window (main.tsx calls this once in every branch that mounts <Toast/> —
 * the full desktop/mobile app AND each auxiliary OS window: settings/activity/ai-history/canvas/
 * pet-bubble). Registering it more than once in the same window would double every remaining toast
 * the same way skipping the marker check would. The pet character window (#/pet) has no <Toast/>
 * and uses lib/diag.ts's registerDiagOnlyErrorHandlers() instead — this module imports the i18n
 * locale bundle for its notice text, which that tiny window must not carry.
 */

const DEDUPE_WINDOW_MS = 4000;

// Single last-message memo (not a growing set) — this only needs to catch the common "same error
// firing every frame of a render loop" case the task calls out, not a general rate limiter across
// many distinct errors.
let lastKey: string | null = null;
let lastAt = 0;

function shouldSuppressDuplicate(key: string, now: number): boolean {
  if (lastKey === key && now - lastAt < DEDUPE_WINDOW_MS) {
    return true;
  }
  lastKey = key;
  lastAt = now;
  return false;
}

function messageOf(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message || reason.name || String(reason);
  }
  if (reason && typeof reason === "object" && "message" in reason) {
    const m = (reason as { message?: unknown }).message;
    if (typeof m === "string" && m) return m;
  }
  return String(reason);
}

function reportUnhandled(reason: unknown, source: "rejection" | "error", now: number): void {
  // Already surfaced (call()'s own toast) or intentionally silent (callSilent()) — do nothing.
  if (isErrorHandled(reason)) return;

  const message = messageOf(reason);
  if (shouldSuppressDuplicate(`${source}:${message}`, now)) return;

  reportDiag("error", "unhandled", source === "rejection" ? "unhandled_rejection" : "uncaught_error", message);

  // eslint-disable-next-line no-console
  console.error(`[brise] unhandled ${source === "rejection" ? "promise rejection" : "error"}:`, reason);
  emitNotice(t("common.unhandled_error", { message }));
}

/**
 * registerGlobalErrorHandlers: wires `window.addEventListener("unhandledrejection"/"error")`.
 * Returns an unregister function (mainly for tests — production code calls this once and never
 * needs to undo it). Deliberately never calls event.preventDefault(): the browser/devtools
 * console must keep showing the raw error for debugging — this only adds a second, user-visible
 * channel alongside it, not a replacement for it.
 */
export function registerGlobalErrorHandlers(): () => void {
  const onRejection = (event: PromiseRejectionEvent) => {
    reportUnhandled(event.reason, "rejection", Date.now());
  };
  // event.error is null/undefined for some cross-origin or script-parsing failures; fall back to
  // the plain message string so those still surface instead of silently no-oping.
  const onError = (event: ErrorEvent) => {
    reportUnhandled(event.error ?? event.message, "error", Date.now());
  };

  window.addEventListener("unhandledrejection", onRejection);
  window.addEventListener("error", onError);

  return () => {
    window.removeEventListener("unhandledrejection", onRejection);
    window.removeEventListener("error", onError);
  };
}
