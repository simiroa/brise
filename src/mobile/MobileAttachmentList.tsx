import { useState } from "react";
import type { Attachment } from "../lib/commands.gen";
import { useAttachmentsBase } from "../lib/attachmentsBase";
import { t } from "../i18n/t";
import { formatFileSize } from "../lib/ui";
import { IconClose } from "../components/icons";
import type { AttachKind } from "./MobileAttachSheet";
import { useNotesStore } from "../stores/notes";
import { call } from "../lib/invoke";
import { beginLongPress, cancelLongPress, consumeLongPress, moveLongPress } from "../lib/longPress";
import { MobileModal } from "./MobileModal";
import { MobileAudioPlayer } from "./MobileAudioPlayer";
import { getVoiceDuration } from "./voiceDurations";
import type { InputAutoMode } from "../stores/settings";
import { isSettingsFix, type VoiceErrCode } from "./mobileInputFlows";

export interface PendingAttachment {
  key: string;
  name: string;
  kind: AttachKind;
  status: "uploading" | "error";
}

export interface VoiceRowState {
  status: "running" | "error";
  code?: VoiceErrCode;
}

/** 음성 첨부 행의 받아쓰기 칩(S2-3b/E1). 전사 서버 호출·본문 삽입은 MobileNote 가 쥐고, 여기는 그리기만 한다. */
export interface VoiceRowProps {
  transcribeMode: InputAutoMode;
  /** attachment id → 진행/실패. 없으면 유휴. */
  states: Record<string, VoiceRowState>;
  /** 이번 세션에 삽입을 끝내 "정리" 를 제안할 첨부(voice_cleanup_mode=ask). */
  cleanupOffers: ReadonlySet<string>;
  /** 받아쓰기 시작+삽입(제안 모드 버튼, 실패 다시 시도). */
  onTranscribe: (a: Attachment) => void;
  /** 서버에 보관된 전사를 본문에 삽입. */
  onInsert: (a: Attachment) => void;
  onCleanup: (a: Attachment) => void;
}

interface MobileAttachmentListProps {
  attachments: Attachment[];
  pending: PendingAttachment[];
  onRetry: (key: string) => void;
  voice?: VoiceRowProps;
}

function voiceErrText(code: VoiceErrCode | undefined): string {
  switch (code) {
    case "ai_required":
      return t("mobileInput.voice_err_ai");
    case "too_long":
      return t("mobileInput.voice_err_too_long");
    case "key":
      return t("mobileVoice.tr_err_key");
    case "format":
      return t("mobileVoice.tr_err_format");
    case "in_progress":
      return t("mobileVoice.tr_in_progress");
    case "deadline":
      return t("mobileVoice.tr_err_deadline");
    default:
      return t("mobileInput.voice_err_failed");
  }
}

function VoiceChip({ a, voice }: { a: Attachment; voice: VoiceRowProps }) {
  const st = voice.states[a.id];
  if (st?.status === "running") {
    return (
      <div className="mobile-attach-row-meta" aria-busy="true" data-testid="voice-transcribing">
        <div className="ai-skeleton-line" />
        {t("mobileInput.voice_transcribing")}
      </div>
    );
  }
  if (st?.status === "error") {
    return (
      <div className="mobile-attach-row-meta" data-testid="voice-error">
        {voiceErrText(st.code)}
        {(!st.code || !isSettingsFix(st.code)) && (
          <button type="button" className="mobile-attach-retry" onClick={() => voice.onTranscribe(a)}>
            {t("mobileInput.voice_retry")}
          </button>
        )}
      </div>
    );
  }
  if (a.transcript && !a.transcript_inserted) {
    return (
      <button type="button" className="mobile-attach-retry" onClick={() => voice.onInsert(a)}>
        {t("mobileInput.voice_transcript_ready")}
      </button>
    );
  }
  if (!a.transcript && voice.transcribeMode === "ask") {
    return (
      <button type="button" className="mobile-attach-retry" onClick={() => voice.onTranscribe(a)}>
        {t("mobileInput.voice_transcribe_ask")}
      </button>
    );
  }
  if (voice.cleanupOffers.has(a.id)) {
    return (
      <button type="button" className="mobile-attach-retry" onClick={() => voice.onCleanup(a)}>
        {t("mobileInput.voice_cleanup")}
      </button>
    );
  }
  return null;
}

