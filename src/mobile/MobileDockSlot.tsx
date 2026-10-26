import { useEffect, useReducer, useRef } from "react";
import type { Editor } from "@tiptap/core";
import type { CustomPreset } from "../stores/presets";
import { MobileCapturePresets } from "./MobileCapturePresets";
import { MobileNoteToolbar } from "./MobileNoteToolbar";
import { MobileSpeedDial, type SpeedDialHandlers } from "./MobileSpeedDial";

/** 독 슬롯이 지금 보여 주는 것. */
export type DockSlotKind = "presets" | "image" | "format" | "none";

/**
 * 독 슬롯의 상태표(순수 함수 — shouldShowCapturePresets 와 같은 스타일이라 Tiptap 없이 표로 시험한다).
 *
 *   관계도·시트 섹션              → none    (서식 동사는 뜻이 없다 — 프리셋도 안 낸다: 프리셋은 본문 텍스트 섹션에 쓰는 것이다.
 *                                            슬롯에는 스피드 다이얼의 ＋ 만 선다 — 떠 있는 FAB 가 이 섹션들의 아래쪽 컨트롤을 가려서 옮겨 왔다)
 *   읽기 전용 텍스트              → format  (예전처럼 비활성 — 프리셋·이미지 크기는 고칠 수 있을 때만)
 *   이미지가 선택됨               → image   (크기 3단이 서식 자리를 대신한다)
 *   입력 화면 + 빈 본문 + 프리셋 미적용 → presets (shouldShowCapturePresets 가 판정해 showPresets 로 온다)
 *                                            **그리고 살아 있는 에디터도 비어 있어야 한다**(bodyEmpty)
 *   그 밖                         → format
 *
 * 왜 bodyEmpty 가 따로 있나: showPresets 의 근거인 스토어 플래그(activeBodyEmpty)는 700ms 자동저장 디바운스가 끝나야
 * 움직인다 — 연달아 치는 동안엔 키마다 타이머가 다시 걸려서 **첫 문장을 다 칠 때까지** 안 움직인다(EditorPanel 이 같은
 * 이유로 ProseMirror 문서에서 직접 읽는다). 그 틈에 프리셋 줄이 눌리면 칠해 둔 글이 프리셋 본문으로 덮인다. 그래서
 * 프리셋은 스토어 플래그 **그리고** 에디터 문서가 둘 다 비었을 때만 보인다(첫 글자에서 서식으로 바뀐다).
 */
export function dockSlotKind(o: {
  textSection: boolean;
  readOnly: boolean;
  imageSelected: boolean;
  showPresets: boolean;
  /** 살아 있는 에디터 문서가 비었다(`editor.isEmpty`) — 스토어 플래그와 달리 첫 글자에 바로 움직인다. */
  bodyEmpty: boolean;
}): DockSlotKind {
  if (!o.textSection) return "none";
  if (o.readOnly) return "format";
  if (o.imageSelected) return "image";
  if (o.showPresets && o.bodyEmpty) return "presets";
  return "format";
}

/**
 * 슬롯 안 버튼의 눌림·선택 표시가 낡지 않게 한다. Tiptap v3 의 useEditor 는 트랜잭션마다 다시 그리지 않아서
 * (shouldRerenderOnTransaction 기본 꺼짐) 캐럿만 옮겨도 "이미지 선택됨 → 크기 3단"·굵게 눌림 표시·"본문이 비었나"가
 * 부모가 우연히 다시 그려질 때까지 안 바뀐다. 그려질 때의 값(진실)을 ref 에 두고, 트랜잭션 뒤 값이 달라졌을 때만 한 번 다시 그린다.
 * useEditorState 를 안 쓰는 건 MobileNote 계열 테스트가 `@tiptap/react` 를 useEditor 만으로 목하기 때문이다.
 */
