/**
 * "가져오기" 셸 브리지 호출 — 요청/응답 배선은 lib/nativeBridge.ts, 응답 해석은 mobileImport.ts.
 *
 *   getPendingImport → 셸이 쥔 가져오기 하나(없으면 null). **읽기만 한다** — 같은 배치를 ack 전에는 계속 돌려준다
 *                      (페이지가 채우기 전에 닫히거나 저장 실패 관문에 막혀도 잃지 않게. 중복은 importId 로 거른다).
 *   ackImport        → 이 배치를 끝냈다(저장했거나 버렸다). 셸이 임시 파일을 지운다.
 *   fetch(file.url)  → 이미지 바이트. 셸이 WebView 요청 가로채기로 내주는 same-origin 스트림(브리지 메시지 아님).
 *
 * 이 모듈은 셸이 없는(일반 브라우저·구형 셸) 환경에서 전부 "아무것도 없음"으로 조용히 끝난다.
 */
import { getNativeBridge, nativeRequest, NativeRequestError } from "../lib/nativeBridge";
import { reportFallback } from "../lib/diag";
import { parseImportReply, type ImportFile, type ShellImportBatch } from "./mobileImport";

/** 셸이 복사를 끝낼 때까지 응답을 미룬다(큰 사진 여러 장) — 위치 요청(25초)보다 넉넉히. */
export const PULL_TIMEOUT_MS = 60_000;
const ACK_TIMEOUT_MS = 10_000;

export function hasImportBridge(): boolean {
  return !!getNativeBridge();
}

/** @returns 가져올 것이 있으면 배치, 아니면(셸 없음·구형 셸·없음·실패) null. */
export async function pullPendingImport(): Promise<ShellImportBatch | null> {
  if (!hasImportBridge()) return null;
  try {
    return parseImportReply(await nativeRequest("getPendingImport", {}, PULL_TIMEOUT_MS));
  } catch (e) {
    // 시간 초과 = 셸이 응답을 못 줬다. 다음 트리거(앞으로 돌아옴·알림)가 다시 부른다.
    reportFallback("mobile-import", "pull_failed", e instanceof NativeRequestError ? e.code : "error");
    return null;
  }
}

/** 실패해도 던지지 않는다 — 셸의 임시 파일은 다음 앱 시작 때 어차피 지워진다. */
export async function ackImport(importId: string): Promise<void> {
  if (!hasImportBridge()) return;
  try {
    const r = await nativeRequest("ackImport", { importId }, ACK_TIMEOUT_MS);
    if (!r.ok && r.error !== "unknown_type") reportFallback("mobile-import", "ack_rejected", r.error ?? "");
  } catch (e) {
    reportFallback("mobile-import", "ack_failed", e instanceof NativeRequestError ? e.code : "error");
  }
}

/** 이미지 바이트를 File 로 받는다. 업로드 직전에 부른다(미리 쥐고 있지 않는다). */
export async function fetchImportFile(file: ImportFile): Promise<File> {
  const res = await fetch(file.url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  return new File([blob], file.name, { type: file.mime || blob.type });
}
