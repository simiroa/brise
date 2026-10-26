import { useEffect, useState } from "react";
import { MobileModal } from "./MobileModal";
import { t } from "../i18n/t";
import { useAiResultGateStore, registerAiResultGateHost } from "../stores/aiResultGate";
import { classifyAiError } from "../lib/aiErrorKind";

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Mobile counterpart to `AiResultModal.tsx` (desktop) — same store (`stores/aiResultGate.ts`,
 * read-only from here: this file only calls its public API), same 3 states (pending/result/error),
 * built on the mobile `MobileModal` primitive instead of `ModalShell`. Mounted once in
 * `MobileApp.tsx` so its `registerAiResultGateHost()` effect makes `gateHostMounted` true for the
 * whole mobile tree — see aiResultGate.ts's header comment (PLAN-2026-09-05 §5 scoped mobile out at
 * the time; this fills that gap so `runWithAiResultGate` gates on mobile instead of silently
 * bypassing straight to insert).
 *
 * ponytail: deliberately thinner than the desktop modal — no provider/model badge, no
 * retry-attempt counter, no deadline-approaching warning, and the error screen always offers
 * [Retry] (no error-kind routing to Settings for no_key/unreachable/model_missing). All of that is
 * real desktop behavior this drops for a first mobile pass; upgrade path is the same branch desktop
 * already has in `AiResultModal.tsx` if a mobile user reports confusion from retrying a
 * doomed-to-fail call. K2(2026-09-06)의 첫 노출 배너도 여기엔 안 넣는다 — 좁은 시트에서 배너 한 줄이
 * 결과 프리뷰를 밀어내는 비용이 이 기능의 "매번 안 묻고 싶으면 설정에서 끄라"는 안내 하나보다
 * 크다고 판단(PLAN상 모바일도 §5 범위 밖). 업그레이드 경로: 데스크톱과 같은 sentinel
 * (`seenFeatureBriefs`의 "ai_result_gate")을 그대로 읽어 여기도 배너를 넣을 수 있다.
 */
export function MobileAiResultSheet() {
  const session = useAiResultGateStore((s) => s.session);
  const decide = useAiResultGateStore((s) => s.decide);
  const [now, setNow] = useState(() => Date.now());

  // This component's mere presence in the tree is what un-bypasses the gate (see header comment) —
  // must run regardless of `session` being null, so it sits above the early return below.
  useEffect(() => registerAiResultGateHost(), []);

  useEffect(() => {
    if (!session || session.status !== "pending") return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restart only on session id/status change
  }, [session?.id, session?.status]);

  if (!session) return null;

  const abort = () => decide("discard");
  const elapsedMs = now - session.startedAt;
  const isEmptyResult = session.status === "result" && !(session.resultText ?? "").trim();
  const errorKind = session.status === "error" ? classifyAiError(session.errorText ?? "") : null;

  const modalTitle = session.noteTitle
    ? t("aiResult.modal_title", { action: session.title, note: session.noteTitle })
    : t("aiResult.modal_title_untitled", { action: session.title });

  return (
    <MobileModal
      title={modalTitle}
      onClose={abort}
      footer={
        session.status === "pending" ? (
          <button type="button" className="mobile-text-btn" onClick={abort} data-testid="ai-result-abort">
            {t("aiResult.abort_button")}
          </button>
        ) : session.status === "result" ? (
          <>
            <button
              type="button"
              className="mobile-text-btn"
              onClick={() => decide("discard")}
              data-testid="ai-result-discard"
            >
              {t("aiResult.discard_button")}
            </button>
            <button
              type="button"
              className="mobile-text-btn"
              onClick={() => decide("retry")}
              data-testid="ai-result-retry"
            >
              {t("aiResult.retry_button")}
            </button>
            <button
              type="button"
              className="mobile-preset-ai-submit"
              disabled={isEmptyResult}
              onClick={() => decide("insert")}
              data-testid="ai-result-insert"
              title={isEmptyResult ? t("aiResult.insert_disabled_empty") : undefined}
            >
              {t("aiResult.insert_button")}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="mobile-text-btn"
              onClick={() => decide("discard")}
              data-testid="ai-result-close"
            >
              {t("aiResult.close_button")}
            </button>
            <button
              type="button"
              className="mobile-preset-ai-submit"
              onClick={() => decide("retry")}
              data-testid="ai-result-retry"
            >
              {t("aiResult.retry_button")}
            </button>
          </>
        )
      }
    >
      <div className="mobile-ai-proposal">
        <div className="mobile-ai-disabled-hint">{session.target}</div>

        {session.status === "pending" && (
          <div className="mobile-ai-disabled-hint" role="status">
            {t("aiResult.status_generating", { elapsed: formatElapsed(elapsedMs) })}
          </div>
        )}

        {session.status === "result" && (
          <>
            <div className="mobile-ai-proposal-text" data-testid="ai-result-preview">
              {session.resultText || t("aiResult.preview_empty")}
            </div>
            {isEmptyResult && (
              <p role="alert" style={{ margin: 0, color: "var(--danger)", fontSize: "var(--text-sm)" }}>
                {t("aiResult.insert_disabled_empty")}
              </p>
            )}
          </>
        )}

        {session.status === "error" && errorKind && (
          <p role="alert" style={{ margin: 0, color: "var(--danger)", fontSize: "var(--text-md)" }}>
            {errorKind === "unknown" ? t("aiResult.unknown_error") : t(`aiResult.error_hint_${errorKind}`)}
          </p>
        )}
      </div>
    </MobileModal>
  );
}
