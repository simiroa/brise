/**
 * 폰 노트 화면의 저장 정직성(V5) + 충돌(D2②) + 원격 변경(K1) — 본문 쓰기를 한 곳(flushRef)에서 하고,
 * 실패·충돌·나가기 차단이 그 결과를 따른다.
 *
 * - flushRef.current 의 실제 구현(쓰기 직렬화 · 성공/실패 판정 · 실패 시 sec.body 되돌리기 · bodyUnsavedRef)
 * - 실패 배너의 [다시 시도]·[그래도 나가기](이 기기에 보관 — unsavedStash.ts, 복구는 useMobileUnsavedStash),
 *   충돌 배너의 [복사 후 새로 불러오기]·[덮어쓰기], 원격 변경 [불러오기]
 *
 * flushRef/useSectionEditor 의 등록(registerFlush)은 useMobileSectionView 쪽 — 이 훅은 구현만 매 렌더 덮어 쓴다
 * (오래된 클로저 방지). MobileNoteHandle(useImperativeHandle)은 MobileNote 가 이 훅의 조각으로 조립한다.
 */
import { useRef, useState } from "react";
import { useNotesStore } from "../stores/notes";
import { patchSectionBodyCache } from "../lib/sectionBodyCache";
import { heldConflictBodies } from "../lib/sectionTokens";
import { emitNotice, flushAll } from "../lib/invoke";
import { reportFallback } from "../lib/diag";
import { mdSerializeEditor } from "../lib/mdSerialize";
import { paintSectionBody, unchangedSinceLoad } from "../components/editor/useSectionEditor";
import { t } from "../i18n/t";
import type { MobileBodyEditor } from "./useMobileBodyEditor";
import { clearAllSaveFailures, clearSaveFailed, markSaveFailed, noteHasSaveFailure, retryFailedSaves } from "../lib/sectionSaveFailures";
import { putStashes, removeStash, stashesForNote, type NewUnsavedStash } from "./unsavedStash";

