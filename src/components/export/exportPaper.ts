/**
 * 종이 미리보기(`<iframe srcdoc>`)의 문서와 CSS. (PLAN-2026-10-07-doc-import-export §4)
 *
 * 아래 PAPER_CSS 는 **앱 테마를 일부러 모른다**: 종이는 어느 테마에서도 흰 바탕에 검은 글자여야 하고(인쇄·한글에서
 * 열었을 때의 모습을 근사하는 게 목적), 그래서 색 리터럴이 토큰이 아니라 문서 데이터다 — scripts/check-colors.mjs 의
 * EXEMPT 에 사유와 함께 올라 있다. var() 도 쓰지 않는다 — srcdoc 문서는 앱의 :root 토큰을 상속하지 않는다. 길이는
 * pt/mm/em(종이 단위). 한 줄에 선언 하나로 쓴다 — check:type-scale 이 .ts 를 TSX 인라인 스타일처럼 읽어서, 한 줄에
 * 여러 선언을 이어 쓰면 다음 선언의 숫자까지 margin/padding 값으로 오탐한다.
 * (.css?raw 로 둘 수도 있지만 vitest 는 .css 를 — ?raw 까지 — 빈 문자열로 바꾼다. 문자열이면 테스트가 CSS 를 본다.)
 *
 * 쪽 나눔은 계산하지 않는다(§4 "만들지 않는 것"): 종이 한 장 크기의 창에서 안쪽이 스크롤된다. 정확한 쪽은
 * WebView2 인쇄 창이 보여 준다 — 모달의 [인쇄…] 가 이 문서를 그대로 인쇄한다(W5, printCss).
 *
 * 크기: 문서는 용지 실제 크기(mm)로 짜고 body 의 `zoom` 으로 창 폭에 맞춰 줄인다 — transform 과 달리
 * 레이아웃 폭이 줄어든 만큼만 차지해 iframe 안 스크롤이 어긋나지 않는다.
 */
import type { ExportFormat, ExportMargin, ExportPaper, PaperOrient, PaperSize } from "./exportDoc";

/** 세로 기준 (폭, 높이) mm — Rust doc_export 의 쪽 크기와 같은 종이. b5 는 JIS B5. */
const PAPER_MM: Record<PaperSize, readonly [number, number]> = {
  a4: [210, 297],
  b5: [182, 257],
  letter: [215.9, 279.4],
};

/** CSS 픽셀(96dpi) / mm. */
const PX_PER_MM = 96 / 25.4;

/** 방향까지 반영한 (폭, 높이) mm. */
export function paperMm(paper: ExportPaper): [number, number] {
  const [size, orient] = paper.split("-") as [PaperSize, PaperOrient];
  const [w, h] = PAPER_MM[size];
  return orient === "landscape" ? [h, w] : [w, h];
}

/** 미리보기 창의 폭(px) — ExportModal 이 iframe 폭으로 쓰고, 같은 값으로 zoom 을 계산한다. 크기와 무관하게 방향으로만 정한다. */
export function paperViewWidth(paper: ExportPaper): number {
  return paper.endsWith("-landscape") ? 640 : 540;
}

/** 폭에 대한 높이 비율 — 종이 한 장 모양. */
export function paperViewHeight(paper: ExportPaper): number {
  const [w, h] = paperMm(paper);
  return Math.round((paperViewWidth(paper) * h) / w);
}

/** body 에 걸 zoom — 종이 실제 폭이 창 폭이 되게. */
export function paperZoom(paper: ExportPaper): number {
  const actual = paperMm(paper)[0] * PX_PER_MM;
  // 4자리에서 **내린다** — 올림 값이면 확대된 body 가 창 폭을 소수점 아래로 넘겨 가로 스크롤이 생긴다.
  return Math.floor((paperViewWidth(paper) / actual) * 10_000) / 10_000;
}

/** 본문 안쪽 여백 mm — (위, 좌우, 아래). */
export type PageInset = readonly [number, number, number];

/** 종이 형식이 아닌 문서(Markdown 미리보기 · HTML 파일 인쇄)의 여백 — 이전부터 쓰던 근사값. */
const DEFAULT_INSET: PageInset = [20, 25, 15];

