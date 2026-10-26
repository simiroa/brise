/**
 * diag.ts — frontend entry point for the app-wide diagnostics sink
 * (AUDIT-2026-09-26-fallback-observability.md §7.1, backend: src-tauri/src/diag.rs).
 *
 * Deliberately does NOT import lib/invoke.ts. A later wave (§7.2 frontend-sink, G2) wires
 * invoke.ts's logError()/emitError() to report through this same sink — if this module then
 * called back into invoke.ts's call()/callSilent(), a report failure would recursively try to
 * report itself. This module reaches the backend directly instead: the raw `invoke` from
 * @tauri-apps/api/core in Tauri, or httpInvoke (src/lib/httpBridge.ts) in browser mode — neither
 * of which imports invoke.ts (verified in diag.test.ts by reading this file's own source, not
 * just by review).
 *
 * Contract with every other call site in the app: this module NEVER throws, NEVER leaves a
 * rejected promise for its caller to handle, and NEVER calls console.* about its own failure.
 * "A failing sink must be silent" — reportDiag()/reportFallback() calls can appear from
 * anywhere (that's the point), so a console.error here would shift the 550+ test suite's
 * console-spy assertions the moment any call site lands, and a thrown error here would turn a
 * best-effort diagnostic report into a new source of crashes.
 *
 * Client-side guards, independent of diag.rs's own 60s (source, feature, code, level) dedupe on
 * the backend:
 *  - same (feature, code, level) reported again within 4s is dropped before it ever reaches the
 *    backend (a render loop calling reportDiag() every frame shouldn't turn into an IPC flood).
 *    Remembers up to 32 recent keys (not just the last one), so two keys alternating for the same
 *    failure — e.g. call()'s automatic record plus the caller's reportFallback — both dedupe.
 *  - hard cap ~30 reports/minute. This module's counters are per JS module instance, and each
 *    webview (main/settings/pet/canvas/...) gets its own — so "per module instance" already
 *    means "per window" here.
 *
 * source is never a caller-supplied value — it's read straight from the runtime
 * (getCurrentWindow().label in Tauri, "browser" in browser mode, docs/SYNC.md) so a call site
 * can't get it wrong or spoof another window's label.
 */
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isBrowser, isTauri } from "./env";
import { httpInvoke } from "./httpBridge";

export type DiagLevel = "info" | "warn" | "error";

// diag.rs is the authoritative truncation point (300 chars, char-boundary safe) — trimming here
// too just avoids shipping a needlessly large string over IPC for something that gets cut anyway.
const MESSAGE_MAX_CHARS = 300;
const DEDUPE_WINDOW_MS = 4000;
const RATE_CAP_PER_MINUTE = 30;
const RATE_WINDOW_MS = 60_000;

// 최근 키 여러 개를 기억한다(직전 하나가 아니라) — 같은 실패가 두 이름으로 번갈아 보고되면
// (예: call() 자동 기록 + 호출부의 reportFallback) 단일 memo 로는 하나도 안 걸러져 분당 상한을
// 두 배로 태웠다. 크기는 작게 묶는다: 만료된 키는 조회 때마다 걷어낸다.
const DEDUPE_MAX_KEYS = 32;
const recentKeys = new Map<string, number>();
let rateWindowStart = 0;
let rateCount = 0;

function isDuplicate(key: string, now: number): boolean {
  for (const [k, at] of recentKeys) {
    if (now - at >= DEDUPE_WINDOW_MS) recentKeys.delete(k);
  }
  if (recentKeys.has(key)) return true;
  if (recentKeys.size >= DEDUPE_MAX_KEYS) {
    const oldest = recentKeys.keys().next().value;
    if (oldest !== undefined) recentKeys.delete(oldest);
  }
  recentKeys.set(key, now);
  return false;
}

function isRateLimited(now: number): boolean {
  if (now - rateWindowStart > RATE_WINDOW_MS) {
    rateWindowStart = now;
    rateCount = 0;
  }
  rateCount += 1;
  return rateCount > RATE_CAP_PER_MINUTE;
}

/** getCurrentWindow() can throw synchronously outside Tauri (vitest/jsdom) — same guard shape
 *  lib/invoke.ts uses around its own getCurrentWindow() call. */
function detectSource(): string {
  if (isBrowser()) return "browser";
  try {
    return getCurrentWindow().label;
  } catch {
    return "unknown";
  }
}

