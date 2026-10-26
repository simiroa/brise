import { describe, expect, it } from "vitest";
import { applyPatch, emptySheet, invertPatch, parseSheet, type SheetDoc } from "./types";

describe("CellPatch.hl 왕복", () => {
  it("hl 을 세팅했다가 invertPatch 로 되돌리면 원래(hl 없음) 상태로 돌아간다", () => {
    const doc: SheetDoc = { ...emptySheet(), cells: { A1: { raw: "30" } } };
    const patch = { A1: { raw: "30", hl: "ok" as const } };

    const undo = invertPatch(doc, patch);
    const applied = applyPatch(doc, patch);
    expect(applied.cells.A1).toEqual({ raw: "30", hl: "ok" });

    const reverted = applyPatch(applied, undo);
    expect(reverted.cells.A1).toEqual({ raw: "30" });
  });
});

describe("parseSheet 검증 강화 및 hl 보존 (W5)", () => {
  it("유효한 정규 A1 셀 키만 통과시키고 유효하지 않은 키는 거른다", () => {
    const json = JSON.stringify({
      v: 1,
      cells: {
        A1: { raw: "valid 1" },
        AZ1000: { raw: "valid boundary" },
        "ZZ9999": { raw: "invalid col" },
        "foo": { raw: "not A1" },
        "B$2": { raw: "contains dollar" },
        "A0": { raw: "zero row" },
        "BA1": { raw: "col out of maxCols" }, // BA is 52 (0-indexed 52 -> out of bounds for maxCols 52)
        A1001: { raw: "row out of maxRows" },
      },
    });
    const parsed = parseSheet(json);
    expect(parsed).not.toBeNull();
    expect(parsed!.cells.A1).toEqual({ raw: "valid 1" });
    expect(parsed!.cells.AZ1000).toEqual({ raw: "valid boundary" });
    expect(parsed!.cells["ZZ9999"]).toBeUndefined();
    expect(parsed!.cells["foo"]).toBeUndefined();
    expect(parsed!.cells["B$2"]).toBeUndefined();
    expect(parsed!.cells["A0"]).toBeUndefined();
    expect(parsed!.cells["BA1"]).toBeUndefined();
    expect(parsed!.cells["A1001"]).toBeUndefined();
  });

  it("행 수(rows)를 1..1000 범위로 clamp한다", () => {
    const jsonOver = JSON.stringify({ v: 1, rows: 5000, cells: {} });
    expect(parseSheet(jsonOver)?.rows).toBe(1000);

    const jsonUnder = JSON.stringify({ v: 1, rows: -5, cells: {} });
    expect(parseSheet(jsonUnder)?.rows).toBe(1);

    const jsonNormal = JSON.stringify({ v: 1, rows: 250, cells: {} });
    expect(parseSheet(jsonNormal)?.rows).toBe(250);
  });

  it("Cell.hl 필드를 보존한다", () => {
    const json = JSON.stringify({
      v: 1,
      cells: {
        A1: { raw: "100", hl: "ok" },
        B1: { raw: "200", hl: "warn" },
        C1: { raw: "300", hl: "info" },
        D1: { raw: "400", hl: "invalid_hl" },
      },
    });
    const parsed = parseSheet(json);
    expect(parsed?.cells.A1.hl).toBe("ok");
    expect(parsed?.cells.B1.hl).toBe("warn");
    expect(parsed?.cells.C1.hl).toBe("info");
    expect(parsed?.cells.D1.hl).toBeUndefined();
  });

  it("charts 배열에서 유효한 type만 허용하고 유효하지 않은 것은 필터링한다", () => {
    const json = JSON.stringify({
      v: 1,
      cells: {},
      charts: [
        { id: "c1", type: "bar", series: ["A1:A5"] },
        { id: "c2", type: "kpi", series: ["B1"] },
        { id: "c3", type: "invalid_chart_type", series: ["C1"] },
        { id: "", type: "line", series: ["D1"] },
      ],
    });
    const parsed = parseSheet(json);
    expect(parsed?.charts.length).toBe(2);
    expect(parsed?.charts.map((c) => c.id)).toEqual(["c1", "c2"]);
  });
});
