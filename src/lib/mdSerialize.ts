/**
 * body_md serialization for Brise notes (P0-1 / D1, 2026-07-31).
 *
 * Save path: live editor → `editor.getMarkdown()` (via mdSerializeEditor).
 * Load path: `editor.commands.setContent(body_md, { contentType: "markdown" })`.
 *
 * @tiptap/markdown (1st-party, 3.29.2) is the SSOT. The old one-way HTML→regex converter is
 * gone: it produced markdown that setContent treated as plain text, killing bold/headings/
 * lists/code/images/links on reload. Custom nodes that need app-specific attrs (BriseImage
 * width + data-rel-path) carry their own parseMarkdown/renderMarkdown on the extension.
 *
 * Diagram sections (kind='diagram') never enter this path — EditorPanel/MobileNote skip
 * setContent/getMarkdown for them and store the diagram source (JSON IR, plain-string body_md;
 * mermaid text before the 2026-09-04 JSON IR rebuild) as plain text, unparsed.
 *
 * mdSerializeHtml(html) remains for pure-function callers that only have an HTML fragment
 * (e.g. excerpt-to-new-note via getHTMLFromFragment). It spins a headless editor with the
 * same schema+Markdown extensions, then getMarkdown().
 */

import {
  decodeHtmlEntities,
  Editor,
  Mark,
  mergeAttributes,
  type AnyExtension,
  type Editor as EditorType,
  type Extensions,
  type JSONContent,
  type MarkdownParseHelpers,
  type MarkdownToken,
  type MarkdownTokenizer,
} from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TableRow } from "@tiptap/extension-table";
import {
  BriseTable,
  BriseTableCell,
  BriseTableHeader,
  setTableMarkdownExtensions,
} from "../components/editor/tableColwidth";
import Highlight from "@tiptap/extension-highlight";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import Typography from "@tiptap/extension-typography";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import { createLowlight, common } from "lowlight";
import { Details, DetailsSummary, DetailsContent } from "@tiptap/extension-details";
import Link from "@tiptap/extension-link";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { BriseImage } from "../components/editor/imageExtension";
import {
  BriseHeading,
  BriseParagraph,
  ParagraphFormatCommands,
  setParagraphFormatMarkdownExtensions,
} from "../components/editor/paragraphFormat";

const lowlight = createLowlight(common);

/**
 * `<span …>` 섬의 **안쪽을 마크다운으로** 읽는 파서 — 색 글자(BriseTextStyle)·각주·날짜 마크가 공유한다.
 *
 * 세 마크의 renderMarkdown 은 `<span …>` 을 열고 닫는 문자열만 낸다. 그 사이 글자는 @tiptap/markdown 이 다른
 * 글자처럼 마크다운으로 쓴다(`*` → `\*`, 굵게 → `**…**`). 그런데 그 라이브러리의 기본 파서는 여는 태그부터 닫는
 * 태그까지 토큰의 **원문**을 이어 붙여 DOM 으로 읽었다 — 안쪽의 `\*` 는 글자 그대로 남고 `**…**` 는 별표 글자가
 * 됐다. 다음 저장이 그 역슬래시와 별표를 또 이스케이프해 1→3→7→15→31 로 불었고(2026-10-18 실제 노트 손상),
 * 색 글자 안의 굵게는 다시 열자마자 사라졌다. 쓰는 쪽을 HTML 로 바꿀 수는 없다 — 글자 이스케이프는 라이브러리가
 * 마크와 무관하게 한다(코드 마크만 예외). 그래서 읽는 쪽을 쓰는 쪽에 맞춘다: 우리가 쓰는 모양의 섬만 골라 안쪽을
 * `inlineTokens` 로 토큰화하고, 그 결과에 이 마크를 얹는다.
 *
 * 우리가 쓰는 모양(속성 하나, 큰따옴표)이 아니면 `undefined` — 예전 경로(원문 이어 붙여 DOM 파싱)가 그대로 받는다.
 * 옛 HTML 시절 본문의 `<span style="color: …; font-size: …">` 같은 것은 첫 저장에서 우리 모양으로 바뀐 뒤부터
 * 이 경로를 탄다.
 *
 * 주의 — 토큰화기는 전역이다: Markdown 확장이 자기 marked 인스턴스를 받지 않아 모든 에디터가 marked 싱글턴에
 * 토큰화기를 등록한다. 그래서 같은 마크 이름을 쓰는 스키마(헤드리스 Brise*, 라이브 FootnoteMark/DateMark —
 * `.extend` 라 이 필드들을 물려받는다, 폰)는 전부 같은 parseMarkdown 을 가져야 한다. 처리기가 없는 스키마에서
 * 이 토큰은 안쪽만 남고 마크가 빠진다(폰의 색 글자 — mobileEditorSupport 가 그런 본문을 읽기 전용으로 막는다).
 */
