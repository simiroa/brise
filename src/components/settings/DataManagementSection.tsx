import { useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { useWorkspacesStore } from "../../stores/workspaces";
import { useSettingsStore } from "../../stores/settings";
import { call, callSilent, emitNotice } from "../../lib/invoke";
import type {
  BackupCreateOutput,
  BackupRestoreOutput,
  DbResetOutput,
  ExportAllOutput,
  ImportBundleOutput,
} from "../../lib/commands.gen";
import { ModalShell } from "../ModalShell";
import { PromptDialog } from "../PromptDialog";
import { ImportSourcesPanel } from "../ImportSourcesPanel";
import { ContextMenuShell } from "../common/ContextMenuShell";
import { formatSize } from "../../lib/ui";
import {
  IconCopy,
  IconFileExport,
  IconFileImport,
  IconMoreHorizontal,
  IconShield,
  IconTrash,
} from "../icons";
import { IconAction } from "./IconAction";
import { t } from "../../i18n/t";
import { groupCardStyle, type ImportDialog } from "./shared";
import { SectionHeader } from "./SectionHeader";
import { IconChip } from "./IconChip";
import { SettingsRow } from "./SettingsRow";
import { Banner } from "./Banner";
import { AttachmentStorageSection } from "./AttachmentStorageSection";
import { TestDataSection } from "./TestDataSection";
import { anchorId } from "./settingsAnchor";
import { StorageBackupCard, StorageGaugeStrip } from "./StorageBackupCard";
import { useSettingsBusy } from "./settingsBusy";
import { isBrowser } from "../../lib/env";
import { exportCalendarIcs, importIcsToDatabase, pickAndReadIcsFile } from "../../lib/ical";
import { importThemeFromPicker } from "../../lib/themeTransfer";

interface DataManagementSectionProps {
  onClose: () => void;
}

/**
 * 설정 > 데이터 — 위에서 아래로 저장 공간 게이지, 첨부 저장 카드, 저장 및 백업 카드(저장 위치·자동 백업·마지막
 * 백업 — PLAN-2026-10-24 D6 으로 일반에서 이사, `StorageBackupCard`), 데이터 이동 카드, 위험 작업 카드(개발
 * 빌드면 테스트 DB 카드까지). 페이지 머리(히어로)는 PLAN-2026-10-24 D3 로 없앴다.
 *
 * **위험 작업은 글자 단추다.** 백업·복원·초기화는 되돌릴 수 없어서 아이콘만으로 이름을 숨기지 않고,
 * 다른 섹션과 같은 카드 안에 둔다. 백업은 OS 저장 다이얼로그가 곧바로 한 번 더 묻고 파일을 하나
 * 만들 뿐이라 추가 확인이 없다.
 *
 * **복원·초기화·번들 "교체" 가져오기는 셋 다 타이핑 게이트다(TypeToConfirm).** confirm 모드
 * PromptDialog 는 window 레벨 keydown 을 걸고 `document.activeElement` 가 Cancel 이 아니면 어떤
 * Enter 든 제출하는데, ModalShell 은 열릴 때 포커스를 카드로 보낸다 — 파일 다이얼로그를 Enter 로
 * 닫은 그 키의 후속 입력만으로 DB 를 덮어쓰는 커맨드가 나갔다. ModalShell 은 Escape 만 듣고 Enter
 * 리스너가 없어 맨 Enter 로는 아무 일도 일어나지 않는다. 복원은 초기화보다 덜 위험하지 않다 —
 * 초기화는 비우지만 복원·교체는 지금 데이터를 남의 것으로 덮는다.
 *
 * 복원·초기화 뒤에는 백엔드가 덮어쓰기 직전에 찍은 스냅샷 경로를 **창 안 다이얼로그**로 보여 주고,
 * 사용자가 닫은 뒤에야 창을 닫고 다시 불러온다(토스트는 reload 에 쓸려 아무도 못 봤다).
 *
 * 되돌릴 수 없는 작업(복원·초기화·가져오기·내보내기·백업)이 도는 동안은 `useSettingsBusy` 에 이름을
 * 올린다 — 중복 클릭을 무시하고, 창 셸이 그동안 닫기를 막는다.
 */
export function DataManagementSection({ onClose }: DataManagementSectionProps) {
  // Active notebook (workspace_id = 노트북) — export_workspace_bundle / hash_merge target.
  // 설정 창은 별도 웹뷰라 노트북 스토어(useWorkspacesStore)가 load 되지 않는다 — 그 activeId 는 늘 null
  // 이라 "노트북 내보내기"가 영구히 비활성이었다(2026-10-21 실앱). 설정 스토어는 이 창에서도 load 되고
  // active_workspace_id 설정 키를 들고 있다(노트북 스토어의 load 도 이 값을 맞춘다).
  const activeWorkspaceId = useSettingsStore((s) => s.activeWorkspaceId);
  // 동기화(beta) 브라우저 탭: 데이터 폴더 열기/백업 파일 저장/가져오기/리셋은 전부 로컬 파일시스템
  // 커맨드 아니면 plugin-dialog 피커라 원격 탭에서 쓸 게 없다(excluded-over-HTTP).
  const browser = isBrowser();
  const busy = useSettingsBusy((s) => s.busy);

  const [resetOpen, setResetOpen] = useState(false);
  const [restorePath, setRestorePath] = useState<string | null>(null);
  // 번들 가져오기 다이얼로그는 이 페이지가 쥔다 — 페이지를 떠났다 돌아왔을 때 묵은 다이얼로그가 다시 뜨지 않는다.
  const [importDialog, setImportDialog] = useState<ImportDialog | null>(null);
  // 복원·초기화가 끝난 뒤 보여 줄 안전 스냅샷 경로. 닫으면 창을 닫고 다시 불러온다.
  const [snapshotPath, setSnapshotPath] = useState<string | null>(null);
  // 전체 내보내기·캘린더(.ics)·다른 앱에서 가져오기 — 여긴 메뉴로 남는다. 위험해서 숨긴 것이
  // 아니라 일회성 경로가 여섯이고, 그중 ImportSourcesPanel 이 variant="menu" 로 자기 하위 목록을
  // 여는 부품이기 때문이다. 펼치면 이 카드의 본 행동(노트북 내보내기/가져오기)이 잔가지에 묻힌다.
  const [transferMoreOpen, setTransferMoreOpen] = useState<{ x: number; y: number } | null>(null);
  const exportAll = () =>
    runExclusive("export", async () => {
      if (browser) return;
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const dest = await open({ directory: true, multiple: false });
        if (!dest || Array.isArray(dest)) return;
        const result = await call<ExportAllOutput>("export_all", { dest_dir: dest });
        emitNotice(t("settings.export_done", { n: result.note_count }));
      } catch {
        /* call() 이 토스트를 띄웠다 · 다이얼로그는 Tauri 밖에서 없다 */
      }
    });

  /** Export the active notebook as a self-sufficient brise-bundle.json (QA8 3C). */
  const exportNotebook = () =>
    runExclusive("export", async () => {
      if (browser || !activeWorkspaceId) return;
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const dest = await open({ directory: true, multiple: false });
        if (!dest || Array.isArray(dest)) return;
        const result = await call<ExportAllOutput>("export_workspace_bundle", {
          id: activeWorkspaceId,
          dest_dir: dest,
        });
        emitNotice(t("settings.export_notebook_done", { n: result.note_count, path: result.bundle_path }));
      } catch {
        /* call() 이 토스트를 띄웠다 · 다이얼로그는 Tauri 밖에서 없다 */
      }
    });

  const importBundle = () =>
    runExclusive("import", async () => {
      if (browser) return;
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const path = await open({
          multiple: false,
          filters: [{ name: t("settings.bundle_filter"), extensions: ["json"] }],
        });
        if (!path || Array.isArray(path)) return;
        setImportDialog({ kind: "mode", path });
      } catch {
        /* dialog unavailable */
      }
    });

  // 옵션 0(docs/SYNC.md): DB 스냅샷 + attachments/ + workspace_bg/ 통짜 zip. export_all의 마크다운
  // 번들과 달리 "이 기기 상태 그대로" 백업/복원 — 동기화가 아니라 데이터 손실 안전망. 위쪽 "저장 및
  // 백업" 카드의 자동 백업(스케줄)과는 별개로, 경로를 직접 고르는 일회성 백업이다.
  const fileBackup = () =>
    runExclusive("backup", async () => {
      if (browser) return;
      try {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const today = new Date().toISOString().slice(0, 10);
        const dest = await save({
          defaultPath: `brise-backup-${today}.zip`,
          filters: [{ name: t("settings.backup_zip_filter"), extensions: ["zip"] }],
        });
        if (!dest) return;
        const result = await call<BackupCreateOutput>("backup_create", { dest_path: dest });
        const done = t("settings.backup_done", { size: formatSize(result.size_bytes) });
        // 참조 첨부의 원본은 앱 폴더 밖이라 zip 에 없다 — 별도 토스트를 하나 더 띄우지 않고
        // 같은 완료 알림에 붙인다(사실만, 0 이면 아무 말도 하지 않는다).
        emitNotice(
          result.excluded_reference_count > 0
            ? `${done} ${t("settings.backup_excluded_refs", { n: result.excluded_reference_count })}`
            : done,
        );
      } catch {
        /* call() 이 토스트를 띄웠다 · 다이얼로그는 Tauri 밖에서 없다 */
      }
    });

  const pickRestoreFile = () =>
    runExclusive("restore", async () => {
      if (browser) return;
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const path = await open({
          multiple: false,
          filters: [{ name: t("settings.backup_zip_filter"), extensions: ["zip"] }],
        });
        if (!path || Array.isArray(path)) return;
        setRestorePath(path);
      } catch {
        /* dialog unavailable */
      }
    });

  const doRestore = () =>
    runExclusive("restore", async () => {
      if (!restorePath) return;
      let res: BackupRestoreOutput;
      try {
        // 사용자가 친 "RESTORE" 가 곧 백엔드 커맨드의 확인 리터럴이다 — 초기화의 RESET 과 같은 형태.
        res = await call<BackupRestoreOutput>("backup_restore", { zip_path: restorePath, confirm: "RESTORE" });
      } catch {
        return; // call()이 이미 에러 토스트를 띄웠다 — 다이얼로그를 닫지 않고 재시도/취소를 맡긴다
      }
      setRestorePath(null);
      setSnapshotPath(res.backup_path);
    });

  const doReset = () =>
    runExclusive("reset", async () => {
      if (browser) return;
      let res: DbResetOutput;
      try {
        res = await call<DbResetOutput>("db_reset", { confirm: "RESET" });
      } catch {
        return; // doRestore 와 같다 — call()이 토스트를 띄우고 재throw 하므로 여기서 붙잡는다(함정 8)
      }
      setResetOpen(false);
      setSnapshotPath(res.backup_path);
    });

  // 스냅샷 안내를 닫는 길은 하나다(확인 단추·Escape 모두) — DB 가 이미 바뀌었으니 반드시 다시 불러온다.
  const finishAfterSnapshot = () => {
    setSnapshotPath(null);
    onClose();
    window.location.reload();
  };

  const runImport = (path: string, mode: "add_notebook" | "hash_merge" | "replace", updateExisting = false) =>
    runExclusive("import", async () => {
      let result: ImportBundleOutput;
      try {
        // callSilent, not call(): a version-newer rejection needs its raw backend message swapped
        // for the localized settings.import_version_newer copy (see repo/transfer/import's
        // version gate comment) — call() would already toast the raw message before we get a
        // chance to intercept it. Other rejections still surface via emitNotice below, unchanged.
        result = await callSilent<ImportBundleOutput>("import_bundle", {
          bundle_path: path,
          mode,
          target_workspace_id: mode === "hash_merge" ? activeWorkspaceId ?? undefined : undefined,
          update_existing: mode === "hash_merge" ? updateExisting : undefined,
        });
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        emitNotice(msg.includes("requires a newer version of Brise") ? t("settings.import_version_newer") : msg);
        return;
      }
      // Outside the try: a throw here is a toast/reload problem, not an import failure, and must
      // not be reported as one via the catch above.
      emitNotice(t("settings.import_done", { imported: result.imported_notes, skipped: result.skipped }));
      // 본 창의 노트 트리는 백엔드의 remote-note-write 로 다시 읽힌다 — 이 쓰기는 window="settings" 를 실어
      // 본 창이 자기 메아리로 버리지 않는다(lib/remoteNoteWrite.ts). 대체(replace)면 백엔드가 "data-replaced"
      // 도 내 본 창이 통째로 다시 불러온다(commands/transfer.rs). 노트북 목록과 설정은 remote-note-write 를
      // 타지 않는다(가져오기는 settings_set 을 거치지 않는다) — 두 이벤트로 본 창에 알리고, 이 설정 창은
      // 자기 스토어를 직접 다시 읽는다(설정 창엔 settings-changed 리스너가 없다).
      void emit("workspaces-changed", {}).catch(() => {}); // silent-ok: Tauri 밖(테스트·브라우저)엔 이벤트 버스가 없다
      void emit("settings-changed", {}).catch(() => {}); // silent-ok: 위와 같다
      try {
        await useSettingsStore.getState().load();
        await useWorkspacesStore.getState().load();
      } catch {
        // silent-ok: 두 load() 는 안에서 call() 을 써 실패를 이미 토스트·진단에 남겼다 — 가져오기 자체는 끝났다
      }
      // 대체(replace)는 지우기 전에 안전 스냅샷을 찍는다 — 복원·초기화와 같은 안내로 그 경로를 보여 주고,
      // 닫으면 다시 불러온다(DB 가 통째로 바뀌었다).
      if (result.backup_path) setSnapshotPath(result.backup_path);
    });

  const exportCalendar = async () => {
    try {
      await exportCalendarIcs();
    } catch {
      /* handled */
    }
  };

  const importCalendar = async () => {
    try {
      const ics = await pickAndReadIcsFile();
      if (!ics) return;
      await importIcsToDatabase(ics);
    } catch {
      /* handled */
    }
  };

  const transferMenuItems: { id: string; label: string; testId?: string; run: () => void }[] = [
    { id: "export-all", label: t("settings.export_all"), run: () => void exportAll() },
    { id: "ics-export", label: t("settings.calendar_export_ics"), run: () => void exportCalendar() },
    { id: "ics-import", label: t("settings.calendar_import_ics"), run: () => void importCalendar() },
    // PLAN-2026-09-19 §5: 테마 파일 또는 전체 내보내기 번들에서 **모양만** 가져온다 —
    // 노트북을 건드리는 번들 가져오기(대체)와 무게가 다르다.
    {
      id: "theme",
      label: t("settings.theme_import_styles_only"),
      testId: "data-import-theme",
      run: () => void importThemeFromPicker(),
    },
  ];

  return (
    <>
      {/* 저장 공간 게이지 → 첨부 저장 → 저장 및 백업(PLAN-2026-10-24 D6: 일반에서 이사) → 이동 → 위험 작업 */}
      <StorageGaugeStrip />

      <AttachmentStorageSection />

      <StorageBackupCard />

      {/* 1. 데이터 이동 */}
      <div className="card" style={groupCardStyle}>
        <SectionHeader
          title={t("settings.transfer_tile")}
          icon={<IconFileExport size={14} strokeWidth={2} />}
        />

        <SettingsRow
          anchor="export_notebook"
          label={t("settings.export_notebook")}
          hint={t("settings.export_notebook_hint")}
          control={
            <div style={{ display: "flex", gap: "var(--space-2)" }}>
              <IconAction
                icon={<IconFileExport size={16} />}
                label={t("settings.export_notebook")}
                titleOverride={browser ? t("common.desktop_only") : undefined}
                onClick={() => void exportNotebook()}
                busy={busy === "export"}
                disabled={browser || !activeWorkspaceId || busy !== null}
              />
              <IconAction
                icon={<IconFileImport size={16} />}
                label={t("settings.import_notebook")}
                titleOverride={browser ? t("common.desktop_only") : undefined}
                onClick={() => void importBundle()}
                busy={busy === "import"}
                disabled={browser || busy !== null}
              />
            </div>
          }
        />

        <SettingsRow
          label={t("settings.more")}
          hint={t("settings.transfer_more_hint")}
          control={
            !browser ? (
              <IconAction
                icon={<IconMoreHorizontal size={16} />}
                label={t("settings.more")}
                aria-haspopup="menu"
                aria-expanded={transferMoreOpen != null}
                disabled={busy !== null}
                onClick={(e) => setTransferMoreOpen({ x: e.clientX, y: e.clientY })}
              />
            ) : null
          }
        />
      </div>

      {/* 2. 위험 작업 — 다른 섹션과 같은 카드. 되돌릴 수 없는 동작이라 단추는 글자로 이름을 말한다. */}
      {!browser && (
        <div className="card" style={groupCardStyle} id={anchorId("danger_zone")}>
          <SectionHeader title={t("settings.danger_zone")} icon={<IconTrash size={14} strokeWidth={2} />} />
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
            <Banner
              tone="danger"
              role="region"
              ariaLabel={t("settings.danger_zone")}
              testId="settings-danger-zone"
              icon={
                <IconChip size={32}>
                  <IconShield size={16} />
                </IconChip>
              }
            >
              <div>{t("settings.danger_zone_hint")}</div>
            </Banner>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-3)" }}>
              <button
                type="button"
                className="btn"
                id={anchorId("backup_all")}
                data-testid="settings-file-backup"
                aria-busy={busy === "backup" || undefined}
                disabled={busy !== null}
                onClick={() => void fileBackup()}
              >
                {t("settings.backup_all")}
              </button>
              {/* 복원·초기화는 확인 모달이 한 번 더 지킨다 — 단추는 모달을 여는 것뿐. */}
              <button
                type="button"
                className="btn"
                id={anchorId("restore_all")}
                data-testid="settings-restore"
                aria-busy={busy === "restore" || undefined}
                disabled={busy !== null}
                onClick={() => void pickRestoreFile()}
              >
                {t("settings.restore_all")}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                id={anchorId("reset_db")}
                data-testid="settings-reset-db"
                aria-busy={busy === "reset" || undefined}
                disabled={busy !== null}
                onClick={() => setResetOpen(true)}
              >
                {t("settings.reset_db")}
              </button>
            </div>
          </div>
        </div>
      )}

      {process.env.NODE_ENV === "development" && <TestDataSection />}

      <ContextMenuShell
        anchor={transferMoreOpen}
        onClose={() => setTransferMoreOpen(null)}
        minWidth={200}
        testId="settings-data-more-menu"
      >
        {transferMenuItems.map((item) => (
          <button
            key={item.id}
            type="button"
            className="menu-row menu-item"
            data-testid={item.testId}
            style={{ color: "inherit" }}
            onClick={() => {
              setTransferMoreOpen(null);
              item.run();
            }}
          >
            {item.label}
          </button>
        ))}
        <ImportSourcesPanel variant="menu" />
      </ContextMenuShell>

      {resetOpen && (
        <TypeToConfirm
          title={t("settings.reset_db")}
          word="RESET"
          prefix={t("settings.reset_type_prefix")}
          suffix={t("settings.reset_type_suffix")}
          confirmLabel={t("settings.reset_db")}
          busy={busy === "reset"}
          onCancel={() => setResetOpen(false)}
          onConfirm={() => void doReset()}
        />
      )}

      {/* 복원은 되돌릴 수 없고, 참조 첨부의 원본은 zip 에 없다 — 복원 뒤 원본이 그 자리에 없으면
          열 때야 "file missing" 이 뜬다(타일은 멀쩡해 보인다). 그 사실을 단추 앞에서 한 번 말한다. */}
      {restorePath && (
        <TypeToConfirm
          title={t("settings.restore_all")}
          note={t("settings.restore_reference_note")}
          word="RESTORE"
          prefix={t("settings.restore_type_prefix")}
          suffix={t("settings.restore_type_suffix")}
          confirmLabel={t("settings.restore_all")}
          busyLabel={t("ctx.restore_in_progress")}
          busy={busy === "restore"}
          testId="settings-restore-confirm"
          onCancel={() => setRestorePath(null)}
          onConfirm={() => void doRestore()}
        />
      )}

      {importDialog?.kind === "mode" && (
        <PromptDialog
          title={t("settings.dialog_import_mode_title")}
          description={t("settings.import_mode_hint")}
          mode="choice"
          width={460}
          choices={[
            {
              value: "add_notebook",
              label: t("settings.import_choice_add_notebook"),
              description: t("settings.import_choice_add_notebook_hint"),
            },
            {
              value: "hash_merge",
              label: t("settings.import_choice_hash_merge"),
              description: t("settings.import_choice_hash_merge_hint"),
            },
            {
              value: "replace",
              label: t("settings.import_choice_replace"),
              description: t("settings.import_choice_replace_hint"),
            },
          ]}
          // hash_merge only: when checked, same-title notes are updated in place instead of
          // added as new. Other modes ignore this flag server-side / client-side.
          remember={{ label: t("settings.import_hash_update_existing") }}
          onCancel={() => setImportDialog(null)}
          onSubmit={(value, remember) => {
            const path = importDialog.path;
            if (value === "replace") {
              setImportDialog({ kind: "replaceConfirm", path });
            } else if (value === "hash_merge") {
              setImportDialog(null);
              void runImport(path, "hash_merge", !!remember);
            } else {
              setImportDialog(null);
              void runImport(path, "add_notebook");
            }
          }}
        />
      )}

      {/* 교체는 지금 DB 를 통째로 지우고 번들로 다시 짓는다 — 복원·초기화와 같은 타이핑 게이트. */}
      {importDialog?.kind === "replaceConfirm" && (
        <TypeToConfirm
          title={t("settings.dialog_import_replace_title")}
          note={t("settings.import_choice_replace_hint")}
          word="REPLACE"
          prefix={t("settings.reset_type_prefix")}
          suffix={t("settings.import_replace_type_suffix")}
          confirmLabel={t("settings.import_choice_replace")}
          busy={busy === "import"}
          testId="settings-import-replace-confirm"
          onCancel={() => setImportDialog(null)}
          onConfirm={() => {
            const path = importDialog.path;
            setImportDialog(null);
            void runImport(path, "replace");
          }}
        />
      )}

      {snapshotPath && (
        <ModalShell title={t("settings.safety_snapshot_title")} onClose={finishAfterSnapshot} width={460}>
          <p style={{ fontSize: "var(--text-md)", color: "var(--muted)", margin: "0 0 var(--space-4)" }}>
            {t("settings.safety_snapshot_body")}
          </p>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", margin: "0 0 var(--space-6)" }}>
            <code
              data-testid="settings-safety-snapshot-path"
              title={snapshotPath}
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: "var(--text-xs)",
                color: "var(--text)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                userSelect: "text",
              }}
            >
              {snapshotPath}
            </code>
            <IconAction
              icon={<IconCopy size={14} />}
              label={t("settings.safety_snapshot_copy")}
              size="sm"
              data-testid="settings-safety-snapshot-copy"
              onClick={() => void copySnapshotPath(snapshotPath)}
            />
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="settings-safety-snapshot-ok"
              onClick={finishAfterSnapshot}
            >
              {t("settings.safety_snapshot_reload")}
            </button>
          </div>
        </ModalShell>
      )}
    </>
  );
}

