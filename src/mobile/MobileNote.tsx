import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { StatusEntry } from "../lib/commands.gen";
import { useNotesStore } from "../stores/notes";
import { useSettingsStore } from "../stores/settings";
import { useAiStore, selectAiAvailability } from "../stores/ai";
import { usePresetsStore, TODO_PRESET_BODY_MD } from "../stores/presets";
import { callSilent } from "../lib/invoke";
import { t } from "../i18n/t";
import { IconArrowLeft } from "../components/icons";
import { shouldShowCapturePresets } from "./mobileEditorSupport";
import { MobileAiSheet } from "./MobileAiSheet";
import { MobileDiagramSheet } from "./MobileDiagramSheet";
import { MobileNoteBadges } from "./MobileNoteBadges";
import { MobileAttachSheet, type AttachSheetHandle } from "./MobileAttachSheet";
import { MobileNoteActionBar } from "./MobileNoteActionBar";
import { MobileDockSlot } from "./MobileDockSlot";
import { MobileNoteFab } from "./MobileNoteFab";
import { MobileNudgeBubble } from "./MobileNudgeBubble";
import { MobileSectionStrip } from "./MobileSectionStrip";
import { MobileVoiceRecorder } from "./MobileVoiceRecorder";
import { MobileInputChips } from "./MobileInputChips";
import { MobileSaveBanner, MobileRemoteChangeBanner, MobileStashRecoveryBanner } from "./MobileNoteBanners";
import { MobileNoteBody } from "./MobileNoteBody";
import { useMobileBodyEditor } from "./useMobileBodyEditor";
import { useFabScrollMargin } from "./useFabScrollMargin";
import { useMobileNoteSave } from "./useMobileNoteSave";
import { useMobileUnsavedStash } from "./useMobileUnsavedStash";
import { useMobileSectionOps } from "./useMobileSectionOps";
import { useMobileCapturePreset } from "./useMobileCapturePreset";
import { useMobileInputChips } from "./useMobileInputChips";
import { useMobileVoiceTranscript } from "./useMobileVoiceTranscript";
import { useMobileAttachUpload } from "./useMobileAttachUpload";
import { useMobileNudgeChips } from "./useMobileNudgeChips";
import { getVoicePosition } from "./mobileNoteInputActions";

interface MobileNoteProps {
  /** 머리의 ← (MobileApp: 입력이면 leaveCapture, 노트면 saveAndLeaveNote — 둘 다 flush 뒤 나간다). 저장하기 버튼은 없다
   *  (오너 2026-10-10): 타이핑이 700ms 디바운스로 저장하고, 제목 줄 오른쪽 끝(MobileSaveStatus)이 저장 상태를 보여 준다.
   *  키보드도 저절로 올리지 않는다(D2) — 본문을 탭하면 그때 포커스한다(MobileNoteBody). */
  onBack: () => void;
  /** 입력(capture) 진입만 true. The ONLY difference left between the two entry points: the capture
   *  preset stack (and the first-save location chip). Chrome is identical either way (owner 2026-07-30 item 1). */
  capture?: boolean;
  /** Wiki-link tap navigation (note:// anchors in the body). Same `(id) => void` shape as
   *  MobileHome/MobileSearch/MobileTree's onOpenNote — MobileApp wires all four to the same
   *  `openNote` (flushAll -> selectNote -> navigate("note")), so a tap mid-draft still flushes the
   *  pending edit before swapping activeNote out from under it. Required (not optional) so a wiring
   *  gap at a call site is a tsc error, not a silently inert tap. */
  onOpenNote: (id: string) => void;
}

/** Imperative handle for the 입력 tab's exit path (MobileApp::leaveCapture) — a tab-bar tap away
 *  from capture doesn't go through this component's own back button, so MobileApp needs a way to
 *  (a) flush the pending debounced edit and AWAIT it (the unmount cleanup in useSectionEditor also
 *  flushes, but fire-and-forget — nothing can wait on it, and the post-save decision below must not
 *  run before the write has landed) and (b) read the just-typed plain-text length to decide whether
 *  the post-save AI interstitial should show, without duplicating mdSerializeHtml/stripHtmlForDisplay
 *  logic in MobileApp. */
