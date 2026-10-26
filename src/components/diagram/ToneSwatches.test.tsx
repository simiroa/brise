import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { t } from "../../i18n/t";
import { ToneSwatches } from "./ToneSwatches";

const items = (c: HTMLElement) => Array.from(c.querySelectorAll<HTMLElement>(".diagram-floating-bubble-dropdown-item"));

describe("ToneSwatches", () => {
  it("dot(노드·엣지): 톤 다섯 개를 그리고 선택 표시는 참/거짓 문자열 둘 다 붙는다", () => {
    const { container } = render(<ToneSwatches current="accent" onPick={vi.fn()} />);
    const btns = items(container);
    expect(btns.map((b) => b.getAttribute("data-selected"))).toEqual(["false", "true", "false", "false", "false"]);
    expect(btns[1].textContent).toBe(t("editor.diagram_tone_accent"));
    const chip = btns[1].querySelector("span") as HTMLElement;
    expect(chip.className).toBe("diagram-flow-node-state-dot");
    expect(chip.hasAttribute("data-tone")).toBe(false);
    expect(chip.style.background).toBe("var(--accent)");
    expect((btns[0].querySelector("span") as HTMLElement).style.border).toContain("dashed");
  });

  it("dot 인데 current 가 없으면(다중 선택) data-selected 속성 자체가 없다", () => {
    const { container } = render(<ToneSwatches onPick={vi.fn()} />);
    expect(items(container).every((b) => !b.hasAttribute("data-selected"))).toBe(true);
  });

  it("swatch(그룹): 견본 클래스 + data-tone, 선택 표시는 참일 때만 붙는다", () => {
    const { container } = render(<ToneSwatches variant="swatch" current="done" onPick={vi.fn()} />);
    const btns = items(container);
    expect(btns.map((b) => b.getAttribute("data-selected"))).toEqual([null, null, null, "true", null]);
    const chip = btns[3].querySelector("span") as HTMLElement;
    expect(chip.className).toBe("diagram-floating-bubble-color-swatch");
    expect(chip.getAttribute("data-tone")).toBe("done");
  });

  it("항목을 누르면 그 톤으로 onPick 을 부른다", () => {
    const onPick = vi.fn();
    const { container } = render(<ToneSwatches onPick={onPick} />);
    items(container)[2].click();
    expect(onPick).toHaveBeenCalledWith("warn");
  });
});
