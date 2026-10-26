/**
 * Selection clipboard helpers — pure move out of EditorPanel.tsx (Wave 6A).
 *
 * Owned by the horizontal BubbleMenu (TextBubbleMenu), not the right-click selCtx menu.
 * Wave 6-b: tauri-plugin-clipboard-manager removed — navigator.clipboard (Web Clipboard API,
 * works in WebView2) is now the only path, no OS-plugin/browser-API fallback pair needed.
 * Reads from/to from the live selection (editor.state.selection): BubbleMenu buttons
 * preventDefault on mousedown so the PM selection is still intact at click time.
 */
import type { Editor } from "@tiptap/core";

export async function copyEditorSelection(editor: Editor): Promise<void> {
  const { from, to } = editor.state.selection;
  const text = editor.state.doc.textBetween(from, to, "\n");
  await navigator.clipboard.writeText(text).catch(() => {});
}

export async function cutEditorSelection(editor: Editor): Promise<void> {
  const { from, to } = editor.state.selection;
  const text = editor.state.doc.textBetween(from, to, "\n");
  // 클립보드 쓰기가 실패하면 절대 지우지 않는다(먼저 지우고 나중에 쓰기 실패하면 선택
  // 텍스트가 그냥 사라지는 데이터 손실이 된다) — 그래서 쓰기를 먼저, 성공했을 때만 삭제.
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return; /* 클립보드 접근 불가 — 아무 것도 하지 않고 원문을 그대로 둔다 */
  }
  editor.chain().focus().deleteRange({ from, to }).run();
}

export async function pasteEditorSelection(editor: Editor): Promise<void> {
  const { from, to } = editor.state.selection;
  let text: string;
  try {
    // ponytail: navigator.clipboard.readText() needs Clipboard-Read permission. A user-gesture
    // click (this only runs from a menu item) grants it in WebView2, but this path needs one
    // manual check in the real app — right-click → Paste with real OS clipboard text queued.
    text = await navigator.clipboard.readText();
  } catch {
    return; /* 클립보드가 비어있거나 접근 불가 — 아무 것도 하지 않는다 */
  }
  if (!text) return;
  // insertContent(문자열)은 Tiptap이 HTML로 파싱한다(excerptToNewNote 의 tr.insertText
  // 채택 이유와 동일) — 클립보드 텍스트에 "<"/"&" 가 섞여 있으면 서식이 깨진다. tr.insertText
  // 로 순수 텍스트 교체만 수행한다.
  editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.insertText(text, from, to);
      return true;
    })
    .run();
}
