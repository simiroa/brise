/**
 * 내보내기·인쇄 모달(ExportModal)의 문서 쪽 — 순수 함수와 읽기 한 곳.
 * (PLAN-2026-10-07-doc-import-export §3 W3, §3.1 W6, §4)
 *
 * 모달은 **문서를 한 번만 연다**: 노트의 텍스트 섹션마다 헤드리스 TipTap 한 인스턴스로 body_md 를 열고
 * 같은 인스턴스에서 JSON(HWPX·DOCX 로 보낼 것)과 HTML(종이 미리보기에 그릴 것)을 함께 뽑는다. 둘이 한
 * 파서에서 나오므로 "미리보기엔 보이는데 파일에는 없는" 어긋남이 파서 차이로는 생기지 않는다.
 * 시트 섹션은 계산된 값 표 JSON(exportSheets.ts)을 같은 스키마로 한 번 열어 같은 식으로 뽑고, 각주를 적용한
 * 문서(prepareExport)도 바꾼 JSON 을 같은 스키마로 다시 연다 — 어느 길이든 JSON 과 HTML 은 한 문서에서 나온다.
 * 범위(이 섹션/노트 전체)·형식을 바꿔도 다시 읽지 않는다 — 이미 읽은 섹션에서 골라 쓴다.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import { call, flushAll } from "../../lib/invoke";
import { reportFallback } from "../../lib/diag";
import { createMarkdownEditor, createMarkdownSchemaExtensions } from "../../lib/mdSerialize";
import type { NoteDetail } from "../../lib/commands.gen";
import { parseSheet } from "../../lib/sheet/types";
import { isSheetBodyEmpty } from "../../lib/sheet/isSheetBodyEmpty";
import { t } from "../../i18n/t";
import { yieldFrame } from "../../lib/yieldFrame";
import { isSafeRelPath } from "../editor/imageExtension";
import { resolveImageDisplaySrc } from "../editor/ImageNodeView";
import { sheetToTableDoc } from "./exportSheets";
import { applyFootnotes, collectFootnoteIds, loadFootnoteBodies } from "./exportFootnotes";

/** 문서 편집기용 파일 — export_hwpx · export_docx 가 같은 입력(DocExportSection[] + 용지)을 받아 만든다. */
export type OfficeFormat = "hwpx" | "docx";
/**
 * html = 읽히는 단일 HTML 파일(그림 내장 · 링크 살림) · copy = 같은 HTML 을 클립보드로(메일·그룹웨어 본문에 붙이기).
 * md = Markdown(노트 단위는 Rust export_note). 인쇄는 형식이 아니다 — 모든 형식에 [인쇄…] 버튼이 있다(2026-10-16 "PDF·인쇄" 형식 삭제).
 */
export type ExportFormat = OfficeFormat | "html" | "copy" | "md";
export type ExportScope = "section" | "note";
/** 용지 크기 — b5 는 JIS B5(182×257mm, 한글·Word 의 "B5"). */
export type PaperSize = "a4" | "b5" | "letter";
export type PaperOrient = "portrait" | "landscape";
/** export_hwpx · export_docx 의 paper 인자 그대로. */
export type ExportPaper = `${PaperSize}-${PaperOrient}`;
/** 여백 단계 — export_hwpx · export_docx 의 margin 인자 그대로. 수치는 exportPaper.ts pageInsetMm(Rust 와 같은 값). */
export type ExportMargin = "narrow" | "normal" | "wide";

/** 문서 편집기용 형식(HWPX·DOCX)인가 — 용지 선택 · 종이 위 안내 · 달라지는 점의 표를 공유하는 갈래. */
export function isOfficeFormat(f: ExportFormat): f is OfficeFormat {
  return f === "hwpx" || f === "docx";
}

/** 용지(크기·방향·여백)를 고르는 형식인가 — 문서 편집기용 파일만. html·copy 는 용지가 없다(읽기 폭), md 는 글자뿐이다. */
export function hasPaper(f: ExportFormat): boolean {
  return isOfficeFormat(f);
}

