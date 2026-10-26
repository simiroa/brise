import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useState } from "react";
import { TimeField } from "./TimeField";

function setup(value = "08:00") {
  const onCommit = vi.fn();
  const utils = render(<TimeField value={value} onCommit={onCommit} ariaLabel="시각" data-testid="tf" />);
  const input = screen.getByTestId("tf") as HTMLInputElement;
  return { onCommit, input, ...utils };
}

describe("TimeField", () => {
  it("입력 중엔 커밋하지 않고 Enter 에서 한 번", () => {
    const { onCommit, input } = setup();
    fireEvent.change(input, { target: { value: "09:15" } });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("09:15");
  });

  it("빈 값·같은 값은 보내지 않고 빈 값은 원래 값으로 돌아간다", () => {
    const { onCommit, input } = setup();
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe("08:00");
  });

  it("Escape 는 초안을 버리고, 바꾼 게 있을 때만 이벤트를 삼킨다", () => {
    const { onCommit, input } = setup();
    const outer = vi.fn();
    window.addEventListener("keydown", outer);
    fireEvent.change(input, { target: { value: "10:00" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("08:00");
    expect(outer).not.toHaveBeenCalled();
    // 바뀐 게 없으면 Escape 는 그대로 흘러가(설정 창 닫기 등) 막지 않는다.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(outer).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", outer);
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("밖에서 값이 바뀌면(롤백·다른 창) 초안이 따라간다", () => {
    function Host() {
      const [v, setV] = useState("08:00");
      return (
        <>
          <TimeField value={v} onCommit={() => {}} ariaLabel="시각" data-testid="tf" />
          <button onClick={() => setV("07:30")}>ext</button>
        </>
      );
    }
    render(<Host />);
    fireEvent.click(screen.getByText("ext"));
    expect((screen.getByTestId("tf") as HTMLInputElement).value).toBe("07:30");
  });
});