/**
 * 파일에서 본문이 놓이는 자리(mm) — Rust hwpx.rs / docx.rs `margins` 와 같은 값이어야 미리보기·인쇄가 파일과 맞는다.
 * HWPX 보통은 한글 기본 용지(위 20 + 머리말 15 · 좌우 30 · 아래 15 + 꼬리말 15 — 한글은 본문을 머리말·꼬리말 안쪽에 둔다),
 * DOCX 보통은 Word 기본 25.4mm. 좁게 = 사방 12.7mm(둘 다), 넓게 = 보통에서 좌우만 50.8mm.
 */
export function pageInsetMm(margin: ExportMargin, format: ExportFormat): PageInset {
  const normal: PageInset = format === "hwpx" ? [35, 30, 30] : format === "docx" ? [25.4, 25.4, 25.4] : DEFAULT_INSET;
  if (margin === "narrow") return [12.7, 12.7, 12.7];
  if (margin === "wide") return [normal[0], 50.8, normal[2]];
  return normal;
}

/** CSS margin/padding 값 — 위 좌우 아래. */
function insetCss([top, lr, bottom]: PageInset): string {
  return `${top}mm ${lr}mm ${bottom}mm`;
}

/** 할 일 체크박스는 HWPX 로 ☐/☑ 글자가 된다 — 종이 미리보기도, HTML 파일(W6)도 같은 모양으로. 두 문서가 이 한 벌을 쓴다. */
const TASK_CSS = `
ul[data-type="taskList"] {
  list-style: none;
  padding-left: 0;
}
li[data-type="taskItem"] {
  display: flex;
  gap: 0.45em;
  align-items: baseline;
}
li[data-type="taskItem"] > label {
  flex: none;
}
li[data-type="taskItem"] > label > input,
li[data-type="taskItem"] > label > span {
  display: none;
}
li[data-type="taskItem"] > label::before {
  content: "\\2610";
}
li[data-type="taskItem"][data-checked="true"] > label::before {
  content: "\\2611";
}
li[data-type="taskItem"] > div {
  flex: 1;
  min-width: 0;
}
`;

export const PAPER_CSS = `
html {
  background: #fff;
  overflow-x: hidden;
}
body {
  margin: 0;
  box-sizing: border-box;
  background: #fff;
  color: #111;
  font-family: "HCR Batang", "함초롬바탕", "Batang", "바탕", "Noto Serif KR", "Source Serif 4", serif;
  font-size: 10pt;
  line-height: 1.6;
  overflow-wrap: anywhere;
  word-break: keep-all;
}
p {
  margin: 0;
  min-height: 1.6em;
}
h1, h2, h3, h4, h5, h6 {
  margin: 8pt 0 3pt;
  font-weight: 600;
  line-height: 1.35;
}
h1 { font-size: 16pt; }
h2 { font-size: 14pt; }
h3 { font-size: 12pt; }
h4, h5, h6 { font-size: 10.5pt; }
.sec-title {
  font-size: 13pt;
  margin: 14pt 0 4pt;
}
.sec-title:first-child {
  margin-top: 0;
}
ul, ol {
  margin: 0;
  padding-left: 1.6em;
}
li > p {
  min-height: 0;
}
blockquote {
  margin: 3pt 0 3pt 1em;
  padding-left: 0.8em;
  border-left: 2pt solid #999;
  color: #444;
}
hr {
  border: 0;
  border-top: 0.5pt solid #777;
  margin: 8pt 0;
}
pre {
  margin: 4pt 0;
  padding: 4pt 6pt;
  background: #f2f2f2;
  white-space: pre-wrap;
  font-family: "D2Coding", "Consolas", "Courier New", monospace;
  font-size: 9pt;
  line-height: 1.45;
}
code {
  font-family: "D2Coding", "Consolas", "Courier New", monospace;
  font-size: 0.92em;
}
mark {
  background: #ffe97a;
  color: inherit;
}
a {
  color: #1a4fb0;
  text-decoration: underline;
}
/* ProseMirror 가 그림에 박는 인라인 style 은 앱의 --editor-img-max 를 참조한다 — 여기선 정의되지 않으니 폭만 막는다. */
img {
  max-width: 100% !important;
  height: auto;
}
.img-ph {
  color: #777;
  font-size: 9pt;
}
table {
  border-collapse: collapse;
  width: 100%;
  margin: 3pt 0 5pt;
  table-layout: auto;
}
td, th {
  border: 0.5pt solid #333;
  padding: 2pt 4pt;
  vertical-align: top;
  text-align: left;
}
th {
  background: #e9e7e0;
  font-weight: 600;
}
td p, th p {
  min-height: 0;
}
details > summary {
  font-weight: 600;
}
${TASK_CSS}`;

