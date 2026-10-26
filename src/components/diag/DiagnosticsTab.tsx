import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { callSilent } from "../../lib/invoke";
import { isBrowser } from "../../lib/env";
import { t } from "../../i18n/t";
import type { DiagEntry, DiagWorkerStatus } from "../../lib/commands.gen";

const POLL_MS = 5000;
const COPY_RESET_MS = 1600;

type Level = DiagEntry["level"];
type WorkerState = DiagWorkerStatus["state"];

// 리터럴 키 룩업 — check:i18n 의 unused-keys/undefined-calls 검사는 t 호출의 인자가 그 자리에서
// 곧바로 문자열 리터럴인 형태만 본다(콜백 인자가 변수인 호출은 애초에 매칭 대상이 아니다 —
// AiHistoryPanel.tsx 의 actionLabelKeys 와 같은 패턴). 템플릿 리터럴로 키를 조립하면 이 리터럴
// 문자열이 소스에 안 남아 "쓰이지 않는 키"로 오판된다.
const WORKER_NAME_KEYS: Record<string, string> = {
  schedule: "diag.worker_name_schedule",
  collect: "diag.worker_name_collect",
};

const WORKER_STATE_LABEL_KEYS: Record<WorkerState, string> = {
  alive: "diag.worker_state_alive",
  stale: "diag.worker_state_stale",
  stopped: "diag.worker_state_stopped",
};

const WORKER_STATE_COLOR: Record<WorkerState, string> = {
  alive: "var(--ok)",
  stale: "var(--warn)",
  stopped: "var(--danger)",
};

const LEVEL_LABEL_KEYS: Record<Level, string> = {
  error: "diag.filter_level_error",
  warn: "diag.filter_level_warn",
  info: "diag.filter_level_info",
};

const LEVEL_COLOR: Record<Level, string> = {
  error: "var(--danger)",
  warn: "var(--warn)",
  info: "var(--info)",
};

const LEVELS: Level[] = ["error", "warn", "info"];

function workerLabel(name: string): string {
  const key = WORKER_NAME_KEYS[name];
  return key ? t(key) : name;
}

function formatTs(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString();
}

function dotStyle(color: string): CSSProperties {
  return {
    display: "inline-block",
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: color,
    flexShrink: 0,
  };
}

interface DiagStatusOutput {
  workers: DiagWorkerStatus[];
  log_dir: string;
}
interface DiagRecentOutput {
  items: DiagEntry[];
}

/**
 * 진단 탭 — diag_status(워커 heartbeat, 로그 폴더) + diag_recent(limit 300, JSONL 기반이라
 * 재시작 후에도 보인다)를 5초 폴링한다. 폴링은 이 컴포넌트가 마운트돼 있는 동안만 돈다 — 부모
 * AiHistoryPanel 이 탭 전환 시 언마운트하므로 CallLogTab 과 같은 관례로 정리된다(별도
 * visibilitychange 리스너 불필요).
 * docs/AUDIT-2026-09-26-fallback-observability.md §7.1 W3(diag-viewer).
 */
