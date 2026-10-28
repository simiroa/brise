import { withExportDir } from "./exportDir";
import { call, callSilent, emitNotice, flushAll } from "./invoke";
import { useNotesStore, isNoteContentLocked } from "../stores/notes";
import { useSettingsStore } from "../stores/settings";
import { useUiStore } from "../stores/ui";
import { isNoteTabId, useTabsStore } from "../stores/tabs";
import { EXTRACTABLE_EXTS, fileExt, DOC_IMPORT_HTML_EXTS } from "./fileKinds";
import { addDropped, droppedNotice, importOneFile } from "./docImport";
import type {
  Attachment,
  ExportSectionMdOutput,
  ExportFolderOutput,
  ExportNoteOutput,
  Folder,
  NoteDetail,
  NoteSummary,
  PetNoteCreateOutput,
  Section,
  SectionImportScanOutput,
  Source,
} from "./commands.gen";
import { t } from "../i18n/t";
import { runBatch, type BatchResult } from "./batchActions";
import { showUndoToast } from "./undo";
import { emitProgress } from "./progressToast";
import { announceSaved } from "../components/export/exportSave";

/** 3개 미만은 순식간에 끝나 진행 토스트가 깜빡이기만 한다 — 그 아래는 아예 띄우지 않는다.
 *  단 서식형(hwpx·docx)은 한 개여도 몇 초 걸리므로(L-7) 개수와 무관하게 띄운다. */
const IMPORT_PROGRESS_MIN_FILES = 3;
const IMPORT_PROGRESS_KEY = "import_sections";
/** 가져오기 배치 재진입 방지(L-7) — 진행 중에 다시 눌러 섹션이 중복되는 것을 막는다. */
let importInFlight = false;

/**
 * exportNote: 노트 하나를 .md 로. 지금은 내보내기 모달(components/export/ExportModal)의 "Markdown"(노트 전체) 저장만
 * 이 함수를 부른다 — TitleBar.tsx·ContextMenu.tsx 는 모달을 열 뿐이다(예전엔 둘이 이 함수를 직접 불렀다).
 * HTML 은 W6 에서 빠졌다(마크다운 원문을 <pre> 로 감싼 덤프였다) — 읽히는 HTML 은 모달의 "HTML"(export_html)이다.
 * Runs export_note (async 커맨드 — 첨부 복사가 메인 스레드를 막지 않는다), 트리는 loadTree 로 통째로 다시 읽지 않고
 * `patchNoteSummary(id, { exported_at })` 한 줄로 갱신한다(트리 내보내기 아이콘). 완료는 `announceSaved` — [열기]·[폴더 열기].
 * If the save dialog is cancelled (dest === null) or the
 * plugin-dialog import itself throws (non-Tauri / test environment), this quietly does nothing —
 * both original call sites wrapped the whole body in the same empty catch.
 *
 * 모달이 닫을지 가리도록 **썼으면 true**, 취소·실패(call() 이 이미 토스트)면 false 를 돌려준다.
 */
