import { Extension, generateHTML, mergeAttributes, type Command, type Extensions, type JSONContent } from "@tiptap/core";
import Heading from "@tiptap/extension-heading";
import Paragraph from "@tiptap/extension-paragraph";

/**
 * 양쪽 정렬(justify)은 2026-10-07 W0-B 에서 추가 — 한글 문서(HWP·Word)의 기본 정렬이라, 붙여넣기·가져오기의
 * `text-align: justify` 가 저장 뒤 왼쪽으로 떨어지던 것을 막는다(실측). 저장 형태는 center/right 와 같은
 * `data-brise-align` + `style` HTML 섬이다.
 */
export const TEXT_ALIGNS = ["left", "center", "right", "justify"] as const;
export type TextAlign = (typeof TEXT_ALIGNS)[number];

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    paragraphFormat: {
      setTextAlign: (alignment: TextAlign) => ReturnType;
      indentParagraph: () => ReturnType;
      outdentParagraph: () => ReturnType;
    };
  }
}

const MAX_INDENT = 6;
const EMPTY_PARAGRAPH_MARKDOWN = "&nbsp;";

function clampIndent(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? 0), 10);
  return Number.isFinite(parsed) ? Math.min(MAX_INDENT, Math.max(0, parsed)) : 0;
}

/** 목록 항목·인용 안의 블록인가. 정렬 메뉴·커맨드는 최상위 블록에만 걸리고(updateTopLevelBlocks) 메뉴도 거기선
 *  disabled 다 — 그런데 붙여넣기 HTML 은 그 규칙을 모르고 `<li><p style="text-align: justify">` 를 그대로 읽는다.
 *  한글·Word·웹 문서의 목록은 거의 다 justify 라 그 문단이 HTML 섬(`- <p data-brise-align=…>`)으로 저장되고,
 *  마크다운 목록 항목 안의 HTML 섬은 순서 목록에서 첫 재로드에 정렬이 사라지고(바이트 변동) 하위 목록이 있으면
 *  `-` 글자 문단이 끼며 구조가 깨진다(실측). 정렬 UI 가 막는 곳에는 파서도 정렬·들여쓰기를 들이지 않는다.
 *  표 셀(td/th)은 해당 없다 — 셀 안 문단 정렬은 조각 표가 보존한다(tableColwidth.ts). 그래서 **가장 가까운** 컨테이너
 *  로 판정한다: 목록 항목·인용 안에 든 표의 셀 문단은 바깥 `li` 가 아니라 `td` 를 먼저 만나 정렬을 읽는다(반대로 셀 안
 *  목록의 문단은 `li` 를 먼저 만나 읽지 않는다). */
function insideListOrQuote(element: HTMLElement): boolean {
  const host = element.closest("li, blockquote, td, th");
  return !!host && (host.tagName === "LI" || host.tagName === "BLOCKQUOTE");
}

function parseTextAlign(element: HTMLElement): TextAlign {
  if (insideListOrQuote(element)) return "left";
  return parseTextAlignValue(element.dataset.briseAlign ?? element.style.textAlign);
}

function formatAttributes(node: JSONContent): Record<string, string> {
  const textAlign = parseTextAlignValue(node.attrs?.textAlign);
  const indent = clampIndent(node.attrs?.indent);
  if (textAlign === "left" && indent === 0) return {};

  const styles = [
    textAlign !== "left" ? `text-align: ${textAlign}` : "",
    indent > 0 ? `margin-left: ${indent * 2}em` : "",
  ].filter(Boolean);
  return {
    ...(textAlign !== "left" ? { "data-brise-align": textAlign } : {}),
    ...(indent > 0 ? { "data-brise-indent": String(indent) } : {}),
    style: `${styles.join("; ")};`,
  };
}

function parseTextAlignValue(value: unknown): TextAlign {
  return (TEXT_ALIGNS as readonly unknown[]).includes(value) ? (value as TextAlign) : "left";
}

/** 정렬(왼쪽 아님)·들여쓰기가 있는 블록인가 — 이 파일의 HTML 섬 판정과 tableColwidth.ts 의 조각 표 판정이 함께 쓴다. */
export function isFormatted(node: JSONContent): boolean {
  return parseTextAlignValue(node.attrs?.textAlign) !== "left" || clampIndent(node.attrs?.indent) > 0;
}

