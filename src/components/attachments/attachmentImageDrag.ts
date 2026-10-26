// 첨부바 이미지 타일 → 에디터 본문 드래그. lib/noteDrag.ts의 포인터 기반 자체 드래그 패턴을
// 미러링한다(HTML5 DnD 를 못 쓰는 이유는 그 파일 상단 주석). 그대로 재사용하지 않는 이유:
// noteDrag.ts의 드롭 대상은 DOM 속성(data-note-drop-target)으로 등록된 컨테이너뿐이라, 드롭
// 대상이 "지금 열려 있는 라이브 TipTap 에디터"인 이 흐름과는 맞지 않는다. 임계값(4px)만은
// 제네릭 상수(lib/pointerContract.ts) 그대로 가져다 쓴다.
import type React from "react";
import type { Attachment } from "../../lib/commands.gen";
import { getActiveEditor } from "../../lib/aiSectionBridge";
import { resolveDropPos } from "../editor/useEditorFileDrop";
import { insertImageAtPos } from "../editor/insertImageAtPos";
import { DRAG_THRESHOLD_PX } from "../../lib/pointerContract";

/** Exported for testing — 라이브 에디터 DOM rect 안인지 순수 판정. */
export function isInsideRect(clientX: number, clientY: number, rect: DOMRect): boolean {
  return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
}

function makeGhost(name: string): HTMLElement {
  const ghost = document.createElement("div");
  // noteDrag.ts의 note-drag-ghost와 같은 모양(overlay 시트 톤 + 고정 위치) — 파일명 칩.
  ghost.className = "overlay note-drag-ghost";
  ghost.style.cssText = [
    "position:fixed",
    "z-index:var(--z-drag)",
    "pointer-events:none",
    "display:flex",
    "align-items:center",
    "gap:6px",
    "padding:4px 10px",
    "max-width:220px",
    "font-family:var(--font-body)",
    "font-size:var(--text-xs)",
    "color:var(--text)",
    "white-space:nowrap",
    "overflow:hidden",
    "box-shadow:var(--shadow-lg)",
  ].join(";");
  const text = document.createElement("span");
  text.textContent = name;
  text.style.cssText = "overflow:hidden;text-overflow:ellipsis";
  ghost.appendChild(text);
  return ghost;
}

/** 에디터 rect 안이면 그 좌표의 캐럿 위치를, 아니면 null을 돌려준다(문서 밖 = 삽입 불가). */
function editorPosAt(clientX: number, clientY: number): number | null {
  const editor = getActiveEditor();
  if (!editor) return null; // 다이어그램 섹션(getActiveEditor가 null) 포함
  const rect = editor.view.dom.getBoundingClientRect();
  if (!isInsideRect(clientX, clientY, rect)) return null;
  const docSize = editor.state.doc.content.size;
  return Math.min(resolveDropPos(editor.view.posAtCoords({ left: clientX, top: clientY })?.pos, editor.state.selection.to), docSize);
}

/**
 * 이미지 타일의 onPointerDown에서 호출. 임계값을 넘겨야 실제 드래그가 시작되므로 단순 클릭
 * (프리뷰 토글 등 기존 동작)은 그대로 살아 있다. 다중선택 제스처(Ctrl/Cmd/Shift)는 드래그를
 * 시작하지 않는다 — TreeListRow.tsx와 같은 규칙.
 */
export function startAttachmentImageDrag(e: React.PointerEvent, attachment: Attachment): void {
  if (e.button !== 0) return;
  if (e.ctrlKey || e.metaKey || e.shiftKey) return;
  const startX = e.clientX;
  const startY = e.clientY;
  let ghost: HTMLElement | null = null;
  let lastPos: number | null = null;

  const onMove = (ev: PointerEvent) => {
    if (!ghost) {
      if (Math.abs(ev.clientX - startX) < DRAG_THRESHOLD_PX && Math.abs(ev.clientY - startY) < DRAG_THRESHOLD_PX) {
        return;
      }
      ghost = makeGhost(attachment.name);
      document.body.appendChild(ghost);
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
    }
    ghost.style.left = `${ev.clientX + 8}px`;
    ghost.style.top = `${ev.clientY - ghost.offsetHeight - 4}px`;

    const editor = getActiveEditor();
    if (!editor) return;
    const pos = editorPosAt(ev.clientX, ev.clientY);
    if (pos === null || pos === lastPos) return;
    lastPos = pos;
    editor.chain().focus().setTextSelection(pos).run();
  };

  const onUp = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    if (!ghost) return; // 임계값 미달 = 그냥 클릭
    ghost.remove();
    ghost = null;
    const editor = getActiveEditor();
    if (!editor) return;
    const pos = editorPosAt(ev.clientX, ev.clientY);
    if (pos === null) return; // 에디터 밖 드롭 = 아무 일도 하지 않는다
    insertImageAtPos(editor, attachment, pos);
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}
