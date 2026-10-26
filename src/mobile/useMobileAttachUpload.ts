/**
 * 폰 노트 화면의 첨부 업로드 줄 — 파일 선택·녹음 결과를 한 줄(uploadChainRef)로 직렬 업로드하고, 진행/실패 항목
 * (pending)과 재시도를 쥔다.
 *
 * Attachment upload (owner brief: images/audio/files, independent of the editor entirely — must
 * work even on a read-only/unsupported-body note). ensureMaterialized() mirrors insertSection
 * (useMobileSectionOps): a fresh capture draft has no note id server-side yet, so the first attachment
 * (like the first AI insert) is what actually creates the row.
 *
 * 오디오가 올라가면 받아쓰기 쪽(useMobileVoiceTranscript)에 `onAudioUploaded` 로 넘긴다. 의존은 업로드 → 음성
 * 콜백 한 방향이다 — 음성 훅은 이 줄을 부르지 않으므로(녹음 결과는 onVoiceFinished 가 여기서 바로 올린다) 순환이 없다.
 */
import { useRef, useState } from "react";
import type { Attachment } from "../lib/commands.gen";
import { t } from "../i18n/t";
import { emitNotice } from "../lib/invoke";
import { randomId } from "../lib/ids";
import { useNotesStore } from "../stores/notes";
import { uploadAttachment, AttachmentTooLargeError, type UploadMeta } from "./mobileApi";
import type { AttachKind } from "./MobileAttachSheet";
import type { PendingAttachment } from "./MobileAttachmentList";
import type { VoiceInfo } from "./mobileInputFlows";
import { rememberVoiceDuration } from "./voiceDurations";
import { isRecorderSheetOpen } from "./voiceHandOff";
import { useSettingsStore } from "../stores/settings";
import { reportFallback } from "../lib/diag";

/** Where one finished recording's upload stands — what the recorder sheet's result stage reads (voiceUploadOf). */
export type VoiceUpload =
  | { status: "uploading" }
  | { status: "error"; retry(): void }
  | { status: "done"; attachmentId: string };

