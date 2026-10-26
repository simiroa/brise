import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AppError } from "./commands.gen";
import { isBrowser } from "./env";
import { httpInvoke } from "./httpBridge";
// AUDIT-2026-09-26-fallback-observability.md §7.2 G2: every call()/callSilent() failure also
// reports to the diag sink, not just the console. One-way import only — diag.ts must never import
// back from here (its own header comment explains why: a report failure recursively reporting
// itself). reportDiag() itself never throws/rejects, so this can't turn a quiet failure loud.
import { reportDiag, type DiagLevel } from "./diag";

/** flushAll 을 부른 까닭. "close" = 창이 실제로 닫히는 중(onCloseRequested). 그 밖(노트·섹션 전환,
 *  주기 스냅샷 등)은 undefined — 저장만 하면 되는 평범한 flush 다. 닫힐 때만 할 정리(열린 AI 결과 세션
 *  취소 등)는 이걸 보고 가른다(2026-09-27: 주기 스냅샷의 flushAll 이 생성 중인 AI 결과를 조용히 지웠다). */
export type FlushReason = "close";

const pendingFlushes = new Set<(reason?: FlushReason) => Promise<unknown>>();

/** registerFlush: 자동저장 디바운스 완료/실패 트리거를 등록. 반환 함수는 해제. */
export const registerFlush = (f: (reason?: FlushReason) => Promise<unknown>) => {
  pendingFlushes.add(f);
  return () => pendingFlushes.delete(f);
};

/**
 * flushAll: 노트/섹션 전환·창 close 직전 호출. 모든 등록된 pending 저장을 완료.
 * Bug fix: 콜백 하나가 reject 하면(예: ensureMaterialized 의 note_create 실패) 나머지 flush가
 * 전부 건너뛰어지고 flushAll() 자체도 reject 했다 — onCloseRequested 는 destroy() 를 건너뛰어
 * 창이 영영 안 닫히고, selectNote 는 loadingNoteId 를 못 지워 그 노트가 세션 내내 안 열렸다.
 * 각 콜백을 개별 try/catch 로 감싸 하나가 실패해도 나머지는 계속 돌고 flushAll 은 항상 resolve.
 */
export const flushAll = async (reason?: FlushReason) => {
  const fs = [...pendingFlushes];
  for (const f of fs) {
    try {
      await f(reason);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[brise] flushAll: pending flush rejected", e);
      const message = e instanceof Error ? e.message : String(e);
      reportDiag("error", "flush", "flush_rejected", message);
    }
  }
};

// Browser-mode equivalent of the Tauri onCloseRequested flush below — a tab close/navigation
// fires "pagehide", not a Tauri window event. ponytail: fire-and-forget, async fetch isn't
// guaranteed to land before the tab actually unloads; upgrade to navigator.sendBeacon if lost
// last-edit reports show up in the field.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    void flushAll();
  });
  // 안드로이드 앱 전환·화면 끄기는 pagehide 를 안 부른다(AUDIT M-15) — 백그라운드로 가는 순간 저장 대기분을 서버로 보낸다.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushAll();
  });
}

export type CloseAction = "main-flow" | "hide" | "destroy";

/**
 * closeActionForLabel: main 창만 기존 지오메트리 저장 + window_close_confirmed 흐름을 타고,
 * 그 외 라벨(pet/pet-bubble/settings/activity/ai-history 등 보조 창)은 hide 로 끝낸다 —
 * AuxWindowChrome 의 X 버튼과 동일한 결말. 순수 함수라 라벨 분기만 따로 단위 테스트한다.
 *
 * 예외: 섹션 분리 창(`section-<id>`, src-tauri/src/section_window.rs)은 **destroy** 한다 — 그 창은
 * "존재 = 분리 중"이 단일 진실이라 숨기면 본 창이 영원히 분리 상태로 본다. 파괴돼도 좀비가 되지
 * 않는다(트레이가 되살리는 창이 아니고, 본 창에서 다시 열면 새로 만든다).
 */
export function closeActionForLabel(label: string): CloseAction {
  if (label === "main") return "main-flow";
  return label.startsWith("section-") ? "destroy" : "hide";
}

