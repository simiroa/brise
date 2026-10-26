import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BubbleMenu, type BubbleMenuCtl } from "./DiagramBubbleMenu";

function ctl(over: Partial<BubbleMenuCtl> = {}): BubbleMenuCtl {
  return { active: null, setActive: vi.fn(), flipped: false, ...over };
}

describe("BubbleMenu", () => {
  it("닫혀 있으면 항목 함수를 부르지 않고(버블은 매 프레임 리렌더), 열리면 위로 펼친다", () => {
    const items = vi.fn(() => <span>항목</span>);
    const { rerender, container } = render(
      <BubbleMenu id="shape" menu={ctl()} label="모양" icon={<i />}>{items}</BubbleMenu>,
    );
    expect(items).not.toHaveBeenCalled();
    expect(container.querySelector(".diagram-floating-bubble-dropdown")).toBeNull();

    rerender(<BubbleMenu id="shape" menu={ctl({ active: "shape" })} label="모양" icon={<i />}>{items}</BubbleMenu>);
    const dd = container.querySelector(".diagram-floating-bubble-dropdown") as HTMLElement;
    expect(items).toHaveBeenCalledTimes(1);
    expect(dd.getAttribute("data-placement")).toBe("top");
    expect(dd.style.bottom).toBe("calc(100% + 8px)");
    expect(screen.getByTitle("모양").getAttribute("data-active")).toBe("true");
  });

  it("버블이 뒤집혔으면 아래로 펼친다", () => {
    const { container } = render(
      <BubbleMenu id="tone" menu={ctl({ active: "tone", flipped: true })} label="톤" icon={<i />}>{() => null}</BubbleMenu>,
    );
    const dd = container.querySelector(".diagram-floating-bubble-dropdown") as HTMLElement;
    expect(dd.getAttribute("data-placement")).toBe("bottom");
    expect(dd.style.top).toBe("calc(100% + 8px)");
  });

  it("버튼은 자기 id 로 토글하고, highlight 면 닫혀 있어도 활성 표시를 갖는다", () => {
    const setActive = vi.fn();
    render(<BubbleMenu id="line" menu={ctl({ setActive })} label="선" icon={<i />} highlight>{() => null}</BubbleMenu>);
    const btn = screen.getByTitle("선");
    expect(btn.getAttribute("aria-label")).toBe("선");
    expect(btn.getAttribute("data-active")).toBe("true");
    fireEvent.click(btn);
    const updater = setActive.mock.calls[0][0] as (m: string | null) => string | null;
    expect(updater(null)).toBe("line");
    expect(updater("line")).toBeNull();
    expect(updater("tone")).toBe("line");
  });
});