/**
 * 인쇄할 때만 쓰는 CSS(W5). 미리보기와 같은 문서를 인쇄하므로 화면용 몸체 설정(body 인라인 style 의 폭·여백·zoom)을
 * `!important` 로 걷어 내고 쪽 여백을 `@page` 가 맡는다 — 인라인 style 은 스타일시트의 `!important` 로만 덮인다.
 *
 * 여백 상자 둘(2026-10-08 WebView2 Edg/154 실측): 작성자가 아래 여백 상자에 내용을 주면 브라우저 기본 바닥글이,
 * 위 여백 상자에 내용을 주면 기본 머리글(날짜·창 제목 "Brise")이 빠진다. 위는 빈 글자로 비워 머리글만 지우고, 아래는
 * 쪽 번호를 직접 단다. 여백은 미리보기 종이(body padding)와 같은 값(pageInsetMm).
 * 셀 배경·머리글 칸 색은 인쇄 기본값이 배경을 빼므로 print-color-adjust 로 살린다.
 * 한 줄에 선언 하나(check:type-scale) — 여백 상자 안도 마찬가지.
 */
export function printCss(paper: ExportPaper, inset: PageInset = DEFAULT_INSET): string {
  // 이름(A4·B5)이 아니라 mm 로 적는다 — CSS 의 B5 는 ISO(176×250)라 JIS B5 와 다르다.
  const [w, h] = paperMm(paper);
  return `
@page {
  size: ${w}mm ${h}mm;
  margin: ${insetCss(inset)};
  @top-center {
    content: "";
  }
  @bottom-center {
    content: counter(page) " / " counter(pages);
    font-size: 8pt;
    color: #777;
  }
}
@media print {
  html {
    overflow: visible;
  }
  body {
    width: auto !important;
    padding: 0 !important;
    zoom: 1 !important;
  }
  * {
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  tr, img {
    break-inside: avoid;
  }
  h1, h2, h3, h4, h5, h6 {
    break-after: avoid;
  }
}
`;
}

/** 글자를 HTML 본문·속성값에 넣을 수 있게. (exportHtml.ts 의 <title> 도 이걸 쓴다.) */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** DOCX 미리보기의 본문 글꼴 — export_docx 가 맑은 고딕을 지정하므로(달라지는 점의 "글꼴" 줄과 같다) 종이도 그 글꼴로
 *  그린다. PAPER_CSS 의 함초롬바탕(HWPX 용)을 뒤에서 덮는다. 한 줄에 선언 하나(check:type-scale). */
const DOCX_FONT_CSS = `
body {
  font-family: "Malgun Gothic", "맑은 고딕", "Noto Sans KR", "Source Sans 3", sans-serif;
}
`;

/**
 * 종이 문서 한 벌. 본문은 이미 걸러진 HTML(exportDoc.renderPaperBody) — srcdoc 에 그대로 들어간다.
 * 용지 크기·여백은 파일과 같은 값(paperMm · pageInsetMm) — 글꼴·줄 높이는 "대략"이라는 표시와 맞는 근사다.
 * format 이 docx 면 글꼴도 Word 쪽(맑은 고딕)으로 바뀐다 - 나머지 형식은 HWPX 와 같은 종이다.
 * 인쇄 CSS(printCss)는 형식과 무관하게 늘 들어간다 — 화면에는 영향이 없고, 인쇄는 지금 보이는 종이 그대로다.
 */
export function buildPaperSrcDoc(
  bodyHtml: string,
  paper: ExportPaper,
  format: ExportFormat = "hwpx",
  title = "",
  margin: ExportMargin = "normal",
): string {
  const inset = pageInsetMm(margin, format);
  const css = (format === "docx" ? PAPER_CSS + DOCX_FONT_CSS : PAPER_CSS) + printCss(paper, inset);
  return (
    `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${css}</style></head>` +
    `<body style="width:${paperMm(paper)[0]}mm;padding:${insetCss(inset)};zoom:${paperZoom(paper).toFixed(4)}">${bodyHtml}</body></html>`
  );
}