// R1: flush pending saves before window close.
// try/catch: outside Tauri (vitest/jsdom) getCurrentWindow() can throw synchronously — the trailing
// .catch() only handles a rejected promise, not a sync throw at import time. Guard the whole
// registration so importing this module never crashes in a non-Tauri environment.
try {
void getCurrentWindow()
  .onCloseRequested(async (e) => {
    e.preventDefault();
    // flushAll 이 던져도 닫기는 계속 진행해야 한다 — 예전엔 await 가 맨몸이라 저장 하나가
    // 실패하면 핸들러 전체가 죽고 X 버튼이 영구 무반응이었다(prevent_close 는 이미 걸린 뒤).
    try {
      await flushAll("close");
    } catch {}

    const win = getCurrentWindow();
    if (closeActionForLabel(win.label) === "destroy") {
      // 저장(flushAll)은 위에서 끝났다 — 이제 창을 없앤다. Rust 가 Destroyed 에서 본 창에 알린다.
      try {
        await win.destroy();
      } catch (err) {
        reportDiag("error", "section_window", "destroy_failed", String(err));
      }
      return;
    }
    if (closeActionForLabel(win.label) === "hide") {
      // 보조 창의 네이티브 닫기(Alt+F4/taskbar) = AuxWindowChrome 의 X 버튼과 같은 결말이어야
      // 한다 — hide 뿐, **destroy 는 절대 금지**(2026-08-25 펫 좀비 사고: 파괴된 창은 트레이
      // 복귀조차 못 한다, tray::show_and_focus 참고). 이전엔 여기서도 main 전용
      // window_geometry 저장 + window_close_confirmed 로 흘러갔다 — 보조 창은 그 커맨드가
      // allowlist에 없어 조용히 거부돼 안 닫혔고, 저장은 성공해 보조 창의 rect 가 메인
      // 지오메트리를 덮어썼다. 이 분기가 두 증상을 함께 끝낸다.
      try {
        await win.hide();
      } catch (err) {
        console.error("hide failed on aux window close; window left open", err);
      }
      return;
    }

    try {
      const pos = await win.outerPosition();
      const size = await win.outerSize();
      const isMax = await win.isMaximized();
      const geometry = JSON.stringify({
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
        maximized: isMax,
      });
      await callSilent("settings_set", { entries: { window_geometry: geometry } }).catch(() => {});
    } catch {}

    // 숨김이냐 종료냐는 Rust(window_close_confirmed → close_to_tray 설정)가 정한다.
    // **실패해도 창을 destroy 하지 않는다** — 예전 폴백이 그랬고, 본 창은 파괴되면 트레이
    // 열기조차 못 살리는 영구 좀비가 됐다(2026-08-25 실제 발생, tray::show_and_focus 참고).
    // 여기서 못 닫으면 창은 그대로 열려 있고 사용자는 다시 시도할 수 있다 — 최악이 "안 닫힘"
    // 이어야지 "창이 사라짐"이면 안 된다.
    try {
      await callSilent("window_close_confirmed");
    } catch (err) {
      console.error("window_close_confirmed failed; window left open", err);
    }
  })
  .catch(() => {
    /* not running under Tauri (vite/tests) */
  });
} catch {
  /* getCurrentWindow() threw synchronously — not running under Tauri */
}

let toastHandler: ((err: AppError) => void) | null = null;
export const onAppError = (fn: (err: AppError) => void) => {
  // 가드: 한 번 호출부가 에러 객체를 넘기는 바람에 토스트 핸들러가 통째로 덮어써져
  // 그 세션의 모든 에러 토스트가 죽은 적이 있다. catch (e: any) 였던 탓에 tsc 도 못 잡았다.
  // 등록 함수는 함수만 받는다 — 아니면 조용히 무시하고 시끄럽게 로그를 남긴다.
  if (typeof fn !== "function") {
    // eslint-disable-next-line no-console
    console.error("[brise] onAppError() 는 핸들러 등록용이다. 에러를 알리려면 던져서 call() 이 처리하게 하라.", fn);
    return;
  }
  toastHandler = fn;
};

// W13: mark rejected/thrown error objects that already passed through logError() (i.e. every
// call()/callSilent() failure — call() toasts via emitError() which itself calls logError()
// below, callSilent() calls logError() directly). globalErrorHandlers.ts's window-level
// unhandledrejection/error listeners check this before reacting, so a `void call(...)` site
// that never attached its own .catch() doesn't get a *second*, redundant toast for a failure
// call() already surfaced — and a callSilent() failure (intentionally quiet) doesn't get made
// loud behind the caller's back.
const HANDLED_MARK = Symbol.for("brise.errorAlreadyHandled");

function markHandled(e: unknown): void {
  if (e && typeof e === "object") {
    try {
      Object.defineProperty(e, HANDLED_MARK, { value: true, configurable: true });
    } catch {
      // Best-effort only — a frozen/sealed rejection reason just won't be markable, and the
      // global hook will (rarely) show one redundant toast for it instead of throwing here.
    }
  }
}

