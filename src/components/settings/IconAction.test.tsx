import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { IconAction } from "./IconAction";

describe("IconAction", () => {
  it("aria-label 과 title 이 같은 label 이고, 글자는 그리지 않는다", () => {
    render(<IconAction icon={<svg data-testid="ico" />} label="내보내기" data-testid="x" />);
    const btn = screen.getByRole("button", { name: "내보내기" });
    expect(btn.getAttribute("aria-label")).toBe("내보내기");
    expect(btn.getAttribute("title")).toBe("내보내기");
    expect(btn.getAttribute("type")).toBe("button");
    expect(btn.textContent).toBe("");
    expect(screen.getByTestId("ico")).toBeTruthy();
    expect(btn).toBe(screen.getByTestId("x"));
  });

  it("크기·danger 를 .icon-btn 클래스 가족으로 옮긴다", () => {
    const { rerender } = render(<IconAction icon={null} label="a" />);
    const cls = () => screen.getByRole("button").className.split(" ");
    expect(cls()).toEqual(["icon-btn"]);
    rerender(<IconAction icon={null} label="a" size="sm" danger />);
    expect(cls()).toEqual(["icon-btn", "icon-btn--sm", "icon-btn--danger"]);
    rerender(<IconAction icon={null} label="a" size="lg" />);
    expect(cls()).toEqual(["icon-btn", "icon-btn--lg"]);
  });

  it("titleOverride(브라우저 모드 안내)는 툴팁만 바꾸고 접근 이름은 label 로 둔다", () => {
    render(<IconAction icon={null} label="백업" titleOverride="데스크톱 전용" />);
    const btn = screen.getByRole("button", { name: "백업" });
    expect(btn.getAttribute("title")).toBe("데스크톱 전용");
  });

  it("busy 면 아이콘 대신 스피너 + aria-busy", () => {
    const { rerender } = render(<IconAction icon={<svg data-testid="ico" />} label="테스트" busy />);
    const btn = screen.getByRole("button", { name: "테스트" });
    expect(btn.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByTestId("icon-action-spinner")).toBeTruthy();
    expect(screen.queryByTestId("ico")).toBeNull();
    rerender(<IconAction icon={<svg data-testid="ico" />} label="테스트" />);
    expect(btn.hasAttribute("aria-busy")).toBe(false);
    expect(screen.queryByTestId("icon-action-spinner")).toBeNull();
  });

  // .icon-btn 에 :disabled 모양이 없어 호출자마다 opacity 를 손으로 달던 것을 여기로 모았다.
  it("disabled 면 스스로 흐려지고(not-allowed), busy 면 흐리지 않고 wait 커서", () => {
    const { rerender } = render(<IconAction icon={null} label="d" />);
    const btn = screen.getByRole("button", { name: "d" });
    expect(btn.getAttribute("style")).toBeNull();
    rerender(<IconAction icon={null} label="d" disabled />);
    expect(btn.style.opacity).toBe("var(--dim-disabled)");
    expect(btn.style.cursor).toBe("not-allowed");
    rerender(<IconAction icon={null} label="d" disabled busy />);
    expect(btn.style.opacity).toBe("");
    expect(btn.style.cursor).toBe("wait");
    // 호출자 style 은 그대로 합쳐진다.
    rerender(<IconAction icon={null} label="d" disabled style={{ marginLeft: "auto" }} />);
    expect(btn.style.opacity).toBe("var(--dim-disabled)");
    expect(btn.style.marginLeft).toBe("auto");
  });

  // jsdom 은 :hover 를 계산하지 못하므로 클래스 계약으로 본다 — .icon-btn--static 이 hover 칠·눌림 축소·
  // 아이콘 반응을 끈다(tokens.css). 쉼 색은 그 hover 의 color:inherit 에 휘둘리지 않게 고정.
  it("disabled 면 .icon-btn--static 을 붙여 hover 칠이 들지 않게 하고, 켜지면 뗀다", () => {
    const { rerender } = render(<IconAction icon={null} label="h" danger />);
    const btn = screen.getByRole("button", { name: "h" });
    expect(btn.classList.contains("icon-btn--static")).toBe(false);
    rerender(<IconAction icon={null} label="h" danger disabled />);
    expect(btn.classList.contains("icon-btn--static")).toBe(true);
    expect(btn.style.color).toBe("var(--muted)");
    rerender(<IconAction icon={null} label="h" danger disabled busy />);
    expect(btn.classList.contains("icon-btn--static")).toBe(true);
    rerender(<IconAction icon={null} label="h" danger />);
    expect(btn.classList.contains("icon-btn--static")).toBe(false);
    expect(btn.style.color).toBe("");
  });

  it("나머지 버튼 속성(onClick·disabled·aria-pressed)을 통과시킨다", () => {
    const onClick = vi.fn();
    const { rerender } = render(<IconAction icon={null} label="f" onClick={onClick} aria-pressed={true} />);
    const btn = screen.getByRole("button", { name: "f" });
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    rerender(<IconAction icon={null} label="f" onClick={onClick} disabled />);
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });
});
