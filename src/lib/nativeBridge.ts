/**
 * 셸(`window.BriseNative`, mobile-shell ShellBridge.kt)과의 요청/응답 단일 관문.
 *
 * 프로토콜(ShellBridge.kt 클래스 주석과 같다):
 *   페이지→셸 `postMessage('{"id":n,"type":"<type>", ...payload}')`
 *   셸→페이지 `onmessage({data: '{"id":n,"ok":true|false, ...}'})`
 *
 * 왜 한 곳인가: 브리지 객체의 `onmessage` 는 칸이 하나뿐이고 id 도 하나의 번호 공간이다. 모듈마다
 * `onmessage` 를 덮어쓰고 id 를 따로 세면 서로의 응답을 가로채거나 먼저 보낸 요청의 핸들러를 지운다.
 * 위치(currentPosition.ts)와 가져오기(mobile/mobileImportBridge.ts)가 이걸 같이 쓴다.
 * `onmessage` 는 요청마다 우리 디스패처가 아니면 다시 건다 — 브라우저/테스트가 `BriseNative` 를 갈아끼울 수 있다.
 */
export interface NativeBridge {
  postMessage(msg: string): void;
  onmessage: ((e: { data: string }) => void) | null;
}

/** 셸의 응답. `ok:false` 면 `error` 에 코드가 온다(예: `unknown_type`). 그 밖의 필드는 type 마다 다르다. */
export interface NativeReply {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export type NativeRequestErrorCode = "timeout" | "unavailable";

/** 응답을 못 받은 경우(시간 초과·postMessage 가 던짐). `ok:false` 응답은 던지지 않고 [NativeReply] 로 돌려준다. */
export class NativeRequestError extends Error {
  constructor(public code: NativeRequestErrorCode) {
    super(code);
    this.name = "NativeRequestError";
  }
}

let seq = 0;
const pending = new Map<number, (r: NativeReply) => void>();

function dispatch(e: { data: string }): void {
  let m: { id?: unknown; ok?: unknown; error?: unknown; [k: string]: unknown };
  try {
    m = JSON.parse(e.data);
  } catch {
    return; // silent-ok: 형식이 다른 메시지는 우리 요청의 응답이 아니다
  }
  const resolve = typeof m.id === "number" ? pending.get(m.id) : undefined;
  if (!resolve) return; // id 불일치·이미 시간 초과된 응답은 무시
  pending.delete(m.id as number);
  resolve({ ...m, ok: m.ok === true, error: typeof m.error === "string" ? m.error : undefined });
}

/** 셸이 주입한 브리지. 일반 브라우저·구형 셸 밖에서는 undefined. */
export function getNativeBridge(): NativeBridge | undefined {
  return typeof window === "undefined" ? undefined : (window as unknown as { BriseNative?: NativeBridge }).BriseNative;
}

/**
 * 셸에 요청 하나를 보내고 응답을 기다린다.
 * @throws NativeRequestError 브리지가 없거나(unavailable) 시간 안에 응답이 없을 때(timeout)
 */
export function nativeRequest(type: string, payload: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<NativeReply> {
  const bridge = getNativeBridge();
  if (!bridge) return Promise.reject(new NativeRequestError("unavailable"));
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      if (pending.delete(id)) reject(new NativeRequestError("timeout"));
    }, timeoutMs);
    pending.set(id, (r) => (clearTimeout(timer), resolve(r)));
    if (bridge.onmessage !== dispatch) bridge.onmessage = dispatch;
    try {
      bridge.postMessage(JSON.stringify({ ...payload, id, type }));
    } catch {
      clearTimeout(timer);
      pending.delete(id);
      reject(new NativeRequestError("unavailable"));
    }
  });
}
