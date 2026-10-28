import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DisabledGroup } from "./DisabledGroup";

describe("DisabledGroup", () => {
  it("켜져 있으면 자식을 래퍼 없이 그대로 낸다", () => {
    const { container } = render(
      <DisabledGroup disabled={false} reason="꺼짐" testId="g">
        <button>눌러</button>
      </DisabledGroup>,
    );
    expect(container.querySelector("[data-testid='g']")).toBeNull();
    expect(screen.queryByText("꺼짐")).toBeNull();
    expect(container.querySelector("[inert]")).toBeNull();
  });

  it("꺼지면 자식을 inert 로 잠그고 이유는 inert 밖에 둔다", () => {
    const { container } = render(
      <DisabledGroup disabled reason="동기화가 꺼져 있습니다" testId="g">
        <button>눌러</button>
      </DisabledGroup>,
    );
    const inert = container.querySelector("[inert]");
    expect(inert).not.toBeNull();
    expect(inert?.contains(screen.getByText("눌러"))).toBe(true);
    expect(inert?.contains(screen.getByText("동기화가 꺼져 있습니다"))).toBe(false);
  });
});
