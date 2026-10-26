import { describe, it, expect } from "vitest";
import { DEFAULT_ROW_HEIGHT, LINE_STEP, MAX_LINES, rowHeightOf, rowLineCounts, rowOffsets } from "./rowHeights";
import { emptySheet } from "./types";

describe("rowLineCounts", () => {
  it("빈 시트는 모든 행이 1줄이다", () => {
    const doc = emptySheet();
    expect(rowLineCounts(doc, 3)).toEqual([1, 1, 1]);
  });

  it("셀 raw 의 개행 수 + 1 이 그 행의 줄 수다(같은 행 여러 열 중 최댓값)", () => {
    const doc = emptySheet();
    doc.cells["A2"] = { raw: "한 줄" };
    doc.cells["B2"] = { raw: "첫 줄\n둘째 줄\n셋째 줄" };
    expect(rowLineCounts(doc, 3)).toEqual([1, 3, 1]);
  });

  it("수식(= 로 시작)은 raw 개행과 무관하게 1줄로 센다", () => {
    const doc = emptySheet();
    doc.cells["A1"] = { raw: "=SUM(A1:A2)\n더미" };
    expect(rowLineCounts(doc, 1)).toEqual([1]);
  });

  it("줄 수는 MAX_LINES(6)에서 잘린다", () => {
    const doc = emptySheet();
    doc.cells["A1"] = { raw: "1\n2\n3\n4\n5\n6\n7\n8" };
    expect(rowLineCounts(doc, 1)).toEqual([MAX_LINES]);
  });
});

describe("rowHeightOf", () => {
  it("1줄은 DEFAULT_ROW_HEIGHT 그대로다", () => {
    expect(rowHeightOf(1)).toBe(DEFAULT_ROW_HEIGHT);
  });

  it("3줄 값은 기본 행 높이에 LINE_STEP 2배를 더한다", () => {
    expect(rowHeightOf(3)).toBe(DEFAULT_ROW_HEIGHT + 2 * LINE_STEP);
    expect(rowHeightOf(3)).toBe(62);
  });

  it("MAX_LINES 를 넘는 값은 MAX_LINES 로 잘려 더 커지지 않는다", () => {
    expect(rowHeightOf(MAX_LINES + 5)).toBe(rowHeightOf(MAX_LINES));
  });

  it("0 이하 줄 수는 1줄로 취급한다", () => {
    expect(rowHeightOf(0)).toBe(DEFAULT_ROW_HEIGHT);
    expect(rowHeightOf(-3)).toBe(DEFAULT_ROW_HEIGHT);
  });
});

describe("rowOffsets", () => {
  it("누적 오프셋 — 길이는 heights + 1, out[0] 은 항상 0", () => {
    expect(rowOffsets([24, 62, 24])).toEqual([0, 24, 86, 110]);
  });

  it("빈 배열은 [0] 하나다", () => {
    expect(rowOffsets([])).toEqual([0]);
  });
});
