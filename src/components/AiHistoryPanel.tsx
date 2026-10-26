import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useAiStore, type AiHistoryItem } from "../stores/ai";
import { useSettingsStore } from "../stores/settings";
import { useNotesStore } from "../stores/notes";
import { callSilent } from "../lib/invoke";
import { t } from "../i18n/t";
import { toIsoDateLocal } from "./titlebar/dueDate";
import { DiagnosticsTab } from "./diag/DiagnosticsTab";
import type { CallLogEntry, CallsSummary, NoteSummary } from "../lib/commands.gen";

const actionLabelKeys: Record<string, string> = {
  fill_metadata: "ai.action_default_name_metadata",
  translate: "ai.translate",
  organize: "ai.action_default_name_organize",
  summarize: "ai.action_default_name_summarize",
  list: "ai.action_default_name_list",
  diagram: "ai.action_default_name_diagram",
  diagram_edit: "ai.action_default_name_diagram_edit",
  collect_post_process: "settings.collect_ai_post_process",
};

function translated(path: string, fallback: string): string {
  const value = t(path);
  return value === path ? fallback : value;
}

function actionLabel(actionType: string): string {
  const [operation, outcome] = actionType.split(".", 2);
  const key = actionLabelKeys[operation];
  const operationLabel = key
    ? translated(key, operation)
    : operation
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
  if (!outcome) return operationLabel;
  const outcomeLabel = outcome
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
  return `${operationLabel} · ${outcomeLabel}`;
}

function tabBtnStyle(on: boolean): CSSProperties {
  // Underline via inset box-shadow (not a bottom border) so it never needs a negative margin to
  // sit flush against the tablist's own 1px divider — same convention as SectionTabBar's tabStyle.
  return {
    flex: "none",
    padding: "var(--space-3) var(--space-5)",
    fontSize: "var(--text-sm)",
    fontWeight: 600,
    cursor: "pointer",
    background: on ? "var(--sel)" : "transparent",
    color: on ? "var(--accent)" : "var(--muted)",
    border: "none",
    boxShadow: on ? "inset 0 -2px 0 var(--accent)" : undefined,
  };
}

const scopeHintKeys: Record<"audit" | "calls" | "diag", string> = {
  audit: "ai.call_log_scope_hint_audit",
  calls: "ai.call_log_scope_hint_calls",
  diag: "diag.scope_hint",
};

/**
 * AI 히스토리 창 본문 — "감사"(ai_history, 기존 사용자 대면 기록) / "호출 로그"(ai_calls_active·
 * ai_calls_recent, 진단용) / "진단"(diag_status·diag_recent, 재시작 후에도 남는 폴백·오류 신호)
 * 세 탭. docs/PLAN-2026-09-05-ai-guardrails.md §3 C-4,
 * docs/AUDIT-2026-09-26-fallback-observability.md §7.1 W3.
 * 새 OS 창을 만들지 않는다 — 기존 ai-history 창(aux_window.rs) 안의 탭 전환일 뿐.
 */
export function AiHistoryPanel() {
  const [tab, setTab] = useState<"audit" | "calls" | "diag">("audit");

  return (
    <>
      <div
        role="tablist"
        data-testid="ai-history-tabs"
        style={{ display: "flex", borderBottom: "1px solid var(--divider)", flex: "none" }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === "audit"}
          data-testid="ai-history-tab-audit"
          onClick={() => setTab("audit")}
          style={tabBtnStyle(tab === "audit")}
        >
          {t("ai.call_log_tab_audit")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "calls"}
          data-testid="ai-history-tab-calls"
          onClick={() => setTab("calls")}
          style={tabBtnStyle(tab === "calls")}
        >
          {t("ai.call_log_tab_calls")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "diag"}
          data-testid="ai-history-tab-diag"
          onClick={() => setTab("diag")}
          style={tabBtnStyle(tab === "diag")}
        >
          {t("diag.tab_label")}
        </button>
      </div>
      <div
        style={{
          padding: "var(--space-2) var(--space-5)",
          fontSize: "var(--text-xs)",
          color: "var(--muted)",
          flex: "none",
          borderBottom: "1px solid var(--divider)",
        }}
      >
        {t(scopeHintKeys[tab])}
      </div>
      {tab === "audit" ? <AuditLogTab /> : tab === "calls" ? <CallLogTab /> : <DiagnosticsTab />}
    </>
  );
}

