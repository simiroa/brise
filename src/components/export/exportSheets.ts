/**
 * 시트 섹션 → 내보내기 문서(ProseMirror 표 JSON). (PLAN-2026-10-07-doc-import-export §3.1 W6 — 유즈케이스 5)
 *
 * 예산표·견적서를 보고서와 함께 HWPX·DOCX·인쇄·HTML 로 내보낼 때 시트는 **계산된 값** 표로 들어간다.
 * 값은 시트 화면에 보이는 그대로다 — SheetGrid · SheetPreview 와 같은 엔진(SheetEngine)의 계산값을 같은
 * formatCell 로 글자로 만든다. `projection.toMarkdownTable` 은 cell.raw(수식 텍스트)를 쓰므로 여기선 쓰지 않는다.
 * 수식 오류는 표시 문자열(#DIV/0! 등) 그대로, 체크박스 열은 ☑/☐ 글자.
 *
 * - 1행 = 머리글(specs/features/sheet.md 서식 결정) → tableHeader, 나머지는 tableCell.
 * - 정렬도 그리드 규칙 그대로: 숫자·통화·백분율 열은 오른쪽.
 * - 여러 줄 값(Alt+Enter 로 넣은 개행)은 줄바꿈(hardBreak) — 그리드가 수식 아닌 값에만 줄바꿈을 보이는 것과 같다.
 * - 열 너비(colwidth)는 넣지 않는다 — 50열 × 기본 100px 이면 종이 미리보기의 표가 종이 밖으로 밀려난다.
 *   작성기(doc_export pm.rs column_widths)는 모르는 열을 균등 분배한다.
 *
 * 이 파일은 JSON 만 만든다. HTML 은 부르는 쪽(exportDoc.ts)이 텍스트 섹션과 같은 헤드리스 TipTap 한 번으로 뽑는다.
 */
import type { JSONContent } from "@tiptap/core";
import { SheetEngine } from "../../lib/sheet/engine";
import { formatCell } from "../../lib/sheet/format";
import { parseRef, refKey } from "../../lib/sheet/a1";
import type { SheetDoc } from "../../lib/sheet/types";

/**
 * 내보내는 표 크기 상한. 시트 자체 상한(1000행 × 52열, SHEET_LIMITS)보다 작다:
 * - 열: DOCX 한 행 63칸(Word 한계, doc_export/docx.rs MAX_TABLE_COLS) · 표 열 200(pm.rs MAX_COLS) 안. A4 에 50열도
 *   이미 읽기 어려운 폭이지만 잘라 내는 쪽이 값을 조용히 버리는 것보다 낫다 — 잘린 만큼은 표 아래 한 줄로 알린다.
 * - 행: 500 × 50 = 25,000칸 ≈ 노드 7.5만(칸 · 문단 · 글자) — doc_export Budget(노드 100만 · 깊이 48) · 표 격자 20만 칸 안.
 */
export const SHEET_EXPORT_MAX_ROWS = 500;
export const SHEET_EXPORT_MAX_COLS = 50;

/** 잘린 시트의 크기 — 표 아래 안내 문구(UI 가 i18n 으로 만든다)의 재료. */
export interface SheetTruncation {
  /** 표에 넣지 못한 행·열 수(그 축이 안 잘렸으면 0). */
  moreRows: number;
  moreCols: number;
  /** 표에 넣은 행·열 수. */
  shownRows: number;
  shownCols: number;
}

/**
 * 값이 든 범위 — A1 부터 공백 아닌 raw 가 있는 마지막 행·열까지(projection.ts grid() 와 같은 "A1 기준 사용 범위").
 * 선언된 rows/cols(기본 100 × 26)가 아니다 — 그걸 쓰면 빈 시트도 100 × 26 짜리 빈 표가 된다.
 * 다만 그리드가 그리는 범위(doc.rows × doc.cols.length) 밖의 셀은 화면에 없으니 넣지 않는다.
 */
