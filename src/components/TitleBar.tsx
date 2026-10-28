import React, { useState, useRef, useEffect } from "react";
import { useNotesStore } from "../stores/notes";
import { useSettingsStore } from "../stores/settings";
import { useUiStore } from "../stores/ui";
import { useAiStore, useAiGlow, AI_GLOW_KEYS, selectAiAvailability } from "../stores/ai";
import { useTaxonomyStore } from "../stores/taxonomy";
import { emitNotice, flushAll } from "../lib/invoke";
import { showUndoToast } from "../lib/undo";
import { useTrashStore } from "../stores/trash";
import { getActiveSection, insertAiSection } from "../lib/aiSectionBridge";
import { deleteNote, importFilesAsSections, attachFile } from "../lib/noteActions";
import { openExportModal } from "../stores/exportModal";
import { isBrowser } from "../lib/env";
import { SECTION_IMPORT_EXTS, fileExt } from "../lib/fileKinds";
import {
  IconStar,
  IconMore,
  IconShare,
  IconTrash,
  IconFileImport,
  IconLock,
  IconUnlock,
  IconAi,
} from "./icons";
import { t } from "../i18n/t";
import { PromptDialog } from "./PromptDialog";
import { StatusControl } from "./titlebar/StatusControl";
import { AiActionsMenu } from "./titlebar/AiActionsMenu";
import { TagEditor } from "./titlebar/TagEditor";
import { RegionMetaBadge } from "./titlebar/RegionMetaBadge";
import { DateBadge } from "./titlebar/DateBadge";
import { FolderBadge } from "./titlebar/FolderBadge";
import { NoteIconControl } from "./leftpanel/NoteIconControl";
import { useDismiss } from "../lib/ui";
import { runTranslateAction } from "../stores/runAiAction";
import { FluidHoverHighlight, useFluidHover } from "./common/FluidHover";

type TbDialog =
  // "…" 메뉴 "가져오기" — SECTION_IMPORT_EXTS 파일이 하나 이상 섞여 있을 때만 뜬다(runImportSections
  // 참고). docPaths/otherPaths는 선택 시점의 스냅샷 — 선택 이후 노트가 바뀌어도 이 파일 목록 자체는
  // 그대로다(무엇을 가져올지는 파일 선택 시점에 고정).
  | { kind: "importChoice"; docPaths: string[]; otherPaths: string[] }
  // attachFile(lib/noteActions.ts)이 sourceOriginalPolicy==="ask"일 때 되묻는 콜백 — 이 값을 담아
  // resolve하면 attachFile 내부의 await가 재개된다. useAttachmentActions.ts의 AttachmentsBar
  // 소유 ActionDialog와 같은 모양이지만 TitleBar는 그 컴포넌트를 쓰지 않으므로 자체 dialog에 넣는다.
  | { kind: "keepOriginal"; resolve: (keep: boolean) => void };

function TagPanStrip({ children }: { children: React.ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isPointerDownRef = useRef(false);
  const startXRef = useRef(0);
  const startScrollLeftRef = useRef(0);
  const isDraggingRef = useRef(false);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== undefined && e.button !== 0) return;
    isPointerDownRef.current = true;
    startXRef.current = e.clientX;
    if (containerRef.current) {
      startScrollLeftRef.current = containerRef.current.scrollLeft;
    }
    isDraggingRef.current = false;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isPointerDownRef.current || !containerRef.current) return;
    const dx = e.clientX - startXRef.current;
    if (!isDraggingRef.current && Math.abs(dx) > 4) {
      isDraggingRef.current = true;
    }
    if (isDraggingRef.current) {
      containerRef.current.scrollLeft = startScrollLeftRef.current - dx;
    }
  };

  const onPointerUp = () => {
    isPointerDownRef.current = false;
  };

  const onClickCapture = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isDraggingRef.current) {
      e.stopPropagation();
      e.preventDefault();
      isDraggingRef.current = false;
    }
  };

  return (
    <div
      ref={containerRef}
      className="tag-strip-pan"
      data-testid="titlebar-tag-strip"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onClickCapture={onClickCapture}
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        alignItems: "center",
        gap: 6,
        // × 버튼(.tb-tag-x)이 칩 모서리 밖 2px 로 나오므로 클립되지 않게 여유를 둔다.
        padding: "var(--space-2xs) var(--space-2xs) var(--space-2xs) 0",
        overflowX: "auto",
        overflowY: "hidden",
        cursor: "grab",
        userSelect: "none",
        position: "relative",
      }}
    >
      {children}
    </div>
  );
}