// ── HTML 파일 · 서식 복사 (W6) ─────────────────────────────────────────────────────────
// 둘 다 종이가 아니라 화면에서 읽히는 문서다. 색은 종이와 같은 값(흰 바탕·검은 글자 — 받는 사람의 테마를 모른다).
// 조립은 exportHtml.ts 가 하고, 색·CSS 리터럴은 check:colors 면제인 이 파일에만 둔다.

/**
 * 읽히는 단일 HTML 파일의 화면 CSS. 종이(PAPER_CSS)와 다른 점: 용지 폭이 아니라 읽기 폭(가운데 46em, 좁은 화면은
 * 여백만 줄인다), 글꼴은 어느 OS 에나 있는 산세리프 스택, 넓은 표는 감싼 div(.table-wrap) 안에서 가로로 스크롤.
 * 인쇄는 이 뒤에 붙는 printCss("a4-portrait")(W5 그대로)가 맡는다. 한 줄에 선언 하나(check:type-scale).
 */
export const HTML_DOC_CSS = `
html {
  background: #fff;
}
body {
  margin: 0 auto;
  max-width: 46em;
  padding: 2em 2em 4em;
  background: #fff;
  color: #111;
  font-family: "Malgun Gothic", "맑은 고딕", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif;
  font-size: 1rem;
  line-height: 1.7;
  overflow-wrap: anywhere;
  word-break: keep-all;
}
@media (max-width: 640px) {
  body {
    padding: 1em 0.9em 3em;
  }
}
p {
  margin: 0;
  min-height: 1.7em;
}
h1, h2, h3, h4, h5, h6 {
  margin: 1em 0 0.4em;
  font-weight: 600;
  line-height: 1.35;
}
h1 { font-size: 1.75em; }
h2 { font-size: 1.4em; }
h3 { font-size: 1.2em; }
h4, h5, h6 { font-size: 1.05em; }
.sec-title {
  margin: 2em 0 0.5em;
  padding-bottom: 0.2em;
  border-bottom: 1px solid #ccc;
}
.sec-title:first-child {
  margin-top: 0;
}
ul, ol {
  margin: 0;
  padding-left: 1.6em;
}
li > p {
  min-height: 0;
}
blockquote {
  margin: 0.4em 0 0.4em 1em;
  padding-left: 0.8em;
  border-left: 3px solid #999;
  color: #444;
}
hr {
  border: 0;
  border-top: 1px solid #bbb;
  margin: 1em 0;
}
pre {
  margin: 0.5em 0;
  padding: 0.6em 0.8em;
  background: #f2f2f2;
  white-space: pre-wrap;
  font-family: "D2Coding", "Consolas", "Menlo", "Courier New", monospace;
  font-size: 0.9em;
  line-height: 1.5;
}
code {
  font-family: "D2Coding", "Consolas", "Menlo", "Courier New", monospace;
  font-size: 0.92em;
}
mark {
  background: #ffe97a;
  color: inherit;
}
a {
  color: #1a4fb0;
  text-decoration: underline;
}
/* ProseMirror 가 그림에 박는 인라인 style 은 앱의 --editor-img-max 를 참조한다 — 여기선 정의되지 않으니 폭만 막는다. */
img {
  max-width: 100% !important;
  height: auto;
}
.img-ph {
  color: #777;
  font-size: 0.9em;
}
.table-wrap {
  overflow-x: auto;
  margin: 0.4em 0 0.8em;
}
table {
  border-collapse: collapse;
  width: 100%;
}
/* 칸은 body 의 overflow-wrap: anywhere 를 물려받지 않는다 — anywhere 는 칸의 최소 폭을 한 글자로 낮춰, 넓은 표가 .table-wrap 안에서
   스크롤하는 대신 열을 한 글자 폭까지 줄였다(금액이 여러 줄로 쪼개짐). break-word 는 최소 폭을 낮추지 않는다. */
td, th {
  border: 1px solid #999;
  padding: 4pt 6pt;
  vertical-align: top;
  text-align: left;
  overflow-wrap: break-word;
}
th {
  background: #e9e7e0;
  font-weight: 600;
}
td p, th p {
  min-height: 0;
}
details {
  margin: 0.3em 0;
}
details > summary {
  font-weight: 600;
  cursor: pointer;
}
${TASK_CSS}
@media print {
  body {
    max-width: none;
    font-size: 10.5pt;
  }
  .table-wrap {
    overflow: visible;
  }
  /* 접힌 접기도 인쇄에는 내용까지 — ::details-content 를 아는 브라우저만(모르면 접힌 채 인쇄된다). */
  details::details-content {
    content-visibility: visible;
  }
}
`;

