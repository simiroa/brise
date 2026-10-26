/**
 * 내보내기 모달의 "HTML" · "서식 복사" 문서 조립 — 순수 함수. (PLAN-2026-10-07-doc-import-export §3.1 W6)
 *
 * 입력은 종이 미리보기와 같은 본문(exportDoc.renderPaperBody)이다 — 같은 헤드리스 TipTap 렌더라 미리보기에 보이는 것이
 * 파일·클립보드로도 나간다. 저장·복사용으로 부를 때는 `links: "keep"`(http/https/mailto 만 살림) ·
 * `images: "embed"`(첨부 그림은 `<img data-rel-path="…" src="">` — Rust export_html / export_html_inline 이 첨부 루트
 * 안에서 읽어 data: URI 로 채운다)로 부른다. 이 파일은 data-rel-path 를 지우지 않는다(Rust 가 지운다).
 *
 * - buildHtmlDocument: 아무 기기에서나 열리는 단일 HTML 파일 한 벌(스크립트 없음). 화면은 읽기 폭, 인쇄는 W5 의 A4 CSS.
 * - buildClipboardHtml: 메일·그룹웨어·노션 편집기에 붙일 조각. 그쪽 편집기는 `<style>` 을 버리므로 **인라인 style** 이다.
 * - plainTextOf: 같은 본문의 평문(클립보드 text/plain) — 마크다운 기호 없이 읽히게.
 *
 * 색·CSS 리터럴은 exportPaper.ts 에 있다(그 파일만 check:colors 면제). 여기엔 색을 쓰지 않는다.
 * DOM 은 `<template>` 의 inert 한 조각 위에서 만진다 — 그림이 이 단계에서 로드되지 않는다.
 */
import { CLIP_STYLES, HTML_DOC_CSS, escapeHtml, printCss } from "./exportPaper";

function parseFragment(html: string): DocumentFragment {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  return tpl.content;
}

function serialize(frag: DocumentFragment): string {
  const holder = document.createElement("div");
  holder.appendChild(frag);
  return holder.innerHTML;
}

/** 넓은 표가 읽기 폭을 밀어내지 않게 — 맨 바깥 표마다 가로 스크롤 상자(.table-wrap)로 감싼다. */
function wrapTables(frag: DocumentFragment): void {
  frag.querySelectorAll("table").forEach((table) => {
    if (table.parentElement?.closest("table")) return; // 칸 안의 표는 바깥 표의 상자가 이미 감싼다
    const wrap = document.createElement("div");
    wrap.className = "table-wrap";
    table.replaceWith(wrap);
    wrap.appendChild(table);
  });
}

/**
 * 읽히는 단일 HTML 파일. `body` 는 renderPaperBody 결과(저장용이면 keep·embed). 스크립트는 넣지 않는다.
 *
 * 접기(details)는 **진짜 접기**로 — 종이 렌더가 다 펼쳐 둔 `open` 을 걷어, 앱에서처럼 접힌 채 열린다(누르면 펼쳐진다,
 * 스크립트 없이 브라우저가 한다). 인쇄할 때는 HTML_DOC_CSS 의 print 규칙이 내용까지 내보낸다.
 */
export function buildHtmlDocument(body: string, opts: { title: string; lang?: string }): string {
  const frag = parseFragment(body);
  wrapTables(frag);
  frag.querySelectorAll("details[open]").forEach((d) => d.removeAttribute("open"));
  return (
    // lang 은 부르는 쪽이 준다(앱 화면 언어) — 주지 않으면 붙이지 않는다(내용 언어를 단정하지 않는다).
    `<!doctype html>\n<html${opts.lang ? ` lang="${escapeHtml(opts.lang)}"` : ""}>\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<title>${escapeHtml(opts.title)}</title>\n` +
    `<style>${HTML_DOC_CSS}${printCss("a4-portrait")}</style>\n</head>\n` +
    `<body>\n${serialize(frag)}\n</body>\n</html>\n`
  );
}

// ── 서식 복사 ───────────────────────────────────────────────────────────────────────────

/**
 * 원래 붙어 있던 인라인 style 에서 앱 토큰(`var(--…)`)을 쓰는 선언을 뺀다 — 앱 밖에서는 정의되지 않아 무효가 되고,
 * 무효 선언은 같은 속성의 우리 값까지 지운다(그림의 `max-width: min(100%, var(--editor-img-max))` 가 그렇다).
 */