const SPAN_CLOSE_LEN = "</span>".length;

/** `from` 부터 짝이 맞는 `</span>` 의 위치. 안에 든 span 섬(각주 속 색 글자 등)을 세고, 인라인 코드 안의 태그
 *  모양 글자는 건너뛴다(코드 마크 글자는 엔티티 인코딩·이스케이프 없이 그대로 쓰인다). 없으면 -1. */
function findSpanClose(src: string, from: number): number {
  let depth = 1;
  let i = from;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      let n = 1;
      while (src[i + n] === "`") n += 1;
      let j = i + n;
      let close = -1;
      while (j < src.length) {
        if (src[j] !== "`") {
          j += 1;
          continue;
        }
        let m = 1;
        while (src[j + m] === "`") m += 1;
        if (m === n) {
          close = j;
          break;
        }
        j += m;
      }
      i = close >= 0 ? close + n : i + n;
      continue;
    }
    if (ch === "<") {
      if (/^<span[\s>]/i.test(src.slice(i, i + 6))) {
        depth += 1;
        i += 5;
        continue;
      }
      const closeTag = /^<\/span\s*>/i.exec(src.slice(i, i + 16));
      if (closeTag) {
        depth -= 1;
        if (depth === 0) return i;
        i += closeTag[0].length;
        continue;
      }
    }
    i += 1;
  }
  return -1;
}

/** 안쪽 내용에 마크를 얹는다 — 글자뿐 아니라 줄바꿈(hardBreak) 같은 인라인 잎 노드에도(DOM 경로가 그랬다: 각주 속
 *  `<br>` 이 마크를 안 받으면 앵커가 두 조각이 되어 내보내기 표지가 둘 붙는다). 이미 같은 종류의 마크가 있는 노드는
 *  안쪽 것이 이긴다(겹친 색 span 의 DOM 경로가 안쪽 style 을 뒤에 이어 붙여 안쪽 색을 고르던 것과 같은 결과) — 같은
 *  종류의 마크가 두 개 붙은 노드는 만들지 않는다. */
function withMark(nodes: JSONContent[], mark: { type: string; attrs: Record<string, unknown> }): JSONContent[] {
  return nodes.map((n) => {
    if (n.content) return { ...n, content: withMark(n.content, mark) };
    const marks = n.marks ?? [];
    return marks.some((m) => m.type === mark.type) ? n : { ...n, marks: [...marks, mark] };
  });
}

/** 마크 확장에 펼쳐 넣는 세 필드(markdownTokenName · markdownTokenizer · parseMarkdown). `attr` 은 여는 태그의
 *  유일한 속성 이름, `toAttrs` 는 그 값(엔티티 해석 뒤) → 마크 attrs, 우리 모양이 아니면 null. */
function spanIslandMarkdown(opts: {
  tokenName: string;
  mark: string;
  attr: string;
  toAttrs: (value: string) => Record<string, unknown> | null;
}) {
  const open = new RegExp(`^<span\\s+${opts.attr}="([^"]*)"\\s*>`, "i");
  const start = new RegExp(`<span\\s+${opts.attr}="`, "i");
  const markdownTokenizer: MarkdownTokenizer = {
    name: opts.tokenName,
    level: "inline",
    start: (src: string) => src.search(start),
    tokenize(src, _tokens, lexer) {
      const m = open.exec(src);
      if (!m) return undefined;
      const attrs = opts.toAttrs(decodeHtmlEntities(m[1] ?? ""));
      if (!attrs) return undefined;
      const close = findSpanClose(src, m[0].length);
      if (close < 0) return undefined;
      return {
        type: opts.tokenName,
        raw: src.slice(0, close + SPAN_CLOSE_LEN),
        attrs,
        tokens: lexer.inlineTokens(src.slice(m[0].length, close)),
      };
    },
  };
  return {
    markdownTokenName: opts.tokenName,
    markdownTokenizer,
    parseMarkdown: (token: MarkdownToken, h: MarkdownParseHelpers) =>
      withMark(h.parseInline(token.tokens ?? []), {
        type: opts.mark,
        attrs: (token as { attrs?: Record<string, unknown> }).attrs ?? {},
      }),
  };
}

