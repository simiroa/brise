import Image from "@tiptap/extension-image";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { ImageNodeView } from "./ImageNodeView";
import { IMAGE_WIDTH_DEFAULT, formatImageWidth } from "./imageResize";

/**
 * BriseImage — @tiptap/extension-image extended with a `relPath` attribute (rendered as
 * `data-rel-path`) and a `width` attribute (D5: 기본 40%, 상한 100%).
 *
 * Why relPath: 사용자가 보는 이미지의 `src` 는 Tauri `convertFileSrc()` 가 만든 asset:// URL —
 * `attachments_base_dir` + 첨부의 상대경로로 조립한 세션 한정·절대 경로다. 그 값을 그대로
 * 저장하면 `![alt](src)` 가 이식 불가능해진다(워크스페이스를 옮기면 깨지고, Tauri 밖에서는
 * 의미가 없다). 그래서 둘을 나눠 갖는다: 화면 표시는 `src`, 저장은 `data-rel-path`.
 *
 * P0-1 (2026-07-31): body_md is real markdown via @tiptap/markdown. Stock Image's
 * renderMarkdown only emits `![alt](src)` and drops width + relPath, so resize snapped
 * back to 40% after reload. Custom parse/render keeps both:
 *   `![alt](rel-or-src){width=70%}`
 * On parse, a non-http(s) href is treated as the portable relPath (and as src until the
 * session rewrites display src via convertFileSrc). Existing plain `![alt](path)` still
 * loads (width defaults to 40%). HTML <img data-rel-path style="width:…"> from older
 * bodies still parse via parseHTML.
 */
/**
 * 이미지 src 는 라이브 DOM 에 실제 <img> 로 렌더된다. Link 확장과 달리 extension-image 는 src scheme 을
 * 검증하지 않아, 임포트된 본문의 `<img src="file:///…">` 가 asset: scope 를 우회해 로컬 파일을 로드할 수
 * 있다(정보노출). 앱이 실제 쓰는 건 convertFileSrc 의 http(s)://asset.localhost 와 붙여넣은 원격 https 뿐이므로
 * http/https 만 통과시키고, scheme 있는 그 외(file:/data:/javascript:)는 드롭한다. 상대경로/scheme 없는 값은 통과.
 */
// Exported: ImageNodeView's resolveImageDisplaySrc reuses this same gate on its `rawSrc` fallback
// (the value it falls back to when relPath is absent/unsafe) — parseMarkdown's `src: href || null`
// sets `src` to the SAME unvalidated href relPath is built from, so a body containing
// `![](file:///etc/passwd)` must not reach that fallback verbatim either. parseHTML's own call
// site below still gates its own entry point independently.
export const isSafeImgSrc = (src: string | null): boolean => {
  if (!src) return true;
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(src.trim());
  if (!m) return true; // scheme 없음(상대경로 등) → 허용
  const scheme = m[1].toLowerCase();
  return scheme === "http" || scheme === "https";
};

const isRemoteHref = (href: string): boolean => /^https?:\/\//i.test(href.trim());

/**
 * Guards the join `${attachmentsBaseDir}/${relPath}` that ImageNodeView performs at render time
 * (via useAttachmentsBase) to build the displayable asset:// URL. relPath comes straight from
 * markdown/HTML on parse (parseMarkdown below, or the `data-rel-path` attr's parseHTML) with no
 * validation of its own — a note body containing `![](../../../secrets)` or `![](/etc/passwd)`
 * must not be allowed to escape the attachments dir through that join. Mirrors isSafeImgSrc above
 * (which gates the `src` attr) and is_safe_model_id (migrations.rs) — same "don't trust a stored
 * path used to build a filesystem/URL join" posture used elsewhere in this codebase.
 */
export function isSafeRelPath(relPath: string | null | undefined): relPath is string {
  if (!relPath) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(relPath)) return false; // scheme prefix (http:, file:, data:, ...)
  if (relPath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(relPath)) return false; // absolute (POSIX or Windows drive)
  if (relPath.split(/[\\/]/).some((seg) => seg === "..")) return false; // traversal segment
  return true;
}

/** Escape characters that would break the image destination or the {width=…} suffix. */
function escapeMdAttr(value: string): string {
  return value.replace(/[\\[\]()]/g, "\\$&");
}

