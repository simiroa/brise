import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsTable, SettingsTableRow } from "./SettingsTable";

describe("SettingsTable", () => {
  it("헤더와 행들이 동일한 그리드 열 설정으로 정상 렌더링된다", () => {
    render(
      <SettingsTable
        columns="120px 1fr 60px"
        data-testid="test-table"
        scrollTestId="test-scroll"
        header={
          <>
            <div>종류</div>
            <div>내용</div>
            <div>관리</div>
          </>
        }
      >
        <SettingsTableRow data-testid="row-1">
          <div>아이템 1</div>
          <div>설명 1</div>
          <div>버튼 1</div>
        </SettingsTableRow>
        <SettingsTableRow data-testid="row-2" isLast>
          <div>아이템 2</div>
          <div>설명 2</div>
          <div>버튼 2</div>
        </SettingsTableRow>
      </SettingsTable>,
    );

    expect(screen.getByTestId("test-table")).toBeTruthy();
    expect(screen.getByTestId("test-scroll")).toBeTruthy();
    expect(screen.getByText("종류")).toBeTruthy();
    expect(screen.getByText("아이템 1")).toBeTruthy();
    expect(screen.getByText("아이템 2")).toBeTruthy();
  });

  it("isEmpty가 true이면 헤더는 유지되고 본문 자리에 안내 문구가 가운데 정렬된다", () => {
    render(
      <SettingsTable
        columns="1fr"
        header={<div>헤더</div>}
        isEmpty
        emptyText="데이터가 없습니다."
        bodyTestId="test-body"
      >
        <SettingsTableRow>
          <div>숨겨질 내용</div>
        </SettingsTableRow>
      </SettingsTable>,
    );

    expect(screen.getByText("헤더")).toBeTruthy();
    expect(screen.getByText("데이터가 없습니다.")).toBeTruthy();
    expect(screen.queryByText("숨겨질 내용")).toBeNull();
    expect(screen.queryByTestId("test-body")).toBeNull();
  });

  it("데이터가 있을 때 bodyTestId가 지정되어 있으면 해당 testid로 행 래퍼가 렌더링된다", () => {
    render(
      <SettingsTable
        columns="1fr"
        header={<div>헤더</div>}
        isEmpty={false}
        bodyTestId="test-body"
      >
        <SettingsTableRow>
          <div>행 1</div>
        </SettingsTableRow>
      </SettingsTable>,
    );

    expect(screen.getByTestId("test-body")).toBeTruthy();
    expect(screen.getByText("행 1")).toBeTruthy();
  });

  it("disabled 행은 opacity와 aria-disabled가 적용된다", () => {
    render(
      <SettingsTable columns="1fr" header={<div>헤더</div>}>
        <SettingsTableRow data-testid="disabled-row" disabled title="비활성화됨">
          <div>비활성 행</div>
        </SettingsTableRow>
      </SettingsTable>,
    );

    const row = screen.getByTestId("disabled-row");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.getAttribute("title")).toBe("비활성화됨");
    expect(row.style.opacity).toBe("var(--dim-disabled)");
  });
});
