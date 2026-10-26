import { beforeEach, describe, expect, it, vi } from "vitest";

const callOrder: string[] = [];
const callMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => {
    callOrder.push(`call:${String(args[0])}`);
    return callMock(...args);
  },
  callSilent: (...args: unknown[]) => callMock(...args),
  flushAll: async () => {
    callOrder.push("flushAll");
  },
  emitNotice: vi.fn(),
  registerFlush: () => () => {},
}));
const yieldFrameMock = vi.fn(async () => {});
vi.mock("../../lib/yieldFrame", () => ({ yieldFrame: () => yieldFrameMock() }));
const createEditorSpy = vi.fn();
vi.mock("../../lib/mdSerialize", async (orig) => {
  const actual = await orig<typeof import("../../lib/mdSerialize")>();
  return {
    ...actual,
    createMarkdownEditor: (...a: Parameters<typeof actual.createMarkdownEditor>) => {
      createEditorSpy();
      return actual.createMarkdownEditor(...a);
    },
  };
});
const reportFallbackMock = vi.fn();
vi.mock("../../lib/diag", async (orig) => ({
  ...(await orig<typeof import("../../lib/diag")>()),
  reportFallback: (...a: unknown[]) => reportFallbackMock(...a),
}));

import {
  exportDifferences,
  exportFileSlug,
  loadExportDocs,
  prepareExport,
  renderPaperBody,
  type ExportDocs,
  type ExportDocSection,
} from "./exportDoc";
import { buildPaperSrcDoc, pageInsetMm, paperViewHeight, paperViewWidth, paperZoom, printCss } from "./exportPaper";

// ── 손으로 짠 ProseMirror JSON — 센 결과를 정확히 알 수 있게 ────────────────────────────
const text = (t: string, marks?: { type: string; attrs?: Record<string, unknown> }[]) => ({ type: "text", text: t, marks });
const para = (content: unknown[], attrs: Record<string, unknown> = {}) => ({
  type: "paragraph",
  attrs: { textAlign: "left", indent: 0, ...attrs },
  content,
});
const doc = (...content: unknown[]) => ({ type: "doc", content });

