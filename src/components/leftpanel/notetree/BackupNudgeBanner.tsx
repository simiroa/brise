import { useState } from "react";
import { call, emitNotice } from "../../../lib/invoke";
import type { BackupAutoRunOutput } from "../../../lib/commands.gen";
import { useSettingsStore } from "../../../stores/settings";
import { t } from "../../../i18n/t";
import { IconClose } from "../../icons";
import { isBrowser } from "../../../lib/env";
import { formatSize } from "../../../lib/ui";

// N2-5 (docs/PLAN-2026-07-31-round2.md §2): this round's body_md normalization means the first
// edit of a note carried over from an older DB rewrites its legacy hybrid markup — content is
// preserved, but the bytes change and it can't be undone. db/migrations.rs::run sets the
// `backup_nudge_pending` setting exactly once, only on a boot where an *existing* install's
// schema version actually advanced (never on a brand-new DB). This banner is the only consumer:
// a plain dismissible strip, not a modal — the owner's instruction was "nudge, don't block".
export function BackupNudgeBanner() {
  // 설정 스토어가 부팅 load() 에서 이미 읽은 값 — 트리가 다시 마운트될 때마다(사이드바 보기 전환)
  // settings_get_all 을 따로 부르지 않는다.
  const visible = useSettingsStore((s) => s.backupNudgePending);
  const [running, setRunning] = useState(false);
  // Remote/mobile web client has no local filesystem to back up to (sync_server excludes
  // backup_auto_run from http:true — see specs/commands/_conventions.yaml) — never show there.
  const browser = isBrowser();

  // 낙관적으로 숨기고, 저장이 실패하면 setSimplePref 가 되살린다(토스트는 call() 이).
  const clearFlag = () => {
    void useSettingsStore.getState().setBackupNudgePending(false);
  };

  const backupNow = async () => {
    setRunning(true);
    try {
      const result = await call<BackupAutoRunOutput>("backup_auto_run", {});
      emitNotice(t("settings.backup_done", { size: formatSize(result.size_bytes) }));
      clearFlag();
    } catch {
      /* call() already toasted the error — leave the banner up so the user can retry or dismiss */
      setRunning(false);
    }
  };

  if (!visible || browser) return null;

  return (
    <div
      className="stat-tile"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        padding: "var(--space-2) var(--space-3)",
        marginBottom: "var(--space-2)",
        flex: "none",
      }}
    >
      <span style={{ fontSize: "var(--text-sm)", color: "var(--text)", flex: 1, minWidth: 0 }}>
        {t("tree.backup_nudge_message")}
      </span>
      <button
        type="button"
        onClick={() => void backupNow()}
        disabled={running}
        className="icon-btn icon-btn--sm"
        style={{ width: "auto", padding: "0 var(--space-2)", whiteSpace: "nowrap" }}
      >
        {t("settings.backup_now")}
      </button>
      <button
        type="button"
        onClick={clearFlag}
        title={t("common.close")}
        aria-label={t("common.close")}
        className="icon-btn icon-btn--sm"
      >
        <IconClose size={12} strokeWidth={2.2} />
      </button>
    </div>
  );
}