let markdownExtensions: (() => Extensions) | undefined;

/** Set once by mdSerialize, which owns the shared schema and already imports these nodes. */
export function setParagraphFormatMarkdownExtensions(factory: () => Extensions): void {
  markdownExtensions = factory;
}

function renderHtmlIsland(node: JSONContent): string {
  return markdownExtensions ? generateHTML({ type: "doc", content: [node] }, markdownExtensions()) : "";
}

const formatNodeAttributes = {
  textAlign: {
    default: "left" as TextAlign,
    rendered: false,
    parseHTML: parseTextAlign,
  },
  indent: {
    default: 0,
    rendered: false,
    parseHTML: (element: HTMLElement) => (insideListOrQuote(element) ? 0 : clampIndent(element.dataset.briseIndent)),
  },
};

export const BriseParagraph = Paragraph.extend({
  addAttributes() {
    return { ...this.parent?.(), ...formatNodeAttributes };
  },
  renderHTML({ node, HTMLAttributes }) {
    return ["p", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, formatAttributes(node.toJSON())), 0];
  },
  renderMarkdown: (node, h, ctx) => {
    if (isFormatted(node)) return renderHtmlIsland(node);
    const content = Array.isArray(node.content) ? node.content : [];
    if (content.length === 0) {
      const previousContent = Array.isArray(ctx?.previousNode?.content) ? ctx.previousNode.content : [];
      return ctx?.previousNode?.type === "paragraph" && previousContent.length === 0
        ? EMPTY_PARAGRAPH_MARKDOWN
        : "";
    }
    return h.renderChildren(content);
  },
});

export const BriseHeading = Heading.extend({
  addAttributes() {
    return { ...this.parent?.(), ...formatNodeAttributes };
  },
  renderHTML({ node, HTMLAttributes }) {
    const level = this.options.levels.includes(node.attrs.level) ? node.attrs.level : this.options.levels[0];
    return [
      `h${level}`,
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, formatAttributes(node.toJSON())),
      0,
    ];
  },
  renderMarkdown: (node, h) => {
    if (isFormatted(node)) return renderHtmlIsland(node);
    const level = clampIndent(node.attrs?.level) || 1;
    return node.content ? `${"#".repeat(level)} ${h.renderChildren(node.content)}` : "";
  },
});

function updateTopLevelBlocks(update: (attrs: Record<string, unknown>) => Record<string, unknown>): Command {
  return ({ tr, dispatch }) => {
    const positions = new Set<number>();
    for (const range of tr.selection.ranges) {
      tr.doc.nodesBetween(range.$from.pos, range.$to.pos, (node, pos, parent) => {
        if (parent?.type.name === "doc" && (node.type.name === "paragraph" || node.type.name === "heading")) {
          positions.add(pos);
        }
        return parent?.type.name === "doc";
      });
    }
    if (positions.size === 0) return false;

    let changed = false;
    for (const pos of positions) {
      const node = tr.doc.nodeAt(pos);
      if (!node) continue;
      const attrs = update(node.attrs);
      if (Object.keys(attrs).some((key) => attrs[key] !== node.attrs[key])) {
        changed = true;
        if (dispatch) tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs });
      }
    }
    return changed;
  };
}

export const ParagraphFormatCommands = Extension.create({
  name: "paragraphFormatCommands",
  addCommands() {
    return {
      setTextAlign:
        (alignment: TextAlign) =>
        (props) => {
          if (!(TEXT_ALIGNS as readonly string[]).includes(alignment)) return false;
          return updateTopLevelBlocks(() => ({ textAlign: alignment }))(props);
        },
      indentParagraph:
        () =>
        (props) => updateTopLevelBlocks((attrs) => ({ indent: Math.min(MAX_INDENT, clampIndent(attrs.indent) + 1) }))(props),
      outdentParagraph:
        () =>
        (props) => updateTopLevelBlocks((attrs) => ({ indent: Math.max(0, clampIndent(attrs.indent) - 1) }))(props),
    };
  },
});