export interface MobileNoteHandle {
  flushAndMeasure: () => Promise<number>;
  /** W1/K1: MobileApp 의 listenRemoteNoteWrite(onFocusSkipped) 가 부른다 — 이 노트에 원격 쓰기가
   *  왔는데 포커스 보호로 reloadActive() 를 건너뛴 경우다. noteId 가 지금 열려 있는 노트와 다르면
   *  (드문 레이스) 배너는 그냥 무시된다 — 렌더 쪽에서 note.id 로 다시 비교하므로 여기선 체크가
   *  필요 없다. */
  notifyRemoteChange: (noteId: string) => void;
  /** V5: 마지막 본문 저장이 실패해 이 기기에만 있는 글이 있는가. flushAndMeasure 직후에 읽는다
   *  (flush 가 한 번 재시도하므로). 나가기 경로가 이걸로 "저장된 줄 알고 나가는" 일을 막는다. */
  hasUnsavedFailure: () => boolean;
  /** V5: 나가기를 막았을 때 MobileApp 이 부른다. 화면에 실패 배너를 띄우고, 사용자가 [그래도 나가기]를
   *  고르면 본문을 이 기기에 보관(unsavedStash — 클립보드는 덤)한 뒤 proceed 를 실행한다. 보관도 복사도
   *  못 했으면 나가지 않는다. 보관한 글은 그 노트를 다시 열 때 복구 배너로 돌아온다. */
  showLeaveBlocked: (proceed: () => void) => void;
  /** 가져온 초안을 나가며 노트로 만들기가 실패했다 — MobileApp.leaveCapture 가 부른다. 본문을 다시 "서버에 못 보낸 글"로 만들어, 이후
   *  나가기(뒤로·탭·하드웨어 뒤로)가 flush 로 노트 만들기를 다시 시도하고 또 실패하면 위 관문이 막는다. */
  markDraftUnsent: () => void;
}

/**
 * View+edit unified, like desktop (EditorPanel.tsx) — trimmed for a single-screen phone flow: a
 * horizontally scrollable section strip (MobileSectionStrip; rename/reorder/delete live behind a
 * long-press there) in place of desktop's full tab bar. This file only ASSEMBLES the screen — state
 * and effects live in per-concern hooks:
 *
 *   useMobileBodyEditor      Tiptap instance, activeNote → screen sync, section switch
 *                            (useMobileSectionView: what is painted and how)
 *   useMobileNoteSave        flush/save failure (V5)/conflict (D2②)/remote change (K1)
 *   useMobileUnsavedStash    text kept on this device by "그래도 나가기" → recovery banner (new section)
 *   useMobileSectionOps      section rename/reorder/delete/insert, AI source replace
 *   useMobileCapturePreset   입력 screen's starter presets
 *   useMobileAttachUpload    attachment upload line
 *   useMobileVoiceTranscript voice → transcript → body insert
 *   useMobileInputChips      suggestion chips (date/location/photo-audio meta)
 *   useMobileNudgeChips      typing-detection suggestions: link/#tag → chip row, date/region → bubble above the sentence
 *   useFabScrollMargin       keeps the caret clear of the floating ＋ speed dial (MobileNoteFab): scrollThreshold + scrollMargin
 *
 * Screen layout (owner 2026-10-07, docs/mockups/2026-10-07-mobile-capture, "C 두 상태"): header · badges ·
 * section strip · S2 suggestion cards · body (with the FAB floating bottom-right) · nudge chip row · DOCK
 * (MobileNoteActionBar: [dynamic tool slot]; ✨ lives in the ＋ speed dial, the save state at the end of the title line). While the keyboard is open CSS hides the badges,
 * the strip and the S2 cards and slims the header (tabbar.css / note-header.css, `.mobile-app[data-kbd]`).
 *
 * No bodyCacheRef / skipNextContentLoadRef / bridgeAutoCreateDraft like desktop: those protect a draft's
 * live keystrokes from being clobbered when activeNote's reference changes mid-typing. This screen only
 * mounts once MobileApp has already called newNote()/selectNote() and navigated, and the few paths that
 * swap or re-create activeNote while it is mounted are covered differently: a wiki-link tap flushes
 * first (MobileApp::openNote), ensureMaterialized()'s draft -> real swap reads the already-just-saved
 * body_md back off the store (not stale data), and body-external patches (attachments/date/region —
 * the store deliberately leaves activeNote.sections' body stale for caret safety) are filtered by the
 * note-load effect's server-version check (useMobileBodyEditor, 결함 A 2026-10-07).
 *
 * Every hook call in this component sits ABOVE its `if (!activeNote || !editor) return null` early
 * return — CLAUDE.md 함정 1 (a hook past an early return blanked the whole app twice).
 * MobileNote.realEditor.test.tsx pins that with a real editor (null → note → null).
 */
