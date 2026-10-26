import { useEffect } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import { PREVIEW_EXTENSIONS } from "../../lib/editorExtensions";
import { MARKDOWN_SET_CONTENT_OPTIONS } from "../../lib/mdSerialize";

/**
 * 사료(source) 본문 등 마크다운 원문을 읽기 전용 TipTap 으로 렌더한다. SectionPreview.tsx 와
 * 같은 렌더 경로(PREVIEW_EXTENSIONS, MARKDOWN_SET_CONTENT_OPTIONS) 를 재사용 — marked+
 * dangerouslySetInnerHTML 은 외부 문서 추출본이라 XSS 면이 생겨 쓰지 않는다.
 */
export function MarkdownBody({ text }: { text: string }) {
  const editor = useEditor(
    {
      editable: false,
      content: text,
      contentType: "markdown",
      extensions: PREVIEW_EXTENSIONS,
      editorProps: { attributes: { spellcheck: "false" } },
    },
    []
  );

  useEffect(() => {
    // SectionPreview 와 동일한 함정: destroy된 인스턴스에 커맨드를 부르면 앱 전체가 백지 크래시.
    if (editor && !editor.isDestroyed) {
      editor.commands.setContent(text, MARKDOWN_SET_CONTENT_OPTIONS);
    }
  }, [editor, text]);

  return (
    <div className="mdbody">
      <EditorContent editor={editor} />
    </div>
  );
}