function send(args: { source: string; feature: string; code: string; level: DiagLevel; message: string }): void {
  try {
    if (isBrowser()) {
      void httpInvoke("diag_record", args).catch(() => {});
      return;
    }
    if (!isTauri()) return; // vitest/jsdom, not in browser mode either — nothing to reach.
    void invoke("diag_record", args).catch(() => {});
  } catch {
    // A failing sink must stay silent — see module header. invoke()/httpInvoke() reject rather
    // than throw synchronously in practice, but this still guards detectSource()/isBrowser() etc.
  }
}

/**
 * reportDiag: the general entry point — records one diagnostics entry (see diag.rs for what
 * happens to it: dedupe, JSONL append, ring buffer). Always a fire-and-forget no-op from the
 * caller's point of view: never throws, never rejects, drops silently when deduped or
 * rate-limited.
 */
export function reportDiag(level: DiagLevel, feature: string, code: string, message: string): void {
  try {
    const now = Date.now();
    const key = `${feature}\u0000${code}\u0000${level}`;
    if (isDuplicate(key, now)) return;
    if (isRateLimited(now)) return;
    const truncated = message.length > MESSAGE_MAX_CHARS ? message.slice(0, MESSAGE_MAX_CHARS) : message;
    send({ source: detectSource(), feature, code, level, message: truncated });
  } catch {
    // Never throw — see module header.
  }
}

/**
 * safeErrorDetail: an error → a detail string that is safe to persist. JSON.parse errors embed a
 * slice of the INPUT in their message (V8: `Unexpected token 'x', "…" is not valid JSON`) — when
 * that input is an AI reply about the user (chat memory), a widget config or a sketch, the user's
 * content would land in diag.jsonl. SyntaxError → its name only. (Paths/URLs/keys in other
 * messages are scrubbed by diag.rs itself.)
 */
export function safeErrorDetail(e: unknown): string {
  if (e instanceof SyntaxError) return "SyntaxError";
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

/** reportFallback: shorthand for the common case — a designed fallback fired. Always "warn". */
export function reportFallback(feature: string, code: string, detail?: string): void {
  reportDiag("warn", feature, code, detail ?? "");
}

// invoke.ts 의 HANDLED_MARK 와 같은 전역 심볼 — invoke.ts 를 import 하지 않고(위 헤더의 순환 금지)
// "이미 call()/callSilent() 가 기록한 실패"를 알아본다. Symbol.for 라 같은 키면 같은 심볼이다.
const HANDLED_MARK = Symbol.for("brise.errorAlreadyHandled");

function unhandledMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message || reason.name;
  if (reason && typeof reason === "object" && "message" in reason) {
    const m = (reason as { message?: unknown }).message;
    if (typeof m === "string" && m) return m;
  }
  return String(reason);
}

/**
 * registerDiagOnlyErrorHandlers: 사용자 알림 없이 진단 싱크로만 보내는 전역 unhandled 핸들러.
 * 펫 캐릭터 창(#/pet) 전용이다 — globalErrorHandlers.ts 는 알림 문구 때문에 i18n 전체(로케일
 * JSON 묶음)를 끌고 오는데, 이 창은 토스트를 띄울 자리도 없고 번들을 작게 유지해야 한다
 * (main.tsx 헤더 규약). 이 모듈은 invoke.ts 를 거쳐 이미 그 창에 실려 있어 추가 무게가 없다.
 * 창마다 전역 핸들러는 하나만 — 이걸 등록한 창에서 registerGlobalErrorHandlers 를 또 부르지 않는다.
 */
export function registerDiagOnlyErrorHandlers(): () => void {
  const report = (reason: unknown, code: string) => {
    if (reason && typeof reason === "object" && (reason as Record<PropertyKey, unknown>)[HANDLED_MARK]) return;
    reportDiag("error", "unhandled", code, unhandledMessage(reason));
  };
  const onRejection = (event: PromiseRejectionEvent) => report(event.reason, "unhandled_rejection");
  const onError = (event: ErrorEvent) => report(event.error ?? event.message, "uncaught_error");
  window.addEventListener("unhandledrejection", onRejection);
  window.addEventListener("error", onError);
  return () => {
    window.removeEventListener("unhandledrejection", onRejection);
    window.removeEventListener("error", onError);
  };
}