/** isErrorHandled: true once `e` has gone through logError() (any call()/callSilent() failure).
 * See HANDLED_MARK above for why globalErrorHandlers.ts needs this. */
export function isErrorHandled(e: unknown): boolean {
  return !!(e && typeof e === "object" && (e as Record<PropertyKey, unknown>)[HANDLED_MARK]);
}

// cmd = the command name (feature), so every diag entry says which IPC call failed. level splits
// call() (toasted, so "error" — the user already saw it) from callSilent() (intentionally quiet,
// so "warn" — still worth a diag trace, just not alarming). code falls back to "unknown" for a
// rejection that isn't shaped like AppError (e.g. a raw string/undefined reached this catch).
const logError = (e: AppError, cmd: string, level: DiagLevel) => {
  markHandled(e);
  reportDiag(level, cmd, e.code || "unknown", e.message || "");
  // eslint-disable-next-line no-console
  console.error("[brise]", e.code, e.message);
};

/**
 * Rejection → AppError, for the toast and the diag record only. Tauri rejects with a bare
 * **string** when a call never reaches the command body — invalid/missing args ("invalid args
 * `provider` for command …") and lib.rs's per-window allowlist ("command not allowed from the pet
 * window"). That is exactly how AUDIT-2026-09-26 D1 stayed invisible: the old `(e as AppError) ??
 * {…}` only replaced null/undefined, so a string reached logError as-is and the diag entry came out
 * as code "unknown" with an empty message. Callers still receive the original rejection (see the
 * `throw e ?? err` below) — normalizing what they catch would turn their `String(e)` into
 * "[object Object]".
 */
function toAppError(e: unknown): AppError {
  // Objects pass through untouched (same identity → markHandled marks what the caller catches).
  if (e && typeof e === "object") return e as AppError;
  return { code: "VALIDATION", message: e instanceof Error ? e.message : String(e) };
}

const emitError = (e: AppError, cmd: string) => {
  if (toastHandler) toastHandler(e);
  logError(e, cmd, "error");
};

// 경량 정보성 알림(에러가 아닌) 채널 — Toast.tsx 가 구독. Wave 3C: semantic degraded 안내 등.
let noticeHandler: ((message: string) => void) | null = null;
export const onAppNotice = (fn: (message: string) => void) => {
  noticeHandler = fn;
};

export const emitNotice = (message: string) => {
  if (noticeHandler) noticeHandler(message);
};

// settings_get_all 동시 호출 합치기 — 부팅 중 서로 다른 32곳(스토어·훅)이 같은 순간 전체 설정을 따로
// 읽어 창 표시 전에만 12번 왕복했다(2026-10-22 실측, 매번 전체 직렬화+파싱). **동시에 진행 중인**
// 호출만 하나로 합치고 끝나면 비운다 — 캐시가 아니다. 쓰기(settings_set)가 나가면 진행 중인 읽기와
// 끊는다: 그 뒤의 읽기가 쓰기 이전 값을 받으면 안 된다. 호출자마다 사본을 준다(받은 객체를 고치는
// 곳이 있어도 서로 새지 않게).
let settingsReadInFlight: Promise<unknown> | null = null;
function transport<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const send = () => (isBrowser() ? httpInvoke<T>(cmd, args) : invoke<T>(cmd, args));
  if (cmd === "settings_set") settingsReadInFlight = null;
  if (cmd !== "settings_get_all" || args !== undefined) return send();
  if (!settingsReadInFlight) {
    const p: Promise<unknown> = send();
    settingsReadInFlight = p;
    const clear = () => {
      if (settingsReadInFlight === p) settingsReadInFlight = null;
    };
    p.then(clear, clear);
  }
  return settingsReadInFlight.then((r) => structuredClone(r) as T);
}

export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await transport<T>(cmd, args);
  } catch (e) {
    const err = toAppError(e);
    emitError(err, cmd);
    throw e ?? err;
  }
}

/**
 * callSilent: same as call(), but never shows an error toast — the rejection still propagates
 * (with a console.error for debuggability) so the caller's own catch can decide what to do.
 * Use only for callers whose design intentionally swallows failures locally (e.g. an always-on
 * background phase that would otherwise toast on every keystroke). Every other call site should
 * keep using call() so its toast-on-error behavior stays intact.
 */
export async function callSilent<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await transport<T>(cmd, args);
  } catch (e) {
    const err = toAppError(e);
    logError(err, cmd, "warn");
    throw e ?? err;
  }
}
