import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FormError, FormField, FormToggleRow, WeekdayMaskField } from "./FormField";

describe("FormField primitives", () => {
  it("네이티브 입력은 <label> 로, 버튼형 컨트롤은 <div> 로 감싼다", () => {
    const { container } = render(
      <>
        <FormField label="이름">
          <input data-testid="in" />
        </FormField>
        <FormField as="div" label="반복">
          <button type="button">x</button>
        </FormField>
      </>,
    );
    expect(screen.getByTestId("in").closest("label")).toBeTruthy();
    expect(screen.getByText("x").closest("label")).toBeNull();
    expect(container.querySelectorAll("label")).toHaveLength(1);
  });

  it("FormToggleRow: 이름이 스위치의 aria-label 이고 누르면 반대 값", () => {
    const onChange = vi.fn();
    render(<FormToggleRow label="빨간 날" hint="힌트" checked={false} onChange={onChange} data-testid="tg" />);
    const sw = screen.getByTestId("tg");
    expect(sw.getAttribute("aria-label")).toBe("빨간 날");
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.getByText("힌트")).toBeTruthy();
  });

  it("WeekdayMaskField: 비트 순서대로 눌림 상태와 토글", () => {
    const onToggle = vi.fn();
    render(
      <WeekdayMaskField label="요일" labels={["월", "화", "수", "목", "금", "토", "일"]} mask={0b0000101} onToggle={onToggle} testIdPrefix="wd-" />,
    );
    expect(screen.getByTestId("wd-0").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("wd-1").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByTestId("wd-6"));
    expect(onToggle).toHaveBeenCalledWith(0b1000000);
  });

  it("FormError 는 alert 역할", () => {
    render(<FormError data-testid="e">잘못됨</FormError>);
    expect(screen.getByRole("alert").textContent).toBe("잘못됨");
  });
});