export function useMobileAttachUpload({
  onAudioUploaded,
}: {
  /** 활성 노트에 오디오 첨부가 올라간 직후(useMobileVoiceTranscript::onAudioUploaded). */
  onAudioUploaded: (attachment: Attachment, noteId: string, voice?: VoiceInfo) => void;
}) {
  // Files still filed elsewhere (e.g. camera capture, or the picker takes a while) — attachments
  // are independent of the editor/body entirely, so this never gates on readOnly/isCapture.
  const [pendingFiles, setPendingFiles] = useState<Map<string, File>>(new Map());
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const pendingRef = useRef<PendingAttachment[]>([]);
  pendingRef.current = pending;

  // S2: 업로드 메타(촬영/녹음 시각·좌표)는 key 로 따로 보관한다 — 재시도가 같은 메타로 다시 올린다.
  // 업로드는 전부 uploadChainRef 한 줄로 직렬화한다(녹음기 자동 분할이 선택 업로드와 겹쳐도 순차).
  const uploadMetaRef = useRef(new Map<string, UploadMeta & { voice?: VoiceInfo; confirmSession?: () => Promise<void> }>());
  const uploadChainRef = useRef<Promise<void>>(Promise.resolve());

  // 큐 항목은 enqueue 시점의 노트 id 를 들고 간다 — 줄이 길어 업로드가 노트를 옮긴 뒤에 돌아도
  // (녹음기 자동 분할·재시도) 엉뚱한 노트에 붙지 않는다. 초안이면 그 시점에 ensureMaterialized 가 만든다.
  const uploadNoteRef = useRef(new Map<string, Promise<string | null>>());

  // 녹음 시트의 결과 단계가 "이 녹음" 을 따라가는 손잡이 — 녹음기가 넘긴 File → 업로드 key → 올라간 첨부 id.
  // 상태가 아니라 ref 다: 쓰는 순간마다 setPending 이 같이 일어나 화면이 다시 그려진다(아래 순서 주석).
  const voiceKeyByFileRef = useRef(new WeakMap<File, string>());
  const voiceUploadedRef = useRef(new Map<string, string>());

  /** @returns true when the file was uploaded (the recorder drops its crash copy on that). */
  const runUpload = async (key: string, file: File): Promise<boolean> => {
    setPending((p) => p.map((u) => (u.key === key ? { ...u, status: "uploading" } : u)));
    try {
      let id = await uploadNoteRef.current.get(key);
      if (!id) {
        // 이전 시도에서 초안 확정이 실패했다 — 재시도는 지금 노트로 다시 묶는다.
        const p = useNotesStore.getState().ensureMaterialized();
        uploadNoteRef.current.set(key, p);
        id = await p;
      }
      if (!id) throw new Error("no active note");
      const m = uploadMetaRef.current.get(key);
      const attachment = await uploadAttachment(
        id,
        file,
        m ? { recordedAt: m.recordedAt, lat: m.lat, lng: m.lng } : undefined,
        key,
      );
      // 녹음의 진짜 길이(조각난 MP4 는 <audio> 가 0:05 로 잘못 읽는다)를 첨부 id 로 적는다. 목록을 다시 그리는 스토어
      // 패치보다 먼저여야 첫 렌더부터 맞는 길이가 나온다. 활성 노트가 바뀌었어도 적는다(나중에 그 노트를 열 때 쓴다).
      if (attachment.kind === "audio" && m?.voice?.durationMs != null) rememberVoiceDuration(attachment.id, m.voice.durationMs);
      // 활성 노트가 그새 바뀌었으면 화면 상태(낙관 반영·전사·본문 삽입)는 건드리지 않는다 — 업로드만 그 노트에 됐다.
      const n = useNotesStore.getState().activeNote;
      const stillActive = !!n && n.note.id === id;
      if (n && stillActive) {
        useNotesStore.setState({ activeNote: { ...n, attachments: [...n.attachments, attachment] } });
      }
      uploadNoteRef.current.delete(key);
      // pending 에서 빠지기 전에 적는다 — 그 렌더가 "올리는 중" 도 "올라감" 도 못 보는 틈이 없게.
      if (m?.voice) voiceUploadedRef.current.set(key, attachment.id);
      setPending((p) => p.filter((u) => u.key !== key));
      setPendingFiles((pm) => {
        const next = new Map(pm);
        next.delete(key);
        return next;
      });
      uploadMetaRef.current.delete(key);
      // 첫 시도가 실패했다면 handOff 는 이미 보호본을 남기고 끝났다 — 재시도가 성공한 지금 지운다(복구 목록 이중 업로드 방지).
      if (m?.confirmSession) {
        try { await m.confirmSession(); } catch (e) {
          reportFallback("voice", "session_confirm_failed", e instanceof Error ? e.message : "confirm failed");
        }
      }
      if (attachment.kind === "audio" && stillActive) onAudioUploaded(attachment, id, m?.voice);
      return true;
    } catch (e) {
      setPending((p) => p.map((u) => (u.key === key ? { ...u, status: "error" } : u)));
      // 녹음 시트가 열려 있고 받아쓰기가 켜져 있으면 시트의 결과 단계가 이미 실패를 말한다 — 토스트는 이중이다(X-8).
      const m = uploadMetaRef.current.get(key);
      const sheetShowsIt = !!m?.voice && isRecorderSheetOpen() && useSettingsStore.getState().voiceTranscribeMode !== "off";
      if (!sheetShowsIt) emitNotice(e instanceof AttachmentTooLargeError ? t("mobile.attach_too_large") : t("mobile.attach_failed"));
      return false;
    }
  };

  // Sequential (not concurrent) upload for a multi-pick — a phone's uplink is the bottleneck, not
  // the server, so racing several 25MB-capped uploads at once just contends with itself.
  const enqueueUploads = (
    picked: { file: File; kind: AttachKind; meta?: UploadMeta & { voice?: VoiceInfo; confirmSession?: () => Promise<void> } }[],
    onKey?: (key: string) => void,
  ): Promise<boolean[]> => {
    // ensureMaterialized 는 멱등(진행 중 약속 공유)이라 배치마다 불러도 초안이 둘 생기지 않는다.
    // 실패는 call() 이 이미 토스트했고, runUpload 가 null 을 받아 항목을 error 로 남긴다.
    const noteIdP = (async () => {
      try {
        return await useNotesStore.getState().ensureMaterialized();
      } catch {
        return null; // silent-ok: call() 이 토스트 + 진단 로그
      }
    })();
    const items = picked.map(({ file, kind, meta }) => {
      const key = randomId("upload");
      uploadNoteRef.current.set(key, noteIdP);
      if (meta) uploadMetaRef.current.set(key, meta);
      onKey?.(key);
      return { key, name: file.name, kind, status: "uploading" as const, file };
    });
    setPending((p) => [...p, ...items.map(({ file: _f, ...rest }) => rest)]);
    setPendingFiles((m) => {
      const next = new Map(m);
      for (const it of items) next.set(it.key, it.file);
      return next;
    });
    // runUpload 는 던지지 않는다(실패는 false) — 줄이 끊기지 않는다.
    const done = uploadChainRef.current.then(async () => {
      const oks: boolean[] = [];
      for (const it of items) oks.push(await runUpload(it.key, it.file));
      return oks;
    });
    uploadChainRef.current = done.then(() => {});
    return done;
  };

  const onFilesPicked = (kind: AttachKind, fileList: FileList) => {
    void enqueueUploads(Array.from(fileList).map((file) => ({ file, kind })));
  };

  const retryUpload = (key: string) => {
    const file = pendingFiles.get(key);
    if (file) void runUpload(key, file);
  };

  // true = 업로드까지 끝났다 → 녹음기가 IndexedDB 보호본을 지운다. 실패하면 false 라 보호본이 남아
  // 다음 시트 열림에 복구 안내로 이어진다.
  const onVoiceFinished = async (r: { file: File; recordedAt: string; durationMs: number; lat?: number; lng?: number; confirmSession?: () => Promise<void> }) => {
    const done = enqueueUploads([
        {
          file: r.file,
          kind: "audio",
          meta: {
            recordedAt: r.recordedAt,
            lat: r.lat,
            lng: r.lng,
            voice: { recordedAt: r.recordedAt, durationMs: r.durationMs },
            confirmSession: r.confirmSession,
          },
        },
      ],
      (key) => voiceKeyByFileRef.current.set(r.file, key),
    );
    return (await done)[0] === true;
  };

  /** 녹음기가 넘긴 그 File 의 업로드가 어디까지 왔나 — 모르는 File(녹음 시트 밖) 이면 null. */
  const voiceUploadOf = (file: File): VoiceUpload | null => {
    const key = voiceKeyByFileRef.current.get(file);
    if (!key) return null;
    const attachmentId = voiceUploadedRef.current.get(key);
    if (attachmentId) return { status: "done", attachmentId };
    const p = pending.find((u) => u.key === key);
    if (!p) return null;
    return p.status === "error" ? { status: "error", retry: () => retryUpload(key) } : { status: "uploading" };
  };

  return { pending, pendingRef, retryUpload, onFilesPicked, onVoiceFinished, voiceUploadOf };
}
