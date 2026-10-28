import { useEffect } from "react";
import { installBackupNudgeNotice } from "../../lib/backupNudge";
import { installPetSuggestionNotices } from "./petSuggestionNotices";

/**
 * 프레임 알림(lib/frameNotices.ts)의 생산자를 메인 창에 건다 — 벨이 마운트 지점일 뿐 로직은 각 생산자 모듈에 있다(백업 권유는
 * lib/backupNudge.ts, 펫 제안은 ./petSuggestionNotices.ts, 용량 한도는 lib/storageAlert.ts 가 부팅에서 직접 올린다).
 * 해제는 구독만 끊는다 — `.app` 이 언어 변경으로 리마운트될 때 알림 자체는 남고 새 마운트가 문구를 다시 맞춘다.
 */
export function useFrameNoticeProducers(): void {
  useEffect(() => {
    const offs = [installBackupNudgeNotice(), installPetSuggestionNotices()];
    return () => offs.forEach((off) => off());
  }, []);
}
