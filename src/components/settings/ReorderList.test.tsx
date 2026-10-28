import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReorderList, type ReorderItem } from "./ReorderList";

const ITEMS: ReorderItem[] = [
  { id: "a", label: "Alpha", enabled: true },
  { id: "b", label: "Beta", enabled: true },
  { id: "c", label: "Gamma", enabled: false },
];

function idsOf(items: ReorderItem[]) {
  return items.map((i) => i.id);
}

describe("ReorderList (W23-a)", () => {
  it("renders icon-less chips without switches or move buttons", () => {
    render(<ReorderList items={ITEMS} onReorder={() => {}} onToggle={() => {}} testIdPrefix="chip" />);
    expect(screen.getByTestId("chip-list")).toBeTruthy();
    expect(screen.getByTestId("chip-item-a")).toBeTruthy();
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.queryByTestId("chip-up-a")).toBeNull();
    expect(screen.queryByTestId("chip-down-a")).toBeNull();
    expect(screen.queryByTestId("chip-toggle-a")).toBeNull();
    expect(screen.getByTestId("chip-item-c").getAttribute("data-enabled")).toBe("false");
  });

  it("dims a disabled chip with --dim-disabled and outlines chips with --divider (D2/rule 4)", () => {
    const { container } = render(
      <ReorderList items={ITEMS} onReorder={() => {}} onToggle={() => {}} testIdPrefix="chip" />,
    );
    const off = screen.getByTestId("chip-item-c");
    expect(off.style.opacity).toBe("var(--dim-disabled)");
    expect(off.style.borderColor).toBe("var(--divider)");
    // 켜짐은 배지가 아니라 칩 자체의 밝기(강조 테두리)로 — 켜짐/꺼짐 글자 배지는 없다(오너 2026-10-28).
    expect(screen.getByTestId("chip-item-a").style.borderColor).toBe("var(--accent)");
    expect(screen.queryByTestId("chip-state-a")).toBeNull();
    for (const el of Array.from(container.querySelectorAll<HTMLElement>("*"))) {
      expect(el.getAttribute("style") ?? "").not.toContain("var(--line)");
    }
  });

  it("clicking a chip toggles it", async () => {
    const onToggle = vi.fn();
    render(<ReorderList items={ITEMS} onReorder={() => {}} onToggle={onToggle} testIdPrefix="chip" />);
    await userEvent.click(screen.getByTestId("chip-item-a"));
    expect(onToggle).toHaveBeenCalledWith("a", false);
  });

  it("clicking the last enabled chip is ignored and shakes", async () => {
    const onToggle = vi.fn();
    const lastOn: ReorderItem[] = [
      { id: "a", label: "Alpha", enabled: true },
      { id: "b", label: "Beta", enabled: false },
    ];
    render(<ReorderList items={lastOn} onReorder={() => {}} onToggle={onToggle} testIdPrefix="chip" />);
    await userEvent.click(screen.getByTestId("chip-item-a"));
    expect(onToggle).not.toHaveBeenCalled();
    expect(screen.getByTestId("chip-item-a").getAttribute("data-shake")).toBe("true");
    // 흔들기만으로는 이유가 안 보인다 — aria-live 줄이 같이 말한다.
    const notice = screen.getByTestId("chip-last-notice");
    expect(notice.getAttribute("aria-live")).toBe("polite");
    expect(notice.textContent).toMatch(/at least one/i);
  });

  it("shows the keyboard hint and clears the shake timer on unmount", async () => {
    const clearSpy = vi.spyOn(window, "clearTimeout");
    const lastOn: ReorderItem[] = [{ id: "a", label: "Alpha", enabled: true }];
    const { unmount } = render(
      <ReorderList items={lastOn} onReorder={() => {}} onToggle={() => {}} testIdPrefix="chip" />,
    );
    expect(screen.getByTestId("chip-keyboard-hint").textContent).toMatch(/↑|←|arrow/i);
    await userEvent.click(screen.getByTestId("chip-item-a"));
    clearSpy.mockClear();
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it("drop indicator sits on the side the chip will land: right edge when dragging forward (one-row strip, 2026-10-28)", () => {
    const original = document.elementFromPoint;
    const target = () => screen.getByTestId("chip-item-c");
    (document as any).elementFromPoint = () => target();
    try {
      render(<ReorderList items={ITEMS} onReorder={() => {}} onToggle={() => {}} testIdPrefix="chip" />);
      const a = screen.getByTestId("chip-item-a");
      fireEvent.pointerDown(a, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(a, { pointerId: 1, clientX: 80, clientY: 0 });
      fireEvent.pointerMove(a, { pointerId: 1, clientX: 90, clientY: 0 });
      expect(target().getAttribute("data-drop")).toBe("after");
      expect(target().style.boxShadow).toContain("inset -2px 0");
    } finally {
      (document as any).elementFromPoint = original;
    }
  });

  it("ArrowRight / ArrowLeft reorder the focused chip", () => {
    const onReorder = vi.fn();
    render(<ReorderList items={ITEMS} onReorder={onReorder} onToggle={() => {}} testIdPrefix="chip" />);
    screen.getByTestId("chip-item-a").focus();
    fireEvent.keyDown(screen.getByTestId("chip-item-a"), { key: "ArrowRight" });
    expect(idsOf(onReorder.mock.calls[0][0])).toEqual(["b", "a", "c"]);

    fireEvent.keyDown(screen.getByTestId("chip-item-b"), { key: "ArrowLeft" });
    expect(idsOf(onReorder.mock.calls[1][0])).toEqual(["b", "a", "c"]);
  });

  it("Space/Enter toggles the focused chip", () => {
    const onToggle = vi.fn();
    render(<ReorderList items={ITEMS} onReorder={() => {}} onToggle={onToggle} testIdPrefix="chip" />);
    fireEvent.keyDown(screen.getByTestId("chip-item-c"), { key: "Enter" });
    expect(onToggle).toHaveBeenCalledWith("c", true);
    fireEvent.keyDown(screen.getByTestId("chip-item-b"), { key: " " });
    expect(onToggle).toHaveBeenCalledWith("b", false);
  });
});