/**
 * 읽어 둔 섹션 하나 — 텍스트 섹션이거나 시트(계산된 값 표). doc = ProseMirror JSON(export_hwpx · export_docx 로
 * 그대로 간다), html = 같은 문서의 미리보기용 HTML.
 */
export interface ExportDocSection {
  id: string;
  name: string;
  kind: "text" | "sheet";
  doc: unknown;
  html: string;
}

export interface ExportDocs {
  /** 텍스트 섹션과 시트 섹션, 노트의 섹션 순서대로. 빈 시트·못 읽은 시트는 없다. */
  sections: ExportDocSection[];
  /** 관계도 섹션 수 — 노트 전체로 내보낼 때 빠지는 것(캔버스가 떠 있어야 그림이 나와 아직 못 넣는다). */
  excluded: number;
  /** 각주 첨부 id → 본문 평문(마크다운을 벗긴 글자, 줄은 `\n`). 못 읽은 각주는 키가 없다 — 번호만 나간다. */
  footnotes: Record<string, string>;
}

/** ProseMirror JSON 을 마크다운 스키마로 한 번 열어 정규화된 JSON 과 HTML 을 함께 뽑는다(텍스트 섹션과 같은 스키마). */
function openDocJson(content: JSONContent): { doc: unknown; html: string } {
  const ed = new Editor({ extensions: createMarkdownSchemaExtensions(), content });
  try {
    return { doc: ed.getJSON(), html: ed.getHTML() };
  } finally {
    ed.destroy();
  }
}

/** 시트 본문 → 값 표 문서. 빈 시트는 조용히, 못 읽는 본문(JSON 깨짐)은 기록하고 건너뛴다(null). */
function sheetSectionDoc(bodyMd: string): JSONContent | null {
  if (isSheetBodyEmpty(bodyMd)) return null;
  const sheet = parseSheet(bodyMd);
  if (!sheet) {
    reportFallback("export", "sheet_parse_failed");
    return null;
  }
  return sheetToTableDoc(sheet, (cut) =>
    t("export.sheet_truncated", {
      more_rows: cut.moreRows,
      more_cols: cut.moreCols,
      shown_rows: cut.shownRows,
      shown_cols: cut.shownCols,
    }),
  );
}

/**
 * 노트의 텍스트·시트 섹션을 DB 에서 읽어 문서로 열고, 본문에 걸린 각주의 내용을 읽는다.
 *
 * **flushAll() 이 먼저다** (CLAUDE.md 함정 4): 스토어의 activeNote.sections 는 타이핑 중 최신이 아니다
 * (updateSectionBody 는 캐럿 튐 방지로 일부러 갱신하지 않는다). 그래서 대기 중 저장을 끝낸 뒤 note_get 으로
 * DB 의 본문을 읽는다. 읽기 실패는 call() 이 토스트로 알리고 그대로 던진다 — 호출자는 상태만 정리한다.
 * 각주 본문 읽기는 조용하다 — 하나가 실패해도 그 각주만 본문 없이 나간다(exportFootnotes.ts).
 */
export async function loadExportDocs(
  noteId: string,
  opts: { onProgress?: (i: number, n: number) => void; isCancelled?: () => boolean } = {},
): Promise<ExportDocs> {
  const { onProgress, isCancelled } = opts;
  const aborted: ExportDocs = { sections: [], excluded: 0, footnotes: {} };
  await flushAll();
  const detail = await call<NoteDetail>("note_get", { id: noteId });
  const ordered = [...detail.sections].sort((a, b) => a.position - b.position);
  // 열어야 하는(텍스트·시트) 섹션 수 = 진행 "i/N" 의 N. 섹션마다 TipTap 을 동기로 여는 비용이 큰 노트에서는 수 초라,
  // 섹션 사이마다 한 프레임을 내주고 취소를 확인한다(E-1) — 취소되면 쓸 수 없는 빈 결과를 돌려준다(호출자가 버린다).
  const total = ordered.filter((s) => s.kind === "text" || s.kind === "sheet").length;
  const sections: ExportDocSection[] = [];
  let excluded = 0;
  let done = 0;
  for (const s of ordered) {
    if (s.kind !== "text" && s.kind !== "sheet") {
      excluded += 1;
      continue;
    }
    done += 1;
    onProgress?.(done, total);
    await yieldFrame();
    if (isCancelled?.()) return aborted;
    if (s.kind === "text") {
      const ed = createMarkdownEditor(s.body_md);
      try {
        sections.push({ id: s.id, name: s.name, kind: "text", doc: ed.getJSON(), html: ed.getHTML() });
      } finally {
        ed.destroy();
      }
    } else {
      const table = sheetSectionDoc(s.body_md);
      if (table) sections.push({ id: s.id, name: s.name, kind: "sheet", ...openDocJson(table) });
    }
  }
  if (isCancelled?.()) return aborted;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const s of sections) if (s.kind === "text") collectFootnoteIds(s.doc, ids, seen);
  const footnotes = ids.length ? await loadFootnoteBodies(ids) : {};
  return { sections, excluded, footnotes };
}

