import { useEffect, useState, useRef, type ReactNode } from "react";
import { t } from "../../i18n/t";
import { useAiResultGateStore, type AiResultGateDecision, type AiResultGateSession, type AiResultGateKind } from "../../stores/aiResultGate";
import { useSettingsStore } from "../../stores/settings";
import { call } from "../../lib/invoke";
import { reportFallback } from "../../lib/diag";
import { classifyAiError, type AiErrorKind } from "../../lib/aiErrorKind";
import { ResultBody } from "./ResultBody";

/**
 * AI 결과 게이트의 몸통 (PLAN-2026-09-27 §3) — 한 틀(머리·몸·발 / 행동 줄).
 * 호스트가 둘(독립 창 AiResultModal, AI 모달 AskAiModal)이고 같은 규칙을 쓴다.
 * 결정은 전부 게이트 스토어의 decide() 를 탄다.
 */

// K2(2026-09-06) sentinel
const AI_RESULT_GATE_BRIEF_ID = "ai_result_gate";

const TEXT_OPERATION_DEADLINE_MS = 45_000;
const DEADLINE_WARNING_LEAD_MS = 5_000;

export function formatResultTitle(kind?: AiResultGateKind): string {
  if (kind === "sheet") return t("aiResult.head_result_with_format", { format: t("ai.format_sheet") });
  if (kind === "diagram") return t("aiResult.head_result_with_format", { format: t("ai.format_diagram") });
  return t("aiResult.head_result_with_format", { format: t("ai.format_text") });
}

async function openAiSettings(page: "ai" | "ai_permissions") {
  try {
    await call("settings_window_open", { page });
  } catch {
    // call() 이 이미 토스트를 띄웠다.
  }
}

function errorActionKind(kind: AiErrorKind): "settings" | "retry" | "none" {
  if (kind === "no_key" || kind === "unreachable" || kind === "model_missing") return "settings";
  if (kind === "input_too_long") return "none";
  return "retry";
}

function errorHintKey(kind: AiErrorKind): string {
  return kind === "unknown" ? "aiResult.unknown_error" : `aiResult.error_hint_${kind}`;
}

function errorTitleKey(kind: AiErrorKind): string {
  return `aiResult.error_title_${kind}`;
}

/**
 * 주 버튼 오클릭 가드(PLAN-2026-09-27 §3.2) — 주 버튼의 뜻이 바뀐 직후(보내기 → 중단 → 삽입, 패널이 새로 선 순간 포함) 이
 * 시간 동안 클릭을 무시한다. 키보드 Enter 는 요청문 상자가 받으므로 무관하다. 테스트 환경에서는 0 — 결과가 뜨자마자
 * 누르는 테스트가 수백 개라, 가드 자체는 그 테스트만 값을 켜서 본다.
 */
export const primaryGuard = { ms: import.meta.env.MODE === "test" ? 0 : 400 };

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function finalizeGateDecision(d: AiResultGateDecision): void {
  if (d === "insert" || d === "discard") {
    const { seenFeatureBriefs, setSeenFeatureBriefs } = useSettingsStore.getState();
    if (!seenFeatureBriefs.includes(AI_RESULT_GATE_BRIEF_ID)) void setSeenFeatureBriefs([...seenFeatureBriefs, AI_RESULT_GATE_BRIEF_ID]);
  }
  useAiResultGateStore.getState().decide(d);
}

/** 결과 미리보기 상자 — ResultBody 래퍼로 하위 호환성 유지. */
export function ResultPreview({ text, inline, kind, showRaw }: { text: string; inline?: boolean; kind?: AiResultGateKind; showRaw?: boolean }) {
  return <ResultBody text={text} inline={inline} kind={kind} showRaw={showRaw} />;
}

