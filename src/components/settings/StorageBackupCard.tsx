import { anchorId } from "./settingsAnchor";
import { useEffect, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { useSettingsStore } from "../../stores/settings";
import { t } from "../../i18n/t";
import { isBrowser } from "../../lib/env";
import { call, callSilent, emitNotice } from "../../lib/invoke";
import { formatSize } from "../../lib/ui";
import type {
  BackupAutoRunOutput,
  BackupAutoStatusOutput,
  DataLocationInspectOutput,
  DbStatsOutput,
} from "../../lib/commands.gen";
import { groupCardStyle } from "./shared";
import { IconAction } from "./IconAction";
import { SettingsRow } from "./SettingsRow";
import { SectionHeader } from "./SectionHeader";
import { Select } from "../Select";
import { ModalShell } from "../ModalShell";
import { IconArchive, IconFolderOpen, IconEdit } from "../icons";
import { StorageGauge } from "./StorageGauge";
import { useDataLocation, DataSpaceBar } from "../onboarding/OnboardingDataStep";

const BACKUP_KEEP_OPTIONS = [1, 2, 3, 4, 5];

/**
 * 저장 공간 게이지 — DB + 첨부 사용량과 드라이브 여유. 카드에 넣지 않는 통계 띠(오너 R1)라 페이지
 * 최상위 형제로 세운다. 일반 페이지에서 이사했다(PLAN-2026-10-24 D6: 사용일·노트·첨부 숫자 타일만
 * 일반에 남는다 — 두 곳이 각자 `db_stats` 를 한 번씩 부른다).
 */
export function StorageGaugeStrip() {
  const [stats, setStats] = useState<DbStatsOutput | null>(null);

  useEffect(() => {
    void callSilent<DbStatsOutput>("db_stats")
      .then(setStats)
      .catch(() => setStats(null));
  }, []);

  const dbSize = stats?.db_size_bytes ?? 0;
  const attachmentSize = stats?.attachments_size_bytes ?? 0;
  const imageSize = stats?.image_size_bytes ?? 0;
  const totalUsed = dbSize + attachmentSize;
  const diskFree = stats?.disk_free_bytes ?? null;

  return (
    <StorageGauge
      usedBytes={totalUsed}
      totalBytes={diskFree != null ? totalUsed + diskFree : 0}
      breakdownText={
        stats
          ? t("settings.stats_storage", {
              db: formatSize(dbSize),
              attachments: formatSize(attachmentSize),
              images: formatSize(imageSize),
            })
          : t("settings.stats_info")
      }
      ratioText={
        diskFree != null
          ? `${formatSize(totalUsed)} · ${t("settings.storage_free_caption", { size: formatSize(diskFree) })}`
          : formatSize(totalUsed)
      }
    />
  );
}

/**
 * 저장 및 백업 카드 — 저장 위치(폴더 열기 · 위치 변경) · 자동 백업(주기 · 보관 개수 · 지금 백업 ·
 * 마지막 백업). 일반 페이지에서 이사했다(PLAN-2026-10-24 D6). "마지막 백업" 표시는 이 카드의 자동 백업 행
 * 하나뿐이다 — 데이터 관리의 위험 작업 배너에 있던 같은 캡션은 이사하며 뺐다. 일회성 "파일로 백업…"
 * (사용자가 고른 경로의 zip)은 자동 백업(데이터 폴더 안 backups/)과 다른 동작이라 위험 작업 카드에 남는다.
 */
export function StorageBackupCard() {
  const uiLang = useSettingsStore((s) => s.uiLang);
  const browser = isBrowser();
  const [backupStatus, setBackupStatus] = useState<BackupAutoStatusOutput | null>(null);
  const [backupRunning, setBackupRunning] = useState(false);

  // 저장 위치(PLAN-2026-09-28-onboarding-rebuild.md §6) — OnboardingDataStep 과 같은 조회 훅·
  // 같은 드라이브 공간 바를 재사용한다(재구현하지 않는다).
  const { current: dataLocation } = useDataLocation();
  const [locationPicker, setLocationPicker] = useState<{ path: string; insp: DataLocationInspectOutput } | null>(null);

  const loadBackupStatus = async () => {
    try {
      const s = await call<BackupAutoStatusOutput>("backup_auto_status", {});
      setBackupStatus(s);
    } catch {
      /* call() 이 이미 에러 토스트를 띄웠다 */
    }
  };

  useEffect(() => {
    if (browser) return;
    void loadBackupStatus();
  }, [browser]);

  const setBackupInterval = async (interval: string) => {
    const rollback = backupStatus;
    setBackupStatus((prev) => ({
      last_backup_at: prev?.last_backup_at ?? null,
      keep: prev?.keep ?? 3,
      last_error: prev?.last_error ?? null,
      interval,
    }));
    try {
      await call("settings_set", { entries: { backup_auto_interval: interval } });
    } catch {
      setBackupStatus(rollback);
    }
  };

  const setBackupKeep = async (keep: number) => {
    const rollback = backupStatus;
    setBackupStatus((prev) => ({
      last_backup_at: prev?.last_backup_at ?? null,
      interval: prev?.interval ?? "weekly",
      last_error: prev?.last_error ?? null,
      keep,
    }));
    try {
      await call("settings_set", { entries: { backup_auto_keep: keep } });
    } catch {
      setBackupStatus(rollback);
    }
  };

  const runBackupNow = async () => {
    if (browser) return;
    setBackupRunning(true);
    try {
      const result = await call<BackupAutoRunOutput>("backup_auto_run", {});
      if (result.excluded_reference_count > 0) {
        emitNotice(t("settings.backup_excluded_refs", { n: result.excluded_reference_count }));
      }
      await loadBackupStatus();
    } catch {
      /* call() 이 이미 에러 토스트를 띄웠다 */
    } finally {
      setBackupRunning(false);
    }
  };

  const openDataDir = async () => {
    if (browser) return;
    try {
      await call("data_dir_open", {});
    } catch {
      /* call() 이 이미 에러 토스트를 띄웠다 */
    }
  };

  // "위치 변경" — 폴더를 고르고 점검만 한다. 쓰기 불가/기존 데이터는 여기서 걸러 확인창을
  // 열지 않는다(온보딩 OnboardingDataStep 과 같은 판정). 실제 이동은 확인창의 "위치 변경"에서만.
  const pickDataLocation = async () => {
    if (browser) return;
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true, multiple: false });
      if (!picked || Array.isArray(picked)) return;
      const insp = await call<DataLocationInspectOutput>("data_location_inspect", { path: picked });
      if (!insp.writable) {
        emitNotice(t("settings.data_location_error_not_writable"));
        return;
      }
      if (insp.has_existing_data) {
        emitNotice(t("settings.data_location_error_existing_data"));
        return;
      }
      setLocationPicker({ path: picked, insp });
    } catch {
      /* dialog unavailable outside Tauri, 또는 call() 이 이미 에러 토스트를 띄웠다 */
    }
  };

  // 이 창은 별도 OS 창(설정)이라 data_location_apply 를 직접 부르지 않는다 — 실제 이동은 main
  // 창의 lib/dataMove.ts::runDataMove(같은 관문, 오너 규칙: 유사 기능은 같은 경로)가 맡는다.
  // 요청은 두 채널로 쏜다 — window 이벤트(브라우저/태블릿 인앱 설정은 같은 창)와 Tauri 이벤트
  // (데스크톱은 별도 OS 창) — "onboarding-restart-requested" 와 같은 이중 채널 패턴
  // (App.tsx 가 둘 다 듣는다). 한쪽은 해당 안 되는 창에서 조용히 무해하게 끝난다.
  // 요청을 보내면 확인창은 바로 닫는다 — 진행("옮기는 중" 가림막)과 실패 토스트는 main 창이 보여주고,
  // 성공하면 재시작이 이 창도 닫는다. 여기에 "옮기는 중" 상태를 두면 실패를 알 길이 없어 영원히
  // 잠긴 채 남는다(재검토 2026-09-29). 두 채널이 같은 창에 함께 닿는 경우는 runDataMove 가 한 번만 받는다.
  const requestDataMove = (path: string) => {
    setLocationPicker(null);
    window.dispatchEvent(new CustomEvent("data-move-request", { detail: { path } }));
    // silent-ok: fails only with no Tauri runtime to ride (tests, or the window event above already covers the browser/tablet overlay).
    void emit("data-move-request", { path }).catch(() => {});
  };

  const applyDataLocation = () => {
    if (!locationPicker) return;
    requestDataMove(locationPicker.path);
  };

  return (
    <>
      {/* 저장 및 백업 — 저장 위치(폴더 열기 · 위치 변경) · 자동 백업(주기 · 보관 개수 · 지금 백업) */}
      <div className="card" style={groupCardStyle} id={anchorId("storage_backup")} data-testid="settings-storage-backup">
        <SectionHeader
          title={t("settings.storage_backup_group")}
          hint={t("settings.general_storage_hint")}
          icon={<IconArchive size={14} strokeWidth={2} />}
        />

        {/* 폴더 열기는 이 행에만 둔다 — 같은 폴더 아이콘이 카드 머리에도 있으면 어느 쪽이 "열기"고
            어느 쪽이 "옮기기"인지 헷갈린다. 옮기기는 다른 아이콘을 쓴다. */}
        <SettingsRow
          anchor="data_location"
          label={t("settings.data_location_row")}
          hint={dataLocation ? (dataLocation.split ? t("settings.data_location_split_hint") : dataLocation.root) : t("common.loading")}
          data-testid="settings-data-location"
          control={
            <div style={{ display: "flex", gap: "var(--space-1)" }}>
              <IconAction
                icon={<IconFolderOpen size={16} />}
                label={t("settings.open_data_dir")}
                titleOverride={browser ? t("common.desktop_only") : undefined}
                onClick={() => void openDataDir()}
                disabled={browser}
                data-testid="settings-open-data-folder"
              />
              <IconAction
                icon={<IconEdit size={16} />}
                label={t("settings.data_location_change")}
                titleOverride={browser ? t("common.desktop_only") : undefined}
                onClick={() => void pickDataLocation()}
                disabled={browser}
                data-testid="settings-data-location-change"
              />
            </div>
          }
        />

        <SettingsRow
          anchor="backup_auto"
          label={t("settings.backup_auto")}
          hint={
            backupStatus?.last_backup_at
              ? t("settings.backup_last", { when: formatWhen(backupStatus.last_backup_at, uiLang) })
              : t("settings.backup_last_none")
          }
          data-testid="settings-backup-auto"
          control={
            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
              <Select
                value={backupStatus?.interval ?? "weekly"}
                onChange={(v) => void setBackupInterval(v)}
                ariaLabel={t("settings.backup_auto")}
                options={[
                  { value: "off", label: t("settings.backup_interval_off") },
                  { value: "daily", label: t("settings.backup_interval_daily") },
                  { value: "weekly", label: t("settings.backup_interval_weekly") },
                ]}
              />
              <Select
                value={String(backupStatus?.keep ?? 3)}
                onChange={(v) => void setBackupKeep(Number(v))}
                ariaLabel={t("settings.backup_keep_label")}
                options={BACKUP_KEEP_OPTIONS.map((n) => ({ value: String(n), label: t("settings.backup_keep_option", { n }) }))}
              />
              <IconAction
                icon={<IconArchive size={16} />}
                label={t("settings.backup_now")}
                titleOverride={browser ? t("common.desktop_only") : undefined}
                size="lg"
                busy={backupRunning}
                onClick={() => void runBackupNow()}
                disabled={backupRunning || browser}
              />
            </div>
          }
        />
        {/* 실패는 마지막 성공 시각과 다른 사실이라 같은 행 힌트에 섞지 않고 사유와 함께 따로 선다
            (위험 작업 배너에 있던 같은 줄이 이사 왔다 — 되돌릴 수 없는 단추 옆에 있던 이유는 이 카드가
            이제 같은 페이지 바로 위에 있어 사라졌다). */}
        {backupStatus?.last_error && (
          <div
            data-testid="settings-data-last-backup"
            style={{ fontSize: "var(--text-xs)", color: "var(--danger)", marginTop: "var(--space-2)" }}
          >
            {t("settings.data_last_backup_failed", { reason: backupStatus.last_error })}
          </div>
        )}
      </div>

      {locationPicker && (
        <ModalShell title={t("settings.data_location_change")} onClose={() => setLocationPicker(null)} width={440}>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
            <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--muted)", overflowWrap: "anywhere" }}>
              {locationPicker.path}
            </p>
            <DataSpaceBar
              freeBytes={locationPicker.insp.free_bytes}
              totalBytes={locationPicker.insp.total_bytes}
              currentBytes={locationPicker.insp.current_data_bytes}
              testId="settings-data-location-space-bar"
            />
            {locationPicker.insp.cloud_provider && (
              <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--muted)", lineHeight: 1.5 }}>
                {t("onboarding.data_cloud_split_note", { provider: locationPicker.insp.cloud_provider })}
              </p>
            )}
            <p style={{ margin: 0, fontSize: "var(--text-xs)", color: "var(--faint)", lineHeight: 1.5 }}>
              {t("settings.data_location_restart_note")}
            </p>
            <div style={{ display: "flex", gap: "var(--space-4)", justifyContent: "flex-end" }}>
              <button type="button" className="btn" onClick={() => setLocationPicker(null)}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={applyDataLocation}
                data-testid="settings-data-location-confirm"
              >
                {t("settings.data_location_change")}
              </button>
            </div>
          </div>
        </ModalShell>
      )}
    </>
  );
}

/** 마지막 백업 시각 — OS 로캘이 아니라 앱 UI 언어로 쓴다(나머지 화면 문구와 한 언어). */
function formatWhen(iso: string, uiLang: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(uiLang || undefined);
}
