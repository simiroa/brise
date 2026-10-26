import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { t } from "../i18n/t";
import { reportFallback } from "../lib/diag";
import "../styles/mobileVoice.css";
import { MobileModal } from "./MobileModal";
import { useBackClosable } from "./useBackClosable";
import { useRecoverableRecordings } from "./useRecoverableRecordings";
import { useVoiceRecorder } from "./useVoiceRecorder";
import type { ChunkStore } from "./voiceChunkStore";
import { TIMESLICE_MS } from "./voiceFormat";
import { setRecorderSheetOpen, type FinishedHandler, type VoicePositionAnswer, type VoicePositionPhase } from "./voiceHandOff";
import type { VoiceErrorCode } from "./voiceRecorderMachine";
import type { VoiceErrCode } from "./mobileInputFlows";

/** Where a transcript ended up: the body, a new section (diagram/sheet/read-only body), or nowhere yet
 *  ("kept" — saved on the attachment, the note's voice row offers to insert it). */
export type TranscriptPlacement = "body" | "section" | "kept";

/**
 * The result stage of the recording 완료 produced — computed by the note screen (useMobileVoiceTranscript::stageOf
 * over useMobileAttachUpload::voiceUploadOf). The sheet only reads it and calls the actions; every bit of work lives
 * in those hooks, so closing the sheet cancels nothing.
 */
export type VoiceStage =
  | { kind: "saving" }
  | { kind: "upload_failed"; retry(): void }
  | { kind: "offer"; transcribe(): void }
  | { kind: "transcribing" }
  | { kind: "transcribe_failed"; code: VoiceErrCode; retry?: () => void }
  | { kind: "done"; text: string; placed: TranscriptPlacement };

export interface MobileVoiceRecorderProps {
  open: boolean;
  onClose(): void;
  /** Fires once per saved file (an auto-split or an interruption yields several). Resolve true only once
   *  the file is uploaded: the crash copy is then dropped; false/void keeps it for the next-open recovery. */
  onFinished: FinishedHandler;
  /** Called at the start of each segment, and once more after the stop when it answered "later" (MobileNote maps
   *  the device location mode + permission memory — see voicePositionPolicy: no permission dialog over a live recording). */
  getPosition?: (phase: VoicePositionPhase) => Promise<VoicePositionAnswer>;
  /** The result stage for the file 완료 handed to onFinished. Absent, or null for that file (transcription off, the
   *  note changed), keeps the old beat: "saved" for a moment, then the sheet closes itself. */
  stageOf?: (file: File) => VoiceStage | null;
  /** Test seam; defaults to IndexedDB. */
  store?: ChunkStore;
}

const INTRO_KEY = "brise_voice_intro_seen";
const DISCARD_CONFIRM_MS = 3000;
/** How long the "saved" beat stays on the sheet before it closes — long enough to read, short enough not to wait on. */
const SAVED_HOLD_MS = 450;

function introSeen(): boolean {
  try { return localStorage.getItem(INTRO_KEY) === "1"; } catch { return false; } // silent-ok: storage blocked => show the intro again
}
function markIntroSeen() {
  try { localStorage.setItem(INTRO_KEY, "1"); } catch { /* silent-ok: per-viewer convenience only */ }
}

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function transcribeErrorText(code: VoiceErrCode): string {
  switch (code) {
    case "ai_required": return t("mobileInput.voice_err_ai");
    case "too_long": return t("mobileInput.voice_err_too_long");
    case "key": return t("mobileVoice.tr_err_key");
    case "format": return t("mobileVoice.tr_err_format");
    case "in_progress": return t("mobileVoice.tr_in_progress");
    case "deadline": return t("mobileVoice.tr_err_deadline");
    default: return t("mobileInput.voice_err_failed");
  }
}

function placedText(p: TranscriptPlacement): string {
  return p === "body" ? t("mobileVoice.placed_body") : p === "section" ? t("mobileVoice.placed_section") : t("mobileVoice.placed_kept");
}

function errorText(code: VoiceErrorCode): string {
  switch (code) {
    case "denied": return t("mobileVoice.err_denied");
    case "no_mic": return t("mobileVoice.err_no_mic");
    case "busy": return t("mobileVoice.err_busy");
    case "empty": return t("mobileVoice.err_empty");
    default: return t("mobileVoice.err_unknown");
  }
}

