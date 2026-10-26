/**
 * 폰 노트 화면의 "지금 어떤 섹션이 어떤 모양으로 떠 있나" — 그 상태와 그것을 에디터에 칠하는 규칙 한 곳.
 *
 * 섹션은 세 모양으로 뜬다: 본문(Tiptap), 관계도(DiagramSection — Tiptap 은 비어 숨는다), 시트(MobileSheetEditor —
 * 마찬가지). 본문은 다시 편집 가능/읽기 전용(canEditBodyOnMobile 이 못 왕복하는 서식)으로 갈린다. 노트 로드 효과·섹션
 * 전환·AI/전사 삽입·캡처 프리셋 네 경로가 전부 "이 섹션을 올린다"는 같은 분기를 타므로 showSection 한 곳에서 한다
 * (이전엔 네 벌 손복사였고, 그 탓에 노트 로드 쪽에만 시트 분기가 빠졌던 적이 있다).
 *
 * 이 훅은 에디터 인스턴스를 만들지 않는다 — useMobileBodyEditor 가 useEditor 를 만들 때 onUpdate 가 이 훅의 ref 들
 * (sectionRef·readOnlyRef·timeoutRef·flushRef)을 먼저 알아야 해서 이쪽을 먼저 부른다. 에디터는 칠할 때 인자로 받는다.
 */
import { useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import type { Section } from "../lib/commands.gen";
import { useNotesStore } from "../stores/notes";
import { paintSectionBody, useSectionEditor } from "../components/editor/useSectionEditor";
import { canEditBodyOnMobile } from "./mobileEditorSupport";

type MobileSectionKind = "text" | "diagram" | "sheet";

export function useMobileSectionView() {
  // Section ref+state mirror + flush registration — editor/useSectionEditor.ts (shared with
  // desktop's EditorPanel.tsx, which was hand-rolling the exact same pattern; see that file's own
  // comment for what's genuinely shared vs what stays duplicated). No onSet callback here — the
  // BubbleMenu-anchor reset it drives on desktop doesn't exist on mobile.
  const {
    sectionRef,
    activeSectionId,
    setActiveSection: setActiveSectionObj,
    timeoutRef,
    flushRef,
  } = useSectionEditor<MobileSectionKind>();

  const [readOnly, setReadOnly] = useState(false);
  // 읽기 전용(편집 불가 서식)·다이어그램·시트 섹션은 Tiptap 이 빈 채로 떠 있다. 이때 자동 저장/flush 가
  // 에디터 직렬화 결과("")를 본문으로 알고 서버에 쓰면 **데스크톱 서식 노트의 본문이 폰에서 열람만 해도
  // 지워진다**(2026-10-04 실기기에서 실제로 두 섹션이 0자가 됨 — 스냅샷으로 복구). 그래서 쓰기 경로
  // (onUpdate 타이머·flushRef)는 이 ref 를 본다. state 가 아니라 ref 인 이유: useEditor 의 onUpdate 가
  // 오래된 클로저를 쥘 수 있고, setReadOnly 가 반영되기 전 틈에도 막아야 해서.
  const readOnlyRef = useRef(false);
  const markReadOnly = (v: boolean) => {
    readOnlyRef.current = v;
    setReadOnly(v);
  };

  // 이 섹션을 화면에 칠할 때 알고 있던 서버 버전(`sections[].updated_at`). 노트 로드 효과가 "본문 외 패치로
  // activeNote 참조만 바뀐" 경우를 가려내는 데 쓴다(useMobileBodyEditor 의 효과 주석 참조).
  const paintedVersionRef = useRef<{ id: string; updatedAt: string | null | undefined } | null>(null);
  const setActiveSection = (sec: { id: string; body: string; kind: MobileSectionKind }) => {
    paintedVersionRef.current = {
      id: sec.id,
      updatedAt: useNotesStore.getState().activeNote?.sections.find((s) => s.id === sec.id)?.updated_at,
    };
    setActiveSectionObj(sec.id, sec.body, sec.kind);
  };

  // The full Section object for a kind:'diagram' current section — DiagramSection needs the whole
  // Section (id/name/body_md/position/kind), not just sectionRef's {id,body,kind} slice. null means
  // "current section is not a diagram" (text or sheet); same for sheetSection below. Both null =
  // text. Drives rendering and the toolbar's formatting verbs.
  const [diagramSection, setDiagramSection] = useState<Section | null>(null);
  // DiagramSection/MobileSheetEditor 는 마운트 때만 본문을 읽는다 — rev 가 오르면 key 가 바뀌어 다시 마운트한다.
  const [diagramRev, setDiagramRev] = useState(0);
  const [sheetSection, setSheetSection] = useState<Section | null>(null);
  const [sheetRev, setSheetRev] = useState(0);

  // 호출 순서가 규약이다: setActiveSection(updated_at 을 이 순간 읽는다) → 상태 setter → markReadOnly →
  // 에디터. markReadOnly 의 ref 쓰기가 setEditable 보다 먼저여야 그 틈에 자동 저장이 못 끼어든다.
  const showDiagram = (editor: Editor | null, sec: Section) => {
    setDiagramSection(sec);
    setSheetSection(null);
    markReadOnly(false);
    if (editor) {
      editor.setEditable(false); // tiptap stays inert/hidden — DiagramSection owns the screen
      editor.commands.clearContent(false);
    }
  };
  const showSheet = (editor: Editor | null, sec: Section) => {
    setDiagramSection(null);
    setSheetSection(sec);
    markReadOnly(false);
    if (editor) {
      editor.setEditable(false);
      editor.commands.clearContent(false);
    }
  };
  const showText = (editor: Editor | null, body: string, clearUneditable: boolean) => {
    setDiagramSection(null);
    setSheetSection(null);
    const editable = canEditBodyOnMobile(body);
    markReadOnly(!editable);
    if (editor) {
      editor.setEditable(editable);
      // 읽기 전용은 칠하지 않는다 — sec.body(원문)를 PlainTextBody 가 그대로 보여 준다.
      if (editable) paintSectionBody(editor, sectionRef.current, body);
      else if (clearUneditable) editor.commands.clearContent(false);
    }
  };

  /**
   * 섹션 하나를 화면에 올린다(sectionRef·활성 id 포함). `editor` 가 null 이어도 상태·ref 는 갱신한다.
   *
   * ponytail: clearUneditable=false 는 AI/전사 삽입(insertSection)이 쓰던 동작이다 — 읽기 전용 본문일 때 에디터
   * 내용을 비우지 않는다(노트 로드·섹션 전환은 비운다). 이 차이를 일부러 보존했다.
   * Ceiling: 읽기 전용 섹션을 삽입한 직후 flushAndMeasure 의 getText() 길이가 이전 섹션 글자 수일 수 있다.
   * Upgrade path: 삽입 경로도 기본값(true)으로 — 동작 변경이라 따로 판단한다.
   */
  const showSection = (editor: Editor | null, sec: Section, opts: { clearUneditable?: boolean } = {}) => {
    setActiveSection({ id: sec.id, body: sec.body_md, kind: sec.kind });
    if (sec.kind === "diagram") showDiagram(editor, sec);
    else if (sec.kind === "sheet") showSheet(editor, sec);
    else showText(editor, sec.body_md, opts.clearUneditable ?? true);
  };

  /** 캡처 프리셋 본문을 현재 섹션(id)에 칠한다 — 프리셋은 항상 본문(prose)이고 읽기 전용이어도 비우지 않는다. */
  const showPresetBody = (editor: Editor | null, id: string, body: string) => {
    setActiveSection({ id, body, kind: "text" });
    showText(editor, body, false);
  };

  // 관계도/시트 소스를 통째로 바꾼 뒤 다시 마운트시킨다(AI 수정하기 — useMobileSectionOps).
  const replaceDiagramBody = (body_md: string) => {
    setDiagramSection((d) => (d ? { ...d, body_md } : d));
    setDiagramRev((r) => r + 1);
  };
  const replaceSheetBody = (body_md: string) => {
    setSheetSection((d) => (d ? { ...d, body_md } : d));
    setSheetRev((r) => r + 1);
  };
  // 서버본을 다시 읽은 뒤 시트만 다시 마운트(충돌 해소 — useMobileNoteSave).
  const remountSheet = () => setSheetRev((r) => r + 1);

  return {
    sectionRef,
    activeSectionId,
    timeoutRef,
    flushRef,
    readOnly,
    readOnlyRef,
    paintedVersionRef,
    diagramSection,
    diagramRev,
    sheetSection,
    sheetRev,
    setActiveSection,
    showSection,
    showPresetBody,
    replaceDiagramBody,
    replaceSheetBody,
    remountSheet,
  };
}