/** 인라인 style 한 벌 — 선언을 한 줄에 하나씩 적고 이어 붙인다(check:type-scale 이 한 줄을 TSX 인라인 스타일처럼 읽는다). */
function inlineStyle(decls: readonly string[]): string {
  return decls.join("; ");
}

/**
 * 서식 복사(W6)의 요소별 인라인 style. 메일·그룹웨어 편집기는 붙여넣은 HTML 의 `<style>` 을 버리므로 요소마다 직접 단다
 * (exportHtml.ts buildClipboardHtml). 셀 배경·형광 색처럼 원래 붙어 있던 인라인 style 은 이것보다 **뒤에** 남겨 이긴다.
 */
export const CLIP_STYLES = {
  table: inlineStyle([
    "border-collapse: collapse",
    "margin: 4pt 0 6pt",
  ]),
  td: inlineStyle([
    "border: 1px solid #999",
    "padding: 3pt 6pt",
    "vertical-align: top",
    "text-align: left",
  ]),
  th: inlineStyle([
    "border: 1px solid #999",
    "padding: 3pt 6pt",
    "vertical-align: top",
    "text-align: left",
    "background-color: #e9e7e0",
    "font-weight: 600",
  ]),
  cellParagraph: inlineStyle([
    "margin: 0",
  ]),
  img: inlineStyle([
    "max-width: 100%",
    "height: auto",
  ]),
  blockquote: inlineStyle([
    "margin: 4pt 0 4pt 1em",
    "padding-left: 0.8em",
    "border-left: 3px solid #999",
    "color: #444",
  ]),
  pre: inlineStyle([
    "margin: 4pt 0",
    "padding: 4pt 6pt",
    "background-color: #f2f2f2",
    "white-space: pre-wrap",
    "font-family: Consolas, 'D2Coding', 'Courier New', monospace",
    "font-size: 0.9em",
  ]),
  code: inlineStyle([
    "font-family: Consolas, 'D2Coding', 'Courier New', monospace",
    "background-color: #f2f2f2",
    "font-size: 0.92em",
  ]),
  h1: inlineStyle([
    "font-size: 1.6em",
    "font-weight: 600",
  ]),
  h2: inlineStyle([
    "font-size: 1.35em",
    "font-weight: 600",
  ]),
  h3: inlineStyle([
    "font-size: 1.15em",
    "font-weight: 600",
  ]),
  mark: inlineStyle([
    "background-color: #ffe97a",
  ]),
  hr: inlineStyle([
    "border: 0",
    "border-top: 1px solid #bbb",
  ]),
  taskList: inlineStyle([
    "list-style: none",
    "padding-left: 0",
  ]),
  placeholder: inlineStyle([
    "color: #777",
  ]),
} as const;

/**
 * 인쇄 직전 — 미리보기 문서의 그림을 전부 eager 로 바꾸고 다 끝날 때까지(load·error) 기다린다.
 * iframe 의 load 이벤트는 `loading="lazy"` 그림을 기다리지 않으므로 명시적 단계가 필요하다(E-4).
 * `timeoutMs` 안에 못 끝나면 false(그래도 인쇄는 부르는 쪽이 진행하고 기록한다), 다 끝나면 true.
 */
export function loadAllImages(doc: Document, timeoutMs: number): Promise<boolean> {
  const imgs = Array.from(doc.images);
  for (const img of imgs) img.loading = "eager";
  const pending = imgs.filter((img) => !img.complete);
  if (pending.length === 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    let left = pending.length;
    const timer = setTimeout(() => resolve(false), timeoutMs);
    for (const img of pending) {
      const one = () => {
        img.removeEventListener("load", one);
        img.removeEventListener("error", one);
        left -= 1;
        if (left === 0) {
          clearTimeout(timer);
          resolve(true);
        }
      };
      img.addEventListener("load", one);
      img.addEventListener("error", one);
    }
  });
}
