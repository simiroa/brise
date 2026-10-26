import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { createLowlight, common } from "lowlight";
import { t } from "../../i18n/t";

const lowlight = createLowlight(common);

/** Native DOM node view: keeps code editable while adding one accessible copy control. */
export const CodeBlockWithCopy = CodeBlockLowlight.configure({ lowlight }).extend({
  addNodeView() {
    return ({ node }) => {
      let currentNode = node;
      let resetTimer: ReturnType<typeof setTimeout> | undefined;

      const dom = document.createElement("div");
      dom.className = "brise-code-block";

      const pre = document.createElement("pre");
      const code = document.createElement("code");
      pre.append(code);

      const button = document.createElement("button");
      button.type = "button";
      button.className = "brise-code-block-copy";
      button.contentEditable = "false";

      const setLabel = (copied: boolean) => {
        const label = t(copied ? "editor.code_copied" : "editor.code_copy");
        button.textContent = label;
        button.title = label;
        button.setAttribute("aria-label", label);
        button.dataset.copied = String(copied);
      };
      const setLanguageClass = () => {
        code.className = currentNode.attrs.language ? `language-${currentNode.attrs.language}` : "";
      };

      setLabel(false);
      setLanguageClass();
      dom.append(pre, button);

      const preventEditorBlur = (event: MouseEvent) => event.preventDefault();
      const copy = async (event: MouseEvent) => {
        event.stopPropagation();
        try {
          await navigator.clipboard.writeText(currentNode.textContent);
        } catch {
          return;
        }
        setLabel(true);
        if (resetTimer) clearTimeout(resetTimer);
        resetTimer = setTimeout(() => setLabel(false), 1600);
      };
      button.addEventListener("mousedown", preventEditorBlur);
      button.addEventListener("click", copy);

      return {
        dom,
        contentDOM: code,
        update(updatedNode: ProseMirrorNode) {
          if (updatedNode.type !== currentNode.type) return false;
          currentNode = updatedNode;
          setLanguageClass();
          return true;
        },
        stopEvent: (event: Event) => event.target === button,
        ignoreMutation: (mutation) => !code.contains(mutation.target),
        destroy() {
          if (resetTimer) clearTimeout(resetTimer);
          button.removeEventListener("mousedown", preventEditorBlur);
          button.removeEventListener("click", copy);
        },
      };
    };
  },
});