// HWPX · DOCX 는 같은 규칙 표를 쓴다(글꼴 문구만 UI 가 형식으로 고른다) — 같은 기대값을 두 형식에 돌린다.
describe.each(["hwpx", "docx"] as const)("exportDifferences — %s", (format) => {
  it("counts task items, details, date/footnote marks, tables, and always lists the font", () => {
    const d = doc(
      { type: "taskList", content: [
        { type: "taskItem", attrs: { checked: false }, content: [para([text("a")])] },
        { type: "taskItem", attrs: { checked: true }, content: [para([text("b")])] },
        { type: "taskItem", attrs: { checked: false }, content: [para([text("c")])] },
      ] },
      { type: "details", content: [{ type: "detailsSummary" }, { type: "detailsContent", content: [para([])] }] },
      { type: "details", content: [] },
      para([text("오늘", [{ type: "date", attrs: { id: "d1" } }]), text("각주", [{ type: "footnote", attrs: { id: "f1" } }])]),
      { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", attrs: { colspan: 1, rowspan: 1 }, content: [para([])] }] }] },
    );
    const diffs = exportDifferences([{ doc: d }], format);
    // 순서까지 — UI 는 이 순서대로 줄을 그린다. 0 인 항목(웹 그림·시트·관계도)은 목록에 없다.
    expect(diffs).toEqual([
      { id: "tasks", n: 3 },
      { id: "details", n: 2 },
      { id: "dates", n: 1 },
      { id: "footnotes", n: 1 },
      { id: "font", n: 0 },
      { id: "table_style", n: 1 },
    ]);
  });

  it("full row order with every line present: … remote images, sheets, then left-out diagrams", () => {
    const d = doc(
      { type: "taskList", content: [{ type: "taskItem", content: [] }] },
      { type: "details", content: [] },
      para([text("날짜", [{ type: "date", attrs: { id: "d" } }]), text("각주", [{ type: "footnote", attrs: { id: "f" } }])]),
      { type: "table", content: [] },
      para([{ type: "image", attrs: { src: "https://x.test/a.png", relPath: null } }]),
    );
    const sheetDoc = doc({ type: "table", content: [] }, { type: "table", content: [] });
    expect(exportDifferences([{ doc: d, kind: "text" }, { doc: sheetDoc, kind: "sheet" }], format, { excluded: 2 })).toEqual([
      { id: "tasks", n: 1 },
      { id: "details", n: 1 },
      { id: "dates", n: 1 },
      { id: "footnotes", n: 1 },
      { id: "font", n: 0 },
      // 시트의 표는 table_style 에 들지 않는다 — sheets 로 따로
      { id: "table_style", n: 1 },
      { id: "remote_images", n: 1 },
      { id: "sheets", n: 1 },
      { id: "excluded", n: 2 },
    ]);
  });

  it("counts a date/footnote once per id even when it spans several text nodes or repeats", () => {
    const f = { type: "footnote", attrs: { id: "f1" } };
    const d = doc(
      para([text("반은 ", [f]), text("굵게", [{ type: "bold" }, f]), text(" 그리고 다시", [f])]),
      para([text("둘째 각주", [{ type: "footnote", attrs: { id: "f2" } }])]),
      para([text("오", [{ type: "date", attrs: { id: "d1" } }]), text("늘", [{ type: "bold" }, { type: "date", attrs: { id: "d1" } }])]),
    );
    const byId = Object.fromEntries(exportDifferences([{ doc: d }], format).map((x) => [x.id, x.n]));
    expect(byId).toMatchObject({ footnotes: 2, dates: 1 });
  });

  it("an empty/plain document still lists only the font line (never an empty list)", () => {
    const diffs = exportDifferences([{ doc: doc(para([text("그냥 글")])) }], format);
    expect(diffs).toEqual([{ id: "font", n: 0 }]);
  });

  it("adds excluded sections only when there are some, and sums across several sections", () => {
    const sections = [
      { doc: doc({ type: "taskList", content: [{ type: "taskItem", content: [] }] }) },
      { doc: doc({ type: "taskList", content: [{ type: "taskItem", content: [] }, { type: "taskItem", content: [] }] }) },
    ];
    const diffs = exportDifferences(sections, format, { excluded: 2 });
    expect(diffs.find((x) => x.id === "tasks")?.n).toBe(3);
    expect(diffs.find((x) => x.id === "excluded")?.n).toBe(2);
    expect(exportDifferences(sections, format, { excluded: 0 }).some((x) => x.id === "excluded")).toBe(false);
  });

  it("counts images that are not attachment files (web URLs) as ones that can't be included", () => {
    const d = doc(
      para([{ type: "image", attrs: { src: "https://x.test/a.png", relPath: null } }]),
      para([{ type: "image", attrs: { src: "n1/a.png", relPath: "n1/a.png" } }]),
      para([{ type: "image", attrs: { src: "../escape.png", relPath: "../escape.png" } }]),
    );
    expect(exportDifferences([{ doc: d }], format).find((x) => x.id === "remote_images")?.n).toBe(2);
  });

  it("DOCX and HWPX produce the very same list for any document (only the UI's font wording differs)", () => {
    const d = doc(
      { type: "taskList", content: [{ type: "taskItem", content: [] }] },
      { type: "details", content: [] },
      para([text("날짜", [{ type: "date", attrs: { id: "d" } }])]),
      { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", attrs: { colspan: 1, rowspan: 1 }, content: [para([])] }] }] },
      para([{ type: "image", attrs: { src: "https://x.test/a.png", relPath: null } }]),
    );
    expect(exportDifferences([{ doc: d }], "docx", { excluded: 1 })).toEqual(
      exportDifferences([{ doc: d }], "hwpx", { excluded: 1 }),
    );
  });
});

// html(파일) · copy(서식 복사) — 웹 그림은 웹에서 보이고, 글꼴·표 모양은 그대로라 둘 다 그 줄이 없다. 접기만 갈린다:
// 파일은 진짜 접기(<details>)로 남지만, 붙여넣는 곳에는 접기가 없어 서식 복사는 펼친 내용으로 나간다(exportHtml flattenDetails).
describe("exportDifferences — html · copy", () => {
  const d = doc(
    { type: "taskList", content: [{ type: "taskItem", content: [] }, { type: "taskItem", content: [] }] },
    { type: "details", content: [] },
    para([text("날짜", [{ type: "date", attrs: { id: "d" } }]), text("각주", [{ type: "footnote", attrs: { id: "f" } }])]),
    { type: "table", content: [] },
    para([{ type: "image", attrs: { src: "https://x.test/a.png", relPath: null } }]),
    para([text("빨강", [{ type: "textStyle", attrs: { color: "#f00" } }])], { textAlign: "center" }),
  );
  const sections = [{ doc: d }, { doc: doc(), kind: "sheet" as const }];

  it("html lists tasks, dates, footnotes, sheets and left-out diagrams — folds stay folds", () => {
    expect(exportDifferences(sections, "html", { excluded: 3 })).toEqual([
      { id: "tasks", n: 2 },
      { id: "dates", n: 1 },
      { id: "footnotes", n: 1 },
      { id: "sheets", n: 1 },
      { id: "excluded", n: 3 },
    ]);
  });

  // 결함 재현(W6 검증 V2): 서식 복사는 접기를 펼쳐 붙이는데(접기 0개) 목록에 그 줄이 없어 "접기가 남는다"고 읽혔다.
  it("copy also lists folds — the pasted fragment has them expanded", () => {
    expect(exportDifferences(sections, "copy", { excluded: 3 })).toEqual([
      { id: "tasks", n: 2 },
      { id: "details", n: 1 },
      { id: "dates", n: 1 },
      { id: "footnotes", n: 1 },
      { id: "sheets", n: 1 },
      { id: "excluded", n: 3 },
    ]);
  });

  it.each(["html", "copy"] as const)("%s: nothing to list for plain text", (format) => {
    expect(exportDifferences([{ doc: doc(para([text("x")])) }], format)).toEqual([]);
  });
});

describe("printCss / buildPaperSrcDoc", () => {
  it("prints the paper at real size: @page size and margins, screen zoom/width/padding undone, browser header off, page numbers on", () => {
    const html = buildPaperSrcDoc("<p>본문</p>", "a4-landscape", "hwpx", "이력서 <초안> & \"최종\"");
    expect(html).toContain("size: 297mm 210mm;");
    // HWPX 보통 = 한글 기본 용지의 본문 자리(위 20+머리말 15 · 좌우 30 · 아래 15+꼬리말 15)
    expect(html).toContain("margin: 35mm 30mm 30mm;");
    expect(html).toContain("zoom: 1 !important;");
    expect(html).toContain("width: auto !important;");
    expect(html).toContain("padding: 0 !important;");
    expect(html).toContain('@top-center {\n    content: "";');
    expect(html).toContain('content: counter(page) " / " counter(pages);');
    expect(html).toContain("print-color-adjust: exact;");
    // 화면용 종이(인라인 style)는 그대로 — 인쇄 CSS 는 @media print 안에서만 덮는다
    expect(html).toContain("width:297mm;padding:35mm 30mm 30mm;");
    expect(html).toContain("<title>이력서 &lt;초안&gt; &amp; &quot;최종&quot;</title>");
    expect(printCss("a4-portrait")).toContain("size: 210mm 297mm;");
    expect(printCss("a4-portrait")).toContain("margin: 20mm 25mm 15mm;");
  });

  // 오너 요청(2026-10-16): 크기·여백이 미리보기·인쇄·파일에 같이 간다. 값은 Rust hwpx.rs / docx.rs margins 와 같다.
  it("paper size and margin presets reach both the screen paper and the print page, per format", () => {
    const b5 = buildPaperSrcDoc("<p>x</p>", "b5-portrait", "docx", "t", "narrow");
    expect(b5).toContain("size: 182mm 257mm;");
    expect(b5).toContain("margin: 12.7mm 12.7mm 12.7mm;");
    expect(b5).toContain("width:182mm;padding:12.7mm 12.7mm 12.7mm;");
    const letter = buildPaperSrcDoc("<p>x</p>", "letter-landscape", "docx", "t", "wide");
    expect(letter).toContain("size: 279.4mm 215.9mm;");
    expect(letter).toContain("margin: 25.4mm 50.8mm 25.4mm;"); /* type-scale-exempt: 종이 여백(mm) 문서 데이터 */
    expect(pageInsetMm("normal", "docx")).toEqual([25.4, 25.4, 25.4]);
    expect(pageInsetMm("wide", "hwpx")).toEqual([35, 50.8, 30]);
    // 창 크기는 방향으로 폭을 정하고 높이는 그 종이 비율 — zoom 은 종이 실제 폭을 창 폭에 맞춘다
    expect(paperViewWidth("b5-portrait")).toBe(540);
    expect(paperViewHeight("b5-portrait")).toBe(Math.round((540 * 257) / 182));
    expect(paperViewWidth("letter-landscape")).toBe(640);
    expect(paperZoom("a4-portrait")).toBeLessThanOrEqual(540 / ((210 * 96) / 25.4));
  });
});

describe("exportDifferences — Markdown", () => {
  it("Markdown: counts color, alignment/indent, merged or shaded cells, date/footnote marks as formatting kept as HTML", () => {
    const d = doc(
      para([text("빨강", [{ type: "textStyle", attrs: { color: "#f00" } }])]),
      para([text("가운데")], { textAlign: "center" }),
      para([text("들여쓰기")], { indent: 2 }),
      { type: "table", content: [{ type: "tableRow", content: [
        { type: "tableCell", attrs: { colspan: 2, rowspan: 1 }, content: [para([])] },
        { type: "tableCell", attrs: { colspan: 1, rowspan: 1, backgroundColor: "rgb(255, 255, 0)" }, content: [para([])] },
      ] }] },
      para([text("날짜", [{ type: "date", attrs: { id: "d" } }])]),
    );
    expect(exportDifferences([{ doc: d }], "md")).toEqual([{ id: "rich_format", n: 6 }]);
  });

  it("Markdown: a plain document has nothing to report (the modal then says it goes out as is)", () => {
    const d = doc(para([text("그냥")], { textAlign: "left", indent: 0 }), { type: "heading", attrs: { level: 1, textAlign: "left", indent: 0 }, content: [] });
    expect(exportDifferences([{ doc: d }], "md")).toEqual([]);
    // textStyle without a color is not formatting
    expect(exportDifferences([{ doc: doc(para([text("x", [{ type: "textStyle", attrs: { color: null } }])])) }], "md")).toEqual([]);
  });

  // 결함 재현(W6 검증 V3): Markdown 은 Rust 가 시트를 칸에 적힌 그대로(수식 `=SUM(…)` 포함) 표로 쓰는데, 목록이 비어 있어
  // 미리보기의 계산 값이 파일에 들어가는 줄 알게 했다. 시트는 서식으로 훑지 않고 개수만 sheets 로 센다.
  it("Markdown: sheet sections are counted as sheets (written as typed), not scanned for formatting", () => {
    const sheetDoc = doc(para([text("가운데")], { textAlign: "right" }));
    expect(exportDifferences([{ doc: sheetDoc, kind: "sheet" }], "md")).toEqual([{ id: "sheets", n: 1 }]);
    const colored = doc(para([text("빨강", [{ type: "textStyle", attrs: { color: "#f00" } }])]));
    expect(exportDifferences([{ doc: colored }, { doc: sheetDoc, kind: "sheet" }], "md")).toEqual([
      { id: "rich_format", n: 1 },
      { id: "sheets", n: 1 },
    ]);
  });
});

describe("exportFileSlug", () => {
  it("replaces characters that cannot be in a file name and falls back when empty", () => {
    expect(exportFileSlug('a/b:c*d?"e<f>g|h\\i', "x")).toBe("a_b_c_d__e_f_g_h_i");
    expect(exportFileSlug("   ", "제목 없음")).toBe("제목 없음");
    expect(exportFileSlug("이력서", "x")).toBe("이력서");
  });
});

describe("loadExportDocs", () => {
  beforeEach(() => {
    callOrder.length = 0;
    callMock.mockReset();
    reportFallbackMock.mockReset();
  });

  const detail = (sections: unknown[]) => ({ note: { id: "n1", title: "T" }, sections, sources: [], attachments: [] });
  const sheetBody = (cells: Record<string, string>, cols: unknown[] = []) =>
    JSON.stringify({ v: 1, rows: 100, cols: [...cols, ...Array.from({ length: 26 - cols.length }, () => ({}))], cells: Object.fromEntries(Object.entries(cells).map(([k, raw]) => [k, { raw }])), charts: [] });

  it("flushes pending saves BEFORE note_get, keeps text and sheet sections in position order, counts diagrams as excluded", async () => {
    callMock.mockResolvedValue(
      detail([
        { id: "b", name: "둘째", body_md: "- [ ] 할 일", position: 1, kind: "text" },
        { id: "s", name: "표", body_md: sheetBody({ A1: "항목", A2: "=1+1" }), position: 2, kind: "sheet" },
        { id: "a", name: "첫째", body_md: "# 제목\n\n본문", position: 0, kind: "text" },
        { id: "d", name: "관계도", body_md: "{}", position: 3, kind: "diagram" },
      ]),
    );
    const docs = await loadExportDocs("n1");

    expect(callOrder).toEqual(["flushAll", "call:note_get"]);
    expect(callMock).toHaveBeenCalledWith("note_get", { id: "n1" });
    expect(docs.sections.map((s) => [s.id, s.kind])).toEqual([["a", "text"], ["b", "text"], ["s", "sheet"]]);
    expect(docs.excluded).toBe(1);
    expect(docs.footnotes).toEqual({});
    // 같은 파서에서 JSON 과 HTML 이 함께 나온다.
    expect(docs.sections[0].html).toContain("<h1>제목</h1>");
    expect(JSON.stringify(docs.sections[1].doc)).toContain("taskItem");
    expect(docs.sections[1].html).toContain('data-type="taskItem"');
  });

  it("a sheet section opens as a value table through the same schema — header row th, computed value, no formula text", async () => {
    callMock.mockResolvedValue(
      detail([{ id: "s", name: "예산", body_md: sheetBody({ A1: "항목", B1: "금액", A2: "합", B2: "=2*3" }, [{}, { fmt: "number" }]), position: 0, kind: "sheet" }]),
    );
    const [s] = (await loadExportDocs("n1")).sections;
    const json = JSON.stringify(s.doc);
    // 스키마를 지나며 표가 조용히 버려지지 않았다
    expect(json).toContain('"type":"table"');
    expect(json).toContain('"type":"tableHeader"');
    expect(json).not.toContain("=2*3");
    expect(s.html).toContain("<table");
    expect(s.html).toMatch(/<th[^>]*>.*항목/);
    expect(s.html).toMatch(/<td[^>]*><p[^>]*text-align: right[^>]*>6<\/p><\/td>/);
  });

  describe("progress and cancellation (E-1)", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, name: `섹션${i}`, body_md: `본문 ${i}`, position: i, kind: "text" }));
    beforeEach(() => {
      yieldFrameMock.mockClear();
      createEditorSpy.mockClear();
    });

    it("reports (i, n) for each of 20 text sections and yields a frame before opening each one", async () => {
      callMock.mockResolvedValue(detail(twenty));
      const seen: [number, number][] = [];
      const docs = await loadExportDocs("n1", { onProgress: (i, n) => seen.push([i, n]) });
      expect(seen).toEqual(twenty.map((_, i) => [i + 1, 20]));
      expect(yieldFrameMock).toHaveBeenCalledTimes(20);
      expect(createEditorSpy).toHaveBeenCalledTimes(20);
      expect(docs.sections).toHaveLength(20);
    });

    it("stops opening sections once cancelled (after 5) and returns nothing usable", async () => {
      callMock.mockResolvedValue(detail(twenty));
      let calls = 0;
      const docs = await loadExportDocs("n1", { onProgress: () => (calls += 1), isCancelled: () => calls > 5 });
      expect(createEditorSpy).toHaveBeenCalledTimes(5);
      expect(calls).toBe(6);
      expect(docs).toEqual({ sections: [], excluded: 0, footnotes: {} });
    });
  });

  it("skips empty sheets silently and records an unreadable sheet body", async () => {
    callMock.mockResolvedValue(
      detail([
        { id: "e1", name: "빈", body_md: "{}", position: 0, kind: "sheet" },
        { id: "e2", name: "빈2", body_md: "", position: 1, kind: "sheet" },
        { id: "e3", name: "칸만", body_md: sheetBody({ A1: "  " }), position: 2, kind: "sheet" },
        { id: "bad", name: "깨짐", body_md: "not json", position: 3, kind: "sheet" },
      ]),
    );
    const docs = await loadExportDocs("n1");
    expect(docs.sections).toEqual([]);
    expect(docs.excluded).toBe(0);
    expect(reportFallbackMock).toHaveBeenCalledTimes(1);
    expect(reportFallbackMock.mock.calls[0].slice(0, 2)).toEqual(["export", "sheet_parse_failed"]);
  });

  it("reads the body of every footnote marked in the text sections (once per id); a failed read is recorded, not thrown", async () => {
    callMock.mockImplementation(async (cmd: string, args: { id: string }) => {
      if (cmd === "note_get") {
        return detail([
          { id: "a", name: "가", body_md: '<span data-footnote="f1">서울</span> 출장 <span data-footnote="f2">부산</span>', position: 0, kind: "text" },
          { id: "b", name: "나", body_md: '다시 <span data-footnote="f1">서울</span>', position: 1, kind: "text" },
        ]);
      }
      if (cmd === "attachment_read_text" && args.id === "f1") return { text: "**본사** 주소", truncated: false };
      throw { code: "NOT_FOUND", message: "gone" };
    });
    const docs = await loadExportDocs("n1");
    expect(docs.footnotes).toEqual({ f1: "본사 주소" });
    const reads = callMock.mock.calls.filter((c) => c[0] === "attachment_read_text").map((c) => c[1]);
    expect(reads).toEqual([{ id: "f1" }, { id: "f2" }]);
    expect(reportFallbackMock.mock.calls.map((c) => c[1])).toEqual(["footnote_read_failed"]);
  });

  it("propagates a note_get failure (call() has already toasted it)", async () => {
    callMock.mockRejectedValue({ code: "NOT_FOUND", message: "x" });
    await expect(loadExportDocs("n1")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("prepareExport", () => {
  beforeEach(() => {
    callOrder.length = 0;
    callMock.mockReset();
  });

  async function load(sections: { id: string; body_md: string; kind?: string }[], bodies: Record<string, string>): Promise<ExportDocs> {
    callMock.mockImplementation(async (cmd: string, args: { id: string }) => {
      if (cmd === "note_get") {
        return { note: { id: "n1" }, sections: sections.map((s, i) => ({ name: s.id, position: i, kind: "text", ...s })), sources: [], attachments: [] };
      }
      if (args.id in bodies) return { text: bodies[args.id], truncated: false };
      throw { code: "NOT_FOUND", message: "x" };
    });
    return loadExportDocs("n1");
  }

  it("numbers footnotes across the picked sections in order of first appearance and lists them at the end — in doc AND html", async () => {
    const docs = await load(
      [
        { id: "a", body_md: '<span data-footnote="f2">둘째 먼저</span> 그리고 <span data-footnote="f1">첫째</span>' },
        { id: "b", body_md: '다시 <span data-footnote="f2">둘째</span>' },
      ],
      { f1: "일 본문", f2: "이 본문" },
    );
    const before = JSON.stringify(docs);
    const out = prepareExport(docs.sections, docs, { footnoteHeading: "각주" });

    expect(out[0].html).toContain("둘째 먼저</span>[1] 그리고");
    expect(out[0].html).toContain("첫째</span>[2]");
    expect(out[0].html).not.toContain("<h3>");
    expect(out[1].html).toContain("둘째</span>[1]");
    expect(out[1].html).toContain("<h3>각주</h3><p>[1] 이 본문</p><p>[2] 일 본문</p>");
    // 파일로 가는 JSON 도 같은 내용
    expect(JSON.stringify(out[1].doc)).toContain('"text":"[2] 일 본문"');
    expect(JSON.stringify(out[1].doc)).toContain('"level":3');
    // 원본은 그대로, kind·id·name 은 유지
    expect(JSON.stringify(docs)).toBe(before);
    expect(out.map((s) => [s.id, s.kind])).toEqual([["a", "text"], ["b", "text"]]);
  });

  it("only the picked section: numbering starts over inside it and the list is at its end", async () => {
    const docs = await load(
      [
        { id: "a", body_md: '<span data-footnote="f1">앞</span>' },
        { id: "b", body_md: '<span data-footnote="f2">뒤</span>' },
      ],
      { f1: "하나", f2: "둘" },
    );
    const [b] = prepareExport(docs.sections.filter((s) => s.id === "b"), docs, { footnoteHeading: "Notes" });
    expect(b.html).toContain("뒤</span>[1]");
    expect(b.html).toContain("<h3>Notes</h3><p>[1] 둘</p>");
    expect(b.html).not.toContain("하나");
  });

  it("returns the very same array when there are no footnotes (stable for memo), and leaves untouched sections as the same objects", async () => {
    const docs = await load([{ id: "a", body_md: "그냥 글" }, { id: "b", body_md: '<span data-footnote="f">x</span>' }, { id: "c", body_md: "끝 아님" }], { f: "본문" });
    const onlyPlain = docs.sections.filter((s) => s.id === "a");
    expect(prepareExport(onlyPlain, docs, { footnoteHeading: "각주" })).toBe(onlyPlain);
    const twoPicked = docs.sections.filter((s) => s.id !== "c");
    const out = prepareExport(twoPicked, docs, { footnoteHeading: "각주" });
    expect(out[0]).toBe(twoPicked[0]);
    expect(out[1]).not.toBe(twoPicked[1]);
  });

  it("a footnoted span with a line break in it (body_md <br>) gets one marker, not one per piece", async () => {
    const docs = await load([{ id: "a", body_md: '<span data-footnote="f">서울<br>본사</span> 끝' }], { f: "본문" });
    const [a] = prepareExport(docs.sections, docs, { footnoteHeading: "각주" });
    expect(a.html.match(/\[1\]/g)).toHaveLength(2); // 본문 표지 하나 + 끝 목록 하나
    expect(a.html).toMatch(/본사<\/span>\[1\] 끝/);
  });

  it("a footnote whose body could not be read still gets [n] in the text and an entry with no body", async () => {
    const docs = await load([{ id: "a", body_md: '<span data-footnote="gone">없는 각주</span>' }], {});
    const [a] = prepareExport(docs.sections, docs, { footnoteHeading: "각주" });
    expect(a.html).toContain("없는 각주</span>[1]");
    expect(a.html).toContain("<h3>각주</h3><p>[1]</p>");
  });
});

describe("renderPaperBody", () => {
  const sec = (name: string, html: string): Pick<ExportDocSection, "name" | "html"> => ({ name, html });
  const opts = { baseDir: "C:/att", convert: (p: string) => `asset://${p}`, showTitles: false, imageLabel: "그림" };

  it("resolves attachment images through the editor's own rule (base dir + convert) and keeps width styling", () => {
    const html = '<p><img src="n1/a.png" alt="a" data-rel-path="n1/a.png" style="width: 40%"></p>';
    const out = renderPaperBody([sec("s", html)], opts);
    expect(out).toContain('src="asset://C:/att/n1/a.png"');
    expect(out).toContain("width: 40%");
  });

  it("display mode loads preview images lazily; embed mode (file / clipboard) stays untouched", () => {
    const html = '<p><img src="n1/a.png" alt="a" data-rel-path="n1/a.png"></p>';
    const display = renderPaperBody([sec("s", html)], opts);
    expect(display).toContain('loading="lazy"');
    expect(display).toContain('decoding="async"');
    const embed = renderPaperBody([sec("s", html)], { ...opts, images: "embed" });
    expect(embed).not.toContain("loading=");
    expect(embed).not.toContain("decoding=");
  });

  it("leaves a placeholder (not a broken <img>) while the base dir is unresolved, and for unsafe paths", () => {
    const html =
      '<p><img src="n1/a.png" alt="사진" data-rel-path="n1/a.png"></p>' +
      '<p><img src="file:///etc/passwd" data-rel-path="../x.png"></p>';
    const out = renderPaperBody([sec("s", html)], { ...opts, baseDir: null, convert: null });
    expect(out).not.toContain("<img");
    expect(out).toContain("[사진]");
    expect(out).toContain("[그림]");
  });

  it("opens collapsed blocks and strips link targets so the frame can't navigate", () => {
    const html =
      '<details><summary>접기</summary><div data-type="detailsContent"><p>속</p></div></details>' +
      '<p><a href="note://abc" target="_blank" rel="noopener">링크</a></p>';
    const out = renderPaperBody([sec("s", html)], opts);
    expect(out).toContain("<details open");
    expect(out).not.toContain("href=");
    expect(out).not.toContain("note://");
    expect(out).toContain(">링크</a>");
  });

  it('links: "keep" leaves only http/https/mailto hrefs and strips everything else (case, whitespace and control-character tricks included)', () => {
    const links = [
      ["https://example.com/a?b=1", "https://example.com/a?b=1"],
      ["HTTP://Example.com", "http://example.com/"],
      ["  https://x.test/p  ", "https://x.test/p"],
      ["mailto:me@x.test", "mailto:me@x.test"],
      ["javascript:alert(1)", null],
      ["JAVASCRIPT:alert(1)", null],
      ["java\tscript:alert(1)", null],
      ["\u0001javascript:alert(1)", null],
      [" \njavascript:alert(1)", null],
      ["data:text/html,<b>x</b>", null],
      ["note://abc", null],
      ["note:abc", null],
      ["file:///C:/x.txt", null],
      ["relative/page.html", null],
      ["//evil.test/x", null],
      ["#anchor", null],
    ] as const;
    const html = links.map(([href], i) => `<p><a href="${href.replace(/"/g, "&quot;")}" target="_blank" rel="noopener">l${i}</a></p>`).join("");
    const out = renderPaperBody([sec("s", html)], { ...opts, links: "keep" });
    const tpl = document.createElement("template");
    tpl.innerHTML = out;
    const anchors = [...tpl.content.querySelectorAll("a")];
    expect(anchors).toHaveLength(links.length);
    anchors.forEach((a, i) => {
      expect([a.textContent, a.getAttribute("href")]).toEqual([`l${i}`, links[i][1]]);
      expect(a.hasAttribute("target")).toBe(false);
      expect(a.hasAttribute("rel")).toBe(false);
    });
    // 기본(strip)은 지금 그대로 — 전부 벗긴다
    expect(renderPaperBody([sec("s", html)], opts)).not.toContain("href=");
  });

  it('images: "embed" leaves attachment images as <img data-rel-path src=""> for Rust to fill — no asset URL, regardless of base dir', () => {
    const html =
      '<p><img src="n1/a.png" alt="사진" data-rel-path="n1/a.png" style="width: 40%"></p>' +
      '<p><img src="https://x.test/b.png" alt="웹"></p>' +
      '<p><img src="data:image/png;base64,AAAA" alt="데이터"></p>' +
      '<p><img src="file:///etc/passwd" data-rel-path="../x.png" alt="탈출"></p>' +
      '<p><img src="loose.png"></p>';
    for (const base of [opts, { ...opts, baseDir: null, convert: null }]) {
      const out = renderPaperBody([sec("s", html)], { ...base, images: "embed" });
      const tpl = document.createElement("template");
      tpl.innerHTML = out;
      const imgs = [...tpl.content.querySelectorAll("img")];
      expect(imgs.map((i) => [i.getAttribute("src"), i.getAttribute("data-rel-path"), i.getAttribute("alt")])).toEqual([
        ["", "n1/a.png", "사진"],
        ["https://x.test/b.png", null, "웹"],
      ]);
      expect(imgs[0].getAttribute("style")).toContain("width: 40%");
      expect(out).not.toContain("asset://");
      expect(out).not.toContain("../x.png");
      expect(out).not.toContain("data:image");
      expect([...tpl.content.querySelectorAll(".img-ph")].map((p) => p.textContent)).toEqual(["[데이터]", "[탈출]", "[그림]"]);
    }
  });

  it('images: "embed" (the output path) drops the internal ids of footnote and date marks but keeps their text', () => {
    const html = '<p>앞 <span data-footnote="0b5f-uuid"><strong>각주 글</strong></span> 과 <span data-date="d-1">10월 8일</span> 뒤</p>';
    const out = renderPaperBody([sec("s", html)], { ...opts, images: "embed" });
    expect(out).toBe("<p>앞 <strong>각주 글</strong> 과 10월 8일 뒤</p>");
    // 미리보기(display)는 그대로 둔다
    expect(renderPaperBody([sec("s", html)], opts)).toContain('data-footnote="0b5f-uuid"');
  });

  it("puts each section's name before it as a title only when asked (several sections)", () => {
    const sections = [sec("이력서 <1>", "<p>가</p>"), sec("자기소개", "<p>나</p>")];
    const withTitles = renderPaperBody(sections, { ...opts, showTitles: true });
    expect(withTitles).toContain('<h2 class="sec-title">이력서 &lt;1&gt;</h2><p>가</p>');
    expect(withTitles.indexOf("자기소개")).toBeLessThan(withTitles.indexOf("<p>나</p>"));
    expect(renderPaperBody(sections, opts)).not.toContain("sec-title");
  });
});
