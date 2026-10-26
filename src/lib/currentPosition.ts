/**
 * 현재 좌표의 단일 관문. 셸(window.BriseNative)이 있으면 그 브리지(≈20m, 빠름), 없으면
 * navigator.geolocation. 프로토콜은 mobile-shell ShellBridge.kt 클래스 주석과 같다:
 *   페이지→셸 postMessage('{"id":n,"type":"getLocation"}')
 *   셸→페이지 onmessage: {id,ok:true,lat,lng,accuracy,ts} | {id,ok:false,error}
 * 사진·음성·"현재 위치" 행이 전부 이것만 쓴다 — 분기를 다른 곳에 두지 않는다.
 */
import { getNativeBridge, nativeRequest, NativeRequestError } from "./nativeBridge";

export interface CurrentPosition {
  lat: number;
  lng: number;
  accuracy?: number;
}

export type CurrentPositionErrorCode = "no_permission" | "no_provider" | "timeout" | "security" | "unavailable";

export class CurrentPositionError extends Error {
  constructor(public code: CurrentPositionErrorCode) {
    super(code);
    this.name = "CurrentPositionError";
  }
}

/** 셸의 위치 갱신 제한이 20초 — 그보다 조금 길게 기다린다. */
export const NATIVE_TIMEOUT_MS = 25_000;
const WEB_TIMEOUT_MS = 15_000;

const KNOWN: CurrentPositionErrorCode[] = ["no_permission", "no_provider", "timeout", "security"];

let inflight: Promise<CurrentPosition> | null = null;

/** 요청/응답 배선(id·onmessage·시간 초과)은 lib/nativeBridge.ts 가 쥔다 — 가져오기 요청과 같은 브리지를 쓰기 때문이다. */
async function viaNative(): Promise<CurrentPosition> {
  let m;
  try {
    m = await nativeRequest("getLocation", {}, NATIVE_TIMEOUT_MS);
  } catch (e) {
    throw new CurrentPositionError(e instanceof NativeRequestError && e.code === "timeout" ? "timeout" : "unavailable");
  }
  if (m.ok && typeof m.lat === "number" && typeof m.lng === "number") {
    return { lat: m.lat, lng: m.lng, accuracy: typeof m.accuracy === "number" ? m.accuracy : undefined };
  }
  throw new CurrentPositionError(KNOWN.find((c) => c === m.error) ?? "unavailable");
}

function viaWeb(): Promise<CurrentPosition> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new CurrentPositionError("no_provider"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (err) =>
        reject(new CurrentPositionError(err.code === 1 ? "no_permission" : err.code === 3 ? "timeout" : "unavailable")),
      { timeout: WEB_TIMEOUT_MS, maximumAge: 60_000 },
    );
  });
}

/** 동시 호출은 한 요청을 공유한다(중복 권한 팝업·중복 GPS 구동 방지). */
export function getCurrentPosition(): Promise<CurrentPosition> {
  if (inflight) return inflight;
  const p = getNativeBridge() ? viaNative() : viaWeb();
  inflight = p;
  const clear = () => {
    if (inflight === p) inflight = null;
  };
  p.then(clear, clear);
  return p;
}
