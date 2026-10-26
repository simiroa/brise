/**
 * 폰 노트 화면의 Tiptap 인스턴스 + 스토어(activeNote)에서 화면으로의 동기화.
 *
 * - useEditor 설정(스키마 확장은 mobileEditorExtensions.ts, 여기는 입력 보조·플레이스홀더·700ms 자동 저장 타이머)
 * - 노트 로드 효과: activeNote 가 바뀌면 어떤 섹션을 어떤 모양으로 칠할지 정한다(칠하는 규칙은 useMobileSectionView)
 * - 섹션 전환(switchSection). 자동 포커스는 기본적으로 없다(D2, 오너 2026-10-10) — 본문 탭이 포커스한다(MobileNoteBody).
 *   예외 하나(O-1): ＋ 로 연 빈 초안은 `mobileCaptureFocus` 신호로 칠한 직후 한 번 끝에 포커스한다.
 *
 * 저장 쪽(flushRef 의 실제 구현·실패 처리)은 useMobileNoteSave 가 이 훅이 돌려준 ref 들로 붙는다 —
 * onUpdate 타이머는 `flushRef.current()` 만 부른다.
 */
import { useEffect, useRef } from "react";
import { useEditor } from "@tiptap/react";
import Placeholder from "@tiptap/extension-placeholder";
import type { NoteDetail, Section } from "../lib/commands.gen";
import { useNotesStore } from "../stores/notes";
import { hasSaveFailed } from "../lib/sectionSaveFailures";
import { t } from "../i18n/t";
import { TaskListDashInputRule } from "../components/editor/taskListDashInputRule";
import { MdAutoformatGate } from "../components/editor/mdAutoformatGate";
import { createMobileSchemaExtensions } from "./mobileEditorExtensions";
import { useMobileSectionView } from "./useMobileSectionView";
import { cancelCaptureFocus, hasCaptureFocusRequest } from "./mobileCaptureFocus";