function ownDeclarations(style: string | null): string {
  if (!style) return "";
  return style
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d && !d.includes("var("))
    .join("; ");
}

/** 우리 style 을 앞에, 원래 style 을 뒤에 — 셀 배경·형광 색처럼 원래 값이 있으면 그쪽이 이긴다. */
function styleUnder(el: Element, base: string): void {
  const own = ownDeclarations(el.getAttribute("style"));
  el.setAttribute("style", own ? `${base}; ${own}` : base);
}

/** 우리 style 을 뒤에 — 원래 값보다 우리 값이 이겨야 하는 곳(그림 폭). */
function styleOver(el: Element, over: string): void {
  const own = ownDeclarations(el.getAttribute("style"));
  el.setAttribute("style", own ? `${own}; ${over}` : over);
}

/** 할 일 항목: CSS ::before 는 붙여넣으면 사라진다 — 체크박스 input 을 빼고 글자 "☐ "/"☑ " 를 내용 앞에 넣는다. */
function flattenTaskItem(li: Element): void {
  const mark = li.getAttribute("data-checked") === "true" ? "☑ " : "☐ ";
  li.querySelectorAll(":scope > label").forEach((label) => label.remove());
  const body = li.querySelector(":scope > div") ?? li;
  const first = body.querySelector(":scope > p") ?? body;
  first.insertBefore(document.createTextNode(mark), first.firstChild);
  styleUnder(li, CLIP_STYLES.taskList);
}

/** 접기: 붙여넣는 곳에는 접기가 없다 — 펼친 내용으로, 요약(summary)은 굵은 문단으로. */
function flattenDetails(details: Element): void {
  const out = document.createDocumentFragment();
  for (const child of [...details.children]) {
    if (child.tagName === "SUMMARY") {
      const p = document.createElement("p");
      const strong = document.createElement("strong");
      while (child.firstChild) strong.appendChild(child.firstChild);
      p.appendChild(strong);
      out.appendChild(p);
    } else if (child.getAttribute("data-type") === "detailsContent") {
      while (child.firstChild) out.appendChild(child.firstChild);
    } else {
      out.appendChild(child);
    }
  }
  details.replaceWith(out);
}

/**
 * 클립보드 text/html 조각. 요소마다 인라인 style 을 단다(표 테두리·머리글 배경·그림 폭·인용 선·코드 음영·제목 크기·형광).
 * 할 일은 ☐/☑ 글자, 접기는 펼친 내용. 첨부 그림의 data-rel-path 는 그대로 둔다 — export_html_inline 이 채운다.
 */
export function buildClipboardHtml(body: string): string {
  const frag = parseFragment(body);
  // 안쪽 접기부터 풀어야 바깥 접기를 풀 때 남지 않는다 — 문서 순서의 역순.
  [...frag.querySelectorAll("details")].reverse().forEach(flattenDetails);
  frag.querySelectorAll('li[data-type="taskItem"]').forEach(flattenTaskItem);
  frag.querySelectorAll('ul[data-type="taskList"]').forEach((ul) => styleUnder(ul, CLIP_STYLES.taskList));
  frag.querySelectorAll("table").forEach((el) => styleUnder(el, CLIP_STYLES.table));
  frag.querySelectorAll("th").forEach((el) => styleUnder(el, CLIP_STYLES.th));
  frag.querySelectorAll("td").forEach((el) => styleUnder(el, CLIP_STYLES.td));
  frag.querySelectorAll("td > p, th > p").forEach((el) => styleUnder(el, CLIP_STYLES.cellParagraph));
  frag.querySelectorAll("img").forEach((el) => styleOver(el, CLIP_STYLES.img));
  frag.querySelectorAll("blockquote").forEach((el) => styleUnder(el, CLIP_STYLES.blockquote));
  frag.querySelectorAll("pre").forEach((el) => styleUnder(el, CLIP_STYLES.pre));
  frag.querySelectorAll("code").forEach((el) => {
    if (!el.closest("pre")) styleUnder(el, CLIP_STYLES.code);
  });
  frag.querySelectorAll("h1").forEach((el) => styleUnder(el, CLIP_STYLES.h1));
  frag.querySelectorAll("h2").forEach((el) => styleUnder(el, CLIP_STYLES.h2));
  frag.querySelectorAll("h3").forEach((el) => styleUnder(el, CLIP_STYLES.h3));
  frag.querySelectorAll("mark").forEach((el) => styleUnder(el, CLIP_STYLES.mark));
  frag.querySelectorAll("hr").forEach((el) => styleUnder(el, CLIP_STYLES.hr));
  frag.querySelectorAll(".img-ph").forEach((el) => styleUnder(el, CLIP_STYLES.placeholder));
  return serialize(frag);
}

