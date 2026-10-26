import { Table, TableCell, TableHeader, renderTableToMarkdown } from "@tiptap/extension-table";
import { generateHTML, type Extensions, type JSONContent } from "@tiptap/core";
import { reportFallback } from "../../lib/diag";
import { isFormatted } from "./paragraphFormat";

/**
 * 표 열 너비 왕복 (오너 요구 2026-09-21 "표에서 라인을 드래그해서 표 너비 개별 조정").
 *
 * extension-table 의 GFM 표 markdown(renderTableToMarkdown)은 colwidth 를 왕복시키지
 * 않는다 — BriseImage 의 `![alt](src){width=…}` 접미사 선례를 표에도 적용한다: 표 바로
 * 다음 줄에 `{colwidth=120,,200}` 한 줄(빈 칸=자동)을 **표의 마지막 행**으로 남긴다. 모든
 * 열이 자동이면 이 줄 자체를 안 쓴다 — colwidth 없는 기존 표는 출력이 예전과 바이트 단위로
 * 같다(회귀 방지, tableColwidth.test.ts 의 "colwidth 없는 표" 케이스).
 *
 * 파싱 함정(실측, 2026-09-21): 이 줄을 표와 별개인 block 토큰으로 잡으려 했으나
 * (markdownTokenizer 로 표 뒤에서 흡수) marked 의 GFM 표 규칙 자체가 빈 줄 없이 이어지는
 * 비-파이프 줄까지 **표의 body row 로 그냥 삼켜버린다** — extension-table 이 등록한
 * markdownTokenizer(Table.config.markdownTokenizer)는 셀 안에 백틱+파이프가 있을 때만
 * 도는 별도 경로라 평범한 표에는 전혀 관여하지 않는다(preprocessTablePipes 가 실제로
 * 바꾼 게 없으면 undefined 반환). 그래서 되돌리는 지점도 같다: parseMarkdown 에서
 * baseParseMarkdown 이 만든 표 노드의 **마지막 행**이 "첫 칸=`{colwidth=...}`, 나머지
 * 칸 전부 빈칸" 모양이면 그 행을 colwidths 로 해석해 떼어낸다.
 *
 * 첫 행 셀에만 colwidth 를 둔다 — extension-table 의 TableView.updateColumns/createColGroup
 * 이 `node.firstChild`(첫 행)의 셀 colwidth 만 읽어 colgroup 을 만들기 때문에 그 이상은
 * 불필요하다.
 *
 * ── HTML 조각 표 (PLAN-2026-10-07-doc-import-export §3 W0, 조사 §2.4) ──
 * GFM 표에는 병합(colspan/rowspan)·셀 배경·셀 안 여러 블록을 쓸 칸이 없다. renderTableToMarkdown
 * 은 그걸 **조용히 평탄화**한다(실측: 병합 표의 값이 다른 열로 밀림, 셀 안 목록은 `- a- b<br>p2`
 * 로 뭉개짐, 셀 안 정렬은 재로드 때 사라짐) — 그래서 그런 표만 `<table>` HTML 조각으로 저장한다
 * (paragraphFormat 의 renderHtmlIsland 와 같은 방식: generateHTML + 주입된 공용 스키마). 그 밖의
 * 표는 위 GFM 경로 그대로라 출력이 바이트 단위로 같다. 읽기는 손볼 것이 없다 — marked 가 `<table>`
 * HTML 블록을 토큰으로 주고 @tiptap/markdown 이 parseHTML 규칙으로 표 노드를 만든다.
 * 조각 안에서는 colwidth 가 셀의 `colwidth` 속성으로 실려 가므로 `{colwidth=…}` 마커 줄은 쓰지 않는다
 * (HTML 블록 뒤에 붙이면 블록의 일부로 삼켜진다).
 */

let markdownExtensions: (() => Extensions) | undefined;

/** mdSerialize 가 한 번 주입한다 — 공용 스키마 빌더가 이 파일을 import 하므로 거꾸로 import
 *  하면 순환이다(paragraphFormat.setParagraphFormatMarkdownExtensions 와 같은 이유·같은 형태). */
export function setTableMarkdownExtensions(factory: () => Extensions): void {
  markdownExtensions = factory;
}

