/**
 * Browser-mode transport — used by invoke.ts (call/callSilent) and by the few listen() call sites
 * that also run in a plain browser tab (lib/remoteNoteWrite.ts, SidebarChat, mobile/mobileApi.ts —
 * they pick browserListen over Tauri's listen() via isBrowser()) when served by the sync server
 * instead of inside the Tauri webview. Contract (docs/SYNC.md; server side is
 * src-tauri/src/sync_server/handlers/):
 *
 *   POST /api/v1/invoke {"cmd","args"} → the command's JSON result, errors as {"error": string}
 *   with 400/404/500 — a command's own AppError also carries {"code"} (409 for CONFLICT). Some
 *   commands are excluded over HTTP (OS dialogs, local-FS paths, server lifecycle) — a 404 means
 *   "not available here", not "not found" in the domain sense.
 *
 *   GET /api/v1/events?token=... is an SSE stream of named frames — SSE_EVENTS below is the
 *   allow-list of the ones this bridge delivers.
 */
import { getBrowserToken, authHeaders } from "./env";
import type { AppError } from "./commands.gen";

const APP_ERROR_CODES: ReadonlySet<string> = new Set(["NOT_FOUND", "VALIDATION", "CONFLICT", "IO", "DB"]);
function isAppErrorCode(v: unknown): v is AppError["code"] {
  return typeof v === "string" && APP_ERROR_CODES.has(v);
}

/** 폰→PC 요청 시간 상한(AUDIT M-1). PC 가 잠들거나 망이 끊기면 fetch 는 영영 안 끝나서 쓰기 사슬·뒤로·탭·노트 열기가
 *  전부 그 뒤에 선다 — 이 한 지점에서 끊어 기존 실패 배너(V5)가 받게 한다. 오래 걸리는 게 정상인 명령만 길게. */
export const INVOKE_TIMEOUT_MS = 15_000;
export const LONG_INVOKE_TIMEOUT_MS = 150_000;
const LONG_COMMANDS: ReadonlySet<string> = new Set([
  "audio_transcribe",
  "pet_chat",
  "pet_conversation_save",
  "link_suggest",
  "link_preview",
  "collect_source_add_nl",
  "attachment_fetch_reader",
  "dashboard_graph",
]);
export function invokeTimeoutMs(cmd: string): number {
  return cmd.startsWith("ai_") ||
    cmd.startsWith("geocode_") ||
    cmd.startsWith("attachment_thumbs") ||
    LONG_COMMANDS.has(cmd)
    ? LONG_INVOKE_TIMEOUT_MS
    : INVOKE_TIMEOUT_MS;
}

/** 시간 초과를 `{code:"IO", message:"timeout"}` 로 바꿔 던지는 fetch. */
export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  // AbortSignal.timeout 대신 직접 — 가짜 타이머로 시험할 수 있고, 타이머를 안 지워 응답 본문 읽기(res.json())가 멈춘 경우도 같이 끊는다
  // (끝난 뒤의 abort 는 무동작).
  const ctl = new AbortController();
  let timedOut = false;
  setTimeout(() => {
    timedOut = true;
    ctl.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch (e) {
    if (timedOut) throw { code: "IO", message: "timeout" } as AppError;
    throw { code: "IO", message: String(e) } as AppError;
  }
}

/** POST /api/v1/invoke — the browser-mode equivalent of @tauri-apps/api/core's invoke(). */
export async function httpInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const res = await fetchWithTimeout(
    "/api/v1/invoke",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ cmd, args: args ?? {} }),
    },
    invokeTimeoutMs(cmd),
  );

  if (!res.ok) {
    // 401 body is plain text ("unauthorized"), not the {"error"} JSON shape the other statuses
    // use (src-tauri/src/sync_server/handlers/auth.rs::unauthorized()) — call it out by name instead
    // of falling through to a bare "HTTP 401".
    if (res.status === 401) {
      throw { code: "IO", message: "unauthorized: sync token missing/invalid" } as AppError;
    }
    let serverMsg = "";
    let serverCode: AppError["code"] | null = null;
    try {
      const body = await res.json();
      if (typeof body?.error === "string") serverMsg = body.error;
      if (isAppErrorCode(body?.code)) serverCode = body.code;
    } catch {
      /* non-JSON error body — fall through to the generic message below */
    }
    // A command's own AppError carries its code (handlers/responses.rs::command_error_response — CONFLICT is
    // 409, the rest 500). Read it FIRST: it's the same code desktop IPC gives, so callers can
    // branch on CONFLICT/NOT_FOUND identically in both transports.
    if (serverCode) throw { code: serverCode, message: serverMsg || `HTTP ${res.status}` } as AppError;
    // 404 without a code = the sync server doesn't route this command at all (excluded-over-HTTP
    // class, per the contract above) — that's a bridge-level fact, not a domain "not found", so the
    // message carries a recognizable "unavailable_in_browser" marker instead of whatever the
    // (likely empty) body says. Gated UI should never trigger this in the first place.
    if (res.status === 404) {
      throw { code: "NOT_FOUND", message: `unavailable_in_browser: ${cmd}` } as AppError;
    }
    const code = res.status === 400 ? "VALIDATION" : "DB";
    throw { code, message: serverMsg || `HTTP ${res.status}` } as AppError;
  }

  return (await res.json()) as T;
}