/**
 * 고른 섹션을 내보낼 모양으로 — 지금은 각주: 본문 `[n]` + 마지막 고른 섹션 끝의 "각주" 목록(exportFootnotes.ts).
 * 번호는 **고른 섹션들에 걸쳐** 처음 나오는 순서라 "이 섹션"만 고르면 그 섹션 안에서 1 부터다.
 * 바뀐 섹션만 JSON 을 다시 열어 doc·html 을 함께 새로 만든다(미리보기 = 파일). 각주가 없으면 **입력 배열 그대로**
 * 돌려준다(부르는 쪽 useMemo 가 흔들리지 않게). 순수 — picked · docs 는 바꾸지 않는다.
 */
export function prepareExport(
  picked: ExportDocSection[],
  docs: ExportDocs,
  opts: { footnoteHeading: string },
): ExportDocSection[] {
  const applied = applyFootnotes(
    picked.map((s) => s.doc),
    docs.footnotes,
    opts.footnoteHeading,
  );
  if (!applied) return picked;
  return picked.map((s, i) =>
    applied.changed[i] ? { ...s, ...openDocJson(applied.docs[i] as JSONContent) } : s,
  );
}

/** 파일 이름으로 쓸 수 없는 글자를 `_` 로. 비면 fallback. */
export function exportFileSlug(title: string, fallback: string): string {
  const slug = (title ?? "").trim().replace(/[\\/:*?"<>|]/g, "_");
  return slug || fallback;
}

// ── 달라지는 점 ─────────────────────────────────────────────────────────────────────────

/**
 * 형식을 거치며 달라지는 것의 종류. 문구는 UI(ExportModal)가 id 로 고른다 — 이 파일은 센 것만 안다.
 * - tasks / details / dates / footnotes / font / table_style / remote_images / sheets / excluded : HWPX · DOCX
 *   (font 문구만 형식별)
 * - tasks / details / dates / footnotes / remote_images / sheets / excluded : 인쇄 — 종이 미리보기 그대로라 글꼴·표 모양은
 *   달라지지 않는다
 * - tasks / dates / footnotes / sheets / excluded : HTML — 접기는 진짜 접기(<details>)로 남고 웹 그림은 웹에서 보인다
 * - 위 + details : 서식 복사 — 붙여넣는 곳에는 접기가 없어 펼친 내용으로 나간다(exportHtml buildClipboardHtml)
 * - rich_format / sheets : Markdown — 색·정렬·병합 표 같은 서식이 HTML 조각으로 남고, 시트는 Rust 가 칸에 적힌 그대로
 *   (수식 포함) 마크다운 표로 쓴다
 *
 * dates = 날짜 표시 → 일반 글자, footnotes = 각주 → 본문 `[n]` + 끝 목록(prepareExport), sheets = 시트 → 계산된 값 표
 * (수식은 빠진다 — Markdown 만 반대로 적힌 그대로, 문구는 형식 표의 sheetCells 가 고른다), excluded = 관계도 섹션(노트 전체일
 * 때만, 부르는 쪽이 센다).
 */
export type ExportDiffId =
  | "tasks"
  | "details"
  | "dates"
  | "footnotes"
  | "font"
  | "table_style"
  | "excluded"
  | "remote_images"
  | "sheets"
  | "rich_format";

export interface ExportDiff {
  id: ExportDiffId;
  /** 센 개수. 개수가 뜻이 없는 항목(font)은 0. */
  n: number;
}

interface PmNode {
  type?: string;
  attrs?: Record<string, unknown>;
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
  content?: PmNode[];
}

interface DocCounts {
  tasks: number;
  details: number;
  /**
   * 날짜·각주 — **서로 다른 id** 수(끝 목록의 항목 수와 같다). 한 표시가 여러 글자 노드에 걸치면(일부만 굵게 등)
   * 노드를 세면 두 번 센다. id 가 없는 표시는 노드마다 하나로 센다.
   */
  dateIds: Set<string>;
  datesNoId: number;
  footnoteIds: Set<string>;
  tables: number;
  /** 첨부 폴더 안의 파일로 해석되지 않는 그림(웹 주소 등). */
  remoteImages: number;
  /** 색 · 정렬/들여쓰기 · 병합/배경 칸 · 날짜/각주 조각 — 마크다운에서 HTML 조각이 되는 서식 곳수. */
  richFormat: number;
}

function scanDoc(root: unknown, acc: DocCounts): void {
  const node = root as PmNode | null;
  if (!node || typeof node !== "object") return;
  const attrs = node.attrs ?? {};
  switch (node.type) {
    case "taskItem":
      acc.tasks += 1;
      break;
    case "details":
      acc.details += 1;
      break;
    case "table":
      acc.tables += 1;
      break;
    case "tableCell":
    case "tableHeader":
      if (Number(attrs.colspan) > 1 || Number(attrs.rowspan) > 1 || attrs.backgroundColor) acc.richFormat += 1;
      break;
    case "image":
      if (!isSafeRelPath(attrs.relPath as string | null | undefined)) acc.remoteImages += 1;
      break;
    case "paragraph":
    case "heading": {
      const align = attrs.textAlign;
      if ((typeof align === "string" && align !== "left") || Number(attrs.indent) > 0) acc.richFormat += 1;
      break;
    }
    default:
      break;
  }
  for (const m of node.marks ?? []) {
    if (m.type === "date" || m.type === "footnote") {
      const id = m.attrs?.id;
      if (m.type === "footnote") {
        if (typeof id === "string" && id) acc.footnoteIds.add(id);
      } else if (typeof id === "string" && id) {
        acc.dateIds.add(id);
      } else {
        acc.datesNoId += 1;
      }
      acc.richFormat += 1; // 마크다운에서는 <span data-…> 섬으로 남는다
    } else if (m.type === "textStyle" && m.attrs?.color) {
      acc.richFormat += 1;
    }
  }
  for (const child of node.content ?? []) scanDoc(child, acc);
}

/**
 * 문서 JSON 을 한 번 훑어 형식별로 달라지는 점을 센다 — 0 인 항목은 목록에서 빠지고, 목록이 비면
 * UI 가 "그대로 나갑니다"를 보인다. HWPX · DOCX 는 같은 규칙 표를 쓴다(체크박스 → ☐/☑, 접기 → 펼침, 날짜 → 글자,
 * 각주 → [n] + 끝 목록, 칸 높이·테두리 → 기본값, 시트 → 값 표, 관계도 제외) — 형식마다 다른 건 font 의 문구뿐이라
 * (함초롬바탕 / 맑은 고딕) 그건 UI 가 형식으로 고른다. 글꼴은 늘 지정되므로 font 가 항상 들어, 두 형식의 목록은 비는 일이 없다.
 *
 * 시트 섹션(kind "sheet")은 개수만 sheets 로 센다 — 그 문서의 표는 시트에서 만든 것이라 table_style 에 넣지 않고,
 * Markdown 의 rich_format 에도 넣지 않는다(Markdown 은 Rust 가 시트를 칸에 적힌 그대로 자기 표로 쓴다 — 그래서 Markdown 도
 * sheets 줄은 있다: 미리보기·다른 형식의 계산 값과 달리 수식이 글자로 들어간다). kind 가 없으면 텍스트 섹션.
 * prepareExport 를 지난 섹션을 넣어도 같은 수가 나온다(각주 마크는 남고 끝 목록에는 표시가 없다).
 */
export function exportDifferences(
  sections: ReadonlyArray<{ doc: unknown; kind?: ExportDocSection["kind"] }>,
  format: ExportFormat,
  opts: { excluded?: number } = {},
): ExportDiff[] {
  const c: DocCounts = {
    tasks: 0,
    details: 0,
    dateIds: new Set(),
    datesNoId: 0,
    footnoteIds: new Set(),
    tables: 0,
    remoteImages: 0,
    richFormat: 0,
  };
  let sheets = 0;
  for (const s of sections) {
    if (s.kind === "sheet") sheets += 1;
    else scanDoc(s.doc, c);
  }
  const dates = c.dateIds.size + c.datesNoId;
  const footnotes = c.footnoteIds.size;
  const excluded = opts.excluded ?? 0;
  const diffs: ExportDiff[] = [];
  const push = (id: ExportDiffId, n: number) => {
    if (n > 0) diffs.push({ id, n });
  };
  if (isOfficeFormat(format)) {
    push("tasks", c.tasks);
    push("details", c.details);
    push("dates", dates);
    push("footnotes", footnotes);
    diffs.push({ id: "font", n: 0 });
    push("table_style", c.tables);
    push("remote_images", c.remoteImages);
    push("sheets", sheets);
    push("excluded", excluded);
  } else if (format === "html" || format === "copy") {
    push("tasks", c.tasks);
    if (format === "copy") push("details", c.details);
    push("dates", dates);
    push("footnotes", footnotes);
    push("sheets", sheets);
    push("excluded", excluded);
  } else {
    push("rich_format", c.richFormat);
    push("sheets", sheets);
  }
  return diffs;
}

// ── 종이 미리보기용 HTML ────────────────────────────────────────────────────────────────

/**
 * 바깥으로 내보내도 되는 주소인가 — 되면 브라우저가 읽을 모양(정규화된 href), 아니면 null.
 * 직접 접두사를 맞춰 보지 않고 WHATWG URL 파서에 맡긴다: 브라우저가 그 링크를 읽는 규칙 그대로라
 * 앞뒤 공백·제어 문자, 중간의 탭·개행(`java\tscript:`), 대문자 스킴(`JAVASCRIPT:`)이 우회로가 되지 않는다.
 * 상대 주소(`a.png`, `//host`)는 기준 주소가 없어 실패한다 — 내보낸 파일에서는 어차피 아무 데도 안 가리킨다.
 */
function exportableUrl(raw: string | null, protocols: ReadonlySet<string>): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null; // 상대 주소·깨진 주소 — "내보낼 수 없다"가 답이라 기록할 실패가 아니다
  }
  return protocols.has(u.protocol) ? u.href : null;
}