export function sheetUsedRange(doc: SheetDoc): { rows: number; cols: number } {
  let rows = 0;
  let cols = 0;
  for (const [key, cell] of Object.entries(doc.cells)) {
    if (typeof cell?.raw !== "string" || cell.raw.trim() === "") continue;
    const ref = parseRef(key);
    if (!ref || ref.row >= doc.rows || ref.col >= doc.cols.length) continue;
    rows = Math.max(rows, ref.row + 1);
    cols = Math.max(cols, ref.col + 1);
  }
  return { rows, cols };
}

type Align = "left" | "right";

function cellNode(type: "tableHeader" | "tableCell", text: string, align: Align, multiline: boolean): JSONContent {
  const para: JSONContent = { type: "paragraph" };
  if (align === "right") para.attrs = { textAlign: "right" };
  // 빈 글자 노드는 ProseMirror 가 거부한다 — 빈 칸은 내용 없는 문단.
  const content: JSONContent[] = [];
  const lines = multiline ? text.split(/\r\n?|\n/) : [text.replace(/[\r\n]+/g, " ")];
  lines.forEach((line, i) => {
    if (i > 0) content.push({ type: "hardBreak" });
    if (line) content.push({ type: "text", text: line });
  });
  if (content.length) para.content = content;
  return { type, content: [para] };
}

/**
 * 시트 문서 → 표 한 개(+ 잘렸으면 안내 문단)인 ProseMirror 문서. 값이 든 칸이 없으면 null(빈 시트는 건너뛴다).
 * `truncatedLabel` 은 잘렸을 때만 불린다 — 문구는 부르는 쪽이 i18n 으로 만든다(이 파일은 센 것만 안다).
 */
export function sheetToTableDoc(
  sheet: SheetDoc,
  truncatedLabel: (cut: SheetTruncation) => string,
): JSONContent | null {
  const used = sheetUsedRange(sheet);
  if (used.rows === 0 || used.cols === 0) return null;
  const shownRows = Math.min(used.rows, SHEET_EXPORT_MAX_ROWS);
  const shownCols = Math.min(used.cols, SHEET_EXPORT_MAX_COLS);

  const engine = new SheetEngine(sheet);
  const rows: JSONContent[] = [];
  for (let r = 0; r < shownRows; r++) {
    const cells: JSONContent[] = [];
    for (let c = 0; c < shownCols; c++) {
      const a1 = refKey(c, r);
      // 그리드(SheetGrid · SheetPreview)와 같은 호출: **열** 서식만, 로케일 없이(formatCell 기본 ko).
      // ponytail: 스키마의 셀 단위 fmt 오버라이드는 그리드가 아직 안 읽는다 — 화면과 같게 여기서도 안 읽는다.
      // 그리드가 셀 fmt 를 읽게 되면 두 곳을 같은 도우미로 묶는다.
      const col = sheet.cols[c];
      const fmt = col?.fmt ?? "text";
      // 하나만 그리드와 다르다: 체크박스 열의 **머리글** 칸. 그리드는 1행에도 체크박스를 그려 머리글 글자("완료")가
      // ☐ 로 사라지는데, 내보낸 표에서 1행은 머리글이라 글자 그대로 둔다(다른 서식은 숫자가 아닌 글자를 원문대로 둔다).
      const cellFmt = r === 0 && fmt === "checkbox" ? "text" : fmt;
      const text = formatCell(engine.getValue(a1), cellFmt, { dp: col?.dp, cur: col?.cur });
      const raw = engine.getRaw(a1);
      const multiline = !!raw && !raw.startsWith("=") && raw.includes("\n");
      const align: Align = fmt === "number" || fmt === "currency" || fmt === "percent" ? "right" : "left";
      cells.push(cellNode(r === 0 ? "tableHeader" : "tableCell", text, align, multiline));
    }
    rows.push({ type: "tableRow", content: cells });
  }

  const content: JSONContent[] = [{ type: "table", content: rows }];
  if (shownRows < used.rows || shownCols < used.cols) {
    const label = truncatedLabel({
      moreRows: used.rows - shownRows,
      moreCols: used.cols - shownCols,
      shownRows,
      shownCols,
    });
    content.push(label ? { type: "paragraph", content: [{ type: "text", text: label }] } : { type: "paragraph" });
  }
  return { type: "doc", content };
}