export function AiResultPanel({ session, inline, pager, refine }: { session: AiResultGateSession; inline?: boolean; pager?: ReactNode; refine?: ReactNode }) {
  const decide = useAiResultGateStore((s) => s.decide);
  const [now, setNow] = useState(() => Date.now());
  const [pullCopied, setPullCopied] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const seenBriefs = useSettingsStore((s) => s.seenFeatureBriefs);
  const setSeenFeatureBriefs = useSettingsStore((s) => s.setSeenFeatureBriefs);

  useEffect(() => {
    if (session.status !== "pending") return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [session.id, session.status]);

  // K2 — AI 모달 안에서는 첫 안내 배너를 띄우지 않는다(첫 실행 환영 카드가 대신함). 독립 결과 창에서만 띄운다.
  const showGateBrief = !inline && !seenBriefs.includes(AI_RESULT_GATE_BRIEF_ID);
  const markGateBriefSeen = () => {
    if (!seenBriefs.includes(AI_RESULT_GATE_BRIEF_ID)) void setSeenFeatureBriefs([...seenBriefs, AI_RESULT_GATE_BRIEF_ID]);
  };

  const abort = () => finalizeGateDecision("discard");

  const elapsedMs = now - session.startedAt;
  const showDeadlineWarning =
    session.status === "pending" && elapsedMs >= TEXT_OPERATION_DEADLINE_MS - DEADLINE_WARNING_LEAD_MS;
  const isEmptyResult = session.status === "result" && !(session.resultText ?? "").trim();
  const errorKind = session.status === "error" ? classifyAiError(session.errorText ?? "") : null;
  const errorAction = errorKind ? errorActionKind(errorKind) : "none";

  const copyPullCommand = () => {
    void navigator.clipboard
      .writeText(`ollama pull ${session.model}`)
      .then(() => {
        setPullCopied(true);
        setTimeout(() => setPullCopied(false), 1600);
      })
      .catch((e: unknown) => reportFallback("ai_result", "pull_command_copy_failed", String(e)));
  };

  // 주 버튼 400ms 오클릭 방지 가드 (§3.2 P3): 역할이 바뀐 직후 400ms 동안 클릭 무시
  const primaryRole =
    session.status === "pending"
      ? "abort"
      : session.status === "result"
        ? (isEmptyResult ? "retry" : "insert")
        : session.status === "error"
          ? (errorAction === "settings" ? "settings" : errorAction === "retry" ? "retry" : "close")
          : "none";

  // 패널이 나타난 순간도 "뜻이 바뀐" 순간이다 — AI 모달에서 [보내기]를 두 번 누르면 두 번째 클릭이 막 나타난 [중단]에
  // 떨어지고, 이전 버전 화면에서 살아 있는 결과로 바뀔 때도 패널이 새로 선다(2026-09-28 검토).
  const prevRoleRef = useRef(primaryRole);
  const roleChangedAtRef = useRef<number>(Date.now());

  useEffect(() => {
    if (prevRoleRef.current !== primaryRole) {
      prevRoleRef.current = primaryRole;
      roleChangedAtRef.current = Date.now();
    }
  }, [primaryRole]);

  const handlePrimaryClick = (action: () => void) => {
    if (Date.now() - roleChangedAtRef.current < primaryGuard.ms) return;
    action();
  };

  return (
    <div
      className={inline ? "ai-result-panel ai-result-panel--inline" : "ai-result-panel"}
      data-testid="ai-result-panel"
    >
      {showGateBrief && (
        <div role="note" data-testid="ai-result-first-brief" className="ai-result-panel__brief">
          <span className="ai-result-panel__brief-text">{t("aiResult.first_brief_text")}</span>
          <button type="button" onClick={() => void openAiSettings("ai_permissions")} className="btn" data-testid="ai-result-first-brief-settings">
            {t("aiResult.first_brief_open_settings")}
          </button>
          <button
            type="button"
            onClick={markGateBriefSeen}
            className="btn"
            data-testid="ai-result-first-brief-dismiss"
          >
            {t("aiResult.first_brief_dismiss")}
          </button>
        </div>
      )}
      {!inline && <div className="ai-result-panel__window-target">{session.target}</div>}

      {/* W2 §3.3: 결과 상자 하나 (머리 한 줄 + 몸 + 발 한 줄) */}
      <div className="ai-result-box" data-status={session.status} data-testid="ai-result-box">
        {/* 머리: 제목 (좌) · 넘기개/경과 (우) */}
        <div className="ai-result-box__head">
          <span
            className={`ai-result-box__title${session.status === "error" ? " ai-result-box__title--error ai-result-panel__error-title" : ""}`}
          >
            {session.status === "pending" && t("aiResult.head_generating")}
            {session.status === "result" && formatResultTitle(session.kind)}
            {session.status === "error" && errorKind && `⚠ ${t(errorTitleKey(errorKind))}`}
          </span>
          <span className="ai-result-box__head-extra">
            {session.status === "pending" && formatElapsed(elapsedMs)}
            {session.status === "result" && !isEmptyResult && (
              <button
                type="button"
                className="ai-result-box__raw-toggle"
                data-testid="ai-result-raw-toggle"
                title={showRaw ? t("aiResult.view_rendered") : t("aiResult.view_raw")}
                onClick={() => setShowRaw((v) => !v)}
              >
                {showRaw ? t("aiResult.view_rendered") : t("aiResult.view_raw")}
              </button>
            )}
            {session.status !== "pending" && inline && pager}
          </span>
        </div>

        {/* 몸: 스크롤 콘텐츠 */}
        <div className={`ai-result-box__body${session.status === "pending" ? " ai-result-box__body--pending" : ""}`}>
          {session.status === "pending" && (
            <>
              <div className="ai-result-box__skeleton" aria-hidden="true">
                <div className="ai-skeleton-line" />
                <div className="ai-skeleton-line" />
                <div className="ai-skeleton-line" />
              </div>
              {session.maxAttempts !== undefined && (
                <div className="ai-result-panel__pending-meta">
                  {t("aiResult.retry_progress", { attempt: session.attempt, max: session.maxAttempts })}
                </div>
              )}
              {showDeadlineWarning && (
                <div role="status" className="ai-result-panel__pending-warning">
                  {t("aiResult.deadline_warning")}
                </div>
              )}
            </>
          )}

          {session.status === "result" && (
            <>
              {isEmptyResult ? (
                <p role="alert" className="ai-result-panel__empty-msg" data-testid="ai-result-preview">
                  {t("aiResult.insert_disabled_empty")}
                </p>
              ) : (
                <ResultBody text={session.resultText ?? ""} kind={session.kind} showRaw={showRaw} inline={inline} />
              )}
            </>
          )}

          {session.status === "error" && errorKind && (
            <div className="ai-result-panel__error-box">
              <p role="alert" className="ai-result-panel__error-hint">
                {t(errorHintKey(errorKind))}
              </p>
              {errorKind === "input_too_long" && (
                <p className="ai-result-panel__error-subhint">
                  {t("aiResult.input_too_long_hint")}
                </p>
              )}
              <details>
                <summary className="ai-result-panel__error-summary">
                  {t("aiResult.raw_error_label")}
                </summary>
                <pre className="ai-result-panel__error-pre">
                  {session.errorText}
                </pre>
              </details>
            </div>
          )}
        </div>

        {/* 발: 캡션 (우하단 작은 캡션 --faint) */}
        {session.status === "pending" && (inline ? session.model : session.provider || session.model) && (
          <div className="ai-result-box__foot">
            <span className="ai-result-panel__meta-caption">
              {/* AI 모달은 헤더가 제공자를 보인다(§3.6) — 캡션은 모델만. */}
              {(inline ? [session.model] : [session.provider, session.model]).filter(Boolean).join(" · ")}
            </span>
          </div>
        )}
        {session.status === "result" && !isEmptyResult && (
          <div className="ai-result-box__foot">
            <span className="ai-result-panel__meta-caption">
              {session.model && inline
                ? `${session.model} · ${t("aiResult.result_meta_no_model", { seconds: Math.round((session.durationMs ?? 0) / 1000) })}`
                : session.model
                ? t("aiResult.result_meta", {
                    provider: session.provider ?? "",
                    model: session.model,
                    seconds: Math.round((session.durationMs ?? 0) / 1000),
                  })
                : t("aiResult.result_meta_no_model", {
                    seconds: Math.round((session.durationMs ?? 0) / 1000),
                  })}
            </span>
          </div>
        )}
      </div>

      {/* 다듬기 칩: 결과 상태에서만 상자 밖 바로 아래 한 줄 */}
      {inline && session.status === "result" && !isEmptyResult && refine}

      {/* 행동 줄: 상태표에 따른 버튼 배치 [보조2] [보조1] [주] */}
      <div className="ai-result-panel__actions">
        {inline && (
          <span className="ai-result-panel__target" data-testid="ai-result-target">
            {session.target}
          </span>
        )}

        {session.status === "pending" && (
          <button type="button" onClick={() => handlePrimaryClick(abort)} className="btn btn-primary" data-testid="ai-result-abort">
            {t("aiResult.abort_button")}
          </button>
        )}

        {session.status === "result" && !isEmptyResult && (
          <>
            <button type="button" onClick={() => finalizeGateDecision("discard")} className="btn" data-testid="ai-result-discard">
              {t("aiResult.discard_button")}
            </button>
            <button type="button" onClick={() => decide("retry")} className="btn" data-testid="ai-result-retry">
              {t("aiResult.retry_button")}
            </button>
            <button
              type="button"
              onClick={() => handlePrimaryClick(() => finalizeGateDecision("insert"))}
              className="btn btn-primary"
              data-testid="ai-result-insert"
            >
              {t("aiResult.insert_button")}
            </button>
          </>
        )}

        {session.status === "result" && isEmptyResult && (
          <>
            <button type="button" onClick={() => finalizeGateDecision("discard")} className="btn" data-testid="ai-result-discard">
              {t("aiResult.discard_button")}
            </button>
            <button
              type="button"
              onClick={() => handlePrimaryClick(() => decide("retry"))}
              className="btn btn-primary"
              data-testid="ai-result-retry"
            >
              {t("aiResult.retry_button")}
            </button>
          </>
        )}

        {session.status === "error" && (
          <>
            {errorAction === "settings" && (
              <>
                {errorKind === "model_missing" && session.provider === "ollama" && session.model && (
                  <button type="button" onClick={copyPullCommand} className="btn" data-testid="ai-result-copy-pull">
                    {pullCopied
                      ? t("aiResult.copy_pull_command_copied", { command: `ollama pull ${session.model}` })
                      : t("aiResult.copy_pull_command_button")}
                  </button>
                )}
                <button type="button" onClick={() => finalizeGateDecision("discard")} className="btn" data-testid="ai-result-close">
                  {inline ? t("aiResult.back_to_edit") : t("aiResult.close_button")}
                </button>
                <button
                  type="button"
                  onClick={() => handlePrimaryClick(() => void openAiSettings("ai"))}
                  className="btn btn-primary"
                  data-testid="ai-result-open-settings"
                >
                  {t("aiResult.open_ai_settings_button")}
                </button>
              </>
            )}
            {errorAction === "retry" && (
              <>
                <button type="button" onClick={() => finalizeGateDecision("discard")} className="btn" data-testid="ai-result-close">
                  {inline ? t("aiResult.back_to_edit") : t("aiResult.close_button")}
                </button>
                <button
                  type="button"
                  onClick={() => handlePrimaryClick(() => decide("retry"))}
                  className="btn btn-primary"
                  data-testid="ai-result-retry"
                >
                  {t("aiResult.retry_button")}
                </button>
              </>
            )}
            {errorAction === "none" && (
              <button
                type="button"
                onClick={() => handlePrimaryClick(() => finalizeGateDecision("discard"))}
                className="btn btn-primary"
                data-testid="ai-result-close"
              >
                {inline ? t("aiResult.back_to_edit") : t("aiResult.close_button")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