/** CSS 색 한 개로만 통과시킨다(#hex · 색 이름 · rgb()/hsl()). 셀 배경은 style 속성 문자열로
 *  다시 쓰이므로 `;`·`url(` 같은 선언이 끼어들 틈을 두지 않는다. 투명·상속 키워드는 "배경 없음". */
const SAFE_CSS_COLOR = /^(?:#[0-9a-f]{3,8}|[a-z]+|(?:rgb|hsl)a?\([\d.,%\s/-]+\))$/i;
const NO_BACKGROUND = new Set(["transparent", "inherit", "initial", "unset", "none"]);

function safeCellColor(value: unknown): string | null {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v || !SAFE_CSS_COLOR.test(v) || NO_BACKGROUND.has(v.toLowerCase())) return null;
  return v;
}

/** 셀 배경 — 값은 파서가 정규화한 `style.backgroundColor`(예 `rgb(255, 255, 0)`)라 왕복해도 같은
 *  문자열이다. `bgcolor` 속성은 Word/한글에서 붙여넣은 HTML 의 흔한 형태인데, 날것(`#FFFF00`)으로
 *  저장하면 재로드 때 style 쪽 정규화(rgb)와 달라 두 번째 저장부터 바이트가 바뀐다 — 같은 파서를
 *  거쳐 첫 저장부터 정규형으로 맞춘다. */
function parseCellBackground(element: HTMLElement): string | null {
  const styled = safeCellColor(element.style.backgroundColor);
  if (styled) return styled;
  const legacy = element.getAttribute("bgcolor");
  if (!legacy) return null;
  const probe = element.ownerDocument.createElement("span");
  probe.style.backgroundColor = legacy;
  return safeCellColor(probe.style.backgroundColor);
}

const cellBackgroundAttribute = {
  default: null as string | null,
  parseHTML: parseCellBackground,
  renderHTML: (attributes: { backgroundColor?: string | null }) => {
    const color = safeCellColor(attributes.backgroundColor);
    return color ? { style: `background-color: ${color}` } : {};
  },
};

// 병합 스키마에 등록하는 쪽은 mdSerialize.ts(markdownSchemaExtensions) 하나다 — 라이브 에디터는
// 그 목록을 PREVIEW_EXTENSIONS 로 그대로 받으므로 셀 속성이 두 벌로 갈라지지 않는다.
export const BriseTableCell = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), backgroundColor: cellBackgroundAttribute };
  },
});

export const BriseTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), backgroundColor: cellBackgroundAttribute };
  },
});

/** GFM 한 칸으로는 못 담는 셀인가: 병합 · 배경 · 블록 2개 이상 · 문단이 아닌 블록 · 서식 있는 문단.
 *  서식 있는 문단을 넣는 이유: GFM 칸에선 `<p style>` 가 인라인 HTML 로 들어갔다가 재로드 때 서식이 벗겨진다(실측). */
function cellNeedsHtml(cell: JSONContent): boolean {
  const attrs = cell.attrs ?? {};
  if (Number(attrs.colspan) > 1 || Number(attrs.rowspan) > 1) return true;
  if (safeCellColor(attrs.backgroundColor)) return true;
  const blocks = cell.content ?? [];
  if (blocks.length > 1) return true;
  return blocks.some((b) => b.type !== "paragraph" || isFormatted(b));
}

/** GFM 이 담는 머리글 배치는 "첫 행 전체가 th" 하나뿐이다 — 첫 열이 라벨 th 인 양식(성명 | 빈칸)이나 첫 행에 th·td 가
 *  섞인 표는 GFM 으로 내면 재로드 때 th 가 td 로 접히거나 첫 행 전체가 머리글이 된다(W2 검증 2026-10-07).
 *  ponytail: 첫 행에 th 가 하나도 없는 표(Word 붙여넣기에 흔함)는 여기서 다루지 않는다 — GFM 이 빈 머리글 행을 끼워
 *  넣는 기존 동작 그대로다. 조각으로 바꾸면 그런 표가 전부 폰에서 읽기 전용이 되므로 따로 정할 일이다. */
function headerLayoutNeedsHtml(node: JSONContent): boolean {
  return !!node.content?.some((row, i) => {
    const cells = row.content ?? [];
    const headers = cells.filter((c) => c.type === "tableHeader").length;
    return i > 0 ? headers > 0 : headers > 0 && headers < cells.length;
  });
}