export const MobileNote = forwardRef<MobileNoteHandle, MobileNoteProps>(function MobileNote(
  { onBack, capture = false, onOpenNote },
  ref
) {
  const activeNote = useNotesStore((s) => s.activeNote);
  const activeBodyEmpty = useNotesStore((s) => s.activeBodyEmpty);
  const setTitle = useNotesStore((s) => s.setTitle);
  const setNoteYear = useNotesStore((s) => s.setNoteYear);
  const setEventPrecision = useNotesStore((s) => s.setEventPrecision);
  const setStatus = useNotesStore((s) => s.setStatus);
  const setRegion = useNotesStore((s) => s.setRegion);
  const setLocation = useNotesStore((s) => s.setLocation);
  // docs/PLAN-schedule-system.md §7.7/W5-6 — same store actions TitleBar.tsx's desktop bell already
  // uses (stores/notesActive.ts, landed in W5-4). Nothing new added to the store for mobile.
  const setRemind = useNotesStore((s) => s.setRemind);
  const setSchedule = useNotesStore((s) => s.setSchedule);
  const uiLang = useSettingsStore((s) => s.uiLang);
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  const notificationsEnabled = useSettingsStore((s) => s.notificationsEnabled);
  const setNotificationsEnabled = useSettingsStore((s) => s.setNotificationsEnabled);
  const aiReachable = useAiStore((s) => s.aiReachable);
  const ensureAiReachable = useAiStore((s) => s.ensureAiReachable);
  const customPresets = usePresetsStore((s) => s.customPresets);
  const presetsLoaded = usePresetsStore((s) => s.loaded);
  const loadPresets = usePresetsStore((s) => s.load);

  const [aiSheetOpen, setAiSheetOpen] = useState(false);
  const [customStatuses, setCustomStatuses] = useState<StatusEntry[]>([]);
  const [attachSheetOpen, setAttachSheetOpen] = useState(false);
  const [diagramSheetOpen, setDiagramSheetOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  // 스피드 다이얼의 "사진" 이 시트를 열지 않고 갤러리 입력만 누르는 손잡이 — 훅이라 조기 반환 위(함정 1).
  const attachSheetRef = useRef<AttachSheetHandle>(null);

  // 화면 부트스트랩 — 한 번 로드. 데스크톱 스토어 부트스트랩이 모바일 경로엔 없다.
  useEffect(() => {
    void ensureAiReachable();
  }, [ensureAiReachable]);

  // Same custom-preset store PresetList reads on desktop (kv-stored, see stores/presets.ts) —
  // nothing on the mobile path loads it yet, so this mirrors PresetList's own "load once" effect.
  useEffect(() => {
    if (!presetsLoaded) void loadPresets();
  }, [presetsLoaded, loadPresets]);

  // Status badge vocabulary (owner feedback item 4) — `workspace_id: omit=active` resolves
  // server-side (workspace = 노트북), so this doesn't need the desktop taxonomy store's
  // workspace-scoped load() (stores/taxonomy.ts), which nothing on the mobile path bootstraps.
  // Best-effort: an empty list just means the status sheet only offers the 3 built-ins + "no status".
  useEffect(() => {
    let cancelled = false;
    callSilent<{ statuses: StatusEntry[] }>("workspace_status_list", {})
      .then((r) => {
        if (!cancelled) setCustomStatuses(r.statuses);
      })
      // silent-ok: 상태 어휘는 부가 정보 — 실패하면 기본 3개 + "상태 없음" 만 보인다(callSilent 가 진단은 남겼다).
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const ed = useMobileBodyEditor({ activeNote });
  const { editor } = ed;
  const save = useMobileNoteSave(ed);
  const ops = useMobileSectionOps(ed);
  const capturePreset = useMobileCapturePreset(ed);
  const { inputChips, addChip } = useMobileInputChips({ capture, activeNote });
  const voice = useMobileVoiceTranscript({
    ed,
    bodyUnsavedRef: save.bodyUnsavedRef,
    insertSection: ops.insertSection,
    addChip,
  });
  const upload = useMobileAttachUpload({ onAudioUploaded: voice.onAudioUploaded });
  const { chips: nudgeChips, bubble: nudgeBubble } = useMobileNudgeChips({ ed, activeNote });
  // 문장 위 말풍선의 좌표 기준(.mobile-note-stage)과 보이는 범위(스크롤 영역) — 훅이라 조기 반환 위(함정 1).
  // 콜백 ref → 상태: 말풍선은 이 상자의 자식이라 ref 객체로는 첫 이펙트에서 null 이다(useNudgeBubblePlacement 주석).
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  // [그래도 나가기]가 이 기기에 보관한 글의 복구 — 훅이라 조기 반환 위(함정 1).
  const stash = useMobileUnsavedStash({ ed, noteId: activeNote?.note.id ?? null, bodyUnsavedRef: save.bodyUnsavedRef });
  useFabScrollMargin(editor, scrollEl);
  // M-15: 앱 전환·화면 끄기 → 서버에 못 보낸 글 조용히 보관, 돌아오면 거둔다(훅이라 조기 반환 위 — 함정 1).
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "hidden") void saveRef.current.stashOnHide().catch(() => {}); // silent-ok: 보관은 덤 — putStashes 가 진단을 남긴다
      else saveRef.current.dropHideStash();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  useImperativeHandle(ref, () => ({
    flushAndMeasure: async () => {
      await ed.flushRef.current();
      return editor?.getText().trim().length ?? 0;
    },
    notifyRemoteChange: save.notifyRemoteChange,
    // 업로드가 error 로 남은 채 나가는 것도 같은 관문으로 막는다(사진·파일은 이 화면과 함께 사라진다).
    hasUnsavedFailure: () =>
      save.bodyUnsavedRef.current || save.conflictOpen() || save.noteFailure() || upload.pendingRef.current.some((u) => u.status === "error"),
    showLeaveBlocked: save.showLeaveBlocked,
    markDraftUnsent: save.markDraftUnsent,
  }));

  const getActiveSection = () =>
    ed.sectionRef.current ? { id: ed.sectionRef.current.id, body_md: ed.sectionRef.current.body } : null;

  const handleBack = async () => {
    await ed.flushRef.current();
    onBack();
  };

  if (!activeNote || !editor) return null;

  const note = activeNote.note;
  const availability = selectAiAvailability({ aiEnabled }, { aiReachable });
  const aiReady = availability === "ready";
  const conflictHere = !!save.saveConflict && save.saveConflict.noteId === note.id;
  const conflictSectionName = conflictHere
    ? activeNote.sections.find((s) => s.id === save.saveConflict!.sectionId)?.name?.trim() || undefined
    : undefined;
  // activeBodyEmpty 는 700ms 자동저장 디바운스 뒤에야 움직여서 연달아 치는 동안 낡는다. 그래서 이 값만으로 프리셋 줄을
  // 그리지 않는다 — 독 슬롯이 살아 있는 에디터 문서(editor.isEmpty)로 한 번 더 거르고(dockSlotKind), 칠하는 길목
  // (useMobileCapturePreset::applyCapturePreset)도 비었는지 다시 본다. 뱃지 줄 숨김(위)만 이 낡은 값을 그대로 따른다.
  const showPresets = capture && shouldShowCapturePresets(activeBodyEmpty, capturePreset.presetApplied);
  const textSection = !ed.diagramSection && !ed.sheetSection;
  // 스피드 다이얼의 네 동작(녹음·사진·파일 첨부·AI) — 텍스트 섹션은 떠 있는 FAB 가, 관계도·시트는 독 슬롯의 ＋ 가 같은 것을 부른다.
  // 사진은 탭 핸들러 안에서 동기로 input.click() 까지 가야 한다(MobileSpeedDial::choose) — 상태를 거치지 않는다.
  // AI 는 예전 독 오른쪽 ✨ 버튼이 옮겨 온 것(오너 2026-10-10) — 같은 시트를 연다.
  const speedDial = {
    onOpenVoice: () => setVoiceOpen(true),
    onPickPhoto: () => attachSheetRef.current?.pickGallery(),
    onOpenAttach: () => setAttachSheetOpen(true),
    onOpenAi: () => setAiSheetOpen(true),
    aiReady,
  };
  // Falls back to sectionRef/last-section the same way desktop's resolveActiveSection does, so the
  // strip highlights something on the very first paint (before the note-load effect has run).
  const currentSectionId =
    ed.activeSectionId ?? ed.sectionRef.current?.id ?? activeNote.sections[activeNote.sections.length - 1]?.id ?? null;

  return (
    <>
      <div className="mobile-note-header">
        <button
          type="button"
          className="mobile-icon-btn"
          onClick={() => void handleBack()}
          aria-label={t("mobile.back")}
        >
          <IconArrowLeft size={18} strokeWidth={2} />
        </button>
        <div className="mobile-note-header-meta">
          <div className="mobile-note-title-row">
            <input
              className="mobile-note-title-input"
              value={note.title === "Untitled Note" ? "" : note.title}
              placeholder={t("note.untitled_note")}
              onChange={(e) => setTitle(e.target.value)}
            />
            <MobileSaveStatus />
          </div>
        </div>
      </div>

      <MobileSaveBanner
        savedState={save.savedState}
        conflictHere={conflictHere}
        conflictSectionName={conflictSectionName}
        leaving={save.leaveProceed !== null}
        isBodyUnsaved={() => save.bodyUnsavedRef.current}
        pending={upload.pending}
        retrying={save.retrying}
        onRetryUpload={upload.retryUpload}
        onRetrySave={() => void save.handleRetrySave()}
        onLeaveAnyway={() => void save.handleLeaveAnyway()}
        onConflict={(mode) => void save.handleConflict(mode)}
      />

      {stash.stash && (
        <MobileStashRecoveryBanner
          key={stash.stash.id}
          count={stash.count}
          busy={stash.busy}
          onInsert={() => void stash.insert(stash.stash!)}
          onDiscard={() => stash.discard(stash.stash!)}
        />
      )}

      {/* 충돌·저장 실패 배너가 떠 있는 동안은 K1 배너를 숨긴다 — [불러오기]는 저장 못 한 글 앞에서 무반응이라 헷갈린다(감사 M-19). */}
      {save.remoteChangedNoteId === note.id && !conflictHere && save.savedState !== "failed" && (
        <MobileRemoteChangeBanner onReload={() => void save.handleReloadRemoteChange()} />
      )}

      {/* Empty capture hides the badge row so the editor is the first content. Existing notes
          (and capture after a preset/body) keep the full date/status/region/reminder pills. */}
      {!showPresets && (
      <MobileNoteBadges
        year={note.year}
        month={note.month}
        day={note.day}
        status={note.status}
        region={note.region}
        customStatuses={customStatuses}
        uiLang={uiLang}
        setYear={setNoteYear}
        setEventPrecision={(m, d) => void setEventPrecision(m, d)}
        setStatus={(s) => void setStatus(s)}
        setRegion={(r) => void setRegion(r)}
        setLocation={(lat, lng) => void setLocation(lat, lng)}
        remind={note.remind ?? false}
        startTime={note.start_time ?? null}
        endTime={note.end_time ?? null}
        remindOffsetMin={note.remind_offset_min ?? null}
        rrule={note.rrule ?? null}
        notificationsEnabled={notificationsEnabled}
        onEnableNotifications={() => void setNotificationsEnabled(true)}
        setRemind={(r) => void setRemind(r)}
        setSchedule={(patch) => void setSchedule(patch)}
      />
      )}

      <MobileSectionStrip
        sections={activeNote.sections}
        currentSectionId={currentSectionId}
        onSelect={(s) => void ed.switchSection(s)}
        onRename={ops.renameSection}
        onMove={ops.reorderSection}
        onDelete={ops.deleteSection}
        onAddText={ops.addTextSection}
        onAddDiagram={() => setDiagramSheetOpen(true)}
        onAddSheet={ops.addSheetSection}
      />

      <MobileInputChips chips={inputChips} />

      {ed.readOnly && <div className="mobile-readonly-banner">{t("mobile.readonly_hint")}</div>}

      {/* Positioning root for the FAB: the scrolling body-wrap (MobileNoteBody) can't be it — the FAB must not
          scroll away with the text. Both fill the column the body used to fill on its own.
          data-fab: 떠 있는 FAB 는 텍스트 섹션에만 있다. 관계도·시트는 ＋ 가 독 슬롯으로 가서(아래) 본문 아래 패딩을 안 남긴다. */}
      <div className="mobile-note-stage" data-fab={textSection ? "float" : "dock"} ref={setStageEl}>
        <MobileNoteBody
          editor={editor}
          diagramSection={ed.diagramSection}
          diagramRev={ed.diagramRev}
          sheetSection={ed.sheetSection}
          sheetRev={ed.sheetRev}
          readOnly={ed.readOnly}
          sectionRef={ed.sectionRef}
          attachments={activeNote.attachments}
          pending={upload.pending}
          onRetryUpload={upload.retryUpload}
          voiceRow={voice.voiceRow}
          onOpenNote={onOpenNote}
          scrollRef={setScrollEl}
        />
        {textSection && <MobileNoteFab {...speedDial} scrollEl={scrollEl} />}
        {/* 날짜·지역 제안 — 감지된 문장 위에 뜨는 말풍선. 문서 밖 오버레이라 스크롤하는 본문 안이 아니라 이 상자 안(FAB 옆)에
            둔다. 칩 줄(아래)·독과 달리 레이아웃 높이를 먹지 않는다. */}
        <MobileNudgeBubble editor={editor} model={nudgeBubble} stage={stageEl} scroll={scrollEl} />
      </div>

      {/* 입력 감지 칩 줄(링크·#태그만) — 본문 바로 아래·독 위라 키보드가 열려도 키보드 위에 남는다(.mobile-nudge-row).
          날짜·지역 제안은 위 말풍선(MobileNudgeBubble)이 문장 위에서 맡는다. */}
      <MobileInputChips chips={nudgeChips} variant="nudge" />

      {/* Dock — ALWAYS, on both entry points (owner feedback 2026-07-30 item 1). The dynamic tool slot
          (capture presets while the capture is empty → formatting once there is content → image size when an
          image is selected → the ＋ speed dial on 관계도/시트). ✨ and 저장하기 are gone from here (owner 2026-10-10). */}
      <MobileNoteActionBar
        slot={
          <MobileDockSlot
            editor={editor}
            textSection={textSection}
            readOnly={ed.readOnly}
            showPresets={showPresets}
            customPresets={customPresets}
            todoBodyMd={TODO_PRESET_BODY_MD}
            aiReady={aiReady}
            onApplyPreset={(req) => void capturePreset.applyCapturePreset(req)}
            onGenerateAi={capturePreset.generateAiPreset}
            speedDial={speedDial}
          />
        }
      />

      <MobileAiSheet
        open={aiSheetOpen}
        onClose={() => setAiSheetOpen(false)}
        getActiveSection={getActiveSection}
        insertSection={ops.insertSection}
        activeSectionKind={ed.diagramSection ? "diagram" : ed.sheetSection ? "sheet" : "text"}
        replaceSection={ed.diagramSection ? ops.replaceDiagramSource : ed.sheetSection ? ops.replaceSheetSource : undefined}
      />

      <MobileAttachSheet
        ref={attachSheetRef}
        open={attachSheetOpen}
        onClose={() => setAttachSheetOpen(false)}
        onPick={upload.onFilesPicked}
      />

      <MobileVoiceRecorder
        open={voiceOpen}
        onClose={() => setVoiceOpen(false)}
        onFinished={upload.onVoiceFinished}
        // 완료 뒤 결과 단계(올리기 → 받아 적기 → 미리보기)를 같은 시트에서 — 일은 두 훅이 쥐고 시트는 읽기만 한다.
        stageOf={(file) => voice.stageOf(upload.voiceUploadOf(file))}
        getPosition={getVoicePosition}
      />

      {/* Template -> the SAME insertSection(name, source, "diagram") the AI diagram action uses. */}
      <MobileDiagramSheet
        open={diagramSheetOpen}
        onClose={() => setDiagramSheetOpen(false)}
        onPick={ops.addDiagramSection}
      />
    </>
  );
});

/**
 * 제목 줄 오른쪽 끝의 옅은 저장 상태(오너 2026-10-10, 저장하기 버튼 대신) — 저장 중… / 저장됨 / 저장 안 됨.
 * 같은 `savedState`(stores/notesActive) 를 읽는다: 타이핑하면 onUpdate 가 곧바로 "saving", 700ms 디바운스 뒤 flush 가
 * "saved"/"failed". 실패의 설명·[다시 시도]는 여전히 V5 배너(MobileSaveBanner)가 맡고, 여기는 한 단어뿐이다.
 *
 * 자기 컴포넌트로 뺀 이유: 스토어 구독을 MobileNote 의 조기 반환 위 훅 목록에 하나 더 얹지 않으려고(함정 1), 그리고 이 글자만
 * 다시 그리려고. 초안(아직 노트가 아님)이 "saved" 인 동안은 아무것도 안 그린다 — 저장된 게 없는데 "저장됨" 이라고 하면 거짓이다.
 * 낭독기 알림(aria-live)은 일부러 없다: 키를 칠 때마다 "저장 중" 을 읽게 된다. 실패는 배너가 알린다.
 */
function MobileSaveStatus() {
  const savedState = useNotesStore((s) => s.savedState);
  const draft = useNotesStore((s) => s.activeDraft);
  if (draft && savedState === "saved") return null;
  const label =
    savedState === "saving"
      ? t("mobile.save_status_saving")
      : savedState === "failed"
        ? t("mobile.save_status_failed")
        : t("mobile.save_status_saved");
  return (
    <span className="mobile-save-status" data-testid="mobile-save-status" data-state={savedState}>
      {label}
    </span>
  );
}