/** Tight chip shell so non-owned meta controls can carry per-badge AI glow. */
function MetaGlowChip({
  isGlow,
  stagger,
  children,
}: {
  isGlow?: "active" | "fading" | false;
  stagger: number;
  children: React.ReactNode;
}) {
  return (
    <span
      data-ai-glow={isGlow || undefined}
      data-ai-glow-inset="true"
      style={{
        display: "inline-flex",
        flex: "none",
        borderRadius: "var(--radius-sm)",
        position: "relative",
        // String form — React would append "px" to a number custom property.
        ["--ai-glow-stagger" as string]: String(stagger),
      }}
    >
      {children}
    </span>
  );
}

export function TitleBar() {
  const note = useNotesStore((s) => s.activeNote?.note ?? null);
  const hasActiveNote = useNotesStore((s) => !!s.activeNote);
  const setTitle = useNotesStore((s) => s.setTitle);
  const setNoteYear = useNotesStore((s) => s.setNoteYear);
  const setEventPrecision = useNotesStore((s) => s.setEventPrecision);
  const setEventEnd = useNotesStore((s) => s.setEventEnd);
  const setTags = useNotesStore((s) => s.setTags);
  const setStatus = useNotesStore((s) => s.setStatus);
  const toggleFavorite = useNotesStore((s) => s.toggleFavorite);
  const toggleContentLock = useNotesStore((s) => s.toggleContentLock);
  const focusMode = useUiStore((s) => s.focusMode);
  const aiEnabled = useSettingsStore((s) => s.aiEnabled);
  const organizePending = useAiStore((s) => s.organizePending);
  const translateTargetLang = useAiStore((s) => s.translateTargetLang);
  const setTranslateTargetLang = useAiStore((s) => s.setTranslateTargetLang);
  const promptPending = useAiStore((s) => s.promptPending);
  const generateFromPrompt = useAiStore((s) => s.generateFromPrompt);
  const aiCloudGateOk = useAiStore((s) => s.translateGateOk);
  const refreshAiCloudGate = useAiStore((s) => s.refreshTranslateGate);
  const aiReachable = useAiStore((s) => s.aiReachable);
  const ensureAiReachable = useAiStore((s) => s.ensureAiReachable);
  const aiAvailability = selectAiAvailability({ aiEnabled }, { aiReachable });

  const isNoteGlow = useAiGlow(note ? AI_GLOW_KEYS.note(note.id) : null);
  const isTagsGlow = useAiGlow(note ? AI_GLOW_KEYS.tags(note.id) : null);

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ right: 0, y: 0 });
  const [dialog, setDialog] = useState<TbDialog | null>(null);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const hover = useFluidHover(menuRef, { axis: "y" });

  // 빈 상태(열린 노트 없음)에서 제목부터 바로 칠 수 있게 하는 브리지 — EditorPanel의
  // bridgeAutoCreateDraft(본문 첫 입력 시 draft 생성)와 같은 패턴을 제목 인풋에 그대로
  // 적용한다. activeNote가 없는 동안은 입력값을 이 로컬 버퍼에만 담아두고(스토어에 쓸 곳이
  // 없으므로), 첫 keystroke에서 newNote()를 한 번 태운 뒤 그 사이 더 친 값(draftTitleRef,
  // 항상 최신값)을 setTitle로 반영한다 — activeDraft의 setTitle은 "Untitled Note"가 아닌
  // 값이 들어오면 즉시 ensureMaterialized()를 걸어 실제 노트로 승격시킨다(stores/notes.ts).
  // 재진입 가드(materializingTitleRef)는 이 컴포넌트 인스턴스 안에서만 유효 — EditorPanel의
  // autoCreateRef와 독립적이다. 키보드 포커스는 한 번에 한 입력에만 있을 수 있으므로(제목
  // input과 본문 contenteditable이 동시에 타이핑을 받을 수 없다) 두 브리지가 실제로
  // 동시에 발화하는 경쟁은 없다 — 있더라도 둘 다 상수 id(activeNote는 항상 "__draft__",
  // 섹션은 "draft_sec")에 대해 resolve 이후 스토어의 최신 상태만 읽어 적용하므로 멱등하다.
  const [draftTitleBuffer, setDraftTitleBuffer] = useState<string | null>(null);
  const draftTitleRef = useRef<string | null>(null);
  const materializingTitleRef = useRef(false);

  const handleTitleChange = (value: string) => {
    if (hasActiveNote) {
      setTitle(value);
      return;
    }
    draftTitleRef.current = value;
    setDraftTitleBuffer(value);
    if (materializingTitleRef.current) return;
    materializingTitleRef.current = true;
    void (async () => {
      await useNotesStore.getState().newNote();
      materializingTitleRef.current = false;
      const an = useNotesStore.getState().activeNote;
      // await 도중 더 친 값까지 반영 — 클로저의 `value`(이 호출을 촉발한 그 keystroke)가
      // 아니라 지금까지의 최신값을 쓴다(bridgeAutoCreateDraft가 editor.getHTML()을 다시
      // 읽는 것과 같은 이유).
      const finalValue = draftTitleRef.current ?? value;
      draftTitleRef.current = null;
      setDraftTitleBuffer(null);
      if (!an) return; // newNote()가 no-op했다(예: 받아쓰기 세션 가드가 이미 토스트를 띄움)
      useNotesStore.getState().setTitle(finalValue);
    })();
  };

  // Any outside mousedown closes — this "..." menu has no trigger-button exemption today.
  useDismiss(menuOpen, [], () => setMenuOpen(false), { escape: false });

  useEffect(() => {
    void refreshAiCloudGate();
  }, [refreshAiCloudGate]);

  // Probe AI reachability when the feature is on (or clear when off). Does not block first paint;
  // the menu stays hidden until both aiEnabled and a successful probe (aiReachable === true).
  useEffect(() => {
    void ensureAiReachable();
  }, [aiEnabled, ensureAiReachable]);

  const isFav = note?.is_favorite ?? false;
  // 더보기 메뉴 "내용잠금" — is_favorite와 같은 falsy-fallback 관례(용어집: "내용"=섹션/본문).
  const contentLocked = note?.content_locked ?? false;
  // Draft-page date-badge fallback (see YearBadge below) — only read when !note, so this never
  // matters for a real/draft note's actual date.
  const todayDate = new Date();
  const customStatuses = useTaxonomyStore((s) => s.statuses);
  const folders = useNotesStore((s) => s.folders);
  const loadTree = useNotesStore((s) => s.loadTree);
  const selectNote = useNotesStore((s) => s.selectNote);

  // stores/runAiAction.ts::runTranslateAction 과 같은 일이다(한 줄씩 같은 복제본이었다) — 관문은 그쪽 하나.
  const runAiTranslate = () => runTranslateAction(translateTargetLang);

  const runAiPrompt = async (promptText: string) => {
    await flushAll();
    // Capture before the AI await — a mid-flight note switch must not land the result on B.
    const targetNoteId = useNotesStore.getState().activeNote?.note.id;
    if (!targetNoteId) {
      emitNotice(t("editor.note_required_for_section"));
      return;
    }
    const sec = getActiveSection();
    const generated = await generateFromPrompt(promptText, sec?.body_md ?? null);
    if (generated == null) return;
    if (!generated.trim()) {
      emitNotice(t("editor.ai_empty_result"));
      return;
    }
    await insertAiSection(t("editor.ai_prompt_section_name"), generated, targetNoteId, undefined, {
      aiOrigin: "prompt",
    });
  };

  // "…" 메뉴 "가져오기(md, txt, docx…)" — plugin-dialog 다중 선택, 필터 없음
  // (useAttachmentActions.ts::addFile과 같은 방식 — 이미지 등도 고를 수 있다). 데스크톱 전용
  // (로컬 파일시스템 다이얼로그 — isBrowser() 가드는 DataManagementSection.tsx 등과 같은 패턴:
  // 항목은 보이되 비활성 + 툴팁) + 내용잠금 상태에서도 비활성(섹션 추가와 동치).
  //
  // 선택된 파일은 SECTION_IMPORT_EXTS(문서류: md/txt/docx/pdf/hwpx/pptx/csv/tsv/xlsx) 여부로 두
  // 갈래로 나뉜다:
  //   - 문서류가 하나라도 있으면 "섹션으로 가져오기" / "첨부로만 추가" 중 선택하는 다이얼로그를
  //     띄운다(importChoice) — 섹션 선택 시 문서류만 importFilesAsSections로, 나머지(있다면)는
  //     첨부로. 첨부 선택 시 전부 첨부로.
  //   - 문서류가 없으면(이미지 등만 선택) 다이얼로그 없이 바로 전부 첨부로 보낸다.
  // 첨부 라우팅 자체(확장자별 source_add_file/attachment_add_file + keep-original 정책)는
  // lib/noteActions.ts::attachFile — useAttachmentActions.addOneFile과 공유하는 그 함수다.
  // 드롭 좌표가 없는 모달 흐름이라 useEditorFileDrop.handleFileDrop과 달리 이미지 인라인 삽입은
  // 하지 않는다(첨부바에만 나타나면 된다) — 대신 이쪽에만 있는 것이 이 사용자 선택권이다.
  const browser = isBrowser();
  // 라벨의 예시 확장자는 SECTION_IMPORT_EXTS(md, txt, docx, pdf, hwpx, pptx, csv, tsv, xlsx)에서
  // 그대로 유도한다 — 하드코딩된 나열이 실제 지원 목록과 어긋나는 것을 막기 위해서다. Set의
  // 순회 순서는 삽입 순서(SECTION_TEXT_IMPORT_EXTS가 먼저, sheet가 다음)라 앞 3개는 항상
  // md/txt/docx다. 파일 선택기 자체는 더 이상 이 목록으로 필터링하지 않는다(아래 참고) — 라벨은
  // "이런 것도 된다"는 힌트일 뿐, 실제 선택 가능 범위와는 별개다.
  const importExtsPreview = Array.from(SECTION_IMPORT_EXTS).slice(0, 3).join(", ");
  const importDisabledReason = browser
    ? t("common.desktop_only")
    : contentLocked
      ? t("editor.content_locked_tooltip")
      : undefined;

  // attachFile이 sourceOriginalPolicy==="ask"일 때 되묻는 콜백 — useAttachmentActions.ts의
  // askKeepOriginal과 같은 모양(다이얼로그를 열고 그 onSubmit/onCancel에서 resolve하는 Promise)
  // 이지만, 이 컴포넌트는 자체 TbDialog 상태(kind: "keepOriginal")를 쓴다.
  const askKeepOriginalTb = (): Promise<boolean> =>
    new Promise<boolean>((resolve) => setDialog({ kind: "keepOriginal", resolve }));

  // 문서류가 아닌 파일(이미지 등) + "첨부로만 추가"를 고른 문서류를 첨부로 밀어넣는다. addFile
  // (useAttachmentActions.ts)과 같은 모양의 단순 순차 루프 — 한 파일이 실패해도(call()이 이미
  // AppError 토스트를 띄운다) addFile처럼 그 자리에서 멈춘다(반복문 밖 catch가 없다는 뜻이 아니라,
  // 이 파일 하나의 예외를 호출자가 잡아 나머지를 계속 진행 vs 멈춤 중 addFile은 후자를 고른
  // 기존 관례라 그대로 따른다). 파일 수가 적은 모달 흐름이라 진행 토스트는 두지 않는다
  // (addFile도 없다 — importFilesAsSections의 3개 임계치는 배치 커맨드용, 여긴 매 파일 IPC 왕복).
  const attachFilesToNote = async (noteId: string, paths: string[]) => {
    if (paths.length === 0) return;
    try {
      for (const path of paths) {
        await attachFile(noteId, path, askKeepOriginalTb);
      }
    } catch (e: any) {
      if (!(e && typeof e === "object" && "code" in e)) {
        emitNotice(e?.message ?? String(e));
      }
      return;
    }
    // handleFileDrop(useEditorFileDrop.ts)의 anyAdded와 같은 갱신 시점 — 첨부 목록이 새로고침돼야
    // 방금 추가한 파일이 첨부바에 보인다.
    if (useNotesStore.getState().activeNote?.note.id === noteId) {
      await useNotesStore.getState().reloadActive();
    }
  };

  const runImportSections = async (noteId: string) => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ multiple: true });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const docPaths = paths.filter((p) => SECTION_IMPORT_EXTS.has(fileExt(p)));
      const otherPaths = paths.filter((p) => !SECTION_IMPORT_EXTS.has(fileExt(p)));
      if (docPaths.length === 0) {
        // 이미지 등 비문서 파일만 골랐다 — 선택할 게 없으니 다이얼로그 없이 바로 첨부로.
        await attachFilesToNote(noteId, otherPaths);
        return;
      }
      setDialog({ kind: "importChoice", docPaths, otherPaths });
    } catch (e: any) {
      // call()의 AppError는 이미 토스트됨 — 파일피커 자체 실패만 여기서 알린다(useAttachmentActions.addFile과 동일).
      if (!(e && typeof e === "object" && "code" in e)) {
        emitNotice(e?.message ?? String(e));
      }
    }
  };

  // Trash: note_delete now SOFT-deletes (moves the note to trash) instead of destroying it, so
  // the old "this can't be undone" danger confirm is gone — deleteNote() runs immediately
  // (flushAll→note_delete→closeTab→loadTree→selectNote(next), unchanged — see lib/noteActions.ts),
  // then an undo toast offers the way back. Undo = note_restore + refresh tree (trash store's
  // restoreNote) + reselect the note so it reopens exactly where it left off.
  // 에러를 토스트로 보여주는 이 try/catch는 TitleBar만의 동작이라(ContextMenu의 호출부는 감싸지
  // 않는다) noteActions.ts로 옮기지 않고 여기 그대로 남긴다 — lib/noteActions.ts 주석 참고.
  const runDelete = async (id: string) => {
    try {
      await deleteNote(id);
      void useTrashStore.getState().loadTrash();
      showUndoToast(t("trash.moved"), () => {
        void (async () => {
          await useTrashStore.getState().restoreNote(id);
          await useNotesStore.getState().selectNote(id);
        })();
      });
    } catch (e: any) {
      emitNotice(e?.message || t("note.delete_failed"));
    }
  };

  const rowDisabledStyle: React.CSSProperties = {
    opacity: hasActiveNote ? 1 : 0.4,
    pointerEvents: hasActiveNote ? "auto" : "none",
  };

  // 메타 칩 행 + 태그 스트립 전용 — 즐겨찾기/잠금해제/AI메뉴/더보기 버튼 행(rowDisabledStyle,
  // 위)과 달리 이 행은 내용잠금 시에도 눌러지면 안 된다(제목/태그/폴더/상태/지역/날짜 전부
  // 메타데이터). 별도 변수로 두는 이유: rowDisabledStyle을 그대로 바꾸면 즐겨찾기 버튼과 방금
  // 추가한 잠금해제 버튼까지 함께 막혀버린다(둘 다 잠금과 무관하게 항상 눌려야 하는 예외).
  const metaRowDisabledStyle: React.CSSProperties = {
    opacity: !hasActiveNote ? 0.4 : contentLocked ? "var(--dim-disabled)" : 1,
    pointerEvents: hasActiveNote && !contentLocked ? "auto" : "none",
  };

  return (
    <div
      style={{
        // W24 위생: 포커스 센터링 식(900px/24px)은 --focus-inset 토큰으로 일원화(App.tsx와 공유).
        padding: focusMode ? "12px var(--focus-inset) 4px" : "12px var(--content-inset) 4px",
        flex: "none",
      }}
    >
      {/* tokens.css는 공유 파일이라 수정 불가 — .attach/.attach-x는 :hover만 정의하므로
          :focus-within/:focus-visible 노출은 이 파일 범위로 스코프한 순수 CSS로 보강한다
          (onMouseEnter로 style을 직접 건드리지 않는다). */}

      {/* W22-⑫①: 메타 칩(상태/지역/날짜/폴더/태그) 저대비화 — 상시 테두리를 지우고
          hover/focus 에서만 드러낸다(W9 어시스트 리스트와 같은 톤: 평소 조용, 손 닿으면 반응).
          .tag-btn 은 공유 규칙(tokens.css)이라 여기서 건드리지 않고, 두 클래스 결합으로
          특이도를 높여 이 파일 범위에서만 override한다. 값 있음/없음은 각 컴포넌트가 이미
          color로 구분하므로(예: StatusControl label muted↔text) border-style 구분은 버린다. */}
      <style>{`
        .tag-btn.tb-quiet-chip {
          height: var(--tb-chip-h);
          min-height: var(--tb-chip-h);
          max-height: var(--tb-chip-h);
          /* 칩 테두리는 항상 실선 — .tag-btn 기본이 1px dashed 라서 border-style 을 여기서 못 박지 않으면
             양옆만 점선 세로줄로 보이는 사고가 난다(상하는 칩 높이에 묻힘). */
          border: 1px solid color-mix(in srgb, var(--theme) 40%, transparent);
          border-radius: var(--radius-sm);
          background: transparent;
          font-family: var(--font-body);
          font-size: var(--text-xs);
          font-weight: 400;
          line-height: 1.3;
          box-sizing: border-box;
          transition: background var(--dur-fast), color var(--dur-fast);
        }
        /* 설정값이 없는 칩(상태·지역·태그 추가)은 선을 더 옅게 — 값 있는 칩과 구분. */
        .tag-btn.tb-quiet-chip[data-empty] {
          border-color: color-mix(in srgb, var(--theme) 16%, transparent);
        }
        .tag-btn.tb-quiet-chip:hover,
        .tag-btn.tb-quiet-chip:focus-visible,
        .tag-btn.tb-quiet-chip:focus-within,
        .tag-btn.tb-quiet-chip[aria-expanded="true"] {
          background: var(--line);
          border-color: var(--accent);
        }
        .tag-btn.tb-quiet-chip:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 1px;
        }
      `}</style>

      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {/* Note icon before the title — same control as the tree (long-press picker).
            Interactive here so icon edit has one code path; long-press keeps title typing free. */}
        {note && (
          <span
            style={{
              flex: "none",
              display: "inline-flex",
              alignItems: "center",
              // 내용잠금: 노트 아이콘도 메타데이터다 — 클릭해도 바뀌지 않게 포인터 이벤트를 끈다
              // (실제 저장은 stores/notesActive.ts::setIcon이 patchActiveNote를 지나며 이미
              // 막는다 — 이건 UI 단 시각/조작 피드백).
              ...(contentLocked ? { opacity: "var(--dim-disabled)", pointerEvents: "none" } : {}),
            }}
            data-testid="title-note-icon"
          >
            <NoteIconControl
              noteId={note.id}
              icon={note.icon}
              size={22}
              loadTree={loadTree}
              selectNote={selectNote}
              activeNoteId={note.id}
            />
          </span>
        )}
        <input
          // 빈 상태(열린 노트 없음)에서도 그대로 눌러 쓸 수 있어야 "막 새 노트를 시작하는"
          // 화면으로 읽힌다 — disabled + --faint 톤(비활성/플레이스홀더 느낌)을 걷어내고,
          // 첫 keystroke는 handleTitleChange가 draft 노트를 만들며 받아낸다.
          value={
            hasActiveNote
              ? note?.title === "Untitled Note"
                ? ""
                : (note?.title ?? "")
              : (draftTitleBuffer ?? "")
          }
          onChange={(e) => handleTitleChange(e.target.value)}
          placeholder={t("note.untitled_note")}
          readOnly={contentLocked}
          title={contentLocked ? t("editor.content_locked_tooltip") : undefined}
          style={{
            flex: 1,
            minWidth: 0,
            background: "transparent",
            border: 0,
            outline: "none",
            color: "var(--text)",
            fontFamily: "var(--font-editor)",
            fontWeight: 600,
            fontSize: "var(--text-title)",
            // W24: 1.3(=35.1px) → 35px*fs 고정 — --row-header 산식의 스케일부(49px*fs)와
            // 정확히 맞물리게 한다(0.1px 차이는 비가시, 대신 헤더 총높이가 토큰과 일치).
            lineHeight: "calc(30px*var(--fs))",
            padding: 0,
            cursor: contentLocked ? "default" : undefined,
          }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2xs)", flex: "none", ...rowDisabledStyle }}>
          {/* 내용잠금 상태 아이콘 — 즐겨찾기 바로 왼쪽, 더보기 메뉴를 열지 않아도 항상 보이고
              클릭 한 번으로 바로 해제된다(스펙: 더보기 메뉴를 거칠 필요 없음). rowDisabledStyle에
              합류시키지 않는다 — 그러면 노트가 없을 때 이 버튼도 숨어야 하는데 실제로는
              hasActiveNote가 false면 contentLocked도 항상 false라 자연히 안 그려진다. */}
          {contentLocked && (
            <button
              type="button"
              className="icon-btn icon-btn--sm icon-btn--glow"
              data-testid="titlebar-lock-icon"
              onClick={() => void toggleContentLock()}
              title={t("editor.content_unlock")}
              aria-label={t("editor.content_unlock")}
            >
              <IconLock size={13} strokeWidth={1.8} />
            </button>
          )}
          <button
            type="button"
            className="icon-btn icon-btn--sm icon-btn--glow"
            data-active={isFav ? "true" : undefined}
            onClick={() => void toggleFavorite()}
            title={t("editor.favorite")}
          >
            <IconStar size={13} strokeWidth={1.8} style={{ fill: isFav ? "var(--accent)" : "none" }} />
          </button>
          {/* PLAN-2026-09-08-dates-rebuild.md W4 §2: 제목줄 벨 아이콘 + ReminderModal 은 삭제됐다 —
              날짜 칩(DateBadge) 팝오버가 알림의 유일한 표면이다(행마다 인라인 알림 드로어). */}
          {/* QA8 Wave 4A: snapshot/history button moved to frame-top next to UI lock
              (App.tsx) — app-wide activity view, works without an active note. */}
          {aiAvailability !== "off" ? (
            aiAvailability === "ready" ? (
              <AiActionsMenu
                cloudGateOk={aiCloudGateOk}
                organizePending={organizePending}
                promptPending={promptPending}
                translateLang={translateTargetLang}
                onChangeTranslateLang={(lang) => void setTranslateTargetLang(lang)}
                onTranslate={() => void runAiTranslate()}
                onAskPrompt={(prompt) => void runAiPrompt(prompt)}
              />
            ) : (
              <button
                type="button"
                className="icon-btn icon-btn--sm"
                disabled
                title={aiAvailability === "checking" ? t("editor.ai_checking") : t("editor.ai_unreachable")}
                aria-label={aiAvailability === "checking" ? t("editor.ai_checking") : t("editor.ai_unreachable")}
                style={{ opacity: "var(--dim-disabled)", cursor: "not-allowed" }}
              >
                <IconAi size={13} strokeWidth={1.8} />
              </button>
            )
          ) : null}

          {/* 메뉴 (이름 바꾸기 / 내보내기 / 삭제) */}
          <button
            type="button"
            ref={menuBtnRef}
            onClick={() => {
              if (!menuBtnRef.current) return;
              const rect = menuBtnRef.current.getBoundingClientRect();
              setMenuPos({ right: window.innerWidth - rect.right, y: rect.bottom + 4 });
              setMenuOpen(true);
            }}
            title={t("editor.more")}
            aria-label={t("editor.more")}
            data-active={menuOpen ? "true" : undefined}
            className="icon-btn icon-btn--sm icon-btn--glow"
          >
            <IconMore size={13} strokeWidth={2} />
          </button>
        </div>
      </div>

      {!focusMode && (
        <div
          title={contentLocked ? t("editor.content_locked_tooltip") : undefined}
          style={{
            height: "var(--row-title-3)",
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 6,
            overflow: "hidden",
            flexWrap: "nowrap",
            ...metaRowDisabledStyle,
          }}
        >
          {/* Fixed group: FOLDER first (belonging), then STATUS, REGION, YEAR (+ related dates,
              merged into the one date chip — 2026-09-07 "관련 날짜도 지역처럼 하나로").
              FolderBadge hard-caps width in px so TagPanStrip keeps min room at --fs:1.35. */}
          <div
            data-testid="titlebar-meta-fixed"
            style={{ display: "flex", alignItems: "center", gap: 6, flex: "none", position: "relative" }}
          >
            {note && (
              <MetaGlowChip isGlow={isNoteGlow} stagger={0}>
                <FolderBadge noteId={note.id} folderId={note.folder_id} folders={folders} />
              </MetaGlowChip>
            )}
            <MetaGlowChip isGlow={isNoteGlow} stagger={1}>
              <StatusControl
                status={note?.status ?? null}
                customStatuses={customStatuses}
                onChange={(s) => void setStatus(s)}
              />
            </MetaGlowChip>

            <RegionMetaBadge
              noteId={note?.id ?? null}
              primary={{ region: note?.region ?? null, lat: note?.lat ?? null, lng: note?.lng ?? null }}
              isGlow={isNoteGlow}
            />

            {/* Draft page (0 open tabs, before any draft object exists yet — note is
                undefined here): still show today's full date, not just the year. A ternary on
                `note` itself (not `??` on the field) — a *real* note legitimately has
                month/day === null for year-only precision, and that must keep showing
                year-only, not get overwritten by today's date. end_* stays null on the draft
                page (no ⏰ segment) — matches the pre-merge DueChip, which never had a draft
                fallback either. */}
            <MetaGlowChip isGlow={isNoteGlow} stagger={3}>
              <DateBadge
                year={note ? note.year : todayDate.getFullYear()}
                month={note ? note.month : todayDate.getMonth() + 1}
                day={note ? note.day : todayDate.getDate()}
                end_year={note ? (note.end_year ?? null) : null}
                end_month={note ? (note.end_month ?? null) : null}
                end_day={note ? (note.end_day ?? null) : null}
                noteId={note?.id ?? null}
                setYear={(y) => setNoteYear(y)}
                setEventPrecision={(m, d) => void setEventPrecision(m, d)}
                setEventEnd={(end) =>
                  void setEventEnd(end.end_year, end.end_month, end.end_day)
                }
              />
            </MetaGlowChip>
          </div>

          {/* Single divider right before tags */}
          <span
            aria-hidden
            style={{ width: 1, height: 14, background: "var(--divider)", flex: "none" }}
          />

          {/* Tags pan area: occupies remaining space, drag-to-pan, no scrollbar.
              AI glow lives on each TagEditor chip, not this strip (region-border looked broken). */}
          <TagPanStrip>
            <TagEditor tag_names={note?.tag_names ?? []} setTags={setTags} isGlow={isTagsGlow} />
          </TagPanStrip>
        </div>
      )}

      {menuOpen && (
        <div
          ref={menuRef}
          className="overlay fh-host"
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: "fixed",
            top: menuPos.y,
            right: menuPos.right,
            boxShadow: "var(--shadow-lg)",
            padding: "var(--space-1)", // 4px
            zIndex: "var(--z-dropdown)",
            display: "flex",
            flexDirection: "column",
            minWidth: 150,
          }}
          {...hover.handlers}
        >
          <FluidHoverHighlight hover={hover} />
          {/* 순서: 가져오기 → 내용잠금 → 내보내기 → 삭제 (이름바꾸기는 제목 인풋이 이미
              인라인으로 하므로 이 메뉴에서 제거됨 — PLAN 더보기 메뉴 개편). */}
          <button
            type="button"
            data-testid="titlebar-menu-import"
            className="menu-row menu-item"
            style={{ opacity: browser || contentLocked ? "var(--dim-disabled)" : 1 }}
            disabled={browser || contentLocked}
            title={importDisabledReason}
            onClick={() => {
              setMenuOpen(false);
              if (note) void runImportSections(note.id);
            }}
          >
            <IconFileImport size={15} /> {t("ctx.import_sections_menu", { exts: importExtsPreview })}
          </button>
          <button
            type="button"
            data-testid="titlebar-menu-content-lock"
            className="menu-row menu-item"
            onClick={() => {
              setMenuOpen(false);
              if (note) void toggleContentLock();
            }}
          >
            {contentLocked ? <IconUnlock size={15} /> : <IconLock size={15} />}{" "}
            {contentLocked ? t("editor.content_unlock") : t("editor.content_lock")}
          </button>
          <button
            type="button"
            data-testid="titlebar-menu-export"
            className="menu-row menu-item"
            onClick={() => {
              setMenuOpen(false);
              // 내보내기 모달(components/export/ExportModal) — 노트 우클릭 "내보내기"와 같은 모달, "노트 전체" 범위.
              if (note) openExportModal({ noteId: note.id, noteTitle: note.title, sectionId: null });
            }}
          >
            <IconShare size={15} /> {t("common.nav_export")}
          </button>
          <button
            type="button"
            className="menu-row menu-item"
            style={{ color: "var(--danger)" }}
            onClick={() => {
              setMenuOpen(false);
              if (note) void runDelete(note.id);
            }}
          >
            <IconTrash size={15} /> {t("editor.delete")}
          </button>
        </div>
      )}

      {dialog?.kind === "importChoice" && note && (
        <PromptDialog
          title={t("ctx.import_choice_title")}
          mode="choice"
          description={dialog.otherPaths.length > 0 ? t("ctx.import_choice_desc_mixed") : undefined}
          choices={[
            { value: "sections", label: t("ctx.import_choice_sections") },
            { value: "attach", label: t("ctx.import_choice_attach") },
          ]}
          onCancel={() => setDialog(null)}
          onSubmit={(value) => {
            const id = note.id;
            const { docPaths, otherPaths } = dialog;
            setDialog(null);
            if (value === "sections") {
              void (async () => {
                if (docPaths.length) await importFilesAsSections(id, docPaths);
                await attachFilesToNote(id, otherPaths);
              })();
            } else {
              void attachFilesToNote(id, [...docPaths, ...otherPaths]);
            }
          }}
        />
      )}

      {dialog?.kind === "keepOriginal" && (
        <PromptDialog
          title={t("attachments.keep_original_title")}
          description={`${t("attachments.keep_original_body")} ${t("attachments.keep_original_reference_note")}`}
          mode="confirm"
          confirmLabel={t("attachments.keep_original_keep")}
          cancelLabel={t("attachments.keep_original_discard")}
          onCancel={() => {
            const resolve = dialog.resolve;
            setDialog(null);
            resolve(false);
          }}
          onSubmit={() => {
            const resolve = dialog.resolve;
            setDialog(null);
            resolve(true);
          }}
        />
      )}
    </div>
  );
}