export function useMobileBodyEditor({ activeNote }: { activeNote: NoteDetail | null }) {
  const view = useMobileSectionView();
  const { sectionRef, readOnlyRef, timeoutRef, flushRef, paintedVersionRef } = view;

  const editor = useEditor({
    extensions: [
      // 스키마 확장(StarterKit/Markdown/Link/BriseImage/Footnote/Date …)은 mobileEditorExtensions.ts —
      // 데스크톱 대조표와 date 마크 사유는 거기 주석. 아래는 직렬화와 무관한 입력 보조뿐.
      ...createMobileSchemaExtensions(),
      // 데스크탑과 같은 `- [ ] ` 습관을 받아준다 — 없으면 폰에서만 글머리 안에 literal "[ ]" 가 남아
      // 플랫폼 간 동작이 갈린다.
      TaskListDashInputRule,
      // 오너 결정(2026-09-20) — 마크다운 자동 서식(editor_md_autoformat) 킬 스위치. 데스크톱
      // EditorPanel.tsx 와 같은 확장(mdAutoformatGate.ts 헤더 참고) — 모바일도 노트 본문을 직접
      // 타이핑하는 자리라 똑같이 따른다.
      MdAutoformatGate,
      Placeholder.configure({ placeholder: t("mobile.body_placeholder") }),
    ],
    // D2(오너 2026-10-10): 입력 화면·노트 화면 어디서도 키보드를 저절로 올리지 않는다 — 진입하자마자 키보드가 화면 절반을
    // 덮어 뱃지·섹션 줄이 안 보였다. 쓰려면 본문을 탭한다(MobileNoteBody 가 빈 자리 탭도 끝으로 포커스한다).
    // (예전엔 [+ 기록] 진입에 autofocus "end" + 50ms 보험 타이머가 있었다 — 2026-07-29 실기에서 포커스 없이 친 키가 <body> 로
    //  새던 문제 때문. 이제는 사용자가 먼저 탭해 포커스를 만들므로 그 경로가 없다.)
    autofocus: false,
    content: "",
    editorProps: {
      // 네이티브 브라우저 맞춤법 검사 — 데스크탑 EditorPanel.tsx와 동일(Wave 6-b, nspell 제거).
      attributes: { spellcheck: "true" },
    },
    onUpdate: () => {
      if (!sectionRef.current || readOnlyRef.current) return;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      useNotesStore.getState().setSavedState("saving");
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null;
        // flushRef 가 모든 쓰기(성공/실패 판정·재시도 가능하게 sec.body 되돌리기)를 한 곳에서 한다.
        void flushRef.current();
      }, 700);
    },
  });

  // Note-load — reacts to activeNote identity changes only (selectNote/newNote/ensureMaterialized
  // all create a new activeNote reference; a plain autosave for an already-materialized note does
  // not — see notes.ts::updateSectionBody's non-draft branch comment). Unsupported bodies (table/
  // details/highlight/color-span passthrough HTML — see mobileEditorSupport.ts) render
  // read-only instead of being fed into the minimal Tiptap schema, so an edit here can never
  // silently drop content the desktop editor put there.
  useEffect(() => {
    // isDestroyed: 첫 마운트에 useEditor 가 인스턴스를 교체하면 이전 인스턴스가 destroy 되는데(TipTap v3 는
    // commandManager=null), 그 옛 인스턴스로 이 이펙트가 한 번 돌면 `.commands` 가 null 을 읽고 던져
    // MobileNote 가 ErrorBoundary 로 떨어진다(실기기 S22/Chrome 에서 앱 시작 후 첫 노트 열기마다 재현).
    // 새 인스턴스가 들어오면 deps 의 `editor` 가 바뀌어 이 이펙트가 다시 돈다 — CLAUDE.md 함정 2.
    if (!editor || editor.isDestroyed || !activeNote) return;
    const sections = activeNote.sections;
    if (!sections.length) return;
    const cur = sectionRef.current;
    const sameSection = cur ? sections.some((s) => s.id === cur.id) : false;
    // M-14: 초안 → 실노트 전환(첫 저장). 에디터는 이미 사용자가 친 글을 쥐고 있고 새 노트의 유일한 섹션이 바로 그 글의 자리다 —
    // 다시 칠하면 note_create 왕복 중에 더 친 글자가 지워진다(칠하는 본문은 그 전에 보낸 것이다). 섹션 id 만 갈아 끼우고,
    // sec.body 는 그대로 둬(=이미 보낸 본문) 더 친 글자가 다음 flush 에 나가게 한다. 'draft_sec' = stores/notesActive.ts newNote 의 초안 섹션 id.
    if (!sameSection && cur && cur.id === "draft_sec" && cur.kind === "text" && sections.length === 1 && sections[0].kind === "text") {
      view.setActiveSection({ id: sections[0].id, body: cur.body, kind: "text" });
      // 본문이 그대로이니 칠한 문서 기준선도 그대로 옮긴다 — 안 옮기면 정규형이 아닌 가져온 글이 만들어진 직후 flush 에서
      // 다시 써진다(note_create 바로 뒤의 가짜 편집, unchangedSinceLoad).
      if (sectionRef.current && cur.loaded) sectionRef.current.loaded = cur.loaded;
      return;
    }
    const next = sameSection ? sections.find((s) => s.id === cur!.id)! : sections[sections.length - 1];
    if (sameSection && cur!.id === next.id && cur!.body === next.body_md) return;
    // 같은 섹션인데 서버 버전이 그대로면 다시 칠하지 않는다(2026-10-07 S22 실기 QA, 결함 A). 스토어는 캐럿 보호로
    // activeNote.sections 본문을 일부러 낡게 두므로(notesActive.ts updateSectionBody), 첨부·날짜·지역 같은 본문 외
    // 패치가 새 activeNote 참조를 만들면 여기 들어온 next.body_md 는 이 기기가 이미 넘어선 옛 본문이다. 그걸로
    // setContent 하면 방금 넣은 전사문이 화면에서 사라지고, 다음 타이핑 저장이 DB 의 전사까지 지운다. 서버에서
    // 실제로 바뀐 경우(다른 기기 편집 → 다시 불러오기)는 updated_at 이 움직이므로 그대로 다시 칠한다.
    if (
      sameSection &&
      cur!.id === next.id &&
      next.updated_at &&
      paintedVersionRef.current?.id === next.id &&
      paintedVersionRef.current.updatedAt === next.updated_at
    ) {
      return;
    }
    // 노트를 열면 기본 섹션이 마지막 섹션이다 — 마지막이 시트/관계도여도 switchSection 을 거치지 않고 이 효과로
    // 들어오므로 세 모양 분기를 여기서도 탄다(2026-10-06 실기기 검증: 시트 분기가 빠져 시트 JSON 이 편집 가능한
    // 본문으로 열렸다).
    view.showSection(editor, next);
  }, [activeNote, editor]);

  /**
   * Section strip tap (owner feedback 2026-07-30 item 2 — a mobile note used to show ONE section
   * with no way to reach the others: a 관계도 and the prose next to it were mutually unreachable).
   * Same shape as desktop's EditorPanel::switchSection minus its bodyCacheRef read (mobile has no
   * such cache — see MobileNote.tsx's component comment for why): flush the pending debounced edit
   * FIRST, or the 700ms timer fires against the section we already left and its "no change" test
   * compares the new section's body, silently dropping the edit.
   */
  const switchSection = async (s: Section) => {
    if (!editor || editor.isDestroyed || sectionRef.current?.id === s.id) return;
    await flushRef.current();
    // P0-3: 저장이 실패한 섹션에서는 떠나지 않는다 — 떠나면 실패한 본문이 에디터에서 사라지고 다음 flush 가 "이미 같음" 으로
    // "저장됨" 을 말한다. 실패 배너(재시도·그래도 나가기)가 떠 있다.
    const curId = sectionRef.current?.id;
    if (curId && hasSaveFailed(curId)) return;
    view.showSection(editor, s);
  };

  // O-1: ＋ 로 연 빈 초안만 — 칠하는 효과(위) 다음에 선언해 같은 커밋에서 칠한 뒤 돈다. 마운트당 한 번(이후 저장으로 노트가 되어도 다시 안 올린다).
  // 타이머로 포커스를 늦추지 않는다(07-29 의 50ms 보험을 되살리지 않음) — WebView 가 프로그램 포커스로 키보드를 안 올리면 실기에서 보고한다.
  const focusedOnOpenRef = useRef(false);
  useEffect(() => {
    if (focusedOnOpenRef.current || !editor || editor.isDestroyed || !activeNote || !hasCaptureFocusRequest()) return;
    const st = useNotesStore.getState();
    if (!st.activeDraft || !st.activeBodyEmpty) return;
    focusedOnOpenRef.current = true;
    cancelCaptureFocus();
    editor.commands.focus("end");
  }, [editor, activeNote]);

  // 에디터를 묶어 돌려준다 — 호출자는 editor 를 따로 넘기지 않는다.
  const { paintedVersionRef: _painted, showSection, showPresetBody, ...rest } = view;
  return {
    ...rest,
    editor,
    switchSection,
    showSection: (sec: Section, opts?: { clearUneditable?: boolean }) => showSection(editor, sec, opts),
    showPresetBody: (id: string, body: string) => showPresetBody(editor, id, body),
  };
}

export type MobileBodyEditor = ReturnType<typeof useMobileBodyEditor>;
