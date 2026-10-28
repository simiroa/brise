import { t } from "../i18n/t";
import { emitNotice } from "./invoke";

/**
 * 값을 클립보드에 복사하고 결과를 토스트로 알린다 — 성공하면 `doneMessage`, 실패하면 "복사하지 못했습니다".
 * 실패를 알리지 않고 넘어가거나 "복사했습니다"로 거짓 안내하지 않는 한 길이다(설정 › 동기화·데이터 관리·에이전트 연결이 같이 쓴다).
 * 성공 여부를 돌려준다.
 */
export async function copyWithNotice(value: string, doneMessage: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    emitNotice(doneMessage);
    return true;
  } catch {
    // silent-ok: 실패는 바로 아래 토스트로 사용자에게 알린다(진단 기록 대상이 아닌 권한·포커스 문제).
    emitNotice(t("settings.sync_copy_failed"));
    return false;
  }
}