function editorFlagsKey(editor: Editor): string {
  // isEmpty 도 여기 든다 — 첫 글자가 들어가는 트랜잭션에서 슬롯이 프리셋 → 서식으로 바뀐다(dockSlotKind 주석).
  return [
    editor.isActive("image"),
    editor.isActive("taskList"),
    editor.isActive("bold"),
    editor.isActive("italic"),
    editor.isEmpty,
  ]
    .map((b) => (b ? "1" : "0"))
    .join("");
}
function useEditorFlagsRefresh(editor: Editor): void {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const paintedRef = useRef("");
  paintedRef.current = editorFlagsKey(editor);
  useEffect(() => {
    const sync = () => {
      if (editor.isDestroyed) return;
      if (editorFlagsKey(editor) !== paintedRef.current) bump();
    };
    editor.on("transaction", sync);
    return () => {
      editor.off("transaction", sync);
    };
  }, [editor]);
}

interface Props {
  editor: Editor;
  /** 현재 섹션이 본문(텍스트)인가 — 관계도·시트가 아니다. */
  textSection: boolean;
  readOnly: boolean;
  /** 입력 화면 · 본문이 비었고 프리셋을 아직 안 썼다(shouldShowCapturePresets). 스토어 플래그 기준이라 늦다 —
   *  슬롯이 살아 있는 에디터 문서로 한 번 더 거른다(dockSlotKind). */
  showPresets: boolean;
  customPresets: CustomPreset[];
  todoBodyMd: string;
  aiReady: boolean;
  onApplyPreset: (req: { title: string | null; bodyMd: string }) => void;
  onGenerateAi: (topic: string) => Promise<string | null>;
  /** 관계도·시트 섹션(슬롯이 비는 곳)에 설 스피드 다이얼 ＋ 의 동작. 없으면 슬롯은 빈 채로 둔다. */
  speedDial?: SpeedDialHandlers;
}

/**
 * 하단 독(MobileNoteActionBar)의 왼쪽 "도구함" — 상황에 따라 바뀐다(오너 2026-10-07):
 * 빈 입력 = 프리셋 한 줄(가로 스크롤 + 더보기), 글이 생기면 = 서식, 이미지 선택 = 크기 3단, 관계도·시트 = 스피드 다이얼 ＋ 하나.
 * 한 줄이고 넘치면 가로로 스크롤한다. 높이는 늘 48 이라 상태가 바뀌어도 독이 출렁이지 않는다.
 *
 * 다이얼의 펼침 항목은 슬롯(overflow:auto)을 **넘쳐 위로** 열린다 — 그래서 MobileSpeedDial 은 슬롯 안에서 위치 기준이 되지 않는다
 * (note-capture.css 의 `[data-placement="dock"]` 설명). 슬롯 안에는 ＋ 버튼 하나만 흐름에 놓인다.
 */
export function MobileDockSlot({
  editor,
  textSection,
  readOnly,
  showPresets,
  customPresets,
  todoBodyMd,
  aiReady,
  onApplyPreset,
  onGenerateAi,
  speedDial,
}: Props) {
  useEditorFlagsRefresh(editor);
  const kind = dockSlotKind({
    textSection,
    readOnly,
    imageSelected: editor.isActive("image"),
    showPresets,
    bodyEmpty: editor.isEmpty,
  });
  return (
    <div className="mobile-dock-slot" data-testid="mobile-dock-slot" data-slot={kind}>
      {kind === "presets" && (
        <MobileCapturePresets
          customPresets={customPresets}
          todoBodyMd={todoBodyMd}
          aiReady={aiReady}
          onApply={onApplyPreset}
          onGenerateAi={onGenerateAi}
        />
      )}
      {(kind === "format" || kind === "image") && (
        <MobileNoteToolbar editor={editor} readOnly={readOnly} mode={kind} />
      )}
      {kind === "none" && speedDial && <MobileSpeedDial placement="dock" {...speedDial} />}
    </div>
  );
}