type EventEnvelope<T> = { payload: T };
type UnlistenFn = () => void;

let sharedEventSource: EventSource | null = null;
// The token the shared stream was actually opened with — compared against the CURRENT
// getBrowserToken() on every ensureEventSource() call so a token regenerated elsewhere is picked
// up without waiting for the stale stream to error out on its own.
let sharedEventSourceToken: string | null = null;
const sseHandlers = new Map<string, Set<(payload: unknown) => void>>();

// EventSource's native auto-reconnect (~3s, per spec) keeps retrying the exact URL it was
// constructed with — including its baked-in token — so a token regenerated after connect leaves
// it silently retrying with a now-invalid token forever (2026-07 review finding). Rebuilding
// ourselves on `error` lets each attempt re-read the current token. Bounded ladder instead of a
// fixed interval so a genuinely offline phone doesn't hammer the server; resets to the first rung
// once a rebuilt stream actually opens.
const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 15000];
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function attachEvent(es: EventSource, event: string, handlers: Set<(payload: unknown) => void>) {
  es.addEventListener(event, (e) => {
    const payload = JSON.parse((e as MessageEvent).data);
    for (const h of handlers) h(payload);
  });
}

function attachHandlers(es: EventSource) {
  for (const [event, handlers] of sseHandlers) attachEvent(es, event, handlers);
  es.addEventListener("open", () => {
    reconnectAttempt = 0;
  });
  es.addEventListener("error", () => {
    // A superseded instance (already torn down by a rebuild) can still fire a queued error event —
    // only the currently-shared stream is allowed to schedule a reconnect.
    if (es !== sharedEventSource) return;
    es.close();
    sharedEventSource = null;
    if (reconnectTimer) return; // a rebuild is already scheduled
    const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (sseHandlers.size > 0) ensureEventSource();
    }, delay);
  });
}

function ensureEventSource(): EventSource {
  const token = getBrowserToken();
  if (sharedEventSource && sharedEventSourceToken === token) return sharedEventSource;
  if (sharedEventSource) {
    // Token changed since this stream was opened — rebuild immediately with the fresh one instead
    // of leaving it authenticated as a token that's no longer valid.
    sharedEventSource.close();
    sharedEventSource = null;
  }
  const es = new EventSource(`/api/v1/events?token=${encodeURIComponent(token ?? "")}`);
  attachHandlers(es);
  sharedEventSource = es;
  sharedEventSourceToken = token;
  return es;
}

/** SSE 로 실제 프레임이 오는 이벤트(서버: handlers/sse.rs::events 가 payload 의 `event` 필드로 프레임 이름을 정한다).
 *  "pet-chat-updated" = 채팅 스레드 변경(2026-10-06 채팅 원격 개방) — 데스크톱/다른 기기의 전송·세션 변경을 폰이 받는다. */
const SSE_EVENTS: ReadonlySet<string> = new Set([
  "remote-note-write",
  "pet-chat-updated",
  // S2: 서버(exif_region.rs → events::publish_event)가 payload.event 이름으로 SSE 프레임을 낸다.
  "attachment-meta-suggested",
  "attachment-meta-applied",
]);

/**
 * Browser-mode equivalent of @tauri-apps/api/event's listen(). Only the SSE_EVENTS frames exist
 * over HTTP; every other event this app listens for (mic level meter, pet windows, etc.) is
 * desktop-native and has nothing to deliver — those resolve to a no-op unlisten stub instead of
 * wiring up a stream nobody will ever push to.
 */
export function browserListen<T>(event: string, handler: (event: EventEnvelope<T>) => void): Promise<UnlistenFn> {
  if (!SSE_EVENTS.has(event)) {
    // eslint-disable-next-line no-console
    console.debug(`[brise] browser mode: "${event}" has no HTTP equivalent, listen() is a no-op`);
    return Promise.resolve(() => {});
  }

  const wrapped = (payload: unknown) => handler({ payload: payload as T });
  let handlers = sseHandlers.get(event);
  if (!handlers) {
    handlers = new Set();
    sseHandlers.set(event, handlers);
    // 스트림이 이미 열려 있으면(다른 이벤트가 먼저 구독) 새 프레임 이름은 여기서 붙여야 한다 —
    // attachHandlers 는 스트림 생성 시점의 이벤트만 본다.
    if (sharedEventSource) attachEvent(sharedEventSource, event, handlers);
  }
  handlers.add(wrapped);
  ensureEventSource();

  return Promise.resolve(() => {
    handlers!.delete(wrapped);
  });
}
