import { useEffect, useState } from "react";
import { useSettingsStore } from "../../stores/settings";
import { t } from "../../i18n/t";
import { call, callSilent } from "../../lib/invoke";
import { reportFallback, safeErrorDetail } from "../../lib/diag";
import type { DataLocationGetOutput } from "../../lib/commands.gen";
import { IconAction } from "./IconAction";
import { SettingsRow } from "./SettingsRow";
import { IconFolderOpen, IconTrash } from "../icons";
import { SettingsCard } from "./SettingsCard";

type FolderKind = "data" | "attachments" | "backups";

/**
 * 일반 > 폴더 바로가기 (PLAN-2026-10-27 §1). 데이터·첨부파일·백업 폴더를 탐색기로 바로 연다.
 * 경로는 `data_location_get` 이 말하는 **지금 살아 있는 위치**(포인터로 옮겼으면 그쪽)를 보여 준다.
 * 위치를 *바꾸는* 일은 데이터 관리 > 저장 및 백업의 데이터 위치 행이 맡는다 — 여기는 열기만.
 * 데스크톱 전용(커맨드가 http:false) — 호출부가 브라우저에서는 마운트하지 않는다.
 */
export function FolderShortcutsCard() {
  const [loc, setLoc] = useState<DataLocationGetOutput | null>(null);
  const exportDir = useSettingsStore((s) => s.exportDefaultDir);
  const setExportDir = useSettingsStore((s) => s.setExportDefaultDir);

  // 내보내기 기본 폴더 고르기 — 취소하면 그대로. 대화상자 플러그인이 없으면(Tauri 밖·테스트) 조용히 넘어가되 기록한다.
  const pickExportDir = async () => {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const picked = await openDialog({ directory: true, multiple: false, defaultPath: exportDir || undefined });
      if (picked && !Array.isArray(picked)) await setExportDir(picked);
    } catch (e) {
      reportFallback("settings", "export_dir_pick_failed", safeErrorDetail(e));
    }
  };

  useEffect(() => {
    // 경로 표시는 선택적 — 못 읽으면 힌트만 비고 열기 버튼은 그대로 동작한다.
    void callSilent<DataLocationGetOutput>("data_location_get")
      .then(setLoc)
      .catch(() => setLoc(null));
  }, []);

  // 열기 실패는 call() 이 토스트·진단 로그로 이미 알렸다(사용자 행동이 실패) — 되돌릴 화면 상태가 없어 여기서는 더 할 일이 없으므로 삼킨다.
  const open = async (kind: FolderKind) => {
    try {
      await call("data_subdir_open", { kind });
    } catch {
      /* silent-ok: call() 이 이미 토스트·진단 로그를 남겼다 */
    }
  };

  // 앵커는 리터럴로 — 검색 색인 테스트가 소스에서 `anchor="…"` 를 문자열로 찾는다.
  const rows: Array<{ kind: FolderKind; anchor: string; label: string; path: string | undefined }> = [
    { kind: "data", anchor: "folder_data", label: t("settings.folder_data"), path: loc?.root },
    { kind: "attachments", anchor: "folder_attachments", label: t("settings.folder_attachments"), path: loc?.attachments_dir },
    { kind: "backups", anchor: "folder_backups", label: t("settings.folder_backups"), path: loc?.backups_dir },
  ];

  return (
    <SettingsCard title={t("settings.folder_shortcuts")} icon={<IconFolderOpen size={14} strokeWidth={2} />} testId="settings-folder-shortcuts">
      {rows.map((r) => (
        <SettingsRow
          key={r.kind}
          anchor={r.anchor}
          label={r.label}
          hint={r.path}
          data-testid={`settings-folder-${r.kind}`}
          control={
            <IconAction
              icon={<IconFolderOpen size={16} />}
              label={t("settings.folder_open")}
              onClick={() => void open(r.kind)}
              data-testid={`settings-folder-${r.kind}-open`}
            />
          }
        />
      ))}
      {/* 내보내기 기본 폴더 — 열기 행이 아니라 "정하기" 행이다. 노트·섹션·시트·다이어그램·전체 백업의 저장 대화상자가 여기서 시작한다. */}
      <SettingsRow
        anchor="export_default_dir"
        label={t("settings.export_default_dir")}
        hint={exportDir || t("settings.export_default_dir_none")}
        data-testid="settings-export-default-dir"
        control={
          <div style={{ display: "flex", gap: "var(--space-1)" }}>
            <IconAction
              icon={<IconFolderOpen size={16} />}
              label={t("settings.export_default_dir_pick")}
              onClick={() => void pickExportDir()}
              data-testid="settings-export-default-dir-pick"
            />
            {exportDir && (
              <IconAction
                icon={<IconTrash size={16} />}
                label={t("settings.export_default_dir_clear")}
                onClick={() => void setExportDir("")}
                data-testid="settings-export-default-dir-clear"
              />
            )}
          </div>
        }
      />
    </SettingsCard>
  );
}
