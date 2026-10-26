import { describe, expect, it, vi } from "vitest";
import { recommendSheetAssists, SHEET_ASSISTS, type SheetAssistCtx, type SheetAssistOps } from "./assists";
import { emptySheet, type SheetDoc } from "./types";
import { SheetEngine } from "./engine";
import { t } from "../../i18n/t";

function noopOps(): SheetAssistOps {
  return {
    setCells: vi.fn(),
    setColFormat: vi.fn(),
    sortRange: vi.fn(),
    insertRow: vi.fn(),
    insertCol: vi.fn(),
    deleteRows: vi.fn(),
  };
}

function ctxOf(doc: SheetDoc, range: SheetAssistCtx["range"], ops: SheetAssistOps = noopOps()): SheetAssistCtx {
  return { doc, engine: new SheetEngine(doc), range, ops };
}

function defOf(id: string) {
  const def = SHEET_ASSISTS.find((d) => d.id === id);
  if (!def) throw new Error(`no such assist: ${id}`);
  return def;
}

describe("recommendSheetAssists", () => {
  it("숫자+텍스트 범위에서 sum_row 를 추천하고 적용하면 라벨과 SUM 수식을 1회 setCells 로 채운다", () => {
    const doc: SheetDoc = {
      ...emptySheet(),
      cells: {
        A1: { raw: "이름" },
        A2: { raw: "철수" },
        A3: { raw: "영희" },
        B1: { raw: "금액" },
        B2: { raw: "100" },
        B3: { raw: "200" },
      },
    };
    const range = { r1: 0, c1: 0, r2: 2, c2: 1 };
    expect(recommendSheetAssists(doc, range, new SheetEngine(doc))).toContain("sum_row");

    const ops = noopOps();
    defOf("sum_row").apply(ctxOf(doc, range, ops));
    expect(ops.setCells).toHaveBeenCalledTimes(1);
    expect(ops.setCells).toHaveBeenCalledWith({
      A4: { raw: t("presets.sheet_assist_label_sum") },
      B4: { raw: "=SUM(B2:B3)" },
    });
  });

  it("첫 행이 문자면 헤더로 빼고, 아래 행이 비어 있지 않으면 집계 행을 추천하지 않는다", () => {
    const doc: SheetDoc = {
      ...emptySheet(),
      cells: { A1: { raw: "이름" }, B1: { raw: "금액" }, B2: { raw: "100" } },
    };
    const range = { r1: 0, c1: 0, r2: 1, c2: 1 };
    expect(recommendSheetAssists(doc, range, new SheetEngine(doc))).toContain("sum_row");

    const blocked: SheetDoc = { ...doc, cells: { ...doc.cells, B3: { raw: "이미 있음" } } };
    expect(recommendSheetAssists(blocked, range, new SheetEngine(blocked))).not.toContain("sum_row");

    // 숫자 열이 없으면(텍스트만) 애초에 추천되지 않는다.
    const noNumbers: SheetDoc = { ...emptySheet(), cells: { A1: { raw: "이름" }, A2: { raw: "철수" } } };
    expect(recommendSheetAssists(noNumbers, { r1: 0, c1: 0, r2: 1, c2: 0 }, new SheetEngine(noNumbers))).not.toContain("sum_row");
  });

  it("통화/퍼센트 서식은 숫자만 있는 열에서 추천되고, 이미 그 서식이면 다시 권하지 않는다", () => {
    const doc: SheetDoc = {
      ...emptySheet(),
      cells: { A1: { raw: "10000" }, A2: { raw: "20000" } },
    };
    const range = { r1: 0, c1: 0, r2: 1, c2: 0 };
    const recommended = recommendSheetAssists(doc, range, new SheetEngine(doc));
    expect(recommended).toContain("fmt_currency");
    expect(recommended).toContain("fmt_percent");

    const alreadyCurrency: SheetDoc = { ...doc, cols: doc.cols.map((c, i) => (i === 0 ? { ...c, fmt: "currency" as const } : c)) };
    expect(recommendSheetAssists(alreadyCurrency, range, new SheetEngine(alreadyCurrency))).not.toContain("fmt_currency");
  });

  it("날짜 서식은 ISO/한국식 날짜 문자열 열에서만 추천된다", () => {
    const isoDates: SheetDoc = { ...emptySheet(), cells: { A1: { raw: "2026-01-01" }, A2: { raw: "2026-02-15" } } };
    const range = { r1: 0, c1: 0, r2: 1, c2: 0 };
    expect(recommendSheetAssists(isoDates, range, new SheetEngine(isoDates))).toContain("fmt_date");

    const dotDates: SheetDoc = { ...emptySheet(), cells: { A1: { raw: "2026.01.01" }, A2: { raw: "2026.02.15" } } };
    expect(recommendSheetAssists(dotDates, range, new SheetEngine(dotDates))).toContain("fmt_date");

    const notDates: SheetDoc = { ...emptySheet(), cells: { A1: { raw: "안녕" }, A2: { raw: "12345" } } };
    expect(recommendSheetAssists(notDates, range, new SheetEngine(notDates))).not.toContain("fmt_date");
  });

  it("체크박스 서식은 예/아니오·true/false 값 열에서만 추천되고, apply 는 setColFormat(colIdx,'checkbox')", () => {
    const doc: SheetDoc = { ...emptySheet(), cells: { A1: { raw: "예" }, A2: { raw: "아니오" }, A3: { raw: "TRUE" } } };
    const range = { r1: 0, c1: 0, r2: 2, c2: 0 };
    expect(recommendSheetAssists(doc, range, new SheetEngine(doc))).toContain("fmt_checkbox");

    const ops = noopOps();
    defOf("fmt_checkbox").apply(ctxOf(doc, range, ops));
    expect(ops.setColFormat).toHaveBeenCalledWith(0, "checkbox");

    const notCheckbox: SheetDoc = { ...emptySheet(), cells: { A1: { raw: "예" }, A2: { raw: "글쎄" } } };
    expect(recommendSheetAssists(notCheckbox, range, new SheetEngine(notCheckbox))).not.toContain("fmt_checkbox");
  });

  it("정렬은 선택 범위가 3행 이상일 때만 추천된다", () => {
    const doc: SheetDoc = { ...emptySheet(), cells: { A1: { raw: "3" }, A2: { raw: "1" }, A3: { raw: "2" } } };
    expect(recommendSheetAssists(doc, { r1: 0, c1: 0, r2: 1, c2: 0 }, new SheetEngine(doc))).not.toContain("sort_asc");
    const recommended = recommendSheetAssists(doc, { r1: 0, c1: 0, r2: 2, c2: 0 }, new SheetEngine(doc));
    expect(recommended).toContain("sort_asc");
    expect(recommended).toContain("sort_desc");

    const ops = noopOps();
    defOf("sort_desc").apply(ctxOf(doc, { r1: 0, c1: 0, r2: 2, c2: 0 }, ops));
    expect(ops.sortRange).toHaveBeenCalledWith(0, true);
  });

  it("추천이 없으면 빈 목록 — when() 에서 ops 를 부르면 즉시 던진다(NOOP_OPS 가드)", () => {
    const doc = emptySheet();
    expect(recommendSheetAssists(doc, { r1: 0, c1: 0, r2: 0, c2: 0 }, new SheetEngine(doc))).toEqual([]);
  });

  it("dedupe_rows 는 완전히 같은 내용의 행을 찾아 추천하고, apply 는 뒤의 중복 행 번호로 ops.deleteRows 를 1회 부른다", () => {
    const doc: SheetDoc = {
      ...emptySheet(),
      cells: { A1: { raw: "철수" }, B1: { raw: "1" }, A2: { raw: "철수" }, B2: { raw: "1" }, A3: { raw: "영희" }, B3: { raw: "2" } },
    };
    const range = { r1: 0, c1: 0, r2: 2, c2: 1 };
    expect(recommendSheetAssists(doc, range, new SheetEngine(doc))).toContain("dedupe_rows");

    const ops = noopOps();
    defOf("dedupe_rows").apply(ctxOf(doc, range, ops));
    expect(ops.deleteRows).toHaveBeenCalledTimes(1);
    expect(ops.deleteRows).toHaveBeenCalledWith([1]);

    const noDup: SheetDoc = { ...emptySheet(), cells: { A1: { raw: "철수" }, A2: { raw: "영희" } } };
    expect(recommendSheetAssists(noDup, { r1: 0, c1: 0, r2: 1, c2: 0 }, new SheetEngine(noDup))).not.toContain("dedupe_rows");
  });

  it("fill_blank_down 은 첫 열의 빈 칸 위에 값이 있으면 추천되고, apply 는 가장 가까운 위 값으로 1회 setCells 한다", () => {
    const doc: SheetDoc = {
      ...emptySheet(),
      cells: { A1: { raw: "1월" }, A3: { raw: "2월" }, B1: { raw: "10" }, B2: { raw: "20" }, B3: { raw: "30" } },
    };
    const range = { r1: 0, c1: 0, r2: 2, c2: 1 };
    expect(recommendSheetAssists(doc, range, new SheetEngine(doc))).toContain("fill_blank_down");

    const ops = noopOps();
    defOf("fill_blank_down").apply(ctxOf(doc, range, ops));
    expect(ops.setCells).toHaveBeenCalledTimes(1);
    expect(ops.setCells).toHaveBeenCalledWith({ A2: { raw: "1월" } });

    const noBlank: SheetDoc = { ...emptySheet(), cells: { A1: { raw: "1월" }, A2: { raw: "2월" } } };
    expect(recommendSheetAssists(noBlank, { r1: 0, c1: 0, r2: 1, c2: 0 }, new SheetEngine(noBlank))).not.toContain("fill_blank_down");
  });

  it("hl_extremes 는 숫자 열(3행 이상)의 최대·최소 셀에 hl 을 한 번에 칠하고, 이미 강조된 범위에서는 해제 짝(hl_extremes_clear)만 추천된다", () => {
    const doc: SheetDoc = { ...emptySheet(), cells: { A1: { raw: "10" }, A2: { raw: "30" }, A3: { raw: "20" } } };
    const range = { r1: 0, c1: 0, r2: 2, c2: 0 };
    const recommended = recommendSheetAssists(doc, range, new SheetEngine(doc));
    expect(recommended).toContain("hl_extremes");
    expect(recommended).not.toContain("hl_extremes_clear");

    const ops = noopOps();
    defOf("hl_extremes").apply(ctxOf(doc, range, ops));
    expect(ops.setCells).toHaveBeenCalledTimes(1);
    expect(ops.setCells).toHaveBeenCalledWith({
      A1: { raw: "10", hl: "warn" },
      A2: { raw: "30", hl: "ok" },
    });

    const alreadyHl: SheetDoc = { ...emptySheet(), cells: { A1: { raw: "10", hl: "warn" }, A2: { raw: "30" }, A3: { raw: "20" } } };
    const recommendedClear = recommendSheetAssists(alreadyHl, range, new SheetEngine(alreadyHl));
    expect(recommendedClear).toContain("hl_extremes_clear");
    expect(recommendedClear).not.toContain("hl_extremes");

    const clearOps = noopOps();
    defOf("hl_extremes_clear").apply(ctxOf(alreadyHl, range, clearOps));
    expect(clearOps.setCells).toHaveBeenCalledTimes(1);
    expect(clearOps.setCells).toHaveBeenCalledWith({ A1: { raw: "10", hl: null } });
  });
});