function tableNeedsHtml(node: JSONContent): boolean {
  return headerLayoutNeedsHtml(node) || !!node.content?.some((row) => row.content?.some(cellNeedsHtml));
}

/** 이미지의 `src` 를 저장용(이식 가능) 값으로 — imageExtension.renderMarkdown 이 GFM 칸에서 `relPath || src`
 *  를 목적지로 쓰는 것과 같은 규칙이다. generateHTML 은 `src` 를 그대로 쓰는데, 라이브에서 막 넣은 첨부
 *  이미지는 `src` 가 null 이고 relPath 만 있어(ImageNodeView 가 렌더 때 해석) `<img>` 에 src 가 안 실린다 —
 *  그러면 재로드 때 `img[src]` 규칙이 못 잡아 이미지가 사라진다. 원본 JSON 은 건드리지 않고 복사해서 바꾼다. */
function withPortableImageSrc(node: JSONContent): JSONContent {
  const content = node.content?.map(withPortableImageSrc);
  if (node.type !== "image") return content ? { ...node, content } : node;
  const src = (node.attrs?.relPath as string | null | undefined) || (node.attrs?.src as string | null | undefined) || null;
  return { ...node, attrs: { ...node.attrs, src } };
}

/** 표 하나를 HTML 조각으로. 실패하면 null — 호출부가 GFM 으로 물러난다(저장이 통째로 죽는 것보다
 *  약한 형태로라도 남기는 편이 낫다, 폴백은 기록한다 — CLAUDE.md 함정 11). */
function renderTableHtml(node: JSONContent): string | null {
  if (!markdownExtensions) return null;
  try {
    const html = generateHTML({ type: "doc", content: [withPortableImageSrc(node)] }, markdownExtensions());
    // 조각은 **항상 한 줄**로 낸다 — 개행을 문자 참조(&#10;)로 바꾸면 파서가 되돌린다. 줄에 걸린 것이 둘이다:
    //  ① marked 의 HTML 블록은 **빈 줄에서 끝난다** — 코드 블록 셀 안의 빈 줄 하나가 표를 둘로 쪼갠다.
    //  ② 목록 항목 안에서는 직렬화기가 **모든 줄 앞에 들여쓰기**를 붙인다 — 여러 줄이면 `<pre>` 안 코드 줄이
    //     그 공백을 달고 나가(탭은 공백으로 풀려 코드가 바뀐다), 코드 줄이 `---`·`===` 이면 앞 문단 줄과 묶여
    //     setext 제목이 되어 표가 글자로 부서진다.
    //  ③ marked 는 목록 항목의 이어진 줄에서 **탭을 전부 공백 4칸으로** 푼다 — 줄 한가운데 탭도 같다. 코드 셀의
    //     탭도 문자 참조(&#9;)로 내야 재로드 뒤에도 탭이다. `<p>` 안 탭은 어차피 공백 하나로 접히니 바뀌는 게 없다.
    return html.replace(/\n/g, "&#10;").replace(/\t/g, "&#9;");
  } catch (e) {
    reportFallback("md-serialize", "table_html_failed", e instanceof Error ? e.name : "error");
    return null;
  }
}

/** node.content 는 여기서 항상 JSONContent[] (renderMarkdown 시점 — 실제 PM Fragment 가
 *  아니라 @tiptap/markdown 이 만든 JSON 트리, extension-table 의 renderTableToMarkdown 도
 *  같은 가정으로 `.forEach`를 쓴다). 첫 행 셀 중 하나라도 colwidth 가 있으면 배열을,
 *  전부 자동이면 null 을 돌려준다. */
function firstRowColwidths(node: JSONContent): (number | null)[] | null {
  const firstRow = node.content?.[0];
  if (!firstRow?.content) return null;
  const widths = firstRow.content.map((cell) => {
    const cw = cell.attrs?.colwidth as unknown;
    return Array.isArray(cw) && typeof cw[0] === "number" ? (cw[0] as number) : null;
  });
  return widths.some((w) => w !== null) ? widths : null;
}

/** 셀 하나의 순수 텍스트(문단 하나짜리, 서식 없는 일반 텍스트만 대상 — ponytail: 굵게 등이
 *  섞이면 매칭 안 됨, {colwidth=...} 마커 줄은 애초에 그런 서식을 쓰지 않는다). */
function plainCellText(cell: JSONContent | undefined): string {
  const para = cell?.content?.[0];
  return para?.content?.map((n) => n.text ?? "").join("") ?? "";
}