// ── 평문 ───────────────────────────────────────────────────────────────────────────────

const BLOCK_TAGS = new Set([
  "P", "H1", "H2", "H3", "H4", "H5", "H6", "DIV", "BLOCKQUOTE", "DETAILS", "SUMMARY", "SECTION", "FIGURE", "LI",
]);

/** 줄 안 글자 — 줄바꿈(<br>)만 "\n" 으로, 그림·체크박스는 뺀다. */
function inlineText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const el = node as Element;
  if (el.tagName === "BR") return "\n";
  if (el.tagName === "IMG" || el.tagName === "INPUT") return "";
  let s = "";
  for (const child of el.childNodes) s += inlineText(child);
  return s;
}

function listLines(list: Element, depth: number): string[] {
  const out: string[] = [];
  const indent = "  ".repeat(depth);
  const nested = "  ".repeat(depth + 1);
  let n = Number(list.getAttribute("start")) || 1;
  const taskList = list.getAttribute("data-type") === "taskList";
  for (const li of list.children) {
    if (li.tagName !== "LI") continue;
    const task = taskList || li.getAttribute("data-type") === "taskItem";
    const marker = task
      ? li.getAttribute("data-checked") === "true" ? "☑ " : "☐ "
      : list.tagName === "OL" ? `${n++}. ` : "- ";
    const inner = blockLines(li, depth + 1);
    if (inner.length === 0) {
      out.push(indent + marker.trimEnd());
      continue;
    }
    out.push(indent + marker + inner[0]);
    // 안쪽 목록 줄은 이미 들여 써져 있다 — 그 밖의 이어지는 문단만 항목 내용 자리로 들인다.
    for (const line of inner.slice(1)) out.push(line.startsWith(nested) ? line : nested + line);
  }
  return out;
}

function cellText(cell: Element): string {
  return blockLines(cell, 0).join(" ").replace(/\t/g, " ").trim();
}

function tableLines(table: Element): string[] {
  const out: string[] = [];
  table.querySelectorAll("tr").forEach((tr) => {
    if (tr.closest("table") !== table) return; // 칸 안의 표는 그 칸의 글자로 이미 들어갔다
    const cells = [...tr.children].filter((c) => c.tagName === "TD" || c.tagName === "TH");
    out.push(cells.map(cellText).join("\t"));
  });
  return out;
}

/** 블록 하나 아래를 줄 배열로. 블록 경계마다 줄을 끊고, 빈 문단은 빈 줄로 남긴다(쓴 사람의 줄 간격). */
function blockLines(root: ParentNode, depth: number): string[] {
  const out: string[] = [];
  let inline = "";
  const flush = () => {
    if (inline.trim()) out.push(...inline.split("\n"));
    inline = "";
  };
  for (const node of root.childNodes) {
    if (node.nodeType !== Node.ELEMENT_NODE) {
      inline += inlineText(node);
      continue;
    }
    const el = node as Element;
    const tag = el.tagName;
    if (tag === "LABEL" && el.parentElement?.getAttribute("data-type") === "taskItem") continue; // 체크박스 — 목록 표지가 대신한다
    if (tag === "UL" || tag === "OL") {
      flush();
      out.push(...listLines(el, depth));
    } else if (tag === "TABLE") {
      flush();
      out.push(...tableLines(el));
    } else if (tag === "PRE") {
      flush();
      out.push(...(el.textContent ?? "").replace(/\n$/, "").split("\n"));
    } else if (tag === "HR") {
      flush();
      out.push("");
    } else if (BLOCK_TAGS.has(tag)) {
      flush();
      const inner = blockLines(el, depth);
      if (inner.length) out.push(...inner);
      else if (tag === "P") out.push("");
    } else {
      inline += inlineText(el);
    }
  }
  flush();
  return out;
}

/**
 * 같은 본문의 평문 — 클립보드 text/plain(서식을 못 받는 곳에 붙일 때). 블록 경계에서 줄바꿈, 목록은 "- " / "1. ",
 * 할 일은 ☐/☑, 표는 한 행 한 줄에 칸 사이 탭. 그림은 뺀다(자리 표시 [그림] 글자는 남는다).
 */
export function plainTextOf(body: string): string {
  const lines = blockLines(parseFragment(body), 0);
  return lines
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