/** One back-layer above the modal's own, live only while recording. Hardware back is consumed (the
 *  layer pops) and the parent asks what to do; remounting via `key` pushes a fresh entry so the NEXT
 *  back press is guarded too (useBackClosable header: a layer that refuses to close loses its entry). */
function BackGuard({ onBack }: { onBack: () => void }) {
  useBackClosable(true, onBack);
  return null;
}

/**
 * What the ONE sheet frame is showing. Every phase fills the same slots (state line · timer · meter · message ·
 * action row · recovery list), so a phase change morphs the content in place instead of swapping layouts
 * (owner 2026-10-10: "한 시트 안의 상태 전이 — 높이·자리 유지").
 *   starting  — sheet just opened, mic being granted (machine still idle)
 *   recording / paused — live; confirm = the same live recording asking "what now?" (cancel ≥3s, back, Esc)
 *   interrupted — backgrounded: the segment is already saved, offer to continue in a new one
 *   saving — finish pressed: the recorder is closing the file
 *   uploading — (result stage) the file is on its way to the note; [닫기] is safe, the upload goes on
 *   saved — nothing more to show (transcription off): holds briefly, then the sheet closes itself
 *   failed — mic refused / missing / busy, or nothing was recorded; retry from here
 * Result phases (VoiceStage, only when transcription is on — owner 2026-10-10 "결과 저장도 … 경험이 유지"):
 *   offer — uploaded, transcription mode "ask": [받아 적기] here instead of hunting for the note's voice row
 *   transcribing — the transcript is being written; closing is fine, it goes on in the background
 *   done — a capped, scrollable preview of the transcript and where it went
 *   result_failed — upload or transcription failed; the recording is safe (pending row / crash copy), retry here
 */
type Phase =
  | "starting" | "ready" | "recording" | "paused" | "confirm" | "interrupted" | "saving" | "saved" | "failed"
  | "uploading" | "offer" | "transcribing" | "done" | "result_failed";

/**
 * Bottom recorder sheet (plan §5.2, PLAN-2026-10-10 W-B). Opening the sheet starts recording right away —
 * the speed-dial tap that opened it is the user's intent; there is no separate "tap to record" step. Only the
 * one-time intro (first use) holds the mic until "continue".
 * Hooks live in the inner component so closing the sheet resets all recorder state.
 */
export function MobileVoiceRecorder(props: MobileVoiceRecorderProps) {
  if (!props.open) return null;
  return <Sheet {...props} />;
}