export async function exportNote(id: string, noteTitle: string): Promise<boolean> {
  let wrote = false; // 파일을 쓴 뒤 트리 갱신이 던져도 "썼다"는 사실은 남는다
  try {
    const slug = (noteTitle || t("note.untitled_note")).replace(/[\\/:*?"<>|]/g, "_");

    const { save } = await import("@tauri-apps/plugin-dialog");
    const dest = await save({
      defaultPath: withExportDir(`${slug}.md`),
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!dest) return false;
    // dest_path = 고른 .md 파일 경로 그대로(첨부는 그 옆 {파일 이름}_files/) — specs/commands/export.yaml export_note.
    const out = await call<ExportNoteOutput>("export_note", { id, dest_path: dest });
    wrote = true;
    useNotesStore.getState().patchNoteSummary(id, { exported_at: out?.exported_at ?? new Date().toISOString() });
    announceSaved(out?.written_path || dest);
    return true;
  } catch {
    /* dialog unavailable */
    return wrote;
  }
}

/**
 * renameNote: note_update({id, title}) → patch the tree in place → resync active note if it's
 * the one renamed. TitleBar's old runRename and ContextMenu's rename-dialog note branch (not the
 * folder branch, which stays in ContextMenu — folder_rename is a folder-level action) ran this
 * exact sequence, previously via a full loadTree() reload.
 *
 * 2026-09-13 perf audit (CDP, 100k-note corpus): loadTree() re-fetches the *entire* notebook via
 * the LIMIT-less `folder_list` command — 2.6s+ measured at 100k, paid on every rename. note_update
 * already returns the fresh NoteSummary row, so patchNoteSummary (which also relocates the row
 * between notesByFolder[folder_id] arrays if folder_id changed) is a drop-in, O(1) replacement.
 */
export async function renameNote(id: string, title: string): Promise<void> {
  const updated = await call<NoteSummary>("note_update", { id, title });
  useNotesStore.getState().patchNoteSummary(id, updated);
  if (useNotesStore.getState().activeNote?.note.id === id) {
    await useNotesStore.getState().selectNote(id);
  }
}

/**
 * moveNote: note_update({id, folder_id}) → patch the tree in place → resync active note if it's
 * the one moved. Same refresh shape as renameNote / ContextMenu runMoveFolder — tree membership
 * derives from notesByFolder, and activeNote.note.folder_id must re-read after the move. See
 * renameNote's comment above for why this no longer calls loadTree().
 */
export async function moveNote(id: string, folderId: string): Promise<void> {
  // 내용잠금: 대상 노트가 지금 열려 있지 않을 수도 있다(트리 다중선택 이동, 모바일 액션시트) —
  // activeNote만 보면 안 되므로 id-keyed 헬퍼(stores/notes.ts::isNoteContentLocked)를 쓴다.
  if (isNoteContentLocked(id)) {
    emitNotice(t("editor.content_locked_tooltip"));
    return;
  }
  const updated = await call<NoteSummary>("note_update", { id, folder_id: folderId });
  useNotesStore.getState().patchNoteSummary(id, updated);
  if (useNotesStore.getState().activeNote?.note.id === id) {
    await useNotesStore.getState().selectNote(id);
  }
}

/**
 * toggleFavorite: note_toggle_favorite({id}) → patch the tree in place → resync active note if
 * it's the one toggled. Same shape as renameNote/moveNote — extracted so a note row that ISN'T
 * the open note (mobile's tree/action-sheet verbs; see MobileActionSheet.tsx) has a gateway too,
 * without duplicating ContextMenu.tsx's local toggleFav (that one also closes the context menu, a
 * UI concern this shared function deliberately leaves to its caller). See renameNote's comment
 * above for why this no longer calls loadTree().
 */
export async function toggleFavorite(id: string): Promise<void> {
  const { is_favorite } = await call<{ is_favorite: boolean }>("note_toggle_favorite", { id });
  useNotesStore.getState().patchNoteSummary(id, { is_favorite });
  if (useNotesStore.getState().activeNote?.note.id === id) {
    await useNotesStore.getState().selectNote(id);
  }
}

/**
 * Append a server-created section while keeping the active-note cache coherent. Link suggestion
 * acceptance is a background action, but an open target note must still repaint immediately after
 * the persisted section is added.
 *
 * kind (additive — AttachmentsBar "섹션으로 가져오기" 사료 승격): section_create_with_body 는 이미
 * kind 를 받는다(specs/commands/sections.yaml). 생략 시 기존 동작 그대로 'text'.
 */
export async function appendSectionWithBody(
  noteId: string,
  name: string | undefined,
  bodyMd: string,
  kind?: "text" | "diagram" | "sheet",
): Promise<Section> {
  await flushAll();
  const section = await call<Section>("section_create_with_body", {
    note_id: noteId,
    name,
    body_md: bodyMd,
    ...(kind ? { kind } : {}),
  });
  if (useNotesStore.getState().activeNote?.note.id === noteId) {
    await useNotesStore.getState().reloadActive();
  } else {
    await useNotesStore.getState().loadTree();
  }
  return section;
}

/** 드롭·추가로 막 들어온 첨부(또는 텍스트 추출 소스)를 어시스트 미리보기에 바로 띄운다 — 접혀 있으면 펼친다.
 *  세 드롭 입구(미리보기 패널·첨부바·에디터 본문)와 파일 추가가 한 곳을 지나가게 하는 관문. */
export function previewNewAttachment(id: string, kind: "attachment" | "source" = "attachment") {
  useUiStore.setState({ previewCollapsed: false });
  useUiStore.getState().setPreviewItem({ kind, id });
}

/**
 * attachFile: 파일 하나를 노트의 첨부로 라우팅한다 — EXTRACTABLE_EXTS(pdf/docx/txt/md/pptx)면
 * source_add_file(텍스트 추출, 검색 가능해짐; sourceOriginalPolicy가 "ask"면 askKeepOriginal()로
 * 원본 보관 여부를 물어 그 결과로 original_policy를 정한다), 그 외는 attachment_add_file(단순 복사)
 * 이다. useAttachmentActions.ts의 addOneFile(파일피커·드래그&드롭 공통 지점)과 TitleBar.tsx "…" 메뉴
 * "가져오기"의 비문서/첨부-전용 갈래, 두 곳이 이 판정+라우팅을 그대로 필요로 해서 뽑아냈다
 * (.claude/CLAUDE.md 코드 방침: 두 번째 사용처가 생겼을 때 추상화).
 *
 * 내용잠금 체크는 **여기 없다** — 두 호출부 모두 이미 자기 자리에서 activeNote/note의
 * content_locked를 확인하고 있고(addOneFile은 activeNote 클로저, TitleBar는 메뉴 버튼 자체가
 * disabled), 각자 확인하는 것이 기존 패턴과 맞다(공유 함수로 옮기면 TitleBar 쪽 체크가 중복된다).
 *
 * askKeepOriginal은 콜백으로 받는다 — "물어야 하는 대화상자"를 어떻게 띄울지는 호출자마다 다르다
 * (useAttachmentActions는 AttachmentsBar가 소유한 ActionDialog, TitleBar는 자기 TbDialog).
 */
export async function attachFile(
  noteId: string,
  path: string,
  askKeepOriginal: () => Promise<boolean>,
): Promise<void> {
  const ext = fileExt(path);
  if (!EXTRACTABLE_EXTS.has(ext)) {
    const att = await call<Attachment>("attachment_add_file", { note_id: noteId, file_path: path });
    if (att?.id) previewNewAttachment(att.id);
    return;
  }
  const policy = useSettingsStore.getState().sourceOriginalPolicy;
  const originalPolicy: "keep" | "discard" =
    policy === "keep" || policy === "discard" ? policy : (await askKeepOriginal()) ? "keep" : "discard";
  const src = await call<Source>("source_add_file", {
    note_id: noteId,
    file_path: path,
    original_policy: originalPolicy,
  });
  if (src?.id) previewNewAttachment(src.id, "source");
}

/**
 * importFilesAsSections: 파일/폴더 경로를 section_import_scan 으로 먼저 펼친 뒤(파일은 통과,
 * 폴더는 내부의 지원 파일로 확장 — specs/commands/sections.yaml), 그 결과를 순서대로
 * section_import_file 에 넘겨 각각 새 섹션으로 만든다 — TitleBar "…" 메뉴 다중 선택 · 에디터
 * 본문 드롭(useEditorFileDrop)이 공유한다. 이 스캔 단계가 두 호출부의 유일한 확장자/폴더 판정
 * 지점이다 — 프런트가 파일시스템을 못 읽어 파일/폴더를 여기서 구분할 수 없으므로(scan 커맨드가
 * 존재하는 이유), 지원하지 않는 확장자나 폴더가 아닌 무언가도 scan이 skipped 로 걸러준다.
 *
 * xlsx 는 워크시트 한 장당 섹션 하나가 되므로 section_import_file 의 출력이 `sections: Section[]`
 * 배열이다(나머지 형식은 항상 길이 1) — 파일마다 나온 배열을 순서대로 이어붙인다.
 *
 * 파일 하나를 섹션으로 만드는 일은 importOneFile 한 곳이다 — hwpx·docx 는 서식형(doc_import_html, 못 만들면
 * section_import_file 로 후퇴), 나머지는 section_import_file 그대로. 서식형이 옮기지 못한 요소(dropped)는
 * 파일들을 합산해 끝에 한 줄로 알린다. 되돌리기는 만들어진 섹션 id 로 하므로 서식형 섹션도 똑같이 지운다.
 *
 * runBatch(lib/batchActions.ts)를 그대로 쓴다 — 한 파일이 실패해도(call()이 이미 AppError
 * 토스트를 띄운다) 나머지는 계속 진행하는 것이 기존 배치 관례다. 진행 중에는 runBatch의 기존
 * onProgress(이전엔 아무도 안 쓰던 인자)로 진행 토스트(lib/progressToast.ts)를 갱신한다 —
 * 파일이 IMPORT_PROGRESS_MIN_FILES 미만이면 순식간에 끝나 깜빡임만 남으므로 아예 띄우지 않고,
 * 띄웠으면 성공/실패/예외 어느 경로로 끝나든 finally 로 반드시 지운다(안 지우면 화면에 영원히
 * 남는다). 끝나면 성공/실패 개수를 한 번 더 요약하는데(reportBatch 와 같은 패턴이지만 그 문구
 * "선택된 채로 남아 있습니다"는 파일 가져오기와 맞지 않아 전용 문구를 쓴다), 하나 이상 섹션이
 * 만들어졌으면 그 요약을 되돌리기 버튼이 달린 토스트(showUndoToast)로 띄운다 — 가져오기는
 * 삭제처럼 분명한 단일 행동이라 전역 Ctrl+Z 슬롯(undo.ts latestUndo)을 갖는 게 맞고,
 * useAppHotkeys.ts 가 텍스트 편집 중에는 전역 Ctrl+Z 를 아예 타지 않으므로(TipTap 자신의
 * undo 가 먼저 — lib/hooks/useAppHotkeys.ts) 에디터 입력과 충돌하지 않는다. 만들어진 섹션이
 * 하나도 없으면(예: 스캔은 통과했지만 모든 section_import_file 이 실패) 되돌릴 게 없으니
 * 평범한 알림으로 남긴다. truncated(CSV/TSV/xlsx 상한 절단)는 하나라도 있으면 별도로 알린다.
 *
 * ponytail: 5초(undo.ts DELAY_MS) 창 안에 사용자가 방금 들어온 섹션을 편집한 뒤 되돌리면 그
 * 편집도 함께 사라진다 — 지금은 되돌리기가 곧 section_delete 라서다. 천장은 여기까지이고,
 * 업그레이드 경로는 삭제를 휴지통(soft delete) 경유로 바꾸는 것(note_delete/trash 가 이미 쓰는
 * 패턴, showUndoToast 의 Tier 2 주석 참고) — 지금은 하지 않는다.
 */
export async function importFilesAsSections(noteId: string, paths: string[]): Promise<Section[]> {
  if (paths.length === 0) return [];
  if (importInFlight) {
    emitNotice(t("export.import_busy"));
    return [];
  }
  importInFlight = true;
  try {
    return await importFilesAsSectionsImpl(noteId, paths);
  } finally {
    importInFlight = false;
  }
}

async function importFilesAsSectionsImpl(noteId: string, paths: string[]): Promise<Section[]> {

  let files: string[];
  let skipped: number;
  try {
    const scan = await call<SectionImportScanOutput>("section_import_scan", { paths });
    files = scan.files;
    skipped = scan.skipped;
  } catch {
    return []; // call()이 이미 AppError 토스트를 표출함
  }
  if (skipped > 0) {
    emitNotice(t("editor.section_import_skipped", { n: skipped }));
  }
  if (files.length === 0) return [];

  await flushAll();
  const sections: Section[] = [];
  let anyTruncated = false;
  const droppedTotals = new Map<string, number>();
  const showProgress =
    files.length >= IMPORT_PROGRESS_MIN_FILES || files.some((f) => DOC_IMPORT_HTML_EXTS.has(fileExt(f)));
  let fellBack = 0;
  let res: BatchResult;
  // runBatch 의 onProgress 는 **한 건이 끝난 뒤** 처음 불린다 — 큰 pdf 한 장이 몇 초 걸리면
  // 그동안 다시 무반응이 되어 이 기능이 없애려던 바로 그 구간이 남는다. 0/N 을 먼저 띄운다.
  if (showProgress) {
    emitProgress(IMPORT_PROGRESS_KEY, t("editor.section_import_progress", { done: 0, total: files.length }));
  }
  try {
    res = await runBatch(
      files,
      async (path) => {
        const out = await importOneFile(noteId, path);
        sections.push(...out.sections);
        if (out.truncated) anyTruncated = true;
        if (out.fellBackToText) fellBack += 1;
        addDropped(droppedTotals, out.dropped);
      },
      showProgress
        ? (done, total) => emitProgress(IMPORT_PROGRESS_KEY, t("editor.section_import_progress", { done, total }))
        : undefined,
    );
  } finally {
    if (showProgress) emitProgress(IMPORT_PROGRESS_KEY, null);
  }
  if (anyTruncated) emitNotice(t("editor.section_import_truncated"));
  const droppedMsg = droppedNotice(droppedTotals);
  if (droppedMsg) emitNotice(droppedMsg);
  if (fellBack > 0) emitNotice(t("export.import_fallback_text", { n: fellBack }));

  // 문구가 "N개 섹션"이므로 파일 수가 아니라 실제로 만들어진 섹션 수를 센다 — xlsx 는 파일
  // 하나가 워크시트 수만큼 섹션을 만든다. 실패가 섞인 갈래는 반대로 **파일** 기준이 맞다
  // (어느 파일이 안 됐는지가 사용자가 알아야 할 것이다).
  const summary =
    res.failed.length === 0
      ? t("editor.section_import_done", { n: sections.length })
      : t("editor.section_import_partial", { ok: res.ok.length, failed: res.failed.length });
  if (sections.length > 0) {
    const createdIds = sections.map((s) => s.id);
    showUndoToast(summary, () => {
      void undoImportedSections(noteId, createdIds);
    });
  } else {
    emitNotice(summary);
  }

  if (useNotesStore.getState().activeNote?.note.id === noteId) {
    await useNotesStore.getState().reloadActive();
  }
  return sections;
}

/**
 * undoImportedSections: reverses one importFilesAsSections call — deletes only the section ids
 * *that import created*, not the whole batch's target files. flushAll() first, same reason as
 * deleteNote(): a still-pending debounced section_update against a section we're about to delete
 * would otherwise race and surface a false NOT_FOUND toast. runBatch so one CONFLICT (section_delete
 * rejects deleting a note's last remaining section — specs/commands/sections.yaml) doesn't stop
 * the rest; imports always land on a note that already had a section so this shouldn't trip in the
 * normal path, but the failure isn't swallowed either way — the caller reports ok/failed counts.
 *
 * Deliberately does NOT reach into EditorPanel's sectionRef/switchSection (useSectionActions.ts's
 * handleDeleteSection does, to avoid a debounced write landing on the section it's about to switch
 * away from) — this lib-layer function has no access to that editor-local ref. flushAll() already
 * covers the same race, and EditorPanel's note-load effect (the one watching `activeNote`) already
 * falls back to another section on its own once reloadActive() swaps in a sections list that no
 * longer contains the currently-open one — see the `sameNote` check there.
 */
export async function undoImportedSections(noteId: string, sectionIds: string[]): Promise<void> {
  await flushAll();
  const res = await runBatch(sectionIds, async (id) => {
    await call("section_delete", { id });
  });
  if (useNotesStore.getState().activeNote?.note.id === noteId) {
    await useNotesStore.getState().reloadActive();
  }
  if (res.failed.length === 0) {
    emitNotice(t("editor.section_import_undo_done", { n: res.ok.length }));
  } else {
    emitNotice(t("editor.section_import_undo_partial", { ok: res.ok.length, failed: res.failed.length }));
  }
}

/**
 * exportSectionMd: 텍스트 섹션 하나를 .md 파일로. 내보내기 모달(components/export/ExportModal)의
 * "이 섹션 · Markdown" 저장이 부른다(SectionTabBar.tsx 섹션 탭 우클릭 "내보내기…"(kind==='text')는 그
 * 모달을 연다). exportNote와 같은 모양(저장 다이얼로그 → export 커맨드 → 알림) — 다이얼로그 취소/
 * plugin-dialog 미가용은 조용히 넘어간다(exportNote와 동일 이유).
 * 반환값은 exportNote 와 같다 — 썼으면 true, 취소·실패면 false.
 */
export async function exportSectionMd(id: string, sectionName: string): Promise<boolean> {
  try {
    const slug = (sectionName.trim() || "section").replace(/[\\/:*?"<>|]/g, "_");
    const { save } = await import("@tauri-apps/plugin-dialog");
    const dest = await save({
      defaultPath: withExportDir(`${slug}.md`),
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!dest) return false;
    const out = await call<ExportSectionMdOutput>("export_section_md", { id, dest_path: dest });
    announceSaved(out?.written_path || dest);
    return true;
  } catch {
    /* dialog unavailable, or call() already toasted the AppError (e.g. kind !== 'text') */
    return false;
  }
}

/** Create an inbox memo through the shared note mutation layer and refresh the note index. */
export async function createInboxMemo(text: string, title?: string): Promise<PetNoteCreateOutput> {
  const created = await call<PetNoteCreateOutput>("pet_note_create", { text, title });
  await useNotesStore.getState().loadTree();
  return created;
}

/**
 * deleteNote: flushAll() first — pending debounced saves (title/year/section body) must land
 * BEFORE the note is deleted, otherwise a later flushAll() (e.g. inside selectNote()) fires a
 * section_update against the just-deleted note's section and fails NOT_FOUND, surfacing a false
 * "save failed" toast. Then note_delete → closeTab → loadTree → selectNote(next) if another tab
 * remains open.
 *
 * Error handling is NOT included here on purpose: TitleBar's original runDelete wrapped this
 * sequence in try/catch + emitNotice on failure, while ContextMenu's original runDelete did not
 * (its call site is `void runDelete(id)`, so a failure was an unhandled rejection). That is a
 * real behavioral difference between the two call sites, not an accidental one — folding it into
 * this shared function would change one side's error-path behavior. So this function provides
 * only the pure sequence; each component keeps its own (differing) error handling around the call.
 *
 * removeNoteSummary (not loadTree()) refreshes the tree — see renameNote's comment for the perf
 * reasoning (2.6s+ full-corpus reload at 100k notes, paid here on every delete otherwise).
 */
export async function deleteNote(id: string): Promise<void> {
  await flushAll();
  await call("note_delete", { id });
  useTabsStore.getState().closeTab(id);
  useNotesStore.getState().removeNoteSummary(id);
  const next = useTabsStore.getState().activeTabId;
  // After the last note tab is closed, closeTab activates the home sentinel — not a note id.
  // selectNote(HOME_TAB_ID) would hit note_get and fail; clear the editor instead.
  if (isNoteTabId(next) && next !== id) {
    await useNotesStore.getState().selectNote(next);
  } else if (!isNoteTabId(next)) {
    useNotesStore.getState().discardDraft();
    useNotesStore.setState({ activeNote: null, activeDraft: false });
  }
}

/**
 * addNoteTags: 노트에 태그를 **추가**한다(교체가 아니라 합집합).
 *
 * `note_set_tags` 는 전체 교체 커맨드라 그대로 부르면 기존 태그가 날아간다 — 현재 태그를
 * noteIndex 에서 읽어 합친 뒤 넘긴다. W7-g 다중선택의 "태그 추가" 가 이 함수를 id 마다 반복
 * 호출한다(§9 레이어 규칙: 컴포넌트가 note_set_tags 를 직접 찍고 캐시를 우회하지 않는다).
 * 캐시에 없는 노트(부분 캐시 밖의 검색 히트 등)는 현재 태그를 알 수 없으므로 노트를 조회해
 * 읽는다 — 모른 채 덮어써서 태그를 지우는 것보다 왕복 한 번이 싸다.
 */
export async function addNoteTags(id: string, tagNames: string[]): Promise<void> {
  const clean = tagNames.map((s) => s.trim()).filter(Boolean);
  if (clean.length === 0) return;
  let current = useNotesStore.getState().noteIndex.get(id)?.tag_names;
  if (!current) {
    const detail = await call<NoteDetail>("note_get", { id });
    current = detail.note.tag_names;
  }
  const merged = [...new Set([...current, ...clean])];
  if (merged.length === current.length) return;
  await call<{ tag_names: string[] }>("note_set_tags", { id, tag_names: merged });
  useNotesStore.getState().patchNoteSummary(id, { tag_names: merged });
}

/**
 * setTagColor: tag_set_color({name, color_hue}) → refresh tag_colors → update store.
 * Extracted from TagsFilter.tsx and TagsExpandedCloud.tsx.
 * Swallows errors because callSilent() already surfaces them as a toast.
 */
export async function setTagColor(name: string, hue: number | null): Promise<void> {
  try {
    await callSilent("tag_set_color", { name, color_hue: hue });
    const r = await callSilent<{ colors: Record<string, number> }>("tag_colors").catch(() => null);
    if (r) {
      useNotesStore.setState({ tagColors: r.colors ?? {} });
    }
  } catch {
    // call handles error toast
  }
}

// ponytail: undo for tag CRUD is a follow-up; the confirm dialog is the guard.
async function afterTagMutation(): Promise<void> {
  await useNotesStore.getState().loadTree();
}

export async function renameTag(from: string, to: string): Promise<void> {
  await call("tag_rename", { from, to });
  await afterTagMutation();
}

export async function mergeTags(from: string[], to: string): Promise<void> {
  await call("tag_merge", { from, to });
  await afterTagMutation();
}

export async function deleteTag(name: string): Promise<void> {
  await call("tag_delete", { name });
  await afterTagMutation();
}

/**
 * setNoteStatus: optimistic patchNoteSummary → note_set_status → patch with returned row →
 * reselect active note if it is the target → roll summary back on throw.
 *
 * Shared by ContextMenu (change-status dialog). Lives here
 * (not in lib/status.ts) because it needs the notes store; noteActions already owns that
 * import direction for multi-caller note mutations (export/rename/delete). Do NOT fold
 * useNotesStore.setStatus into this — that path is active-note-only and also updates
 * activeNote / savedState for the editor.
 */
export async function setNoteStatus(id: string, status: string | null): Promise<void> {
  const prevStatus = useNotesStore.getState().noteIndex.get(id)?.status ?? null;
  useNotesStore.getState().patchNoteSummary(id, { status });
  try {
    const updated = await call<NoteSummary>("note_set_status", { id, status });
    useNotesStore.getState().patchNoteSummary(id, updated);
    if (useNotesStore.getState().activeNote?.note.id === id) {
      void useNotesStore.getState().selectNote(id);
    }
  } catch {
    useNotesStore.getState().patchNoteSummary(id, { status: prevStatus });
  }
}

/**
 * duplicateNote: note_get → note_create (same folder/date) → copy section bodies + sources +
 * tags → loadTree → select the new note. Extracted from ContextMenu.tsx's inline `duplicate()`
 * (§R2 layer rule: ContextMenu no longer composes its own note_get/note_create/section_create/
 * source_add_text flow). No new Rust command — front composition only, same as before. The
 * caller (ContextMenu) still owns closeCtx() timing (menu stays open until this resolves).
 */
export async function duplicateNote(id: string): Promise<void> {
  const detail = await call<NoteDetail>("note_get", { id });
  const created = await call<NoteDetail>("note_create", {
    folder_id: detail.note.folder_id,
    title: `${detail.note.title || t("note.untitled_note")} (copy)`,
    // Pass month/day through too, not just year — note_create now defaults an omitted
    // month/day to *today's*, which would otherwise stamp a duplicate of an old note with
    // today's day-of-month while keeping its historical year.
    year: detail.note.year,
    month: detail.note.month,
    day: detail.note.day,
  });

  const srcSections = detail.sections;
  const dstSections = created.sections;
  for (let i = 0; i < srcSections.length; i++) {
    const src: Section = srcSections[i];
    if (i < dstSections.length) {
      // 복제본(방금 만든 노트)의 섹션에 1회 쓰기 — note_create/section_create 응답 토큰을 그대로 보낸다(D2②).
      const dst = dstSections[i];
      await call("section_update", {
        id: dst.id,
        name: src.name,
        body_md: src.body_md,
        ...(dst.updated_at ? { expected_updated_at: dst.updated_at } : {}),
      });
    } else {
      const sec = await call<Section>("section_create", {
        note_id: created.note.id,
        name: src.name,
      });
      await call("section_update", {
        id: sec.id,
        body_md: src.body_md,
        ...(sec.updated_at ? { expected_updated_at: sec.updated_at } : {}),
      });
    }
  }

  for (const src of detail.sources) {
    await call<Source>("source_add_text", {
      note_id: created.note.id,
      name: src.name,
      body: src.body,
    });
  }

  if (detail.note.tag_names.length) {
    await call("note_set_tags", {
      id: created.note.id,
      tag_names: detail.note.tag_names,
    });
  }

  await useNotesStore.getState().loadTree();
  await useNotesStore.getState().selectNote(created.note.id);
}

/**
 * exportFolder: per-note .md files, written into a user-picked directory. Extracted from
 * ContextMenu.tsx's inline `runExportFolder`. Distinct from exportFolderBundle below (which
 * writes the brise-bundle.json shape meant for re-import). Swallows errors via emitNotice
 * (matches the original inline handler — this dialog flow has no other error surface).
 * Markdown 만 — 폴더 단위 HTML 은 W6 에서 뺐다(오너 결정 2026-10-08: 쓸 일이 없다).
 */
export async function exportFolder(id: string): Promise<void> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dest = await open({ directory: true, multiple: false });
    if (!dest) return;
    const res = await call<ExportFolderOutput>("export_folder", {
      id,
      dest_path: dest as string,
    });
    // 건너뛴 노트가 있으면 숨기지 않고 센다(사유는 진단 탭 — Rust 가 노트 id 와 오류 종류만 남긴다).
    emitNotice(
      res.skipped_count > 0
        ? t("ctx.export_folder_done_skipped", { n: res.exported_count, skipped: res.skipped_count, dir: res.written_dir })
        : t("ctx.export_folder_done", { n: res.exported_count, dir: res.written_dir }),
    );
  } catch {
    // silent-ok: 커맨드 실패는 call() 이 이미 토스트·진단으로 알렸다 — 여기서 또 띄우면 같은 실패가 두 번 보인다(U-5). 대화상자 플러그인이 없는 환경도 같다.
  }
}

/**
 * exportFolderBundle: writes the same brise-bundle.json + attachments/ shape as "Export all"
 * (DataManagementSection.exportAll), filtered to one folder, so it can be handed to someone else
 * and re-imported via Settings > Import. Extracted from ContextMenu.tsx's inline
 * `runExportFolderBundle`.
 */
export async function exportFolderBundle(id: string): Promise<void> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dest = await open({ directory: true, multiple: false });
    if (!dest || Array.isArray(dest)) return;
    const res = await call<{ note_count: number; bundle_path: string }>("export_folder_bundle", {
      id,
      dest_dir: dest,
    });
    emitNotice(t("ctx.export_folder_bundle_done", { n: res.note_count, path: res.bundle_path }));
  } catch (e: any) {
    emitNotice(t("ctx.export_folder_bundle_failed", { msg: String(e?.message ?? e) }));
  }
}

/**
 * setFolderColor: folder_set_color({id, color_hue}) → patchFolder with the returned row (icon
 * color derives from it). Extracted from ContextMenu.tsx's inline `runFolderColor`. Previously
 * called loadTree() for a single folder-level field — see renameNote's comment for why that's a
 * full-corpus reload at 100k notes; folder_set_color already returns the updated Folder.
 */
export async function setFolderColor(id: string, hue: number | null): Promise<void> {
  const folder = await call<Folder>("folder_set_color", { id, color_hue: hue });
  useNotesStore.getState().patchFolder(id, folder);
}