export function useMobileNoteSave(ed: MobileBodyEditor) {
  const { editor, sectionRef, readOnlyRef, timeoutRef, flushRef } = ed;

  // V5: 저장 실패. bodyUnsavedRef = "이 기기에만 있는 본문"(나가기 차단의 근거 — 메타데이터 실패는
  // 낙관적 갱신이 되돌려져 글이 사라지지 않으므로 여기 안 센다). savedState 는 배너 표시용.
  const savedState = useNotesStore((s) => s.savedState);
  // D2②: 다른 기기가 먼저 써서 저장이 거부된 섹션. bodyUnsavedRef·savedState 는 섹션 하나짜리 값이라
  // 다른 섹션의 저장이 성공하면 풀린다 — 충돌 본문은 스토어 게이트에만 남으므로 배너·나가기 차단은 이 값을 직접 본다.
  const saveConflict = useNotesStore((s) => s.saveConflict);
  const conflictOpen = () => {
    const s = useNotesStore.getState();
    return !!s.saveConflict && s.saveConflict.noteId === s.activeNote?.note.id;
  };
  // 이 노트에서 아직 서버에 못 보낸 것이 하나라도 있나 — 본문(섹션별)·시트·관계도·제목·연도·충돌. 단일 출처는 sectionSaveFailures.
  const noteFailure = () => {
    const n = useNotesStore.getState().activeNote;
    return !!n && noteHasSaveFailure(n.note.id, n.sections.map((x) => x.id));
  };
  const bodyUnsavedRef = useRef(false);
  const writeChainRef = useRef<Promise<void>>(Promise.resolve());
  const [retrying, setRetrying] = useState(false);
  const [leaveProceed, setLeaveProceed] = useState<(() => void) | null>(null);
  // W1: K1 원격 변경 배너. note id 로 키를 잡아서(단순 bool 아님) 다른 노트로 넘어가면 자동으로
  // 사라진다 — MobileApp/MobileNote 는 화면 전환 없이 note 만 바뀌는 경로(wiki-link 탭)가 있어서,
  // bool 이면 그 노트에 안 속하는 배너가 새 노트 화면에 눌어붙는다.
  const [remoteChangedNoteId, setRemoteChangedNoteId] = useState<string | null>(null);

  // Flush-on-demand — flushRef itself + registerFlush wiring owned by useSectionEditor (useMobileSectionView);
  // this just supplies the real implementation, refreshed every render (stale-closure guard).
  flushRef.current = async () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    // 쓰기를 직렬화한다 — 진행 중인 쓰기가 끝나기 전에 flush 가 "이미 같음" 으로 돌아가 나가기를
    // 통과시키지 않도록(그 쓰기가 실패하면 아무도 모른다).
    const run = writeChainRef.current.then(async () => {
      const sec = sectionRef.current;
      if (!sec) return;
      if (sec.kind === "diagram" || sec.kind === "sheet" || readOnlyRef.current) return;
      if (!editor || editor.isDestroyed) return;
      const body_md = mdSerializeEditor(editor);
      const store = useNotesStore.getState();
      if (unchangedSinceLoad(sec, body_md, editor)) {
        // 에디터 본문이 서버가 아는 본문과 같다(또는 그 본문을 칠한 뒤 바뀐 게 없다 — 정규형이 아닌 원문) — 이 섹션의 실패는 풀린다(되돌려 쓴 경우). 다른 곳의 실패가 남았으면 "saved" 로 말하지 않는다.
        clearSaveFailed(sec.id);
        if (bodyUnsavedRef.current || store.savedState === "saving") {
          bodyUnsavedRef.current = false;
          store.setSavedState(noteFailure() ? "failed" : "saved");
        }
        return;
      }
      const prev = sec.body;
      sec.body = body_md;
      store.setSavedState("saving");
      let ok = true;
      try {
        // updateSectionBody 는 비초안 노트의 쓰기 실패를 던지지 않고 savedState "failed" 로만 남긴다
        // (초안은 ensureMaterialized 가 던진다) — 둘 다 여기서 실패로 읽는다.
        await useNotesStore.getState().updateSectionBody(sec.id, body_md);
        ok = useNotesStore.getState().savedState !== "failed";
      } catch {
        ok = false;
      }
      // 쓰는 동안 섹션 id 가 바뀔 수 있다(초안 → 실노트: sectionRef 가 새 객체로 교체된다) — 실패의 키와 되돌릴 기준선은 지금 떠 있는 쪽이다.
      const live = sectionRef.current ?? sec;
      if (ok) {
        clearSaveFailed(sec.id);
        clearSaveFailed(live.id);
        bodyUnsavedRef.current = false;
        // 함정 4: 스토어 updateSectionBody 는 activeNote.sections 를 안 고친다. 그대로 두면 다른 섹션에 갔다
        // 돌아올 때 switchSection 이 낡은 본문을 칠하고, 그 위의 다음 편집이 방금 저장한 글을 덮는다
        // (2026-10-07 실에디터 테스트로 재현). 관계도·시트와 같은 한 지점으로 캐시를 맞춘다 — updated_at 은
        // 그대로라 노트 로드 효과의 서버 버전 검사가 지금 타이핑 중인 에디터를 다시 칠하지 않는다.
        // ponytail: 저장 실패 뒤 섹션을 옮기면 그 미저장 본문은 이 캐시에도 없다(나가기 차단만 막는다).
        patchSectionBodyCache(sec.id, body_md);
        useNotesStore.getState().setSavedState(noteFailure() ? "failed" : "saved");
      } else {
        // 되돌려야 다음 flush(다시 시도·나가기)가 "이미 같음" 으로 건너뛰지 않고 다시 보낸다.
        sec.body = prev;
        if (live !== sec && live.body === body_md) live.body = prev;
        markSaveFailed(live.id);
        bodyUnsavedRef.current = true;
        useNotesStore.getState().setSavedState("failed");
      }
    });
    writeChainRef.current = run.catch(() => {}); // silent-ok: run 은 위에서 이미 모든 실패를 상태로 옮긴다
    await run;
  };

  // 가져온 초안의 저장하기가 실패했다(MobileApp.leaveCapture) — 가져온 본문은 **쓰기를 한 번도 시도하지 않았다**: 칠한 본문과 sec.body 가
  // 같아 flush 가 "이미 같음" 으로 건너뛰므로, 이 표시가 없으면 뒤로·탭·언마운트가 실패를 모른 채 나가기를 통과시키고 초안이 버려진다
  // (본문·제목·사진이 경고 없이 사라진다). 기준선(sec.body)을 노트가 아직 없는 초안의 본문("")으로 되돌리면 이후 flush(저장하기 재시도·
  // 뒤로·탭)가 본문을 다시 보내 노트 만들기를 다시 시도하고, 또 실패하면 V5 가 그대로 막아 배너·[그래도 나가기] 보관을 낸다.
  // 본문이 비어 있는 가져오기(제목·사진뿐)는 보낼 글이 없어 지킬 것도 없다 — 한계.
  const markDraftUnsent = () => {
    const sec = sectionRef.current;
    if (!sec || sec.kind !== "text" || readOnlyRef.current) return;
    if (!useNotesStore.getState().activeDraft) return;
    sec.body = "";
  };

  // V5: 실패 배너의 [다시 시도] — 메타데이터 쓰기 대기분(flushAll)과 본문을 다시 보낸다.
  const handleRetrySave = async () => {
    setRetrying(true);
    try {
      await flushAll();
      await retryFailedSaves(); // 보낸 표시를 되돌릴 수 없는 쓰기(AI 가 통째로 바꾼 관계도·시트)
      await flushRef.current();
      // 본문이 멀쩡한데 "failed" 가 남은 건 되돌려진 메타데이터 실패뿐 — 글은 안 잃었으니 표시를 끈다. 시트·관계도·제목·연도 실패가 남았으면 끄지 않는다.
      if (!bodyUnsavedRef.current && !noteFailure()) {
        useNotesStore.getState().setSavedState("saved");
        setLeaveProceed(null);
      }
    } finally {
      setRetrying(false);
    }
  };

  // 나가면 화면과 함께 사라질, 서버에 못 보낸 본문들. 지금 에디터가 보여 주는 본문(실패한 쓰기가 있는 텍스트 섹션)
  // + 충돌 게이트가 쥔 다른 섹션들의 본문(폰은 섹션을 옮기면 에디터가 다른 섹션을 그리므로 게이트가 유일한 사본이다).
  // 에디터에 없는 본문(관계도·시트·읽기 전용 섹션을 보는 중)은 건질 것이 없다 — 이전에도 빈 문자열을 복사했을 뿐이다.
  const collectUnsaved = (): NewUnsavedStash[] => {
    const note = useNotesStore.getState().activeNote;
    const sec = sectionRef.current;
    if (!note || !editor || editor.isDestroyed) return [];
    const nameOf = (id: string) => note.sections.find((s) => s.id === id)?.name ?? "";
    const out: NewUnsavedStash[] = [];
    const covered = new Set<string>();
    if (bodyUnsavedRef.current && sec && sec.kind !== "diagram" && sec.kind !== "sheet" && !readOnlyRef.current) {
      const bodyMd = mdSerializeEditor(editor);
      if (bodyMd.trim()) {
        // 초안은 제목이 따로 저장되지 않는다 — 가져온 글의 제목(공유한 페이지 제목 등)이 복구 섹션 이름으로 살아남게 한다.
        const draftTitle = note.note.id === "__draft__" && note.note.title !== "Untitled Note" ? note.note.title.trim() : "";
        out.push({ noteId: note.note.id, sectionId: sec.id, sectionName: draftTitle || nameOf(sec.id), kind: "text", bodyMd });
        covered.add(sec.id);
      }
    }
    if (conflictOpen()) {
      // 현재 섹션도 여기서 담긴다 — 다른 섹션의 저장이 성공해 bodyUnsavedRef 가 풀린 뒤에는 에디터 본문이 위에서 안 담기고
      // 충돌 본문은 게이트에만 남아 있다. 위에서 이미 담은 섹션만 건너뛴다.
      for (const [sectionId, bodyMd] of heldConflictBodies()) {
        const held = note.sections.find((s) => s.id === sectionId);
        if (!held || covered.has(sectionId) || !bodyMd.trim()) continue;
        // kind 가 빠진 응답(kind 를 모르는 옛 백엔드)은 본문으로 본다 — 그대로 두면 보관함 읽기가 모양이 틀린 항목으로 걸러낸다.
        out.push({ noteId: note.note.id, sectionId, sectionName: held.name, kind: held.kind ?? "text", bodyMd });
      }
    }
    return out;
  };

  // V5: [그래도 나가기]. 서버에 못 보낸 본문이 화면과 함께 사라지므로 이 기기에 먼저 보관한다(unsavedStash.ts) —
  // 그 노트를 다시 열면 복구 배너가 뜬다(useMobileUnsavedStash). 클립보드는 덤이다: 폰은 http://100.x 비보안
  // 컨텍스트라 navigator.clipboard 가 없을 수 있어 그것에 기대면 영영 못 나간다. 보관에도 실패했고 복사도
  // 못 했을 때만 나가지 않는다(조용한 유실 금지). 본문은 진단 로그에 넣지 않는다.
  const handleLeaveAnyway = async () => {
    const proceed = leaveProceed;
    if (!proceed || !editor || editor.isDestroyed) return;
    // 본문은 멀쩡하고 업로드만 실패한 경우엔 건질 글이 없다.
    let keptDraft = false;
    if (bodyUnsavedRef.current || conflictOpen()) {
      const entries = collectUnsaved();
      if (entries.length > 0) {
        const stashed = putStashes(entries);
        keptDraft = stashed && entries.some((e) => e.noteId === "__draft__");
        let copied = false;
        try {
          if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(entries[0].bodyMd);
            copied = true;
          }
        } catch {
          // silent-ok: 클립보드는 덤 — 보관(stash) 결과가 나가기를 판정한다(복사 불가는 비보안 컨텍스트의 정상 경로)
        }
        if (!stashed && !copied) {
          reportFallback("mobile-save", "leave_stash_failed");
          emitNotice(t("mobile.save_stash_failed"));
          return;
        }
        if (!stashed) reportFallback("mobile-save", "leave_stash_failed", "clipboard only");
        emitNotice(t(stashed ? "mobile.save_stashed" : "mobile.save_copied"));
      }
    }
    reportFallback("mobile-save", bodyUnsavedRef.current ? "leave_forced" : "leave_forced_upload");
    bodyUnsavedRef.current = false;
    clearAllSaveFailures();
    useNotesStore.getState().setSavedState("saved");
    setLeaveProceed(null);
    // 초안은 보관본이 이제 글의 유일한 사본이다(실제 노트와 같은 규칙) — 초안을 남기면 다음 입력 화면이 같은 글을 에디터에 다시 칠하고
    // (newNote 는 열린 초안을 안 바꾼다) 복구 배너도 같은 글로 떠서 [새 섹션으로 넣기]가 글을 두 번 넣는다. 보관 없이 클립보드만 성공한
    // 경우엔 초안이 더 안전한 사본이라 남긴다.
    if (keptDraft && useNotesStore.getState().activeDraft) {
      // 초안을 치우면 activeNote 가 null 이 되는데 나가는 길의 flush(navigate 의 flushAll·언마운트 정리)가 아직 남아 있다 — 기준선을
      // 에디터가 지금 쥔 본문으로 맞춰 그 flush 들이 "이미 같음" 으로 끝나게 한다(안 그러면 사라진 초안의 섹션 id 로 section_update 가 나간다).
      const sec = sectionRef.current;
      if (sec && sec.kind === "text" && !readOnlyRef.current) sec.body = mdSerializeEditor(editor);
      useNotesStore.getState().discardDraft();
    }
    proceed();
  };

  // M-15: 앱이 백그라운드로 가면(안드로이드는 pagehide 가 안 온다) 서버에 못 보낸 본문을 조용히 보관한다 — OS 가 프로세스를 죽이면
  // 화면의 글이 같이 사라진다. 먼저 flush 를 한 번 더 시도하고, 그래도 남은 것(실패·충돌)만 담는다. 같은 섹션은 직전 숨김 보관본을
  // 갈아 끼워(반복 숨김이 쌓이지 않게) 돌아오면 지운다 — 글은 여전히 화면에 있고, 남겨 두면 복구 배너가 같은 글을 또 묻는다.
  const hideStashIdsRef = useRef<string[]>([]);
  const dropHideStash = () => {
    for (const id of hideStashIdsRef.current) removeStash(id);
    hideStashIdsRef.current = [];
  };
  const stashOnHide = async () => {
    await flushRef.current();
    if (!bodyUnsavedRef.current && !conflictOpen()) return;
    const entries = collectUnsaved();
    if (entries.length === 0) return;
    dropHideStash();
    if (!putStashes(entries)) return; // putStashes 가 이유를 진단 로그에 남겼다
    hideStashIdsRef.current = entries.flatMap((e) =>
      stashesForNote(e.noteId)
        .filter((x) => x.sectionId === e.sectionId && x.kind === e.kind && x.bodyMd === e.bodyMd)
        .map((x) => x.id),
    );
  };

  // K1 배너의 [불러오기]. 데스크톱 편집을 당겨오기 전에 이 기기의 미저장 버퍼부터 커밋한다(다른
  // 나가기 경로 — handleBack/saveAndLeaveNote — 와 같은 flush-먼저 관례). reloadActive() 뒤 배너는
  // note id 매치가 깨지므로 자동으로 사라지지만, 명시적으로도 지워 다음 tick 의 깜빡임을 없앤다.
  const handleReloadRemoteChange = async () => {
    await flushRef.current();
    // V5: 저장 못 한 본문이 있으면 원격본으로 덮어쓰지 않는다 — 실패 배너가 이미 떠 있다(충돌 포함).
    if (bodyUnsavedRef.current || conflictOpen() || noteFailure()) return;
    await useNotesStore.getState().reloadActive();
    setRemoteChangedNoteId(null);
  };

  // D2② 충돌 배너. 본문은 스토어 게이트가 쥔 값(먼저 flushAll 로 모은다) — 클립보드는 쓰지 않는다
  // (폰은 http://100.x 비보안 컨텍스트라 Clipboard API 가 없다).
  const handleConflict = async (mode: "copy" | "overwrite") => {
    setRetrying(true);
    try {
      if (!(await useNotesStore.getState().resolveSaveConflict(mode))) return;
      if (mode === "copy") {
        // 다시 읽은 서버본을 그린다. 실패 뒤 sec.body 가 옛 값으로 되돌려져 있어 note-load 효과가
        // "같음"으로 건너뛸 수 있다(원격 변경이 정렬뿐이면) — 그러면 내 본문이 남아 다음 저장이 덮는다.
        const cur = sectionRef.current;
        if (cur) clearSaveFailed(cur.id); // 내 본문은 사본 섹션으로 갔고 서버본을 다시 읽었다 — 이 섹션의 실패는 풀린다
        const fresh = cur && useNotesStore.getState().activeNote?.sections.find((s) => s.id === cur.id);
        if (fresh && fresh.kind === "text" && editor && !editor.isDestroyed && !readOnlyRef.current) {
          ed.setActiveSection({ id: fresh.id, body: fresh.body_md, kind: fresh.kind });
          if (mdSerializeEditor(editor) !== fresh.body_md) paintSectionBody(editor, sectionRef.current, fresh.body_md);
        }
        // 시트 편집기는 마운트 때만 본문을 읽는다 — 다시 읽은 서버본으로 다시 마운트(관계도는 body_md 를 따라간다).
        if (cur?.kind === "sheet") ed.remountSheet();
        bodyUnsavedRef.current = false;
      } else {
        // 덮어쓰기는 게이트의 본문을 보냈다 — 지금 화면의 본문도 같은 길로 맞춘다(같으면 무동작).
        await flushRef.current();
      }
      if (!bodyUnsavedRef.current) setLeaveProceed(null);
    } finally {
      setRetrying(false);
    }
  };

  return {
    savedState,
    saveConflict,
    bodyUnsavedRef,
    conflictOpen,
    noteFailure,
    retrying,
    leaveProceed,
    remoteChangedNoteId,
    handleRetrySave,
    stashOnHide,
    dropHideStash,
    handleLeaveAnyway,
    handleReloadRemoteChange,
    handleConflict,
    /** MobileNoteHandle.markDraftUnsent — 가져온 초안의 저장하기가 실패했을 때 MobileApp 이 부른다. */
    markDraftUnsent,
    /** MobileNoteHandle.notifyRemoteChange — 렌더 쪽이 note.id 로 다시 비교하므로 여기선 체크가 필요 없다. */
    notifyRemoteChange: (noteId: string) => setRemoteChangedNoteId(noteId),
    /** MobileNoteHandle.showLeaveBlocked — 나가기를 막았을 때 MobileApp 이 부른다. */
    showLeaveBlocked: (proceed: () => void) => setLeaveProceed(() => proceed),
  };
}