/**
 * Renders below the editor body (MobileNote.tsx), independent of body markup — it reads
 * activeNote.attachments directly, so it renders (and upload still works) even for a note whose
 * body is in the mobile read-only fallback (unsupported HTML passthrough).
 *
 * Only attachments with a real file (`rel_path != null`) are shown — desktop's `link`/`note`/
 * `internal` kinds are URL/text bookmarks with no file body (src-tauri/src/models.rs::Attachment),
 * they don't fit "image/audio/file" and are out of this feature's scope.
 */
export function MobileAttachmentList({ attachments, pending, onRetry, voice }: MobileAttachmentListProps) {
  const { baseDir, convert } = useAttachmentsBase();
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  // K4 (W6): long-press -> confirm -> attachment_remove. Pessimistic (call first, patch the store
  // only on success) — same call-then-patch order MobileNote.tsx uses for its own section actions
  // and MobileActionSheet's run() helper uses for its 7 verbs, so there is nothing optimistic to
  // roll back on failure (call() already toasts; the row simply stays and the dialog stays open to
  // retry/cancel). This is deliberately NOT an optimistic remove-then-rollback shape — that shape
  // exists for drag/instant UI that must feel immediate; a long-press-confirm delete has no such
  // latency budget to protect.
  // ponytail: pending (still-uploading) rows have no delete gesture, only retry — attachment_remove
  // needs a server-side id a pending upload doesn't have yet. Ceiling: a stuck/unwanted upload can
  // only be abandoned by leaving the note. Upgrade path: a local "dismiss" that just drops the entry
  // from `pending`/`pendingFiles` client-side (MobileNote.tsx owns those two — no IPC involved).
  const [confirmDelete, setConfirmDelete] = useState<Attachment | null>(null);
  const [deleting, setDeleting] = useState(false);

  const files = attachments.filter((a) => a.rel_path != null);
  const images = files.filter((a) => a.kind === "image");
  const audios = files.filter((a) => a.kind === "audio");
  const others = files.filter((a) => a.kind !== "image" && a.kind !== "audio");
  const pendingPhotos = pending.filter((p) => p.kind === "photo");
  const pendingOther = pending.filter((p) => p.kind !== "photo");

  if (images.length === 0 && audios.length === 0 && others.length === 0 && pending.length === 0 && !confirmDelete) {
    return null;
  }

  const urlFor = (a: Attachment) => (baseDir && convert && a.rel_path ? convert(`${baseDir}/${a.rel_path}`) : null);

  const runDelete = async () => {
    const target = confirmDelete;
    if (!target) return;
    setDeleting(true);
    try {
      await call("attachment_remove", { id: target.id });
      // Attachment has no note_id field to compare against — guard by membership instead, so a
      // note switch mid-flight (rare: this needs a real round trip to the server) can't patch the
      // wrong note's attachments back in.
      const n = useNotesStore.getState().activeNote;
      if (n && n.attachments.some((a) => a.id === target.id)) {
        useNotesStore.setState({ activeNote: { ...n, attachments: n.attachments.filter((a) => a.id !== target.id) } });
      }
      setConfirmDelete(null);
    } catch {
      // call() already toasted; nothing was removed yet, so nothing to roll back. Keep the dialog
      // open so the user can see it failed and retry or cancel.
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="mobile-attach-section">
      {(images.length > 0 || pendingPhotos.length > 0) && (
        <div className="mobile-attach-grid">
          {images.map((a) => {
            const url = urlFor(a);
            return (
              <button
                key={a.id}
                type="button"
                className="mobile-attach-thumb"
                onPointerDown={(e) => beginLongPress(() => setConfirmDelete(a), undefined, e)}
                onPointerUp={cancelLongPress}
                onPointerCancel={cancelLongPress}
                onPointerLeave={cancelLongPress}
                onPointerMove={moveLongPress}
                onClick={() => {
                  if (consumeLongPress()) return;
                  if (url) setViewerUrl(url);
                }}
                aria-label={a.name}
              >
                {url && <img src={url} alt="" loading="lazy" decoding="async" />}
              </button>
            );
          })}
          {pendingPhotos.map((p) => (
            <div key={p.key} className="mobile-attach-thumb mobile-attach-thumb--pending">
              {p.status === "uploading" ? (
                <span className="mobile-attach-pending-badge">{t("mobile.attach_uploading")}</span>
              ) : (
                <button type="button" className="mobile-attach-retry" onClick={() => onRetry(p.key)}>
                  {t("mobile.attach_failed")} · {t("mobile.attach_retry")}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {audios.map((a) => {
        const url = urlFor(a);
        // 이 기기에서 올린 녹음이면 녹음기가 잰 길이를 안다 — 조각난 MP4 의 <audio> 는 길이를 5초로 잘못 읽으므로
        // 그 길이를 직접 그리는 재생기를 쓴다. 모르면(옛 녹음·다른 기기·고른 파일) 예전 그대로 기본 플레이어.
        const knownMs = getVoiceDuration(a.id);
        return (
          <div
            key={a.id}
            className="mobile-attach-row"
            onPointerDown={(e) => beginLongPress(() => setConfirmDelete(a), undefined, e)}
            onPointerUp={cancelLongPress}
            onPointerCancel={cancelLongPress}
            onPointerLeave={cancelLongPress}
            onPointerMove={moveLongPress}
          >
            <div className="mobile-attach-row-main">
              <div className="mobile-attach-row-name">{a.name}</div>
              {url &&
                (knownMs != null ? (
                  <MobileAudioPlayer src={url} durationMs={knownMs} />
                ) : (
                  // eslint-disable-next-line jsx-a11y/media-has-caption -- voice memos have no captions to provide
                  <audio controls src={url} className="mobile-attach-audio" />
                ))}
              {voice && <VoiceChip a={a} voice={voice} />}
            </div>
          </div>
        );
      })}

      {others.map((a) => {
        const url = urlFor(a);
        return (
          <div
            key={a.id}
            className="mobile-attach-row"
            onPointerDown={(e) => beginLongPress(() => setConfirmDelete(a), undefined, e)}
            onPointerUp={cancelLongPress}
            onPointerCancel={cancelLongPress}
            onPointerLeave={cancelLongPress}
            onPointerMove={moveLongPress}
          >
            <div className="mobile-attach-row-main">
              <div className="mobile-attach-row-name">{a.name}</div>
              <div className="mobile-attach-row-meta">{formatFileSize(a.size_bytes, "")}</div>
            </div>
            {url && (
              <a
                href={url}
                download={a.name}
                target="_blank"
                rel="noreferrer"
                className="mobile-attach-download"
                onClick={(e) => {
                  // A long-press that just fired was aimed at the delete confirm, not the download.
                  if (consumeLongPress()) e.preventDefault();
                }}
              >
                {t("mobile.attach_download")}
              </a>
            )}
          </div>
        );
      })}

      {pendingOther.map((p) => (
        <div key={p.key} className="mobile-attach-row">
          <div className="mobile-attach-row-main">
            <div className="mobile-attach-row-name">{p.name}</div>
            <div className="mobile-attach-row-meta">
              {p.status === "uploading" ? t("mobile.attach_uploading") : t("mobile.attach_failed")}
            </div>
          </div>
          {p.status === "error" && (
            <button type="button" className="mobile-attach-retry" onClick={() => onRetry(p.key)}>
              {t("mobile.attach_retry")}
            </button>
          )}
        </div>
      ))}

      {viewerUrl && (
        <div className="mobile-attach-viewer" onClick={() => setViewerUrl(null)}>
          <img src={viewerUrl} alt="" className="mobile-attach-viewer-img" />
          <button
            type="button"
            className="mobile-attach-viewer-close"
            aria-label={t("common.close")}
            onClick={() => setViewerUrl(null)}
          >
            <IconClose size={22} strokeWidth={2} />
          </button>
        </div>
      )}

      {confirmDelete && (
        <MobileModal
          title={t("mobile.attach_delete_confirm_title")}
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <button type="button" className="mobile-text-btn" onClick={() => setConfirmDelete(null)}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="mobile-text-btn mobile-text-btn--danger"
                disabled={deleting}
                onClick={() => void runDelete()}
              >
                {t("common.delete")}
              </button>
            </>
          }
        >
          <p style={{ fontSize: "var(--text-sm)", color: "var(--text)" }}>
            {t("mobile.delete_confirm_irreversible_body")}
          </p>
        </MobileModal>
      )}
    </div>
  );
}
