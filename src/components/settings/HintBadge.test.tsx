import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { HintBadge } from "./HintBadge";

describe("HintBadge", () => {
  it("이름은 aria-label·title 로 주고, 평소엔 말풍선을 그리지 않는다", () => {
    render(<HintBadge hint="한 줄 힌트" />);
    const badge = screen.getByRole("img", { name: "한 줄 힌트" });
    expect(badge.getAttribute("title")).toBe("한 줄 힌트");
    expect(badge.tabIndex).toBe(0);
    expect(screen.queryByTestId("hint-badge-tip")).toBeNull();
  });

  // title 툴팁은 마우스 hover 에서만 뜬다 — Tab 으로 닿으면 아무것도 안 보이던 것을 고친다.
  it("키보드 포커스 동안 같은 문구의 말풍선을 띄우고, blur·Escape 로 걷는다", () => {
    render(<HintBadge hint="한 줄 힌트" />);
    const badge = screen.getByRole("img", { name: "한 줄 힌트" });

    fireEvent.focus(badge);
    const tip = screen.getByTestId("hint-badge-tip");
    expect(tip.textContent).toBe("한 줄 힌트");
    expect(tip.getAttribute("aria-hidden")).toBe("true"); // 이름은 aria-label 이 이미 준다
    expect(tip.className).toBe("overlay");
    expect(badge.contains(tip)).toBe(false); // 스크롤 컨테이너에 잘리지 않게 바깥으로 띄운다

    fireEvent.blur(badge);
    expect(screen.queryByTestId("hint-badge-tip")).toBeNull();

    fireEvent.focus(badge);
    fireEvent.keyDown(badge, { key: "Escape" });
    expect(screen.queryByTestId("hint-badge-tip")).toBeNull();
  });
});