const COLWIDTH_ROW = /^\{colwidth=([^}]*)\}$/;

/** 마지막 행이 "첫 칸=`{colwidth=...}`, 나머지 칸은 전부 빈칸"이면 마커 행으로 보고
 *  tableNode.content 에서 떼어낸 뒤 colwidths 배열을 돌려준다. 아니면 null(그대로 둔다). */
function extractColwidthMarkerRow(tableNode: JSONContent): (number | null)[] | null {
  const rows = tableNode.content;
  if (!rows || rows.length < 2) return null; // 헤더 + 실제 데이터 최소 1행
  const lastRow = rows[rows.length - 1];
  const cells = lastRow?.content;
  if (!cells?.length) return null;
  const m = COLWIDTH_ROW.exec(plainCellText(cells[0]).trim());
  if (!m) return null;
  if (!cells.slice(1).every((c) => plainCellText(c).trim() === "")) return null;
  rows.pop();
  return m[1].split(",").map((s) => {
    const t = s.trim();
    return t ? Number(t) : null;
  });
}

// 표 자체의 파싱/직렬화(정렬·헤더·이스케이프 등)는 원본 그대로 재사용 — renderMarkdown/
// parseMarkdown 두 필드만 얹는다.
const baseParseMarkdown = Table.config.parseMarkdown as NonNullable<typeof Table.config.parseMarkdown>;

export const BriseTable = Table.extend({
  renderMarkdown: (node, h, ctx) => {
    if (tableNeedsHtml(node)) {
      const html = renderTableHtml(node);
      // 목록 항목 안에서는 GFM 경로(renderTableToMarkdown)가 앞뒤에 두는 개행을 똑같이 둔다 — 조각이 앞 문단
      // 줄에 바로 붙으면 marked 가 그 문단의 이어진 줄로 읽어(순서 목록에선 표가 문단 안으로 들어간 스키마 위반
      // 문서가 된다) 뒤 형제 줄까지 HTML 블록에 삼켜, 저장 바이트가 두 모양을 영원히 오간다. 최상위·인용·details
      // 에는 붙이지 않는다 — 거기선 이미 바이트가 고정점이고, 붙이면 조각 둘이 이어질 때 빈 문단이 불어난다.
      if (html) return ctx?.parentType === "listItem" ? `\n${html}\n` : html;
    }
    let base = renderTableToMarkdown(node, h);
    // renderTableToMarkdown 은 **항상 "\n" 으로 시작하고 "\n" 으로 끝난다**. 블록 사이 구분(\n\n)과 합치면 GFM 표 둘이
    // 맞붙을 때 빈 줄 3개(= `\n\n\n\n`)가 되는데, 마크다운 로더는 문단 구분 둘 이상의 틈을 **빈 문단 하나**로 읽는다 —
    // 재열기마다 표 사이에 빈 문단이 생기고 저장할 때마다 빈 줄이 2개씩 불어난다(실측: 같은 입력의 순수 TipTap 표 둘도
    // 똑같다). 표→문단·문단→표·표→HTML 조각 표는 빈 줄 2개라 이미 고정점이므로, 앞 형제가 GFM 으로 나간 표일 때만
    // 선두 "\n" 하나를 뗀다. 앞 형제가 조각 표면 그대로 둔다(조각은 개행으로 끝나지 않아 이미 고정점이다).
    if (ctx?.previousNode?.type === "table" && !tableNeedsHtml(ctx.previousNode) && base.startsWith("\n")) {
      base = base.slice(1);
    }
    const widths = firstRowColwidths(node);
    if (!widths) return base;
    const line = `{colwidth=${widths.map((w) => (w == null ? "" : String(w))).join(",")}}`;
    return `${base}${line}\n`;
  },

  parseMarkdown: (token, h) => {
    const tableNode = baseParseMarkdown(token, h) as JSONContent;
    const widths = extractColwidthMarkerRow(tableNode);
    const firstRow = tableNode.content?.[0];
    if (widths && firstRow?.content) {
      widths.forEach((w, i) => {
        if (w == null) return;
        const cell = firstRow.content?.[i];
        if (!cell) return;
        cell.attrs = { ...(cell.attrs ?? {}), colwidth: [w] };
      });
    }
    return tableNode;
  },
});