function Sheet({ onClose, onFinished, getPosition, stageOf, store }: MobileVoiceRecorderProps) {
  // The file 완료 hands off is the one the result stage follows. finish() emits it synchronously right before it
  // dispatches "done" (and busyRef holds rollovers off meanwhile), so the flag below catches exactly that file and
  // the state update lands in the same batch as "done" — no frame of the saved beat in between.
  // ponytail: an auto-split or an interruption before 완료 hands earlier files too; those are uploaded/transcribed
  // as before but the sheet only follows the last one. Following all would need a per-session list here.
  const [finalFile, setFinalFile] = useState<File | null>(null);
  const finishingRef = useRef(false);
  const tracked: FinishedHandler = (r) => {
    if (finishingRef.current) setFinalFile(r.file);
    return onFinished(r);
  };
  const rec = useVoiceRecorder({ onFinished: tracked, getPosition, store });
  const [intro, setIntro] = useState(() => !introSeen());
  const [confirm, setConfirm] = useState(false);
  const [guardKey, setGuardKey] = useState(0);

  const live = rec.status === "recording" || rec.status === "paused";
  // Snapshot the crash copies ONCE per open, before the auto-start below writes this recording's own session to
  // the same store. Declared (so its effect runs) before the auto-start effect: the store read is issued before
  // getUserMedia can even resolve, so the new live session is never listed (nor swept as a zero-chunk session).
  // It must not depend on the recorder status — the status leaves idle at once, and a re-run would cancel the read.
  const recovery = useRecoverableRecordings({ enabled: !intro, onRecovered: onFinished, store });

  // Auto-start: once per open, as soon as the intro (first use only) is out of the way. A refused/missing mic
  // lands in the failed phase with a retry; a close while the permission dialog is up is handled by the hook.
  // Waits for the recovery listing (X-10): if unsaved recordings exist, do NOT start a new one — the list comes first
  // (starting meant recovering required an unwanted recording first). [새로 녹음하기] starts it by hand.
  const startedRef = useRef(false);
  const [holdForRecovery, setHoldForRecovery] = useState(false);
  const { start } = rec;
  const recoveryLoaded = recovery.loaded;
  const hasRecoverable = recovery.sessions.length > 0;
  useEffect(() => {
    if (intro || !recoveryLoaded || startedRef.current) return;
    startedRef.current = true;
    if (hasRecoverable) setHoldForRecovery(true);
    else void start();
  }, [intro, recoveryLoaded, hasRecoverable, start]);

  // While mounted, a failed upload of a recording is shown here — the upload line skips its toast (X-8).
  useEffect(() => {
    setRecorderSheetOpen(true);
    return () => setRecorderSheetOpen(false);
  }, []);

  const stage: VoiceStage | null = rec.status === "done" && finalFile && stageOf ? stageOf(finalFile) : null;
  const savedBeat = rec.status === "done" && !stage;

  // The "saved" beat closes the sheet by itself (a result stage waits for [닫기] instead).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!savedBeat) return;
    const id = setTimeout(() => onCloseRef.current(), SAVED_HOLD_MS);
    return () => clearTimeout(id);
  }, [savedBeat]);

  // Back / backdrop / Esc: never abandon a live recording silently.
  // 인터럽트(이미 저장됨)는 확인할 것이 없다 — 그냥 닫는다. 직접 일시정지한 녹음은 닫기 전에 finish() 로 "지금까지"를
  // 노트에 올린다(백그라운드 인터럽트와 같은 규칙, M-12) — 그냥 닫으면 언마운트가 소리 없이 멈춰 IndexedDB 에만 남았다.
  const requestClose = useCallback(() => {
    if (rec.interrupted) onClose();
    else if (rec.status === "paused") {
      finishingRef.current = true;
      void rec.finish().catch((e) => { reportFallback("voice", "close_finish_failed", e instanceof Error ? e.message : "finish failed"); }).finally(() => { finishingRef.current = false; onCloseRef.current(); });
    }
    else if (live || rec.status === "finishing") setConfirm(true);
    else onClose();
  }, [live, rec.interrupted, rec.status, rec.finish, onClose]);

  const finish = async () => {
    setConfirm(false);
    finishingRef.current = true;
    try {
      await rec.finish(); // true => status "done" => the result stage, or the saved beat that closes the sheet
    } finally {
      finishingRef.current = false;
    }
  };
  const discard = () => {
    setConfirm(false);
    rec.cancel();
    onClose();
  };
  const onCancelTap = () => {
    if (rec.elapsedMs >= DISCARD_CONFIRM_MS) setConfirm(true);
    else discard();
  };

  if (intro) {
    return (
      <MobileModal title={t("mobileVoice.title")} onClose={onClose} placement="bottom">
        <div className="voice-rec" data-phase="intro">
          <p className="voice-rec-msg">{t("mobileVoice.intro_body")}</p>
          <div className="voice-rec-actions">
            <button type="button" className="menu-row mobile-ai-action" onClick={() => { markIntroSeen(); setIntro(false); }}>
              {t("mobileVoice.intro_continue")}
            </button>
          </div>
        </div>
      </MobileModal>
    );
  }

  const phase: Phase =
    rec.status === "failed" ? "failed"
    : stage?.kind === "saving" ? "uploading"
    : stage?.kind === "offer" ? "offer"
    : stage?.kind === "transcribing" ? "transcribing"
    : stage?.kind === "done" ? "done"
    : stage ? "result_failed"
    : rec.status === "done" ? "saved"
    : rec.status === "finishing" ? "saving"
    : live && rec.interrupted ? "interrupted"
    : live && confirm ? "confirm"
    : rec.status === "recording" ? "recording"
    : rec.status === "paused" ? "paused"
    : holdForRecovery && rec.status === "idle" ? "ready"
    : "starting";

  const paused = rec.status === "paused";
  const min = Math.max(1, Math.round(rec.remainingMs / 60000));

  const stateLabel =
    phase === "starting" ? t("mobileVoice.starting")
    : phase === "ready" ? t("mobileVoice.ready")
    : phase === "uploading" ? t("mobileVoice.uploading")
    : phase === "recording" || (phase === "confirm" && !paused) ? t("mobileVoice.recording")
    : phase === "paused" || phase === "confirm" || phase === "interrupted" ? t("mobileVoice.paused")
    : phase === "saving" ? t("mobileVoice.finishing")
    : phase === "saved" || phase === "offer" ? t("mobileVoice.saved")
    : phase === "transcribing" ? t("mobileVoice.transcribing")
    : stage?.kind === "done" ? placedText(stage.placed)
    : "";

  let msg: ReactNode = null;
  if (stage?.kind === "upload_failed") {
    msg = <span role="alert" className="voice-rec-error">{t("mobileVoice.upload_failed")}</span>;
  } else if (stage?.kind === "transcribe_failed") {
    msg = <span role="alert" className="voice-rec-error">{transcribeErrorText(stage.code)}</span>;
  } else if (phase === "uploading") {
    msg = t("mobileVoice.uploading_hint");
  } else if (phase === "ready") {
    msg = t("mobileVoice.ready_hint");
  } else if (phase === "offer") {
    msg = t("mobileVoice.offer_body");
  } else if (phase === "transcribing") {
    msg = t("mobileVoice.transcribing_hint");
  } else if (phase === "failed") {
    msg = <span role="alert" className="voice-rec-error">{rec.error ? errorText(rec.error) : t("mobileVoice.err_unknown")}</span>;
  } else if (phase === "confirm") {
    msg = t("mobileVoice.confirm_body");
  } else if (phase === "interrupted") {
    msg = t("mobileVoice.interrupted");
  } else if (phase === "recording" && rec.silent) {
    msg = <span role="status">{t("mobileVoice.silent_hint")}</span>;
  } else if (phase === "recording" || phase === "paused") {
    msg = rec.lowTime
      ? <span className="voice-rec-error">{t("mobileVoice.low_time", { min })}</span>
      : t("mobileVoice.remaining", { min });
  }

  const btn = (label: string, onClick: () => void, disabled = false) => (
    <button type="button" className="menu-row mobile-ai-action" onClick={onClick} disabled={disabled}>{label}</button>
  );
  // The row is keyed by GROUP, not phase: recording <-> paused (and on into saving/saved) keeps the same buttons
  // mounted — only labels/disabled change, so focus stays put; a different group fades its row in.
  let actionsKey: string;
  let actions: ReactNode;
  switch (phase) {
    case "starting":
      actionsKey = "starting";
      actions = btn(t("mobileVoice.cancel"), onClose);
      break;
    case "ready":
      actionsKey = "ready";
      actions = <>
        {btn(t("mobileVoice.new_recording"), () => { setHoldForRecovery(false); void rec.start(); })}
        {btn(t("mobileVoice.close"), onClose)}
      </>;
      break;
    case "confirm":
      actionsKey = "confirm";
      actions = <>
        {btn(t("mobileVoice.confirm_continue"), () => setConfirm(false))}
        {btn(t("mobileVoice.confirm_finish"), () => void finish())}
        {btn(t("mobileVoice.confirm_discard"), discard)}
      </>;
      break;
    case "interrupted":
      actionsKey = "interrupted";
      actions = <>
        {btn(t("mobileVoice.continue_recording"), () => void rec.resume())}
        {btn(t("mobileVoice.close"), onClose)}
      </>;
      break;
    case "offer":
      actionsKey = "offer";
      actions = <>
        {btn(t("mobileVoice.transcribe"), () => { if (stage?.kind === "offer") stage.transcribe(); })}
        {btn(t("mobileVoice.close"), onClose)}
      </>;
      break;
    case "uploading":
    case "transcribing":
    case "done":
      // Same row from transcribing into done: [닫기] stays mounted (focus stays put) — closing never cancels.
      actionsKey = "result";
      actions = btn(t("mobileVoice.close"), onClose);
      break;
    case "result_failed": {
      const retry = stage?.kind === "upload_failed" || stage?.kind === "transcribe_failed" ? stage.retry : undefined;
      actionsKey = "result_failed";
      actions = <>
        {retry && btn(t("mobileVoice.retry"), retry)}
        {btn(t("mobileVoice.close"), onClose)}
      </>;
      break;
    }
    case "failed":
      actionsKey = "failed";
      actions = <>
        {btn(t("mobileVoice.retry"), () => { setConfirm(false); void rec.start(); })}
        {btn(t("mobileVoice.close"), onClose)}
      </>;
      break;
    default: {
      // recording · paused · saving · saved — the same three buttons; while saving/saved they go inert and fade.
      const done = phase === "saving" || phase === "saved";
      actionsKey = "live";
      actions = <>
        {btn(paused ? t("mobileVoice.resume") : t("mobileVoice.pause"), () => (paused ? void rec.resume() : rec.pause()), done)}
        {btn(t("mobileVoice.finish"), () => void finish(), done)}
        {btn(t("mobileVoice.cancel"), onCancelTap, done)}
      </>;
    }
  }

  const levelPct = live && !paused ? Math.round(rec.level * 100) : 0;

  return (
    <>
      <MobileModal title={t("mobileVoice.title")} onClose={requestClose} placement="bottom">
        <div
          className="voice-rec"
          data-phase={phase}
          role={phase === "confirm" ? "alertdialog" : undefined}
          aria-label={phase === "confirm" ? t("mobileVoice.confirm_title") : undefined}
        >
          <span className="voice-rec-state">
            <span className="voice-rec-led" data-phase={phase} data-paused={paused} />
            <span key={stateLabel} className="voice-rec-swap">{stateLabel}</span>
          </span>
          {/* Timer · meter · message stay mounted in every phase; at done the preview covers exactly this block, so the
              sheet never changes height (the preview scrolls inside it instead of growing). */}
          <div className="voice-rec-body">
            <div className="voice-rec-body-live" aria-hidden={stage?.kind === "done" ? true : undefined}>
              <div className="voice-rec-time" data-testid="voice-time">{fmt(rec.elapsedMs)}</div>
              <div className="voice-rec-meter" aria-hidden="true">
                <div className="voice-rec-meter-bar" data-testid="voice-level" style={{ width: `${levelPct}%` }} />
              </div>
              <p className="voice-rec-msg">
                {msg != null && <span key={phase + (rec.silent ? "s" : "") + (rec.lowTime ? "l" : "")} className="voice-rec-swap">{msg}</span>}
              </p>
            </div>
            {stage?.kind === "done" && (
              <div className="voice-rec-preview" data-testid="voice-preview" tabIndex={0} aria-label={t("mobileVoice.preview_label")}>
                {/* Not inserted: the how-to sits inside the scrolling preview, not in the state line (which must stay one line). */}
                {stage.placed === "kept" && <p className="voice-rec-preview-hint">{t("mobileVoice.kept_hint")}</p>}
                {stage.text}
              </div>
            )}
          </div>
          {/* The one announcement of the result stage — filled only at done; the in-between phases stay quiet. */}
          <span className="voice-rec-live" aria-live="polite">
            {stage?.kind === "done"
              ? placedText(stage.placed) + (stage.placed === "kept" ? ` ${t("mobileVoice.kept_hint")}` : "")
              : ""}
          </span>
          <div className="voice-rec-actions" key={actionsKey}>{actions}</div>
          {recovery.sessions.length > 0 && (
            <div className="voice-rec-recover">
              <div className="voice-rec-recover-title">{t("mobileVoice.recover_title")}</div>
              {recovery.sessions.map((s) => (
                <div className="voice-rec-recover-row" key={s.id} data-testid="voice-recover-row">
                  <span>
                    {t("mobileVoice.recover_item", {
                      time: new Date(s.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                      dur: fmt(s.chunkCount * TIMESLICE_MS),
                    })}
                  </span>
                  <button type="button" className="menu-row mobile-ai-action" onClick={() => void recovery.recover(s.id)}>{t("mobileVoice.recover_upload")}</button>
                  <button type="button" className="menu-row mobile-ai-action" onClick={() => void recovery.discard(s.id)}>{t("mobileVoice.recover_discard")}</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </MobileModal>
      {live && (
        <BackGuard
          key={guardKey}
          onBack={() => {
            if (rec.interrupted || rec.status === "paused") {
              requestClose();
              return;
            }
            setConfirm(true);
            setGuardKey((k) => k + 1);
          }}
        />
      )}
    </>
  );
}