export function DiagnosticsTab() {
  const [workers, setWorkers] = useState<DiagWorkerStatus[]>([]);
  const [logDir, setLogDir] = useState("");
  const [entries, setEntries] = useState<DiagEntry[]>([]);
  const [loadFailed, setLoadFailed] = useState(false);
  const [levelFilter, setLevelFilter] = useState<Record<Level, boolean>>({
    error: true,
    warn: true,
    info: true,
  });
  const [textFilter, setTextFilter] = useState("");
  const [openFailed, setOpenFailed] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "done" | "failed">("idle");
  const mountedRef = useRef(true);
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    };
  }, []);

  const load = useCallback(() => {
    void Promise.allSettled([
      callSilent<DiagStatusOutput>("diag_status", {}),
      callSilent<DiagRecentOutput>("diag_recent", { limit: 300 }),
    ]).then(([statusRes, entriesRes]) => {
      if (!mountedRef.current) return;
      let failed = false;
      if (statusRes.status === "fulfilled") {
        setWorkers(statusRes.value.workers);
        setLogDir(statusRes.value.log_dir);
      } else {
        failed = true;
      }
      if (entriesRes.status === "fulfilled") {
        setEntries(entriesRes.value.items);
      } else {
        failed = true;
      }
      setLoadFailed(failed);
    });
  }, []);

  // 5초 폴링 — 이 effect 의 cleanup 이 언마운트(=탭 이탈) 시 타이머를 끊는다.
  useEffect(() => {
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const toggleLevel = (level: Level) => {
    setLevelFilter((prev) => ({ ...prev, [level]: !prev[level] }));
  };

  const handleOpenLogDir = async () => {
    if (isBrowser()) return;
    setOpenFailed(false);
    try {
      await callSilent("data_dir_open", {});
    } catch {
      if (mountedRef.current) setOpenFailed(true);
    }
  };

  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(logDir);
      if (mountedRef.current) setCopyState("done");
    } catch {
      if (mountedRef.current) setCopyState("failed");
    }
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
    copyResetTimer.current = setTimeout(() => {
      if (mountedRef.current) setCopyState("idle");
    }, COPY_RESET_MS);
  };

  const query = textFilter.trim().toLowerCase();
  const filteredEntries = entries.filter((e) => {
    if (!levelFilter[e.level]) return false;
    if (!query) return true;
    return (
      e.feature.toLowerCase().includes(query) ||
      e.code.toLowerCase().includes(query) ||
      e.message.toLowerCase().includes(query)
    );
  });

  const copyLabel =
    copyState === "done"
      ? t("diag.copy_path_done")
      : copyState === "failed"
      ? t("diag.copy_path_failed")
      : t("diag.copy_path_btn");

  return (
    <div
      className="scroll"
      data-testid="ai-diag-panel"
      style={{
        flex: "1 1 auto",
        minHeight: 0,
        overflow: "auto",
        padding: "var(--space-4) var(--space-5)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {/* 로그 폴더 카드 — 열기(존재하는 data_dir_open 커맨드 재사용, diag 로그 디렉터리 ==
          AppState.data_dir 라 새 커맨드/권한이 필요 없다) + 경로 복사(열기가 안 되는 창/환경 대비). */}
      <div
        data-testid="ai-diag-logdir-card"
        className="card"
        style={{
          padding: "10px 14px",
          borderRadius: "var(--radius-md)",
          border: "1px solid var(--divider)",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "var(--space-3)" }}>
          <span style={{ fontSize: "var(--text-sm)", fontWeight: 600 }}>{t("diag.log_dir_label")}</span>
          <span
            data-testid="ai-diag-logdir-path"
            style={{
              fontSize: "var(--text-xs)",
              color: "var(--muted)",
              overflowWrap: "anywhere",
              flex: "1 1 auto",
              minWidth: 0,
            }}
          >
            {logDir}
          </span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-3)" }}>
          <button type="button" data-testid="ai-diag-refresh" onClick={load} style={actionBtnStyle}>
            {t("diag.refresh_btn")}
          </button>
          <button
            type="button"
            data-testid="ai-diag-open-log-dir"
            onClick={() => void handleOpenLogDir()}
            style={actionBtnStyle}
          >
            {t("diag.open_log_dir_btn")}
          </button>
          <button
            type="button"
            data-testid="ai-diag-copy-path"
            onClick={() => void handleCopyPath()}
            style={actionBtnStyle}
          >
            {copyLabel}
          </button>
        </div>
        {openFailed && (
          <div style={{ fontSize: "var(--text-xs)", color: "var(--danger)" }}>{t("diag.open_log_dir_failed")}</div>
        )}
      </div>

      {/* 워커 상태 */}
      <div style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--muted)" }}>
        {t("diag.workers_title")}
      </div>
      {workers.length === 0 ? (
        <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)", margin: 0 }}>{t("diag.workers_empty")}</p>
      ) : (
        workers.map((w) => (
          <div
            key={w.name}
            data-testid="ai-diag-worker-row"
            className="card"
            style={{
              padding: "8px 12px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--divider)",
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "var(--space-3)",
              fontSize: "var(--text-sm)",
            }}
          >
            <span aria-hidden="true" style={dotStyle(WORKER_STATE_COLOR[w.state])} />
            <span style={{ fontWeight: 600 }}>{workerLabel(w.name)}</span>
            <span style={{ color: WORKER_STATE_COLOR[w.state] }}>{t(WORKER_STATE_LABEL_KEYS[w.state])}</span>
            <span style={{ marginLeft: "auto", color: "var(--muted)", fontSize: "var(--text-xs)" }}>
              {t("diag.worker_last_beat_label")}: {w.last_beat ? formatTs(w.last_beat) : t("diag.worker_last_beat_none")}
            </span>
          </div>
        ))
      )}

      {/* 필터 */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-3)", marginTop: 4 }}>
        {LEVELS.map((level) => {
          const active = levelFilter[level];
          return (
            <button
              key={level}
              type="button"
              data-testid={`ai-diag-filter-level-${level}`}
              aria-pressed={active}
              onClick={() => toggleLevel(level)}
              style={{
                fontSize: "var(--text-xs)",
                fontWeight: 600,
                padding: "var(--space-2xs) 10px",
                borderRadius: "var(--radius-sm)",
                border: `1px solid ${active ? LEVEL_COLOR[level] : "var(--divider)"}`,
                background: active ? "var(--sel)" : "transparent",
                color: active ? LEVEL_COLOR[level] : "var(--muted)",
                cursor: "pointer",
              }}
            >
              {t(LEVEL_LABEL_KEYS[level])}
            </button>
          );
        })}
        <input
          type="text"
          data-testid="ai-diag-filter-text"
          value={textFilter}
          onChange={(e) => setTextFilter(e.target.value)}
          placeholder={t("diag.filter_text_placeholder")}
          className="field field--sm"
          style={{ flex: "1 1 160px", minWidth: 0, width: "auto" }}
        />
      </div>

      {/* 항목 목록 */}
      <div style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--muted)", marginTop: 4 }}>
        {t("diag.entries_title")}
      </div>
      {loadFailed ? (
        <p style={{ color: "var(--danger)", fontSize: "var(--text-sm)", margin: 0 }}>{t("diag.load_failed")}</p>
      ) : entries.length === 0 ? (
        <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)", margin: 0 }}>{t("diag.empty_state")}</p>
      ) : filteredEntries.length === 0 ? (
        <p style={{ color: "var(--muted)", fontSize: "var(--text-sm)", margin: 0 }}>{t("diag.empty_state_filtered")}</p>
      ) : (
        filteredEntries.map((entry) => (
          <div
            key={entry.id}
            data-testid="ai-diag-entry-row"
            data-level={entry.level}
            className="card"
            style={{
              padding: "8px 12px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--divider)",
            }}
          >
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: "var(--space-3)",
                fontSize: "var(--text-sm)",
              }}
            >
              <span style={{ color: "var(--muted)", flexShrink: 0 }}>{formatTs(entry.ts)}</span>
              <span aria-hidden="true" style={dotStyle(LEVEL_COLOR[entry.level])} />
              <span style={{ color: LEVEL_COLOR[entry.level], fontWeight: 600 }}>
                {t(LEVEL_LABEL_KEYS[entry.level])}
              </span>
              <span
                style={{
                  fontSize: "var(--text-xs)",
                  padding: "var(--space-2xs) 6px",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--line)",
                  color: "var(--muted)",
                }}
              >
                {entry.source}
              </span>
              <span style={{ fontWeight: 600 }}>{entry.feature}</span>
              <span style={{ color: "var(--muted)" }}>{entry.code}</span>
              {entry.count > 1 && (
                <span style={{ color: "var(--muted)", fontSize: "var(--text-xs)" }}>
                  {t("diag.count_suffix", { count: entry.count })}
                </span>
              )}
            </div>
            <div
              style={{
                fontSize: "var(--text-sm)",
                color: "var(--text)",
                marginTop: 4,
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
              }}
            >
              {entry.message}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

const actionBtnStyle: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--accent)",
  background: "transparent",
  border: "1px solid var(--divider)",
  borderRadius: "var(--radius-sm)",
  padding: "var(--space-2xs) 10px",
  cursor: "pointer",
};