const LINK_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:", "mailto:"]);
const WEB_IMAGE_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/**
 * 읽어 둔 섹션 HTML 을 종이에 놓을 본문으로 다듬는다. 부르는 쪽이 문자열을 srcdoc 에 넣거나(미리보기·인쇄),
 * 파일·클립보드용 HTML 로 감싼다(html·copy).
 *
 * - 그림 `images`:
 *   - `"display"`(기본) — 첨부 상대 경로(relPath)를 에디터와 같은 규칙(resolveImageDisplaySrc)으로 asset URL 로 바꾼다.
 *     기반 폴더가 아직 안 풀렸거나(콜드 캐시) 못 푸는 그림은 빈 `<img>` 대신 자리 표시를 둔다.
 *   - `"embed"` — 파일·클립보드용. 첨부 그림은 `<img data-rel-path="…" src="">` 로 둔다 — Rust(export_html ·
 *     export_html_inline)가 첨부 루트 안에서 읽어 data: URI 로 채운다. asset://·앱 내부 주소는 남기지 않는다.
 *     기반 폴더와 무관하다. 웹(http/https) 그림은 주소 그대로, 그 밖(상대·data:·file: 등)은 자리 표시.
 *     첨부가 아닌 그림의 data-rel-path(`../` 같은 위험한 경로 포함)는 지운다 — Rust 가 읽으려 들지 않게.
 * - 접기(details): 열린 상태로 — 정적 `<details>` 는 본문을 숨기지만 HWPX 로는 펼친 채 나간다.
 * - 링크 `links`:
 *   - `"strip"`(기본) — href 를 벗긴다. 미리보기 안에서 `note://` 등을 눌러 프레임이 어딘가로 가면 안 된다.
 *   - `"keep"` — http/https/mailto 만 남기고(exportableUrl) 나머지(note:·javascript:·data:·상대 주소)는 벗긴다.
 *   어느 쪽이든 target·rel 은 지운다(에디터가 붙인 새 창 열기 속성은 내보낸 문서의 일이 아니다).
 * - 섹션이 둘 이상이면 섹션 이름을 제목 문단으로 앞에 둔다(export_hwpx 가 하는 일과 같다).
 *
 * `<template>` 의 inert 한 조각 위에서 만져 그림이 이 단계에서 로드되지 않는다.
 */
