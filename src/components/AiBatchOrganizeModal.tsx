import { useEffect, useRef, useState } from "react";
import { ModalShell } from "./ModalShell";
import { PendingIndicator } from "./common/PendingIndicator";
import { PromptDialog } from "./PromptDialog";
import { usePendingDelay } from "../lib/usePendingDelay";
import { call, callSilent, emitNotice } from "../lib/invoke";
import { uniqueId } from "../lib/ids";
import { t } from "../i18n/t";
import { useNotesStore, displayTitle } from "../stores/notes";
import { buildAiArgs, useAiStore, AI_GLOW_KEYS } from "../stores/ai";
import { classifyAiError, type AiErrorKind } from "../lib/aiErrorKind";
import {
  computeFieldDiffs,
  computeTagZones,
  computeFinalTagNames,
  tagNamesForApply,
  buildApplyPayload,
  defaultSelectedFieldKeys,
  FALLBACK_CURRENT,
} from "../lib/aiProposalDiff";
import type { AiApplyOrganizeOutput, AiCancelCallOutput, AiOrganizeNoteOutput } from "../lib/commands.gen";

// J2: a batch this big can run for a long time (each ai_organize_note call has its own 45s
// deadline, sequential — see the propose loop below) — warn once before starting instead of
// letting the user discover it mid-run. ponytail: fixed constant, no settings UI; bump here if
// the per-call deadline arithmetic below (× 45 / 60) ever changes.
export const BATCH_WARN_THRESHOLD = 50;

interface BatchRow {
  noteId: string;
  currentTitle: string;
  proposal: AiOrganizeNoteOutput;
}

interface FailureRow {
  noteId: string;
  title: string;
  kind: AiErrorKind;
}

// classifyAiError(src/lib/aiErrorKind.ts) expects the raw backend message string — call()/
// callSilent() reject with an AppError-shaped object ({code, message}), and test mocks reject
// with a plain Error (also has .message) — this reads either without caring which.
function errMessage(e: unknown): string {
  const msg = (e as { message?: unknown } | undefined)?.message;
  return typeof msg === "string" ? msg : "";
}

const FAIL_REASON_KEYS: Record<AiErrorKind, string> = {
  no_key: "settings.migration_ai_fail_reason_no_key",
  model_missing: "settings.migration_ai_fail_reason_model_missing",
  unreachable: "settings.migration_ai_fail_reason_unreachable",
  rate_limited: "settings.migration_ai_fail_reason_rate_limited",
  deadline: "settings.migration_ai_fail_reason_deadline",
  cancelled: "settings.migration_ai_fail_reason_cancelled",
  input_too_long: "settings.migration_ai_fail_reason_input_too_long",
  unknown: "settings.migration_ai_fail_reason_unknown",
};

/** 결과 표/적용 결과 아래 접힘 실패 목록 — 제안 단계와 적용 단계가 각자 자기 실패 배열로 부른다. */
function FailureList({ failures }: { failures: FailureRow[] }) {
  if (failures.length === 0) return null;
  return (
    <details style={{ marginTop: 10, fontSize: "var(--text-sm)", color: "var(--muted)" }}>
      <summary style={{ cursor: "pointer" }}>
        {t("settings.migration_ai_failures_toggle", { count: failures.length })}
      </summary>
      <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
        {failures.map((f) => (
          <li key={f.noteId}>
            {f.title} — {t(FAIL_REASON_KEYS[f.kind])}
          </li>
        ))}
      </ul>
    </details>
  );
}

export interface AiBatchOrganizeModalProps {
  /** note_ids from a just-completed migration_import_* call (§2.5). */
  noteIds: string[];
  onClose: () => void;
}

/**
 * §2.5 "임포트한 N개를 AI로 정리" — batch review-and-approve, following after
 * DataManagementSection's pre-flight PromptDialog confirm. Same propose→apply contract as the
 * single-note AiConfirmModal (ai_organize_note / ai_apply_organize), just N rows in a table with
 * checkboxes instead of one card — a note-per-dialog flow doesn't scale to N imported notes.
 */
