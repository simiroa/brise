import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TreeHeaderRow } from "./TreeHeaderRow";

const icon = <svg data-testid="hdr-icon" />;

describe("TreeHeaderRow", () => {
  it("라벨과 개수를 그리고 클릭하면 onClick 을 부른다", () => {
    const onClick = vi.fn();
    render(<TreeHeaderRow icon={icon} label="휴지통" count={3} onClick={onClick} />);
    expect(screen.getByText("휴지통")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("개수 0 도 그대로 표기한다", () => {
    render(<TreeHeaderRow icon={icon} label="아카이브" count={0} onClick={vi.fn()} />);
    expect(screen.getByText("0")).toBeTruthy();
  });

  it("caret 이 없으면 캐럿을 그리지 않고, 있으면 아이콘 앞에 하나 그린다", () => {
    const { container, rerender } = render(
      <TreeHeaderRow icon={icon} label="휴지통" count={1} onClick={vi.fn()} />
    );
    // 아이콘(테스트용 svg) 하나만 있다 — 캐럿 svg 는 없다.
    expect(container.querySelectorAll("svg")).toHaveLength(1);

    rerender(<TreeHeaderRow icon={icon} caret="down" label="즐겨찾기" count={1} onClick={vi.fn()} />);
    const svgs = container.querySelectorAll("svg");
    expect(svgs).toHaveLength(2);
    // 캐럿이 아이콘보다 먼저 온다.
    expect(svgs[1].getAttribute("data-testid")).toBe("hdr-icon");
  });

  it("caret 방향은 IconCaret 회전으로 드러난다(down=0, right=-90)", () => {
    const { container, rerender } = render(
      <TreeHeaderRow icon={icon} caret="down" label="a" count={1} onClick={vi.fn()} />
    );
    expect((container.querySelector("svg") as SVGElement).style.transform).not.toContain("rotate(-90deg)");
    rerender(<TreeHeaderRow icon={icon} caret="right" label="a" count={1} onClick={vi.fn()} />);
    expect((container.querySelector("svg") as SVGElement).style.transform).toContain("rotate(-90deg)");
  });

  it("buttonProps 를 버튼에 그대로 펼친다(data 속성·포인터 핸들러)", () => {
    const onContextMenu = vi.fn((e: React.MouseEvent) => e.preventDefault());
    const onPointerDown = vi.fn();
    render(
      <TreeHeaderRow
        icon={icon}
        label="미분류"
        count={2}
        onClick={vi.fn()}
        buttonProps={{ onContextMenu, onPointerDown, ...{ "data-note-drop-target": "folder:ib1" } }}
      />
    );
    const btn = screen.getByRole("button");
    expect(btn.getAttribute("data-note-drop-target")).toBe("folder:ib1");
    fireEvent.contextMenu(btn);
    expect(onContextMenu).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(btn);
    expect(onPointerDown).toHaveBeenCalledTimes(1);
  });

  it("buttonProps 가 없어도 기본 chrome(type=button, 메뉴 행 클래스)은 유지된다", () => {
    render(<TreeHeaderRow icon={icon} label="x" count={1} onClick={vi.fn()} />);
    const btn = screen.getByRole("button");
    expect(btn.getAttribute("type")).toBe("button");
    expect(btn.className).toBe("menu-row menu-item");
  });
});