export function renderPaperBody(
  sections: ReadonlyArray<Pick<ExportDocSection, "name" | "html">>,
  opts: {
    baseDir: string | null;
    convert: ((path: string) => string) | null;
    /** 섹션 이름을 제목으로 앞에 둘지. */
    showTitles: boolean;
    /** 자리 표시 문구(그림을 못 풀었을 때). */
    imageLabel: string;
    links?: "strip" | "keep";
    images?: "display" | "embed";
  },
): string {
  const keepLinks = opts.links === "keep";
  const embed = opts.images === "embed";
  let out = "";
  for (const s of sections) {
    if (opts.showTitles) {
      const h = document.createElement("h2");
      h.className = "sec-title";
      h.textContent = s.name;
      out += h.outerHTML;
    }
    const tpl = document.createElement("template");
    tpl.innerHTML = s.html;
    const frag = tpl.content;
    frag.querySelectorAll("img").forEach((img) => {
      const relPath = img.getAttribute("data-rel-path");
      const raw = img.getAttribute("src") ?? "";
      let src: string;
      if (embed) {
        if (isSafeRelPath(relPath)) {
          img.setAttribute("src", "");
          return;
        }
        img.removeAttribute("data-rel-path");
        src = exportableUrl(raw, WEB_IMAGE_PROTOCOLS) ?? "";
      } else {
        // 첨부 그림인데 기반 폴더가 아직 안 풀렸으면 원본 src(= 상대 경로)로 물러나지 않는다 — srcdoc 문서에서
        // 상대 경로는 아무 데도 가리키지 않아 깨진 그림이 된다. 풀리면 baseDir 이 바뀌어 다시 그려진다.
        const pending = isSafeRelPath(relPath) && !(opts.baseDir && opts.convert);
        src = pending ? "" : resolveImageDisplaySrc(relPath, raw, opts.baseDir, opts.convert);
      }
      if (src) {
        img.setAttribute("src", src);
        // 미리보기만 — 보이는 그림부터 받는다(수백 장을 한꺼번에 싣지 않는다). 인쇄는 직전에 전부 eager 로 바꿔 기다린다(ExportModal).
        if (!embed) {
          img.setAttribute("loading", "lazy");
          img.setAttribute("decoding", "async");
        }
        return;
      }
      const ph = document.createElement("span");
      ph.className = "img-ph";
      ph.textContent = `[${img.getAttribute("alt") || opts.imageLabel}]`;
      img.replaceWith(ph);
    });
    frag.querySelectorAll("details").forEach((d) => d.setAttribute("open", ""));
    if (embed) {
      // 앱 밖으로 나가는 출력(HTML 파일·서식 복사)에는 각주·날짜 표시의 내부 id(첨부 uuid 등)를 남기지 않는다 — 글자만 둔다.
      frag.querySelectorAll("span[data-footnote], span[data-date]").forEach((el) => el.replaceWith(...Array.from(el.childNodes)));
    }
    frag.querySelectorAll("a").forEach((a) => {
      const href = keepLinks ? exportableUrl(a.getAttribute("href"), LINK_PROTOCOLS) : null;
      if (href) a.setAttribute("href", href);
      else a.removeAttribute("href");
      a.removeAttribute("target");
      a.removeAttribute("rel");
    });
    const holder = document.createElement("div");
    holder.appendChild(frag);
    out += holder.innerHTML;
  }
  return out;
}
