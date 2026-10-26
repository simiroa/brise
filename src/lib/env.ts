/**
 * Runtime environment detection — the same React build runs (a) inside the Tauri webview as
 * today, (b) in a plain browser served by the sync server (docs/SYNC.md), where every call()
 * must go over HTTP instead of Tauri IPC.
 *
 * Discriminator: `window.__TAURI_INTERNALS__` is what @tauri-apps/api/core actually reads for
 * every invoke/convertFileSrc call (verified in node_modules/@tauri-apps/api/core.js) — it only
 * exists inside a Tauri webview, never in a vanilla browser or in vitest/jsdom.
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Browser mode requires a bearer token (the sync server rejects unauthenticated requests) — so
 * "browser mode" is defined as "not Tauri AND we have a token to authenticate with", not just
 * "not Tauri". This keeps every existing test (vitest/jsdom, no __TAURI_INTERNALS__, no token)
 * on the exact same Tauri-invoke code path it exercises today: zero test-file edits needed for
 * this bridge to land.
 */
export function isBrowser(): boolean {
  return !isTauri() && !!getBrowserToken();
}

const TOKEN_KEY = "brise_sync_token";

/**
 * On boot in a browser tab, the sync server hands the bearer token via `?token=...` in the URL
 * (docs/SYNC.md). Stash it in sessionStorage and strip it from the address bar so it doesn't
 * linger in history/bookmarks, then every later read (call() is per-invocation, not cached into
 * a module const — so bridge tests can flip modes freely) goes through sessionStorage.
 */
export function initBrowserToken(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const token = url.searchParams.get("token");
  if (token) {
    sessionStorage.setItem(TOKEN_KEY, token);
    url.searchParams.delete("token");
    window.history.replaceState(null, "", url.toString());
  }
}

export function getBrowserToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Bearer header for every browser-mode fetch — was byte-identical in lib/httpBridge.ts and
 *  mobile/mobileApi.ts (dedup, 2026-07-30 review); both now import this instead. */
export function authHeaders(): Record<string, string> {
  const token = getBrowserToken();
  // 클라이언트 id 는 토큰 유무와 무관하게 보낸다 — 셸(프록시)이 토큰을 대신 실어 주는 폰에선 token 이 null 이다.
  return token ? { Authorization: `Bearer ${token}`, "X-Brise-Client": CLIENT_ID } : { "X-Brise-Client": CLIENT_ID };
}

/** 이 페이지 로드의 클라이언트 id. 서버가 쓰기 알림(SSE)에 실어 돌려주므로, 자기 쓰기의 메아리를
 *  "다른 기기의 변경"으로 오인하지 않는다(lib/remoteNoteWrite.ts). 인증이 아니라 식별자일 뿐. */
export const CLIENT_ID: string =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `c${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;

/**
 * matchMedia breakpoint the boot coordinator (main.tsx) uses to decide whether to mount MobileApp
 * instead of the desktop App tree. 767px matches mobile.css's own posture (a single-column phone
 * layout; nothing here targets tablet — D2, WORKORDER-2026-09-02-mobile-rework.md).
 *
 * Moved here from mobile/MobileApp.tsx (W2b, mobile rework integration wave) so lib/-level code
 * (stores/notesTree.ts::loadTree) can call `isBrowser() && isMobileViewport()` without a
 * lib/ -> mobile/ import edge — it's an environment discriminator, same family as isTauri/isBrowser.
 */
export function isMobileViewport(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  // ?mobile=1 — 데스크톱 브라우저에서 모바일 레이아웃을 강제로 띄우는 시험용 스위치
  // (initBrowserToken이 token은 URL에서 지우지만 mobile 파라미터는 남겨둔다).
  if (new URLSearchParams(window.location.search).has("mobile")) return true;
  return window.matchMedia("(max-width: 767px)").matches;
}