/** 각주·날짜 섬의 id — 빈 값이면 renderMarkdown 이 span 을 안 쓰므로 우리 모양이 아니다. */
const spanIdAttrs = (id: string) => (id ? { id } : null);

/** 색 글자 섬의 style — `color` 선언만 있을 때(BriseTextStyle.renderMarkdown 이 쓰는 모양)만 받는다. 값 추출은
 *  Color 확장의 parseHTML(getStyleProperty: 마지막 선언, 따옴표 제거)과 같게 해 DOM 경로와 같은 attrs 를 낸다. */
function colorSpanAttrs(style: string): Record<string, unknown> | null {
  const decls = style
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean);
  let color: string | null = null;
  for (const decl of decls) {
    const colon = decl.indexOf(":");
    if (colon < 0 || decl.slice(0, colon).trim().toLowerCase() !== "color") return null;
    color = decl.slice(colon + 1).trim().replace(/['"]+/g, "");
  }
  return color ? { color } : null;
}

/**
 * Footnote mark (Wave 4) — body_md wire format SSOT for L2/L4.
 *
 * On-disk body_md embeds the attachment id as an HTML span island that marked re-parses:
 *   `<span data-footnote="<attachment-id>">anchored text</span>`
 *
 * Example: text "hello" with footnote attachment id `abc-123` on the word "hello":
 *   `hello` → body_md contains `<span data-footnote="abc-123">hello</span>`
 *   (typically inside a paragraph: the surrounding block is normal markdown).
 *
 * Mark attrs:
 * - `id` (string): attachments.id of the kind='footnote' row. Attribute SSOT for WHERE the
 *   footnote is anchored; attachment.url is only a list-view hint (anchor_text at creation).
 *
 * Live editor mark file is owned by L2 (`footnoteMark.ts` if/when present). This extension is
 * the schema contract registered in createMarkdownSchemaExtensions so getMarkdown/setContent
 * round-trips without losing the id. L2 must use the same name/attrs/HTML form.
 */
export const BriseFootnote = Mark.create({
  name: "footnote",
  inclusive: false,
  addAttributes() {
    return {
      id: {
        default: null as string | null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-footnote"),
        renderHTML: (attributes: { id?: string | null }) => {
          if (!attributes.id) return {};
          return { "data-footnote": attributes.id };
        },
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-footnote]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes), 0];
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  renderMarkdown: (node: any, h: any) => {
    const content = h.renderChildren(node);
    const id = node.attrs?.id as string | null | undefined;
    if (id) {
      // Escape " and & in id so the HTML island stays well-formed (ids are UUIDs in practice).
      const safe = String(id).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      return `<span data-footnote="${safe}">${content}</span>`;
    }
    return content;
  },
  // 읽기: 섬 안쪽을 마크다운으로(spanIslandMarkdown 머리 주석). 라이브 FootnoteMark 는 .extend 로 물려받는다.
  ...spanIslandMarkdown({ tokenName: "footnoteSpan", mark: "footnote", attr: "data-footnote", toAttrs: spanIdAttrs }),
});

/**
 * Live-editor date mark (PLAN-2026-09-18-nl-dates.md §W3a) — `BriseFootnote`'s sibling.
 *
 * On-disk body_md embeds the note_dates row id as an HTML span island that marked re-parses:
 *   `<span data-date="<note_dates id>">anchored text</span>`
 *
 * Mark attrs:
 * - `id` (string): note_dates.id of the related-date row this text names. Unlike the footnote
 *   attachment (which the mark alone fully owns), a note_dates row can also be deleted without
 *   the mark being stripped — a dangling mark is expected (§W3a scope: "doesn't crash" only, no
 *   visual distinction yet — that needs a live `dates` cache the editor doesn't have, deferred).
 *
 * Live editor mark file is L2's `dateMark.ts` (sibling of `footnoteMark.ts`). This extension is
 * the schema contract registered in markdownSchemaExtensions so getMarkdown/setContent
 * round-trips without losing the id. L2 must use the same name/attrs/HTML form.
 */
export const BriseDateMark = Mark.create({
  name: "date",
  inclusive: false,
  addAttributes() {
    return {
      id: {
        default: null as string | null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-date"),
        renderHTML: (attributes: { id?: string | null }) => {
          if (!attributes.id) return {};
          return { "data-date": attributes.id };
        },
      },
    };
  },
  parseHTML() {
    return [{ tag: "span[data-date]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes), 0];
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  renderMarkdown: (node: any, h: any) => {
    const content = h.renderChildren(node);
    const id = node.attrs?.id as string | null | undefined;
    if (id) {
      // Escape " and & in id so the HTML island stays well-formed (ids are UUIDs in practice).
      const safe = String(id).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      return `<span data-date="${safe}">${content}</span>`;
    }
    return content;
  },
  // 읽기: BriseFootnote 와 같다. 라이브 DateMark 는 .extend 로 물려받는다.
  ...spanIslandMarkdown({ tokenName: "dateSpan", mark: "date", attr: "data-date", toAttrs: spanIdAttrs }),
});

/**
 * Builder shared by this file's headless schema and editorExtensions.ts's PREVIEW_EXTENSIONS
 * headless mdSerializeHtml path. Interactive-only plugins (Placeholder, SlashCommand,
 * Spellcheck, EmojiRender, Typography) are omitted — they don't change body_md bytes.
 *
 * TextStyle is extended so a color attr round-trips as a styled <span> (stock TextStyle has
 * no renderMarkdown; without this, color was silently stripped on save).
 *
 * Exported (not just used by createMarkdownSchemaExtensions below) so the live editor
 * (EditorPanel.tsx) can register this instead of stock TextStyle — registering plain TextStyle
 * there while this fixed variant lived only here was itself the bug: the live save path
 * (mdSerializeEditor called directly on the live editor) uses the live editor's own schema, not
 * this one, so ColorButton's setColor() silently vanished on the very next autosave/reload even
 * though the mark rendered fine in the DOM until then.
 */
export const BriseTextStyle = TextStyle.extend({
  renderMarkdown: (node, h) => {
    const content = h.renderChildren(node);
    const color = node.attrs?.color as string | null | undefined;
    if (color) {
      // HTML form — read back by the colorSpan tokenizer below (inside parsed as markdown, not DOM).
      return `<span style="color: ${color}">${content}</span>`;
    }
    return content;
  },
  // 읽기: 위 모양의 섬은 안쪽을 마크다운으로 읽는다 — 안 그러면 안쪽 이스케이프가 저장마다 분다(spanIslandMarkdown).
  ...spanIslandMarkdown({ tokenName: "colorSpan", mark: "textStyle", attr: "style", toAttrs: colorSpanAttrs }),
});

/**
 * Builder shared by this file's headless schema and editorExtensions.ts's PREVIEW_EXTENSIONS
 * (the live/preview editors' schema-affecting extensions) — Wave R1-b dedup: these two lists
 * used to be hand-synced copies of the same ~15 extensions and had already drifted (this file's
 * copy omitted Typography and a Table `renderWrapper` option the live editor has). The three
 * spots that genuinely differ are parameters, not extra copies: which footnote mark (live/preview
 * share one wire-compatible extension, FootnoteMark; this file's own headless paths use the
 * BriseFootnote above), whether Typography's smart-quote substitution runs (interactive-only,
 * doesn't change body_md bytes — so headless callers skip it, matching this list's prior
 * behavior), and whether Table wraps itself in a scrollable div (a live-DOM concern only).
 */
export function markdownSchemaExtensions(opts: {
  footnote: AnyExtension;
  /** §W3a — optional so existing callers of this function don't break. Defaults to the headless
   *  BriseDateMark (live editors pass their own wire-compatible DateMark, same idiom as footnote). */
  date?: AnyExtension;
  tableRenderWrapper?: boolean;
  typography?: boolean;
  codeBlock?: AnyExtension;
}): Extensions {
  return [
    StarterKit.configure({ codeBlock: false, link: false, heading: false, paragraph: false }),
    BriseParagraph,
    BriseHeading,
    ParagraphFormatCommands,
    Markdown,
    TaskList,
    TaskItem.configure({ nested: true }),
    // resizable: false — 헤드리스 파서(ghost/SectionPreview)엔 뷰가 없어 columnResizing
    // 플러그인이 요구하는 DOM 이 없다. 라이브 에디터만 EditorPanel.tsx 에서 resizable:true 로
    // 오버라이드(Table 확장 옵션 재구성, 새 Table 노드를 추가하지 않는다 — 확장 매니저는
    // 같은 name 의 확장을 dedup 하지 않아 중복 등록하면 플러그인이 두 벌 붙는다).
    BriseTable.configure({ resizable: false, renderWrapper: !!opts.tableRenderWrapper }),
    TableRow,
    BriseTableHeader,
    BriseTableCell,
    Highlight,
    BriseTextStyle,
    Color,
    ...(opts.typography ? [Typography] : []),
    opts.codeBlock ?? CodeBlockLowlight.configure({ lowlight }),
    Details,
    DetailsSummary,
    DetailsContent,
    // protocols: ["note"] — Link's default isAllowedUri drops note:// without this
    // (same contract as EditorPanel.tsx).
    Link.configure({ openOnClick: false, protocols: ["note"] }),
    // inline: true (owner QA 6, item 7) — matches the live editor's schema (EditorPanel.tsx) so
    // this SSOT (round-trip tests, mdSerializeHtml/excerpt path) parses/serializes several
    // images sharing one paragraph the same way live editing does. renderMarkdown/parseMarkdown
    // (imageExtension.ts) are unchanged by this — they emit/read the same `![alt](src){width=…}`
    // token regardless of inline vs. block.
    BriseImage.configure({ inline: true, allowBase64: false }),
    opts.footnote,
    opts.date ?? BriseDateMark,
  ];
}

/** Exported for tests + preset ghost that need the same markdown-capable schema. */
export function createMarkdownSchemaExtensions(): Extensions {
  return markdownSchemaExtensions({ footnote: BriseFootnote });
}

// paragraphFormat's HTML-island renderer needs this same schema, but importing this module there
// would create a cycle. Injecting the existing builder avoids a second extension list.
setParagraphFormatMarkdownExtensions(createMarkdownSchemaExtensions);
// 같은 이유 — 병합·배경·여러 블록 셀이 있는 표는 이 스키마로 `<table>` HTML 조각을 만든다(tableColwidth.ts).
setTableMarkdownExtensions(createMarkdownSchemaExtensions);

/** Options every load-from-body_md setContent call must use so markdown is parsed. */
export const MARKDOWN_SET_CONTENT_OPTIONS = {
  contentType: "markdown" as const,
  emitUpdate: false as const,
};

/** Primary save path — live editor with Markdown extension registered. */
export function mdSerializeEditor(editor: EditorType): string {
  // getMarkdown is installed by @tiptap/markdown on the editor instance.
  const md = typeof editor.getMarkdown === "function" ? editor.getMarkdown() : "";
  return md.trim();
}

/** A doc the live editor held earlier (e.g. right after a body_md load) → the bytes mdSerializeEditor would have
 *  returned at that moment. Same manager as getMarkdown (= serialize(getJSON())), so the schema is the live one. */
export function mdSerializeDoc(editor: EditorType, doc: EditorType["state"]["doc"]): string {
  return editor.markdown ? editor.markdown.serialize(doc.toJSON()).trim() : "";
}

/**
 * HTML string → body_md. Used when the caller has a fragment (excerpt) rather than a live
 * editor. Headless; destroy immediately so tests / one-shot callers don't leak.
 */
export function mdSerializeHtml(html: string): string {
  if (!html) return "";
  const ed = new Editor({
    extensions: createMarkdownSchemaExtensions(),
    content: html,
  });
  try {
    return mdSerializeEditor(ed);
  } finally {
    ed.destroy();
  }
}

/** Headless editor preloaded with body_md as markdown — for tests / ghost preview. */
export function createMarkdownEditor(content = "", asMarkdown = true): Editor {
  return new Editor({
    extensions: createMarkdownSchemaExtensions(),
    content,
    ...(asMarkdown && content ? { contentType: "markdown" as const } : {}),
  });
}
