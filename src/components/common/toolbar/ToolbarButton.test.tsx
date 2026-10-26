import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ToolbarButton } from "./ToolbarButton";
import { ToolbarDivider } from "./ToolbarDivider";

describe("ToolbarButton", () => {
  it("renders with default toolbar-btn class", () => {
    render(<ToolbarButton testId="btn">Click</ToolbarButton>);
    const button = screen.getByTestId("btn");
    expect(button.className).toBe("toolbar-btn");
    expect(button.textContent).toBe("Click");
  });

  it("handles click events", () => {
    const handleClick = vi.fn();
    render(<ToolbarButton testId="btn" onClick={handleClick}>Click</ToolbarButton>);
    fireEvent.click(screen.getByTestId("btn"));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it("sets data-active and aria-pressed correctly when active is boolean", () => {
    const { rerender } = render(<ToolbarButton testId="btn" active={true}>Active</ToolbarButton>);
    const button = screen.getByTestId("btn");
    expect(button.getAttribute("data-active")).toBe("true");
    expect(button.getAttribute("aria-pressed")).toBe("true");

    rerender(<ToolbarButton testId="btn" active={false}>Inactive</ToolbarButton>);
    expect(button.getAttribute("data-active")).toBe("false");
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("sets data-active and aria-pressed for mixed state", () => {
    render(<ToolbarButton testId="btn" active="mixed">Mixed</ToolbarButton>);
    const button = screen.getByTestId("btn");
    expect(button.getAttribute("data-active")).toBe("partial");
    expect(button.getAttribute("aria-pressed")).toBe("mixed");
  });

  it("applies aria-label and title", () => {
    render(<ToolbarButton testId="btn" title="Undo Action">Icon</ToolbarButton>);
    const button = screen.getByTestId("btn");
    expect(button.getAttribute("title")).toBe("Undo Action");
    expect(button.getAttribute("aria-label")).toBe("Undo Action");
  });
});

describe("ToolbarDivider", () => {
  it("renders divider with correct class and aria-hidden", () => {
    render(<ToolbarDivider testId="divider" />);
    const divider = screen.getByTestId("divider");
    expect(divider.className).toBe("toolbar-divider");
    expect(divider.getAttribute("aria-hidden")).toBe("true");
  });
});