/** 기존 감사 탭 — ai_history 스토어 그대로, 이전 AiHistoryPanel 본문과 동일. */
function AuditLogTab() {
  const historyItems = useAiStore((s) => s.historyItems);
  const [selectedItem, setSelectedItem] = useState<AiHistoryItem | null>(null);
  const [usageRows, setUsageRows] = useState<Array<{ day: string; action_type: string; provider: string; calls: number }>>([]);

  useEffect(() => {
    void callSilent<{ rows: Array<{ day: string; action_type: string; provider: string; calls: number }> }>("ai_get_usage", {})
      .then((res) => {
        if (res?.rows) setUsageRows(res.rows);
      })
      .catch(() => {});
  }, []);

  // ai_usage 는 백엔드에서 today_ymd_local(로컬 달력일) 로 키가 매겨진다 — UTC 슬라이스를 쓰면
  // KST 00:00~09:00 사이 "오늘 호출"이 어제로 잡힌다.
  const todayStr = toIsoDateLocal();
  const todayCalls = usageRows.filter((r) => r.day === todayStr).reduce((sum, r) => sum + r.calls, 0);
  const totalCalls = usageRows.reduce((sum, r) => sum + r.calls, 0);

  const providerCounts: Record<string, number> = {};
  for (const r of usageRows) {
    providerCounts[r.provider] = (providerCounts[r.provider] || 0) + r.calls;
  }

  return (
    <>
      <div
        className="scroll"
        data-testid="ai-history-panel"
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
        {/* 통계 요약 헤더 (P3 수집 v2) */}
        {totalCalls > 0 && (
          <div
            data-testid="ai-usage-stats-card"
            className="card"
            style={{
              padding: "10px 14px",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--divider)",
              marginBottom: 4,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                <span style={{ fontSize: "var(--text-sm)", fontWeight: 600 }}>
                  {t("ai.usage_today") || "오늘 호출"}: <span style={{ color: "var(--accent)" }}>{todayCalls}</span>
                </span>
                <span style={{ fontSize: "var(--text-sm)", color: "var(--muted)" }}>•</span>
                <span style={{ fontSize: "var(--text-sm)", fontWeight: 600 }}>
                  {t("ai.usage_total") || "누적 호출"}: <span>{totalCalls}</span>
                </span>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {Object.entries(providerCounts).map(([prov, count]) => (
                  <span
                    key={prov}
                    style={{
                      fontSize: "var(--text-xs)",
                      padding: "var(--space-2xs) 6px",
                      borderRadius: "var(--radius-sm)",
                      border: "1px solid var(--line)",
                      color: "var(--muted)",
                    }}
                  >
                    {prov}: {count}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {historyItems.length === 0 ? (
          <p style={{ color: "var(--muted)", fontSize: "var(--text-md)" }}>
            {t("ai.history_empty") || "No AI history recorded yet."}
          </p>
        ) : (
          historyItems.map((item) => {
            const expanded = selectedItem?.id === item.id;
            const resultId = `ai-history-result-${item.id}`;
            return (
            <div
              key={item.id}
              className="card"
              style={{
                padding: "8px 12px",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--divider)",
              }}
            >
              <button
                type="button"
                onClick={() => setSelectedItem(expanded ? null : item)}
                aria-expanded={expanded}
                aria-controls={expanded ? resultId : undefined}
                style={{
                  width: "100%",
                  cursor: "pointer",
                  color: "inherit",
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  textAlign: "left",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: "var(--text-sm)", marginBottom: 4, gap: 12 }}>
                  <span style={{ fontWeight: 600, color: "var(--accent)" }}>{actionLabel(item.action_type)}</span>
                  <span style={{ color: "var(--muted)", flexShrink: 0 }}>
                    {new Date(item.created_at).toLocaleString()}
                  </span>
                </div>
                {item.prompt_or_input && (
                  <div style={{ fontSize: "var(--text-sm)", color: "var(--muted)", marginBottom: 4, overflowWrap: "anywhere" }}>
                    <strong>{translated("ai.history_input", "Input")}:</strong> {item.prompt_or_input}
                  </div>
                )}
                {!expanded && (
                  <div
                    style={{
                      fontSize: "var(--text-sm)",
                      color: "var(--text)",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {item.result_text}
                  </div>
                )}
              </button>
              {expanded && (
                <div
                  id={resultId}
                  data-testid={resultId}
                  style={{
                    fontSize: "var(--text-sm)",
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                    marginTop: 6,
                    padding: 8,
                    background: "var(--hover)",
                    borderRadius: "var(--radius-xs)",
                  }}
                >
                  {item.result_text}
                </div>
              )}
            </div>
          );
          })
        )}
      </div>
    </>
  );
}

// ── 호출 로그 탭 (신규) ──────────────────────────────────────────────────────────────────────

const OUTCOME_COLOR: Record<string, string> = {
  ok: "var(--ok)",
  error: "var(--danger)",
  deadline: "var(--danger-soft)",
  cancelled: "var(--muted)",
};

function formatElapsedMs(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatDurationMs(ms: number | undefined): string {
  if (ms == null) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function formatOp(op: string | undefined): string {
  if (!op) return "—";
  return op.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** note_id → 노트 제목(있으면) — noteIndex에 없으면(다른 노트북·이미 삭제됨) id 앞 8자로 대신한다. */
function noteLabelFor(noteId: string | undefined, noteIndex: Map<string, NoteSummary>): string | undefined {
  if (!noteId) return undefined;
  const found = noteIndex.get(noteId);
  return found ? found.title : noteId.slice(0, 8);
}

function outcomeLabel(outcome: string | undefined): string {
  if (!outcome) return t("ai.call_log_in_progress");
  const key = `ai.call_log_outcome_${outcome}`;
  const label = t(key);
  return label === key ? outcome : label;
}

/**
 * 호출 로그 탭 — ai_calls_active(진행 중, 1초 폴링) + ai_calls_recent(최근 종료, limit 100).
 * 두 커맨드 모두 DB 없이 Rust 프로세스 전역 링 버퍼를 읽는다(repo/ai/call_log.rs) — 폴링 비용은
 * 로컬 IPC 왕복 하나뿐이다.
 *
 * ponytail: 폴링 간격은 진행 중 항목이 있으면 1초, 없으면 4초로 늦춘다(스펙이 요구하는 건 "진행
 * 중일 때 1초"뿐이지만, 폴링을 완전히 멈추면 이 탭을 계속 열어둔 채로 새로 시작되는 호출을 영영
 * 못 본다 — 4초 유휴 하트비트가 그 발견 지연의 상한이다). 탭을 벗어나면(부모가 언마운트) cleanup
 * 이 타이머를 끊는다.
 */
function CallLogTab() {
  const aiDebugVerbose = useSettingsStore((s) => s.aiDebugVerbose);
  const [activeItems, setActiveItems] = useState<CallLogEntry[]>([]);
  const [recentItems, setRecentItems] = useState<CallLogEntry[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [loadFailed, setLoadFailed] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [summary, setSummary] = useState<CallsSummary | null>(null);
  const prevActiveCountRef = useRef(0);

  // K4(2026-09-06) — 탭이 마운트될 때 한 번만(폴링 아님). 조회 실패면 카드를 숨긴다 — 이미 아래
  // 활성/최근 목록이 폴링으로 스스로 돌므로, 요약 카드 하나 실패했다고 탭 전체를 막을 이유는 없다.
  useEffect(() => {
    let cancelled = false;
    void callSilent<CallsSummary>("ai_calls_summary", { days: 7 })
      .then((res) => {
        if (!cancelled && res) setSummary(res);
      })
      .catch(() => {
        if (!cancelled) setSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const fetchRecent = () => {
      void callSilent<{ items: CallLogEntry[] }>("ai_calls_recent", { limit: 100 })
        .then((res) => {
          if (!cancelled && res?.items) setRecentItems(res.items);
        })
        .catch(() => {
          if (!cancelled) setLoadFailed(true);
        });
    };

    const tick = () => {
      void callSilent<{ items: CallLogEntry[] }>("ai_calls_active", {})
        .then((res) => {
          if (cancelled) return;
          const items = res?.items ?? [];
          // 방금 활성 항목이 사라졌다 = 호출 하나가 막 끝났다 → 최근 목록을 다시 읽어 즉시 보이게.
          if (prevActiveCountRef.current > 0 && items.length === 0) fetchRecent();
          prevActiveCountRef.current = items.length;
          setActiveItems(items);
          setNow(Date.now());
          setLoadFailed(false);
          timer = setTimeout(tick, items.length > 0 ? 1000 : 4000);
        })
        .catch(() => {
          if (cancelled) return;
          setLoadFailed(true);
          timer = setTimeout(tick, 4000);
        });
    };

    fetchRecent();
    tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const isEmpty = activeItems.length === 0 && recentItems.length === 0;

  return (
    <div
      className="scroll"
      data-testid="ai-calllog-panel"
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
      {aiDebugVerbose && (
        <div style={{ fontSize: "var(--text-xs)", color: "var(--danger-soft)" }}>
          {t("ai.call_log_verbose_active")}
        </div>
      )}

      {summary && <CallLogSummaryCard summary={summary} />}

      {isEmpty ? (
        <p style={{ color: "var(--muted)", fontSize: "var(--text-md)" }}>
          {loadFailed ? t("ai.call_log_load_failed") : t("ai.call_log_empty")}
        </p>
      ) : (
        <>
          {activeItems.length > 0 && (
            <>
              <div style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--muted)" }}>
                {t("ai.call_log_section_active")}
              </div>
              {activeItems.map((entry) => (
                <CallLogRow
                  key={entry.id}
                  entry={entry}
                  isActive
                  elapsedMs={now - new Date(entry.ts).getTime()}
                  expanded={expandedId === entry.id}
                  onToggle={() => setExpandedId((cur) => (cur === entry.id ? null : entry.id))}
                />
              ))}
            </>
          )}
          {recentItems.length > 0 && (
            <>
              <div style={{ fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--muted)", marginTop: activeItems.length > 0 ? 8 : 0 }}>
                {t("ai.call_log_section_recent")}
              </div>
              {recentItems.map((entry) => (
                <CallLogRow
                  key={entry.id}
                  entry={entry}
                  isActive={false}
                  expanded={expandedId === entry.id}
                  onToggle={() => setExpandedId((cur) => (cur === entry.id ? null : entry.id))}
                />
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}

/** K4 — 호출 로그 탭 상단 7일 요약 카드. by_provider/discard_reasons는 0건이면 그 줄을 숨긴다
 * (discard_reasons는 대부분 비어 있을 것 — [건너뛰기]가 기본 경로다). */
function CallLogSummaryCard({ summary }: { summary: CallsSummary }) {
  const providerEntries = Object.entries(summary.by_provider).filter(([, count]) => count > 0);
  const discardEntries = Object.entries(summary.discard_reasons).filter(([, count]) => count > 0);
  return (
    <div
      data-testid="ai-calllog-summary-card"
      className="card"
      style={{
        padding: "10px 14px",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--divider)",
        display: "grid",
        gap: 4,
        fontSize: "var(--text-sm)",
      }}
    >
      <div style={{ fontWeight: 600 }}>
        {t("ai.call_log_summary_line", {
          days: 7,
          total: summary.total,
          ok: summary.by_outcome.ok ?? 0,
          error: summary.by_outcome.error ?? 0,
          deadline: summary.by_outcome.deadline ?? 0,
          cancelled: summary.by_outcome.cancelled ?? 0,
        })}
        {summary.median_duration_ms != null &&
          ` · ${t("ai.call_log_summary_median", { seconds: Math.round(summary.median_duration_ms / 1000) })}`}
        {summary.p90_duration_ms != null &&
          ` · ${t("ai.call_log_summary_p90", { seconds: Math.round(summary.p90_duration_ms / 1000) })}`}
      </div>
      {providerEntries.length > 0 && (
        <div style={{ color: "var(--muted)" }}>
          {providerEntries.map(([prov, count]) => `${prov}: ${count}`).join(" · ")}
        </div>
      )}
      {discardEntries.length > 0 && (
        <div style={{ color: "var(--muted)" }} data-testid="ai-calllog-summary-discard-reasons">
          {discardEntries.map(([reason, count]) => `${t(`aiResult.discard_reason_${reason}`)}: ${count}`).join(" · ")}
        </div>
      )}
    </div>
  );
}

function CallLogRow({
  entry,
  isActive,
  elapsedMs,
  expanded,
  onToggle,
}: {
  entry: CallLogEntry;
  isActive: boolean;
  elapsedMs?: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const noteIndex = useNotesStore((s) => s.noteIndex);
  const noteLabel = noteLabelFor(entry.note_id, noteIndex);
  // caller/request_id는 컬럼에 항상 보이면 넘친다 — op 옆엔 title 툴팁으로만 걸고, 전체 값은
  // 펼침 영역(hasBody)에 prompt/response 앞부분과 나란히 둔다.
  const hasBody = !!(entry.prompt_head || entry.response_head || entry.caller || entry.request_id);
  const resultId = `ai-calllog-body-${entry.id}`;
  return (
    <div
      className="card"
      data-testid="ai-calllog-row"
      data-outcome={entry.outcome ?? "active"}
      style={{
        padding: "8px 12px",
        borderRadius: "var(--radius-sm)",
        border: "1px solid var(--divider)",
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "var(--space-3)", fontSize: "var(--text-sm)" }}>
        <span style={{ color: "var(--muted)", flexShrink: 0 }}>{new Date(entry.ts).toLocaleString()}</span>
        <span style={{ fontWeight: 600 }}>
          {entry.provider} · {entry.model}
        </span>
        <span style={{ color: "var(--muted)" }} title={entry.caller ? `${t("ai.call_log_caller_label")}: ${entry.caller}` : undefined}>
          {formatOp(entry.op)}
        </span>
        {noteLabel && (
          <span
            style={{
              fontSize: "var(--text-xs)",
              padding: "var(--space-2xs) 6px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--line)",
              color: "var(--muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              maxWidth: 160,
              whiteSpace: "nowrap",
            }}
            title={entry.note_id ? `${t("ai.call_log_note_label")}: ${entry.note_id}` : undefined}
          >
            {noteLabel}
          </span>
        )}
        <span style={{ color: "var(--muted)" }}>{t("ai.call_log_attempts_label")}: {entry.attempts}</span>
        {entry.fallback_used && (
          <span
            style={{
              fontSize: "var(--text-xs)",
              padding: "var(--space-2xs) 6px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--line)",
              color: "var(--muted)",
            }}
          >
            {t("ai.call_log_fallback_badge")}
          </span>
        )}
        <span style={{ marginLeft: "auto", flexShrink: 0, display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          {isActive ? (
            <span style={{ color: "var(--info)" }}>
              {outcomeLabel(undefined)} · {formatElapsedMs(elapsedMs ?? 0)}
            </span>
          ) : (
            <>
              <span style={{ color: "var(--muted)" }}>{formatDurationMs(entry.duration_ms)}</span>
              <span style={{ color: OUTCOME_COLOR[entry.outcome ?? ""] ?? "var(--muted)", fontWeight: 600 }}>
                {outcomeLabel(entry.outcome)}
              </span>
              {/* K4 — 버린 이유(있으면). aiResult.json의 discard_reason_* 를 재사용한다(K3와 같은 값). */}
              {entry.discard_reason && (
                <span style={{ color: "var(--muted)", fontSize: "var(--text-xs)" }} data-testid="ai-calllog-discard-reason">
                  {t(`aiResult.discard_reason_${entry.discard_reason}`)}
                </span>
              )}
            </>
          )}
        </span>
      </div>
      {entry.error && (
        <div
          title={entry.error}
          style={{
            fontSize: "var(--text-xs)",
            color: "var(--danger)",
            marginTop: 4,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {entry.error}
        </div>
      )}
      {hasBody && (
        <>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={expanded ? resultId : undefined}
            style={{
              marginTop: 4,
              fontSize: "var(--text-xs)",
              color: "var(--accent)",
              background: "transparent",
              border: "none",
              padding: 0,
              cursor: "pointer",
            }}
          >
            {expanded ? t("ai.call_log_hide_body") : t("ai.call_log_show_body")}
          </button>
          {expanded && (
            <div
              id={resultId}
              data-testid={resultId}
              style={{
                fontSize: "var(--text-xs)",
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                marginTop: 6,
                padding: 8,
                background: "var(--hover)",
                borderRadius: "var(--radius-xs)",
              }}
            >
              {entry.caller && (
                <div style={{ marginBottom: 6 }}>
                  <strong>{t("ai.call_log_caller_label")}:</strong> {entry.caller}
                </div>
              )}
              {entry.request_id && (
                <div style={{ marginBottom: 6 }} title={entry.request_id}>
                  <strong>{t("ai.call_log_request_id_label")}:</strong> {entry.request_id.slice(0, 8)}
                </div>
              )}
              {entry.prompt_head && (
                <div style={{ marginBottom: entry.response_head ? 6 : 0 }}>
                  <strong>{t("ai.call_log_prompt_head_label")}:</strong> {entry.prompt_head}
                </div>
              )}
              {entry.response_head && (
                <div>
                  <strong>{t("ai.call_log_response_head_label")}:</strong> {entry.response_head}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
