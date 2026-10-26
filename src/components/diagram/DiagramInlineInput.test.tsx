import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DiagramInlineInput } from "./DiagramInlineInput";

describe("DiagramInlineInput", () => {
  it("renders with default classes nodrag nopan nowheel and custom class", () => {
    render(
      <DiagramInlineInput
        defaultValue="test text"
        className="my-custom-class"
        testId="inline-input"
        onCommit={vi.fn()}
      />
    );

    const input = screen.getByTestId("inline-input");
    expect(input.className).toContain("nodrag");
    expect(input.className).toContain("nopan");
    expect(input.className).toContain("nowheel");
    expect(input.className).toContain("my-custom-class");
    expect((input as HTMLInputElement).value).toBe("test text");
  });

  it("calls onCommit on blur", () => {
    const onCommit = vi.fn();
    render(
      <DiagramInlineInput
        defaultValue="initial"
        testId="inline-input"
        onCommit={onCommit}
      />
    );

    const input = screen.getByTestId("inline-input");
    fireEvent.change(input, { target: { value: "updated" } });
    fireEvent.blur(input);

    expect(onCommit).toHaveBeenCalledWith("updated");
  });

  it("calls onCommit on Enter key when not composing", () => {
    const onCommit = vi.fn();
    render(
      <DiagramInlineInput
        defaultValue="initial"
        testId="inline-input"
        onCommit={onCommit}
      />
    );

    const input = screen.getByTestId("inline-input");
    fireEvent.change(input, { target: { value: "committed" } });
    fireEvent.keyDown(input, { key: "Enter", nativeEvent: { isComposing: false } });

    expect(onCommit).toHaveBeenCalledWith("committed");
  });

  it("does not call onCommit on Enter key when composing (IME)", () => {
    const onCommit = vi.fn();
    render(
      <DiagramInlineInput
        defaultValue="initial"
        testId="inline-input"
        onCommit={onCommit}
      />
    );

    const input = screen.getByTestId("inline-input");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });

    expect(onCommit).not.toHaveBeenCalled();
  });

  it("calls onCancel on Escape key", () => {
    const onCancel = vi.fn();
    render(
      <DiagramInlineInput
        defaultValue="initial"
        testId="inline-input"
        onCommit={vi.fn()}
        onCancel={onCancel}
      />
    );

    const input = screen.getByTestId("inline-input");
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("supports controlled value and onChange", () => {
    const onChange = vi.fn();
    render(
      <DiagramInlineInput
        value="controlled"
        onChange={onChange}
        testId="inline-input"
        onCommit={vi.fn()}
      />
    );

    const input = screen.getByTestId("inline-input");
    fireEvent.change(input, { target: { value: "new text" } });

    expect(onChange).toHaveBeenCalledWith("new text");
  });

  it("selects content on focus if selectOnFocus is true", () => {
    render(
      <DiagramInlineInput
        defaultValue="text to select"
        testId="inline-input"
        selectOnFocus
        onCommit={vi.fn()}
      />
    );

    const input = screen.getByTestId("inline-input") as HTMLInputElement;
    const selectSpy = vi.spyOn(input, "select");
    fireEvent.focus(input);

    expect(selectSpy).toHaveBeenCalledTimes(1);
  });
});
