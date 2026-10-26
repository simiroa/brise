import { useCallback, useState } from "react";
import { callSilent } from "../lib/invoke";
import { reportFallback } from "../lib/diag";
import { CurrentPositionError, getCurrentPosition, type CurrentPositionErrorCode } from "../lib/currentPosition";

export interface ResolvedLocation {
  region: string;
  lat: number;
  lng: number;
}

// 세션 메모리: 권한이 거부되면 자동 시도를 끈다(매번 실패하지 않게). 수동 탭은 계속 시도한다.
let denied = false;
export const isLocationDenied = (): boolean => denied;
export function resetLocationDenied(): void {
  denied = false;
}

/** 현재 위치 → {region,lat,lng}. 이름 실패는 "lat, lng" 폴백(exif_region 과 같은 규칙). 좌표 실패는 throw. */
export async function resolveCurrentLocation(lang: string): Promise<ResolvedLocation> {
  let pos;
  try {
    pos = await getCurrentPosition();
    denied = false;
  } catch (e) {
    const code: CurrentPositionErrorCode = e instanceof CurrentPositionError ? e.code : "unavailable";
    if (code === "no_permission") denied = true;
    reportFallback("location", `position_${code}`);
    throw e;
  }
  const { lat, lng } = pos;
  try {
    const res = await callSilent<{ label: string | null }>("geocode_reverse", { lat, lng, lang: lang || "ko" });
    const label = res?.label?.split(",")[0].trim();
    if (label) return { region: label, lat, lng };
    reportFallback("location", "geocode_empty");
  } catch {
    reportFallback("location", "geocode_failed"); // callSilent 가 호출 실패는 기록했지만 폴백 발동 자체도 남긴다
  }
  return { region: `${lat.toFixed(4)}, ${lng.toFixed(4)}`, lat, lng };
}

/** E1(입력 화면 자동 첨부)이 재사용: locate() 와 자동 시도 가능 여부(denied). */
export function useCurrentLocationApply(lang: string) {
  const [busy, setBusy] = useState(false);
  const locate = useCallback(async () => {
    setBusy(true);
    try {
      return await resolveCurrentLocation(lang);
    } finally {
      setBusy(false);
    }
  }, [lang]);
  return { locate, busy, denied: isLocationDenied() };
}