/** 되돌릴 수 없는 작업 하나를 설정 창 전체의 busy 슬롯에 걸고 돈다 — 이미 무언가 돌면 무시(중복 클릭). */
async function runExclusive(name: string, fn: () => Promise<void>): Promise<void> {
  const store = useSettingsBusy.getState();
  if (store.busy !== null) return;
  store.setBusy(name);
  try {
    await fn();
  } finally {
    useSettingsBusy.getState().setBusy(null);
  }
}

async function copySnapshotPath(path: string) {
  try {
    await navigator.clipboard.writeText(path);
    emitNotice(t("settings.safety_snapshot_copied"));
  } catch {
    emitNotice(t("settings.sync_copy_failed"));
  }
}

/**
 * 타이핑 게이트 확인 모달 — `word` 를 그대로 쳐야 확인 단추가 열린다. 맨 Enter 로는 아무 일도
 * 일어나지 않는다(ModalShell 엔 Enter 리스너가 없다, 파일 위 주석). 도는 동안(busy)은 닫지 않는다 —
 * 끝나면 다음 단계로 가고, 실패하면 그대로 열려 재시도/취소를 맡긴다.
 */
function TypeToConfirm({
  title,
  note,
  word,
  prefix,
  suffix,
  confirmLabel,
  busyLabel,
  busy,
  testId,
  onCancel,
  onConfirm,
}: {
  title: string;
  note?: string;
  word: string;
  prefix: string;
  suffix: string;
  confirmLabel: string;
  busyLabel?: string;
  busy: boolean;
  testId?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  const ok = typed === word;
  const cancel = () => {
    if (!busy) onCancel();
  };
  return (
    <ModalShell title={title} onClose={cancel} width={400}>
      {note && <p style={{ fontSize: "var(--text-md)", color: "var(--muted)", margin: "0 0 var(--space-4)" }}>{note}</p>}
      <p style={{ fontSize: "var(--text-md)", color: "var(--muted)", margin: "0 0 var(--space-6)" }}>
        {prefix} <strong>{word}</strong> {suffix}
      </p>
      <input
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder={word}
        className="field"
        style={{ marginBottom: "var(--space-4)" }}
      />
      <div style={{ display: "flex", gap: "var(--space-4)", justifyContent: "flex-end" }}>
        <button type="button" onClick={cancel} disabled={busy} className="btn">
          {t("common.cancel")}
        </button>
        <button
          type="button"
          data-testid={testId}
          disabled={!ok || busy}
          onClick={onConfirm}
          className={ok ? "btn btn-danger" : "btn"}
        >
          {busy && busyLabel ? busyLabel : confirmLabel}
        </button>
      </div>
    </ModalShell>
  );
}
