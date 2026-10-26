import type { MouseEvent } from "react";
import type { Editor } from "@tiptap/core";
import { t } from "../i18n/t";
import { IconCheck, IconBold, IconItalic } from "../components/icons";
import { MobileImageSizeControls } from "./MobileImageSizeControls";

interface Props {
  editor: Editor;
  /** 읽기 전용 본문 — 서식 버튼만 막는다. */
  readOnly: boolean;
  /** "format" = ☑ B I, "image" = 이미지 크기 3단. 어느 쪽인지는 MobileDockSlot 이 정한다(dockSlotKind). */
  mode: "format" | "image";
}

/**
 * IME 조합이 살아 있는 동안은 서식 버튼이 에디터 포커스를 **놓게** 한다 — 독 루트의 keepEditorFocus 위임을 끊는다.
 *
 * keepEditorFocus 는 눌러도 에디터 포커스(=화면 키보드)를 지키려고 mousedown 을 막는다. 그런데 막으면 **조합이 살아 있는
 * 채로** 명령이 트랜잭션을 꽂는다. 예전 툴바 줄은 mousedown 을 안 막아서 버튼으로 포커스가 넘어가며 조합이 끝난
 * 뒤(글자가 문서에 확정된 뒤)에 명령이 돌았다 — 그 보장이 사라졌다. 안드로이드 Gboard 는 조합 범위의 DOM 이
 * 바뀌면 글자를 겹치거나 깬다(mobileNudgeApply.ts 가 같은 이유로 조합 중 트랜잭션을 거부한다). 안드로이드에선 에디터가
 * 거의 늘 조합 중이라(prosemirror-view 주석) "조합 중이면 건너뛰기"는 버튼이 죽고, "조합이 끝나길 기다리기"는 한글처럼
 * 마지막 음절이 끝까지 조합 중인 입력에서 한참 안 돈다 — 그래서 막는 대신 **포커스를 놓게 해** 예전 경로(blur 로 조합
 * 확정 → click → chain().focus() 로 복귀)를 그대로 탄다. 대가는 조합 중 그 한 번의 키보드 깜박임이다.
 *
 * 세 버튼이 같다(☑ 만이 아니다). 굵게/기울임은 캐럿만 있으면 저장 표식(stored marks)만 얹혀 ProseMirror 가 스스로 자기 조합
 * 추적을 끊게 되어 있지만(updateStateInner), 그때 IME(Gboard)는 조합을 그대로 쥐고 있다. 예전엔 한 번도 안 탄 길이고 기기에서
 * 안전한지 검증하지 못했으므로 예전 동작(포커스를 먼저 놓는다)으로 되돌렸다. 깜박임이 거슬리면 캐럿만 있는 굵게/기울임을 다시
 * 면제할 수 있다 — 기기에서 글자가 겹치지 않는지 본 뒤에.
 */
const releaseFocusWhileComposing = (editor: Editor) => (e: MouseEvent<HTMLElement>) => {
  if (editor.view?.composing) e.stopPropagation();
};

/**
 * 독 슬롯(MobileDockSlot)의 서식 도구 — 예전 맨 위 툴바 줄(.mobile-note-toolbar)의 서식 부분이다. 클립·마이크는
 * ＋ 스피드 다이얼(MobileSpeedDial — 텍스트 섹션은 떠 있는 FAB, 관계도·시트는 독 슬롯)로 갔고, 줄 자체는 사라졌다(오너 2026-10-07: 키보드 위 엄지 영역으로 내린다 — 하단 배치는
 * MobileNoteActionBar 가 이미 검증한 경로).
 *
 * 관계도·시트 섹션엔 이 컴포넌트를 아예 그리지 않는다(bold/italic/checklist 는 JSON/시트 소스에 뜻이 없다 — 오너
 * 2026-07-30 item 4). 이미지를 선택하면 서식 자리를 크기 3단이 대신한다.
 * 버튼마다 `editor.chain().focus()` 로 포커스를 되돌리고, 눌러도 키보드가 안 내려가는 건 독 루트의
 * keepEditorFocus 가 맡는다 — **IME 조합 중인 눌림만 예외**다(releaseFocusWhileComposing).
 */
export function MobileNoteToolbar({ editor, readOnly, mode }: Props) {
  if (mode === "image") {
    return (
      <MobileImageSizeControls
        editor={editor}
        className="mobile-image-toolbar-sizes"
        testId="mobile-image-size-controls"
      />
    );
  }
  return (
    <div className="mobile-dock-tools" role="group" aria-label={t("mobile.format_group")}>
      <button
        type="button"
        className="mobile-icon-btn"
        disabled={readOnly}
        data-active={editor.isActive("taskList")}
        aria-label={t("mobile.checklist")}
        title={t("mobile.checklist")}
        onMouseDown={releaseFocusWhileComposing(editor)}
        onClick={() => editor.chain().focus().toggleTaskList().run()}
      >
        <IconCheck size={22} strokeWidth={2} />
      </button>
      <button
        type="button"
        className="mobile-icon-btn"
        disabled={readOnly}
        data-active={editor.isActive("bold")}
        aria-label={t("editor.bold")}
        title={t("editor.bold")}
        onMouseDown={releaseFocusWhileComposing(editor)}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        <IconBold size={20} strokeWidth={2.2} />
      </button>
      <button
        type="button"
        className="mobile-icon-btn"
        disabled={readOnly}
        data-active={editor.isActive("italic")}
        aria-label={t("editor.italic")}
        title={t("editor.italic")}
        onMouseDown={releaseFocusWhileComposing(editor)}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        <IconItalic size={20} strokeWidth={2} />
      </button>
    </div>
  );
}
