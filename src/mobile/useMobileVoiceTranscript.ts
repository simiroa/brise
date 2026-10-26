/**
 * 폰 노트 화면의 음성 받아쓰기(S2-3) — 업로드가 끝난 오디오 첨부 → (모드에 따라) 전사 → 본문 삽입 → 정리 제안·날짜 후보.
 * 전사 진행/실패 표시(voiceRow)와 전사문 삽입 규칙이 여기 있다. 녹음 시트·업로드 줄은 useMobileAttachUpload 와
 * MobileVoiceRecorder, 서버 전사는 `audio_transcribe` IPC.
 *
 * docs/PLAN-2026-10-06-s2-input.md.
 */
import { useRef, useState } from "react";
import type { Attachment } from "../lib/commands.gen";
import { t } from "../i18n/t";
import { callSilent } from "../lib/invoke";
import { reportFallback } from "../lib/diag";
import { runAiAction } from "../stores/runAiAction";
import { useAiPresetsStore, builtinDefault } from "../stores/aiPresets";
import { useNotesStore } from "../stores/notes";
import { useMobileAmbientStore } from "../stores/mobileAmbient";
import { useSettingsStore, dateNudgeModeOf } from "../stores/settings";
import {
  buildTranscriptBlock,
  buildTranscriptNode,
  classifyTranscribeError,
  dateCandidateFromText,
  isSettingsFix,
  type VoiceInfo,
} from "./mobileInputFlows";
import type { VoiceRowProps, VoiceRowState } from "./MobileAttachmentList";
import type { ChipData } from "./useMobileInputChips";
import type { MobileBodyEditor } from "./useMobileBodyEditor";
import type { MobileSectionOps } from "./useMobileSectionOps";
import { applyDateCandidate } from "./mobileNoteInputActions";
import type { VoiceUpload } from "./useMobileAttachUpload";
import type { TranscriptPlacement, VoiceStage } from "./MobileVoiceRecorder";

/** IME 조합이 안 끝나는 경우의 상한 — 넘으면 그냥 넣는다(전사문은 첨부에 안전하지만 사용자가 칩을 기다리게 하지 않는다). */
const COMPOSITION_WAIT_MS = 15000;