export function AiBatchOrganizeModal({ noteIds, onClose }: AiBatchOrganizeModalProps) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<BatchRow[]>([]);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  // WF F1: live progress + a real stop for the propose loop. A note whose ai_organize_note call
  // fails is still skipped from the table (same partial-failure tolerance as before) but now also
  // recorded in proposalFailures so the user can see WHY instead of a note silently vanishing.
  const [processed, setProcessed] = useState(0);
  const [proposalFailures, setProposalFailures] = useState<FailureRow[]>([]);
  const [aborted, setAborted] = useState(false);
  // J1: did the abort's ai_cancel_call actually stop an in-flight ai_organize_note call
  // (response count > 0)? Starts false — the abort-pending message below defaults to the pre-J1
  // "runs out its own 45s deadline" wording until the response comes back and says otherwise.
  const [callsCancelled, setCallsCancelled] = useState(false);
  // Not state: the for-loop below reads this synchronously between awaits. A React state value
  // would only be current on the next render, which for a loop with no re-render in between would
  // never observe the click in time.
  const abortRef = useRef(false);
  // A1 (PLAN-2026-09-05 §1 A-4): default OFF — matches AiConfirmModal's per-field default
  // (덮어씀 = 기본 미선택). Row-level field checkboxes don't exist here (would need a column per
  // field × N rows); this single toggle is the batch-scale equivalent of "check every overwrite
  // box" versus "leave them all unchecked". ponytail: if a user needs per-field control in a
  // batch, that's a second implementation with real demand behind it — add a column then.
  const [overwriteAll, setOverwriteAll] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyProcessed, setApplyProcessed] = useState(0);
  const [applyFailures, setApplyFailures] = useState<FailureRow[]>([]);
  const showPending = usePendingDelay(loading || applying);
  const ranRef = useRef(false);
  // J1: one request_id for the whole batch's propose loop — every ai_organize_note call in this
  // run shares it, so [Stop] can cancel whichever one is currently in flight with a single
  // ai_cancel_call({ request_id }) instead of guessing which note is running.
  const [requestId] = useState(() => uniqueId());
  // J2: notes above BATCH_WARN_THRESHOLD get a one-time confirm before any call goes out. Below
  // the threshold this starts already "confirmed" so the propose loop's own effect (below) fires
  // immediately, same as before J2 existed.
  const [warnConfirmed, setWarnConfirmed] = useState(noteIds.length <= BATCH_WARN_THRESHOLD);

  // Sequential, not concurrent (see task rationale: local Ollama / rate-limited cloud APIs).
  useEffect(() => {
    if (!warnConfirmed) return;
    if (ranRef.current) return;
    ranRef.current = true;
    void (async () => {
      const noteIndex = useNotesStore.getState().noteIndex;
      const aiStore = useAiStore.getState();
      for (const noteId of noteIds) {
        // Checked BEFORE starting the next note's call, never after — abortRef stops the loop
        // from starting another note. The currently in-flight call (if any) is separately
        // cancelled by handleAbort's ai_cancel_call({ request_id }), not by this check.
        if (abortRef.current) break;
        const glowKey = AI_GLOW_KEYS.note(noteId);
        aiStore.addGlow(glowKey);
        try {
          const args = await buildAiArgs(noteId);
          const proposal = await call<AiOrganizeNoteOutput>("ai_organize_note", { ...args, request_id: requestId });
          // currentTitle 은 표 표시·실패 목록에만 쓰인다 — 센티널 "Untitled Note" 도 "제목 없음"으로.
          // 색인에 없는 노트는 "" 그대로 둬서 아래 `|| r.noteId` 폴백이 id 를 보이게 한다.
          const known = noteIndex.get(noteId);
          const currentTitle = known ? displayTitle(known.title) : "";
          setRows((prev) => [...prev, { noteId, currentTitle, proposal }]);
          setChecked((prev) => ({ ...prev, [noteId]: true }));
        } catch (e) {
          // call() already toasted; also record it so the review step can show which notes and why.
          const known = noteIndex.get(noteId);
          const title = known ? displayTitle(known.title) : noteId;
          setProposalFailures((prev) => [...prev, { noteId, title, kind: classifyAiError(errMessage(e)) }]);
        } finally {
          aiStore.removeGlow(glowKey);
          setProcessed((p) => p + 1);
        }
      }
      setLoading(false);
    })();
  }, [noteIds, warnConfirmed, requestId]);

  // J1: real cancellation, not just "stop starting new notes". Whatever ai_organize_note call is
  // currently in flight for this batch shares `requestId` (set above), so one ai_cancel_call
  // reaches it directly instead of the old visual-guess approach. callSilent(...).catch(...) is
  // the CLAUDE.md-approved shape here — no toast wanted for this best-effort cleanup call, same
  // pattern as stores/aiResultGate.ts's dispatchAiCancelCall.
  const handleAbort = () => {
    abortRef.current = true;
    setAborted(true);
    void callSilent<AiCancelCallOutput>("ai_cancel_call", { request_id: requestId })
      .catch(() => undefined)
      .then((res) => setCallsCancelled((res?.count ?? 0) > 0));
  };

  const toggle = (id: string) => setChecked((c) => ({ ...c, [id]: !c[id] }));

  // A1 (PLAN-2026-09-05 §1 A-4): same field-diff contract AiConfirmModal uses
  // ([[similar-features-same-path]]) — fill fields (current empty) apply by default, overwrite
  // fields (current has a value) only apply when overwriteAll is checked. Tags keep the existing
  // 3-zone default (kept always survives, added defaults on capped, removed never auto-applied)
  // regardless of overwriteAll — that's already the A-0 fix and this toggle is scoped to the
  // non-tag fields the bug report named (title/year/region/lat/lng/source_urls).
  function rowPlan(row: BatchRow) {
    const current = useNotesStore.getState().noteIndex.get(row.noteId) ?? FALLBACK_CURRENT;
    // noteIndex rows this modal sees can be partial (loaded via a lighter list query than the
    // full tree) — guard tag_names the same way the pre-A1 code did (?? []), since
    // computeTagZones/computeFinalTagNames call array methods on it directly.
    const currentTags = current.tag_names ?? [];
    const diffs = computeFieldDiffs(current, row.proposal);
    const selectedKeys = overwriteAll ? new Set(diffs.map((d) => d.key)) : defaultSelectedFieldKeys(diffs);
    const tagZones = computeTagZones(currentTags, row.proposal.tag_names);
    const finalTags = computeFinalTagNames(currentTags, new Set(tagZones.defaultSelectedAdded), new Set());
    const tagNames = tagNamesForApply(currentTags, finalTags);
    const payload = buildApplyPayload(diffs, selectedKeys, tagNames);
    const fillCount = diffs.filter((d) => d.state === "fill").length;
    const overwriteCount = diffs.filter((d) => d.state === "overwrite").length;
    return { payload, fillCount, overwriteCount };
  }

  const applyChecked = async () => {
    setApplying(true);
    setApplyProcessed(0);
    setApplyFailures([]);
    let applied = 0;
    const localFailures: FailureRow[] = [];
    for (const row of rows) {
      if (!checked[row.noteId]) continue;
      const { payload } = rowPlan(row);
      if (Object.keys(payload).length === 0) {
        setApplyProcessed((p) => p + 1);
        continue; // nothing selected for this note — skip the call entirely
      }
      try {
        await call<AiApplyOrganizeOutput>("ai_apply_organize", { id: row.noteId, ...payload });
        applied++;
      } catch (e) {
        // call() already toasted; also record it below the table (AI.md §5-4: partial failure
        // keeps the modal open instead of closing over an incomplete apply).
        const failure = { noteId: row.noteId, title: row.currentTitle || row.noteId, kind: classifyAiError(errMessage(e)) };
        localFailures.push(failure);
        setApplyFailures((prev) => [...prev, failure]);
      } finally {
        setApplyProcessed((p) => p + 1);
      }
    }
    await useNotesStore.getState().loadTree();
    setApplying(false);
    if (localFailures.length > 0) {
      emitNotice(t("settings.migration_ai_apply_result", { ok: applied, failed: localFailures.length }));
      return; // stay open so the user can see which notes failed and why
    }
    emitNotice(t("settings.migration_ai_apply_done", { count: applied }));
    onClose();
  };

  const checkedCount = rows.filter((r) => checked[r.noteId]).length;

  // J2: gate the whole modal behind one confirm when the batch is big enough that "how long will
  // this take" is a real question. Declared after every hook above (rules-of-hooks — see
  // CLAUDE.md 함정 1) so this early return never changes hook order across renders.
  if (!warnConfirmed) {
    return (
      <PromptDialog
        title={t("aiBatch.warn_title")}
        description={t("aiBatch.warn_desc", {
          count: noteIds.length,
          minutes: Math.ceil((noteIds.length * 45) / 60),
        })}
        mode="confirm"
        confirmLabel={t("aiBatch.warn_confirm_btn")}
        onCancel={onClose}
        onSubmit={() => setWarnConfirmed(true)}
      />
    );
  }

  return (
    <ModalShell title={t("settings.migration_ai_modal_title")} onClose={onClose} width={680}>
      <div style={{ position: "relative" }}>
        <PendingIndicator active={showPending} />
        {loading ? (
          <>
            <p style={{ fontSize: "var(--text-md)", color: "var(--muted)", margin: 0 }}>{t("settings.migration_ai_progress")}</p>
            <p style={{ fontSize: "var(--text-sm)", color: "var(--muted)", marginTop: 6 }}>
              {t("settings.migration_ai_progress_counter", {
                done: processed,
                total: noteIds.length,
                failed: proposalFailures.length,
              })}
            </p>
            <div style={{ marginTop: 10 }}>
              {aborted ? (
                <span style={{ fontSize: "var(--text-sm)", color: "var(--muted)" }}>
                  {callsCancelled ? t("aiBatch.abort_cancelled_pending") : t("settings.migration_ai_abort_pending")}
                </span>
              ) : (
                <button type="button" onClick={handleAbort} className="btn">
                  {t("settings.migration_ai_abort_btn")}
                </button>
              )}
            </div>
            <FailureList failures={proposalFailures} />
          </>
        ) : rows.length === 0 ? (
          <>
            <p style={{ fontSize: "var(--text-md)", color: "var(--muted)", margin: 0 }}>{t("settings.migration_ai_empty")}</p>
            <FailureList failures={proposalFailures} />
          </>
        ) : (
          <>
            <label style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10, cursor: "pointer", fontSize: "var(--text-md)" }}>
              <input
                type="checkbox"
                checked={overwriteAll}
                onChange={(e) => setOverwriteAll(e.target.checked)}
                style={{ accentColor: "var(--accent)" }}
              />
              {t("settings.migration_ai_overwrite_toggle")}
            </label>
            <div style={{ maxHeight: 360, overflowY: "auto", marginBottom: 16 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--text-md)" }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--muted)" }}>
                    <th style={{ padding: "4px 6px" }} />
                    <th style={{ padding: "4px 6px" }}>{t("settings.migration_ai_col_current")}</th>
                    <th style={{ padding: "4px 6px" }}>{t("ai.field_title")}</th>
                    <th style={{ padding: "4px 6px" }}>{t("ai.field_year")}</th>
                    <th style={{ padding: "4px 6px" }}>{t("ai.field_tags")}</th>
                    <th style={{ padding: "4px 6px" }}>{t("ai.field_region")}</th>
                    <th style={{ padding: "4px 6px" }}>{t("settings.migration_ai_col_summary")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const { fillCount, overwriteCount } = rowPlan(r);
                    const summaryKey = overwriteAll
                      ? "settings.migration_ai_row_summary_include"
                      : "settings.migration_ai_row_summary_skip";
                    return (
                      <tr key={r.noteId} style={{ borderTop: "1px solid var(--divider)" }}>
                        <td style={{ padding: "4px 6px" }}>
                          <input
                            type="checkbox"
                            aria-label={r.currentTitle || r.noteId}
                            checked={!!checked[r.noteId]}
                            onChange={() => toggle(r.noteId)}
                            style={{ accentColor: "var(--accent)" }}
                          />
                        </td>
                        <td style={{ padding: "4px 6px", color: "var(--muted)", wordBreak: "break-word" }}>
                          {r.currentTitle}
                        </td>
                        <td style={{ padding: "4px 6px", wordBreak: "break-word" }}>{r.proposal.title ?? ""}</td>
                        <td style={{ padding: "4px 6px" }}>{r.proposal.year ?? ""}</td>
                        <td style={{ padding: "4px 6px", wordBreak: "break-word" }}>
                          {(r.proposal.tag_names ?? []).map((tg) => `#${tg}`).join(", ")}
                        </td>
                        <td style={{ padding: "4px 6px", wordBreak: "break-word" }}>{r.proposal.region ?? ""}</td>
                        <td style={{ padding: "4px 6px", color: "var(--muted)", whiteSpace: "nowrap" }}>
                          {t(summaryKey, { fill: fillCount, overwrite: overwriteCount })}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <FailureList failures={proposalFailures} />
            {applying && (
              <p style={{ fontSize: "var(--text-sm)", color: "var(--muted)", marginTop: 6 }}>
                {t("settings.migration_ai_apply_progress_counter", {
                  done: applyProcessed,
                  total: checkedCount,
                  failed: applyFailures.length,
                })}
              </p>
            )}
            <FailureList failures={applyFailures} />
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 10 }}>
              <button type="button" onClick={onClose} className="btn" disabled={applying}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                onClick={() => void applyChecked()}
                className="btn btn-primary"
                disabled={applying || checkedCount === 0}
              >
                {t("settings.migration_ai_apply_btn", { count: checkedCount })}
              </button>
            </div>
          </>
        )}
      </div>
    </ModalShell>
  );
}
