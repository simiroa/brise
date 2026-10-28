import { useSettingsStore } from "../stores/settings";
import { t } from "../i18n/t";
import { call, emitNotice } from "./invoke";
import { isBrowser } from "./env";
import { formatSize } from "./ui";
import { pushNotice, removeNotice } from "./frameNotices";
import type { BackupAutoRunOutput } from "./commands.gen";

/**
 * 백업 권유 알림(N2-5, docs/PLAN-2026-07-31-round2.md §2)의 생산자 — 설정 플래그 `backupNudgePending` 이 알림의 근거다.
 * db/migrations.rs::run 이 기존 설치의 스키마가 실제로 올라간 부팅에서만 이 플래그를 한 번 세운다. 원격/모바일 웹엔 백업할 로컬
 * 파일시스템이 없어(backup_auto_run 은 http:false) 띄우지 않는다.
 */
export const BACKUP_NOTICE_KEY = "backup-nudge";

/** backup_auto_run 이 실행 중인가 — backupNow 의 가드(토스트·벨 단추 공통, 인스턴스와 무관한 모듈 수준).
 *  토스트의 "지금 백업" 과 벨 단추는 같은 함수를 부르고, 상태는 다음 렌더에야 반영돼 연달아 오는 호출을 못 막는다 — 백업이 겹쳐 돌 수 있었다. */
let backupInFlight = false;

function publish(running: boolean): void {
  pushNotice({
    key: BACKUP_NOTICE_KEY,
    text: t("tree.backup_nudge_message"),
    actionLabel: t("settings.backup_now"),
    dismissLabel: t("common.close"),
    busy: running,
    onAction: () => void backupNow(),
    // 낙관적으로 숨기고, 저장이 실패하면 setSimplePref 가 플래그를 되살린다(토스트는 call() 이) — 그러면 아래 구독이 알림을 다시 올린다.
    onDismiss: clearBackupFlag,
  });
}

function clearBackupFlag(): void {
  void useSettingsStore.getState().setBackupNudgePending(false);
}

/** 지금 백업한다. 가드는 이 함수 안에 있다(위 backupInFlight). */
export async function backupNow(): Promise<void> {
  if (backupInFlight) return;
  backupInFlight = true;
  if (useSettingsStore.getState().backupNudgePending) publish(true);
  try {
    const result = await call<BackupAutoRunOutput>("backup_auto_run", {});
    emitNotice(t("settings.backup_done", { size: formatSize(result.size_bytes) }));
    clearBackupFlag();
  } catch {
    // silent-ok: call() 이 이미 토스트했다 — 알림을 남겨 다시 시도하거나 닫을 수 있게 한다.
  } finally {
    backupInFlight = false;
    if (useSettingsStore.getState().backupNudgePending) publish(false);
  }
}

/** 설정 플래그를 알림에 잇는다 — 켜지면 올리고 꺼지면 지운다. 해제 함수를 돌려준다(알림 자체는 남긴다 — 리마운트가 다시 맞춘다). */
export function installBackupNudgeNotice(): () => void {
  if (isBrowser()) return () => {};
  const sync = (pending: boolean) => {
    if (pending) publish(backupInFlight);
    else removeNotice(BACKUP_NOTICE_KEY);
  };
  sync(useSettingsStore.getState().backupNudgePending);
  let prev = useSettingsStore.getState().backupNudgePending;
  return useSettingsStore.subscribe((s) => {
    if (s.backupNudgePending === prev) return;
    prev = s.backupNudgePending;
    sync(prev);
  });
}