export function useMobileVoiceTranscript({
  ed,
  bodyUnsavedRef,
  insertSection,
  addChip,
}: {
  ed: MobileBodyEditor;
  /** 저장 실패 여부 — 삽입 직후 flush 가 실패하면 "삽입했다" 고 표시하지 않는다(useMobileNoteSave). */
  bodyUnsavedRef: { current: boolean };
  insertSection: MobileSectionOps["insertSection"];
  addChip: (c: ChipData) => void;
}) {
  const { editor, sectionRef, readOnlyRef, flushRef } = ed;
  const [voiceStates, setVoiceStates] = useState<Record<string, VoiceRowState>>({});
  const [cleanupOffers, setCleanupOffers] = useState<ReadonlySet<string>>(new Set());
  // 녹음 시트의 결과 단계가 읽는 "끝난 전사" — 글과 실제로 들어간 자리. 행(voiceStates)은 성공하면 지우지만 시트는
  // 미리보기를 보여야 하므로 따로 둔다. 삽입이 끝나기 전엔 비어 있다(그동안 시트는 "받아 적는 중").
  const [results, setResults] = useState<Record<string, { text: string; placed: TranscriptPlacement }>>({});
  const voiceTranscribeMode = useSettingsStore((s) => s.voiceTranscribeMode);
  const voiceInfoRef = useRef(new Map<string, VoiceInfo>());
  const transcribingRef = useRef(new Set<string>());

  const patchAttachment = (id: string, patch: Partial<Attachment>) => {
    const n = useNotesStore.getState().activeNote;
    if (!n) return;
    useNotesStore.setState({
      activeNote: { ...n, attachments: n.attachments.map((a) => (a.id === id ? { ...a, ...patch } : a)) },
    });
  };

  /** 전사문을 본문 끝에 넣는다(커서 자리가 아님 — 키보드도 올리지 않는다).
   *  @returns 실제로 들어간 자리, 못 넣었으면 null(다른 노트로 이동 · 저장 실패 · 섹션 생성 실패). */
  const insertTranscript = async (att: Attachment, text: string, noteId: string): Promise<"body" | "section" | null> => {
    if (useNotesStore.getState().activeNote?.note.id !== noteId) return null; // 그 사이 다른 노트로 이동
    const info = voiceInfoRef.current.get(att.id);
    const sec = sectionRef.current;
    if (editor && !editor.isDestroyed && sec && sec.kind !== "diagram" && sec.kind !== "sheet" && !readOnlyRef.current) {
      // 전사문은 수십 초~2분 늦게 온다 — 그때 커서는 사용자가 지금 쓰는 자리라 문단을 쪼갠다. 항상 본문 끝, 포커스도 건드리지 않는다.
      // IME 조합 중이면 compositionend 까지 미룬다(조합 중 문서 변경은 Gboard 에서 글자를 깨뜨린다).
      if (editor.view?.composing) {
        await new Promise<void>((resolve) => {
          const dom = editor.view.dom;
          const timer = setTimeout(done, COMPOSITION_WAIT_MS);
          function done() {
            clearTimeout(timer);
            dom.removeEventListener("compositionend", done);
            resolve();
          }
          dom.addEventListener("compositionend", done);
        });
        // 기다리는 사이 에디터가 사라졌거나 다른 노트로 옮겼으면 넣지 않는다.
        if (editor.isDestroyed || useNotesStore.getState().activeNote?.note.id !== noteId) return null;
      }
      editor.commands.insertContentAt(editor.state.doc.content.size, buildTranscriptNode(text, info));
      // 저장이 실패했으면 "삽입했다" 고 표시하지 않는다 — 실패 배너가 이미 떠 있고 칩이 남아 다시 넣을 수 있다.
      await flushRef.current();
      return bodyUnsavedRef.current ? null : "body";
    }
    // 관계도/시트/읽기 전용 본문엔 넣을 자리가 없다 → 새 텍스트 섹션으로 둔다.
    // ponytail: insertSection 이 그 섹션으로 화면을 옮긴다. 조용히 두려면 insertSection 에 'keep view' 옵션이 필요하다.
    const before = useNotesStore.getState().activeNote?.sections.length ?? 0;
    await insertSection(t("mobileInput.voice_section_name"), buildTranscriptBlock(text, info), noteId);
    return (useNotesStore.getState().activeNote?.sections.length ?? 0) > before ? "section" : null;
  };

  const markInserted = async (att: Attachment) => {
    try {
      await callSilent("attachment_transcript_mark_inserted", { attachment_id: att.id });
    } catch {
      reportFallback("voice-transcribe", "mark_inserted_failed"); // 화면은 이미 삽입됨 — 다시 열면 칩이 한 번 더 뜰 수 있다
    }
    patchAttachment(att.id, { transcript_inserted: true });
  };

  const runCleanup = async (text: string, noteId: string) => {
    const preset =
      useAiPresetsStore.getState().list.find((p) => p.id === "organize" && !p.hidden) ?? builtinDefault("organize");
    if (!preset) return;
    try {
      // 정리 결과는 새 섹션으로 들어간다 — 원문은 본문 인용 블록에 그대로 남는다(모바일 에디터엔 접힘 블록이 없다).
      await runAiAction(preset, {
        contextText: text,
        insertSection: (n, b, id, k) => insertSection(n, b, id, k), // 다섯째 인자가 runAiAction 쪽은 opts 라 모양이 다르다
        targetNoteId: noteId,
      });
    } catch {
      reportFallback("voice-transcribe", "cleanup_failed");
    }
  };

  const runTranscribe = async (att: Attachment, noteId: string, insert: boolean) => {
    if (transcribingRef.current.has(att.id)) return;
    transcribingRef.current.add(att.id);
    setVoiceStates((st) => ({ ...st, [att.id]: { status: "running" } }));
    // 전사는 runAiAction 밖이라 AI 글로우 키도 게이트 세션도 없다 — 배경 빛줄기(MobileAmbient)가 이 틈에서 꺼지지 않게 센다.
    const endAiWork = useMobileAmbientStore.getState().beginAiWork();
    let text: string;
    try {
      // 토스트 없는 호출: 실패는 행의 칩이 말한다(AI 꺼짐은 안내, 그 밖은 [다시 시도]) — 토스트까지 띄우면 이중이다.
      const r = await callSilent<{ text: string }>("audio_transcribe", { note_id: noteId, attachment_id: att.id });
      text = (r?.text ?? "").trim();
      if (!text) throw new Error("transcribe_empty");
    } catch (e) {
      const code = classifyTranscribeError(e);
      if (code !== "ai_required" && code !== "in_progress") reportFallback("voice-transcribe", code === "too_long" ? "too_long" : "failed");
      setVoiceStates((st) => ({ ...st, [att.id]: { status: "error", code } }));
      return;
    } finally {
      transcribingRef.current.delete(att.id);
      endAiWork();
    }
    setVoiceStates((st) => {
      const { [att.id]: _gone, ...rest } = st;
      return rest;
    });
    patchAttachment(att.id, { transcript: text, transcript_inserted: false });
    let placed: "body" | "section" | null = null;
    if (insert) {
      try {
        placed = await insertTranscript(att, text, noteId);
      } catch (e) {
        // 삽입이 던지면(에디터 명령·flush) 전사문은 첨부에 남아 있다 — 행이 [삽입] 을 다시 띄우고, 시트는 "받아 적었어요" 로 끝난다.
        reportFallback("voice-transcribe", "insert_failed", e instanceof Error ? e.message : "insert threw");
      }
    }
    setResults((r) => ({ ...r, [att.id]: { text, placed: placed ?? "kept" } }));
    if (placed) {
      await markInserted(att);
      const cleanup = useSettingsStore.getState().voiceCleanupMode;
      if (cleanup === "auto") void runCleanup(text, noteId);
      else if (cleanup === "ask") setCleanupOffers((o) => new Set(o).add(att.id));
    }
    // 날짜 후보 — 일반 본문 넛지와 같은 정책(date_nudge_*): off 없음 / 제안 칩 / 자동 추가.
    const ss = useSettingsStore.getState();
    const mode = dateNudgeModeOf(ss.dateNudgeEnabled, ss.dateNudgeAuto);
    const cand = mode === "off" ? null : dateCandidateFromText(text, ss.uiLang);
    if (cand) {
      if (mode === "auto") void applyDateCandidate(noteId, cand, true);
      else addChip({ key: `date:${att.id}`, noteId, kind: "date", cand });
    }
  };

  /**
   * 업로드 줄(useMobileAttachUpload)이 오디오 첨부를 올린 직후 부른다 — 활성 노트에서 올라간 경우에만.
   * 모드는 업로드가 끝난 지금 읽는다(설정이 중간에 바뀔 수 있다). 업로드 줄을 막지 않게 기다리지 않는다.
   */
  const onAudioUploaded = (attachment: Attachment, noteId: string, voice?: VoiceInfo) => {
    if (voice) voiceInfoRef.current.set(attachment.id, voice);
    if (useSettingsStore.getState().voiceTranscribeMode === "auto") {
      void runTranscribe(attachment, noteId, true);
    }
  };

  const noteIdOrNull = () => useNotesStore.getState().activeNote?.note.id ?? null;
  const voiceRow: VoiceRowProps = {
    transcribeMode: voiceTranscribeMode,
    states: voiceStates,
    cleanupOffers,
    onTranscribe: (a) => {
      const id = noteIdOrNull();
      if (id) void runTranscribe(a, id, true);
    },
    onInsert: (a) => {
      const id = noteIdOrNull();
      if (!id || !a.transcript) return;
      const text = a.transcript;
      void (async () => {
        if ((await insertTranscript(a, text, id)) != null) await markInserted(a);
      })();
    },
    onCleanup: (a) => {
      const id = noteIdOrNull();
      if (!id || !a.transcript) return;
      setCleanupOffers((o) => {
        const next = new Set(o);
        next.delete(a.id);
        return next;
      });
      void runCleanup(a.transcript, id);
    },
  };

  /**
   * 녹음 시트의 결과 단계(MobileVoiceRecorder `stageOf`) — 그 녹음의 업로드 상태를 전사 상태와 합쳐 한 단계로.
   * 일은 전부 이 훅·업로드 줄이 쥔다: 시트는 읽고 버튼만 누른다, 그래서 시트를 닫아도 전사는 그대로 이어진다.
   * null = 더 보여 줄 것이 없다(받아쓰기 꺼짐 · 다른 노트로 이동) → 시트는 "저장했어요" 뒤 스스로 닫힌다.
   */
  const stageOf = (up: VoiceUpload | null): VoiceStage | null => {
    if (voiceTranscribeMode === "off" || !up) return null;
    if (up.status === "uploading") return { kind: "saving" };
    if (up.status === "error") return { kind: "upload_failed", retry: up.retry };
    const att = useNotesStore.getState().activeNote?.attachments.find((a) => a.id === up.attachmentId);
    if (!att) return null;
    const st = voiceStates[att.id];
    if (st?.status === "error") {
      const code = st.code ?? "failed";
      return { kind: "transcribe_failed", code, retry: isSettingsFix(code) ? undefined : () => voiceRow.onTranscribe(att) };
    }
    if (st?.status === "running") return { kind: "transcribing" };
    const done = results[att.id];
    if (done) return { kind: "done", text: done.text, placed: done.placed };
    // 전사는 끝났는데 삽입(저장 flush)이 아직이다 — 여기서 [받아 적기] 를 다시 띄우면 두 번 전사된다.
    if (att.transcript) return { kind: "transcribing" };
    if (voiceTranscribeMode === "ask") return { kind: "offer", transcribe: () => voiceRow.onTranscribe(att) };
    return { kind: "transcribing" }; // auto: onAudioUploaded 가 같은 틱에 시작했다
  };

  return { voiceRow, onAudioUploaded, stageOf };
}
