import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CheatsheetPopover, type CheatsheetItem, Key } from "./CheatsheetPopover";

// Extracted from EditorPanel (2026-08-12) so the 관계도 hint bar could reuse it. These lock the two
// behaviours that make it usable at all: hover peeks, click PINS — a popover you have to keep the
// mouse on is unreadable while you try the thing it describes.
const ITEMS: CheatsheetItem[] = [
  { rule: "# ", desc: "제목" },
  { rule: "- ", desc: "목록" },
];

describe("CheatsheetPopover", () => {
  const mount = (items: CheatsheetItem[] = ITEMS) => render(<CheatsheetPopover title="입력 규칙" items={items} />);

  it("starts closed and lists nothing", () => {
    mount();
    expect(screen.queryByTestId("cheatsheet-panel")).toBeNull();
    expect(screen.getByTestId("cheatsheet-toggle").getAttribute("title")).toBe("입력 규칙");
  });

  it("hover opens it and mouse-out closes it again (legacy {rule, desc} format backwards compatibility)", () => {
    const view = mount();
    const host = view.container.firstElementChild!;
    fireEvent.mouseEnter(host);
    const panel = screen.getByTestId("cheatsheet-panel");
    // The chips keep their literal text, trailing space and all ("# " is not "#") — getByText
    // trims, so read the <code> nodes directly.
    expect(Array.from(panel.querySelectorAll("code")).map((c) => c.textContent)).toEqual(
      ITEMS.map((i) => ("rule" in i ? i.rule : "")),
    );
    for (const item of ITEMS) {
      if ("desc" in item) expect(panel.textContent).toContain(item.desc);
    }
    fireEvent.mouseLeave(host);
    expect(screen.queryByTestId("cheatsheet-panel")).toBeNull();
  });

  it("click PINS it open — it survives the mouse leaving, and a second click unpins", () => {
    const view = mount();
    const host = view.container.firstElementChild!;
    fireEvent.mouseEnter(host);
    fireEvent.click(screen.getByTestId("cheatsheet-toggle"));
    fireEvent.mouseLeave(host);
    expect(screen.getByTestId("cheatsheet-panel")).toBeTruthy();

    fireEvent.click(screen.getByTestId("cheatsheet-toggle"));
    expect(screen.queryByTestId("cheatsheet-panel")).toBeNull();
  });

  it("renders heading items as section titles with styling", () => {
    const itemsWithHeadings: CheatsheetItem[] = [
      { heading: "구획 1 (편집)" },
      { rule: [Key("F2")], desc: "셀 편집" },
      { heading: "구획 2 (이동)" },
      { rule: [Key("Tab")], desc: "다음 셀" },
    ];

    const view = mount(itemsWithHeadings);
    const host = view.container.firstElementChild!;
    fireEvent.mouseEnter(host);

    const panel = screen.getByTestId("cheatsheet-panel");
    expect(panel.textContent).toContain("구획 1 (편집)");
    expect(panel.textContent).toContain("구획 2 (이동)");
    expect(panel.textContent).toContain("셀 편집");
    expect(panel.textContent).toContain("다음 셀");

    // Headings have muted color and small font
    const headingEls = Array.from(panel.querySelectorAll("div")).filter(
      (d) => d.textContent === "구획 1 (편집)" || d.textContent === "구획 2 (이동)",
    );
    expect(headingEls).toHaveLength(2);
    expect(headingEls[0].style.fontSize).toBe("var(--text-2xs)");
    expect(headingEls[0].style.color).toBe("var(--muted)");
    expect(headingEls[0].style.fontWeight).toBe("600");
  });

  it("applies scroll container styling (maxHeight and overflowY: auto) and panel width constraint", () => {
    const view = mount();
    const host = view.container.firstElementChild!;
    fireEvent.mouseEnter(host);

    const panel = screen.getByTestId("cheatsheet-panel");
    expect(panel.style.width).toBe("min(260px, calc(100vw - var(--space-6)))");
    expect(panel.style.right).toBe("0px");

    const scrollContainer = panel.querySelector(".scroll") as HTMLElement;
    expect(scrollContainer).not.toBeNull();
    expect(scrollContainer.style.overflowY).toBe("auto");
    expect(scrollContainer.style.maxHeight).toBe("min(46vh, 360px)");
  });
});