export const BriseImage = Image.extend({
  addAttributes() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parent = (this.parent?.() ?? {}) as Record<string, any>;
    return {
      ...parent,
      // NodeView-render-time resolution (ImageNodeView.tsx) — this attribute is now the
      // FALLBACK display source, not the primary one. relPath (below) is primary for local
      // attachment images; src stays primary only for remote (http/https) images pasted from
      // the web (relPath is null for those — see parseMarkdown). No renderHTML override here:
      // it inherits the parent's default (renders node.attrs.src as-is, whatever that is).
      // That matters for ONE consumer — renderPresetGhostHtml's headless getHTML() (EditorPanel.tsx)
      // — which has no NodeView and can't resolve relPath→asset URL (that resolution needs
      // useAttachmentsBase, an async Tauri call gated behind a React hook; renderHTML is a
      // synchronous string-builder with neither). A preset body containing a real attachment
      // image would render a blank/broken <img> in that read-only hover preview. Deliberate,
      // not a silent gap: presets are prose templates and essentially never embed real
      // attachment images, and PREVIEW_EXTENSIONS' own comment already documents that the ghost
      // shows the parsed result "including any residual warts, not a prettier fiction."
      src: {
        ...parent.src,
        parseHTML: (element: HTMLElement) => {
          const src = element.getAttribute("src");
          return isSafeImgSrc(src) ? src : null;
        },
      },
      relPath: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-rel-path"),
        renderHTML: (attributes: { relPath?: string | null }) => {
          if (!attributes.relPath) return {};
          return { "data-rel-path": attributes.relPath };
        },
      },
      width: {
        default: formatImageWidth(IMAGE_WIDTH_DEFAULT),
        parseHTML: (element: HTMLElement) =>
          element.style.width || element.getAttribute("width") || formatImageWidth(IMAGE_WIDTH_DEFAULT),
        renderHTML: (attributes: { width?: string }) => {
          // Used for non-NodeView HTML (copy/export). Live editing uses ImageNodeView.
          // Width-related styles only — border-radius lives once in tokens.css
          // (`.ProseMirror img` / `.brise-image-img`) so renderHTML never nukes/duplicates CSS.
          const w = attributes.width || formatImageWidth(IMAGE_WIDTH_DEFAULT);
          // Same absolute cap as ImageNodeView's live display (--editor-img-max, tokens.css) —
          // keeps ghost-preview/export sizing consistent with the real editor.
          return {
            style: `width: ${w}; max-width: min(100%, var(--editor-img-max)); height: auto; display: block;`,
          };
        },
      },
    };
  },

  // Desktop free-drag handle (D5). Mobile hides the handle via CSS and uses 3-step buttons.
  addNodeView() {
    return ReactNodeViewRenderer(ImageNodeView);
  },

  // Override stock Image markdown so width + relPath survive save/reload (P0-1 / D5).
  parseMarkdown: (token, helpers) => {
    const href = String(token.href ?? "");
    const widthRaw = (token as { width?: string }).width;
    const width =
      widthRaw && String(widthRaw).trim()
        ? String(widthRaw).trim()
        : formatImageWidth(IMAGE_WIDTH_DEFAULT);
    const relPath = href && !isRemoteHref(href) ? href : null;
    return helpers.createNode("image", {
      src: href || null,
      title: token.title ?? null,
      alt: token.text ?? "",
      relPath,
      width,
    });
  },

  renderMarkdown: (node) => {
    const alt = String(node.attrs?.alt ?? "");
    const relPath = node.attrs?.relPath as string | null | undefined;
    const src = String(relPath || node.attrs?.src || "");
    const width = String(node.attrs?.width || formatImageWidth(IMAGE_WIDTH_DEFAULT));
    const title = node.attrs?.title as string | null | undefined;
    const dest = title ? `${src} "${String(title).replace(/"/g, '\\"')}"` : src;
    // Always emit {width=…} so double round-trip is byte-stable and resize survives reload.
    return `![${escapeMdAttr(alt)}](${dest}){width=${width}}`;
  },

  // Stock marked image tokens stop at `![alt](src)`; the `{width=…}` suffix needs a tokenizer.
  // Falls back to the plain image form (no suffix) so older body_md still loads.
  markdownTokenizer: {
    name: "image",
    level: "inline" as const,
    start: (src: string) => src.indexOf("!["),
    tokenize(src: string, _tokens: unknown, lexer: { inlineTokens: (s: string) => unknown[] }) {
      // ![alt](href) or ![alt](href "title") with optional {width=70%}
      const rule =
        /^!\[([^\]]*)\]\(\s*<?([^\s>)]+)>?(?:\s+(?:"([^"]*)"|'([^']*)'))?\s*\)(?:\{width=([^}]+)\})?/;
      const match = rule.exec(src);
      if (!match) return undefined;
      const alt = match[1] ?? "";
      const href = match[2] ?? "";
      const title = match[3] ?? match[4] ?? null;
      const width = match[5]?.trim();
      // Cast: marked's MarkdownToken is a loose bag; width is our app-specific field read in parseMarkdown.
      return {
        type: "image",
        raw: match[0],
        href,
        title,
        text: alt,
        width: width || undefined,
        tokens: lexer.inlineTokens(alt),
      } as unknown as import("@tiptap/core").MarkdownToken;
    },
  },
});
