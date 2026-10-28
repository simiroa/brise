import { callSilent } from "./invoke";
import { pushNotice } from "./frameNotices";
import { formatSize } from "./ui";
import { t } from "../i18n/t";
import { useSettingsStore } from "../stores/settings";
import type { DbStatsOutput } from "./commands.gen";

const GB = 1024 ** 3;
export const STORAGE_NOTICE_KEY = "storage-alert";

/** 앱 데이터(DB+첨부)가 한도를 넘었나 — 한도 0(끔)이거나 용량을 모르면 아니다. */
export function isOverStorageLimit(usedBytes: number, limitGb: number): boolean {
  return limitGb > 0 && usedBytes > limitGb * GB;
}

/**
 * 시작 시 한 번: 용량 한도(`storage_alert_gb`)를 넘었으면 알린다(설정 › 데이터 관리, 오너 2026-10-28).
 * 한도 0 이면 `db_stats` 도 부르지 않는다. 조회 실패는 callSilent 가 진단 로그에 남기고 조용히 넘어간다 —
 * 알림은 "있으면 보여주는" 성격이다. 알림은 프레임 알림 스토어에 올린다(lib/frameNotices.ts) — 토스트로 한 번 뜨고, 놓쳐도 벨 메뉴에 남는다
 * (예전엔 `emitNotice` 라 토스트만 뜨고 사라졌다).
 */
export async function checkStorageAlertOnce(): Promise<void> {
  const limitGb = useSettingsStore.getState().storageAlertGb;
  if (limitGb <= 0) return;
  const stats = await callSilent<DbStatsOutput>("db_stats");
  const used = (stats?.db_size_bytes ?? 0) + (stats?.attachments_size_bytes ?? 0);
  if (isOverStorageLimit(used, limitGb)) {
    pushNotice({
      key: STORAGE_NOTICE_KEY,
      text: t("settings.storage_alert_over", { used: formatSize(used), limit: `${limitGb} GB` }),
      dismissLabel: t("common.close"),
    });
  }
}
