import { describe, it, expect } from "vitest";
import { findMarkdownTables, listToDiagramText } from "./textDerive";
import { parseDiagramText } from "../components/diagram/diagramText";

describe("findMarkdownTables", () => {
  it("헤더+구분+데이터 행이 있는 GFM 표 하나를 행렬(헤더 포함)로 돌려준다", () => {
    const md = ["# 제목", "", "| 이름 | 나이 |", "| --- | --- |", "| 철수 | 10 |", "| 영희 | 12 |", ""].join("\n");
    expect(findMarkdownTables(md)).toEqual([
      [
        ["이름", "나이"],
        ["철수", "10"],
        ["영희", "12"],
      ],
    ]);
  });

  it("정렬 콜론(:---:)이 있는 구분 행도 인식한다", () => {
    const md = ["| a | b |", "|:---:|---:|", "| 1 | 2 |"].join("\n");
    expect(findMarkdownTables(md)).toEqual([[["a", "b"], ["1", "2"]]]);
  });

  it("표가 둘이면 등장 순서대로 둘 다 돌려준다", () => {
    const md = ["| a |", "| - |", "| 1 |", "", "본문 문단", "", "| b |", "| - |", "| 2 |"].join("\n");
    expect(findMarkdownTables(md)).toEqual([[["a"], ["1"]], [["b"], ["2"]]]);
  });

  it("표가 없으면 빈 배열", () => {
    expect(findMarkdownTables("그냥 본문\n두 번째 줄")).toEqual([]);
  });

  it("구분 행이 없는 파이프 줄은 표로 인식하지 않는다", () => {
    expect(findMarkdownTables("| a | b |\n일반 문단")).toEqual([]);
  });
});

describe("listToDiagramText", () => {
  it("항목 3개 미만이면 null", () => {
    expect(listToDiagramText("- 하나\n- 둘")).toBeNull();
  });

  it("들여쓰기 트리를 diagramText 문법(공백 2칸)으로 변환한다", () => {
    const md = ["- 회사", "  - 개발팀", "  - 디자인팀"].join("\n");
    expect(listToDiagramText(md)).toBe(["회사", "  개발팀", "  디자인팀"].join("\n"));
  });

  it("번호 목록(1.)도 인식한다", () => {
    const md = ["1. 첫째", "2. 둘째", "3. 셋째"].join("\n");
    expect(listToDiagramText(md)).toBe(["첫째", "둘째", "셋째"].join("\n"));
  });

  it("변환 결과가 parseDiagramText 로 항상 파싱된다(연결자 기호가 섞인 라벨 포함)", () => {
    const md = ["- 처리 -> 완료", "- 그룹 [베타]", "- ###메모"].join("\n");
    const text = listToDiagramText(md);
    expect(text).not.toBeNull();
    const result = parseDiagramText(text!);
    expect(result.ok).toBe(true);
  });
});
