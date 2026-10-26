import { useState } from "react";
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useToolbarRovingFocus } from "./useToolbarRovingFocus";

function TestToolbar({
  buttons = ["b1", "b2", "b3"],
  disabledButtons = [],
  includeInput = false,
}: {
  buttons?: string[];
  disabledButtons?: string[];
  includeInput?: boolean;
}) {
  const roving = useToolbarRovingFocus<HTMLDivElement>();
  return (
    <div
      role="toolbar"
      aria-label="test toolbar"
      data-testid="test-toolbar"
      ref={roving.ref}
      onKeyDown={roving.onKeyDown}
    >
      {includeInput ? <input data-testid="test-input" /> : null}
      {buttons.map((b) => (
        <button
          key={b}
          data-testid={b}
          disabled={disabledButtons.includes(b)}
        >
          {b}
        </button>
      ))}
    </div>
  );
}

describe("useToolbarRovingFocus", () => {
  it("① has exactly one button with tabIndex=0 initially", () => {
    render(<TestToolbar buttons={["b1", "b2", "b3"]} />);
    const b1 = screen.getByTestId("b1");
    const b2 = screen.getByTestId("b2");
    const b3 = screen.getByTestId("b3");

    expect(b1.tabIndex).toBe(0);
    expect(b2.tabIndex).toBe(-1);
    expect(b3.tabIndex).toBe(-1);

    const zeros = [b1, b2, b3].filter((b) => b.tabIndex === 0);
    expect(zeros.length).toBe(1);
  });

  it("② moves focus with ArrowRight and wraps, and reverses with ArrowLeft and wraps", () => {
    render(<TestToolbar buttons={["b1", "b2", "b3"]} />);
    const b1 = screen.getByTestId("b1");
    const b2 = screen.getByTestId("b2");
    const b3 = screen.getByTestId("b3");

    b1.focus();
    expect(document.activeElement).toBe(b1);

    // ArrowRight -> b2
    fireEvent.keyDown(b1, { key: "ArrowRight" });
    expect(document.activeElement).toBe(b2);
    expect(b2.tabIndex).toBe(0);
    expect(b1.tabIndex).toBe(-1);

    // ArrowRight -> b3
    fireEvent.keyDown(b2, { key: "ArrowRight" });
    expect(document.activeElement).toBe(b3);
    expect(b3.tabIndex).toBe(0);
    expect(b2.tabIndex).toBe(-1);

    // ArrowRight wrap -> b1
    fireEvent.keyDown(b3, { key: "ArrowRight" });
    expect(document.activeElement).toBe(b1);
    expect(b1.tabIndex).toBe(0);
    expect(b3.tabIndex).toBe(-1);

    // ArrowLeft wrap -> b3
    fireEvent.keyDown(b1, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(b3);
    expect(b3.tabIndex).toBe(0);
    expect(b1.tabIndex).toBe(-1);

    // ArrowLeft -> b2
    fireEvent.keyDown(b3, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(b2);
    expect(b2.tabIndex).toBe(0);
  });

  it("③ moves to first with Home and last with End", () => {
    render(<TestToolbar buttons={["b1", "b2", "b3"]} />);
    const b1 = screen.getByTestId("b1");
    const b2 = screen.getByTestId("b2");
    const b3 = screen.getByTestId("b3");

    b2.focus();
    fireEvent.focusIn(b2);
    expect(b2.tabIndex).toBe(0);

    // End -> b3
    fireEvent.keyDown(b2, { key: "End" });
    expect(document.activeElement).toBe(b3);
    expect(b3.tabIndex).toBe(0);
    expect(b2.tabIndex).toBe(-1);

    // Home -> b1
    fireEvent.keyDown(b3, { key: "Home" });
    expect(document.activeElement).toBe(b1);
    expect(b1.tabIndex).toBe(0);
    expect(b3.tabIndex).toBe(-1);
  });

  it("④ skips disabled buttons during navigation and tabIndex assignment", () => {
    render(<TestToolbar buttons={["b1", "b2", "b3"]} disabledButtons={["b2"]} />);
    const b1 = screen.getByTestId("b1");
    const b2 = screen.getByTestId("b2") as HTMLButtonElement;
    const b3 = screen.getByTestId("b3");

    expect(b1.tabIndex).toBe(0);
    expect(b2.disabled).toBe(true);
    expect(b3.tabIndex).toBe(-1);

    b1.focus();
    // ArrowRight should skip b2 and go directly to b3
    fireEvent.keyDown(b1, { key: "ArrowRight" });
    expect(document.activeElement).toBe(b3);
    expect(b3.tabIndex).toBe(0);
    expect(b1.tabIndex).toBe(-1);

    // ArrowRight from b3 should wrap back to b1
    fireEvent.keyDown(b3, { key: "ArrowRight" });
    expect(document.activeElement).toBe(b1);

    // ArrowLeft from b1 should wrap to b3
    fireEvent.keyDown(b1, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(b3);
  });

  it("⑤ ignores modifier keys and inputs", () => {
    render(<TestToolbar buttons={["b1", "b2"]} includeInput={true} />);
    const b1 = screen.getByTestId("b1");
    const b2 = screen.getByTestId("b2");
    const input = screen.getByTestId("test-input");

    b1.focus();
    fireEvent.keyDown(b1, { key: "ArrowRight", ctrlKey: true });
    expect(document.activeElement).toBe(b1);

    fireEvent.keyDown(b1, { key: "ArrowRight", metaKey: true });
    expect(document.activeElement).toBe(b1);

    fireEvent.keyDown(b1, { key: "ArrowRight", altKey: true });
    expect(document.activeElement).toBe(b1);

    input.focus();
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(document.activeElement).toBe(input);
    expect(b2.tabIndex).toBe(-1);
  });

  it("⑥ recovers focus when focused button unmounts, and does not steal focus if focus was outside", () => {
    function DynamicHarness() {
      const [items, setItems] = useState(["b1", "b2", "b3"]);
      return (
        <div>
          <button data-testid="outside-btn">Outside</button>
          <button data-testid="remove-b2" onClick={() => setItems(["b1", "b3"])}>
            Remove B2
          </button>
          <button data-testid="remove-b3" onClick={() => setItems(["b1", "b2"])}>
            Remove B3
          </button>
          <TestToolbar buttons={items} />
        </div>
      );
    }

    const { unmount } = render(<DynamicHarness />);
    const b2 = screen.getByTestId("b2");

    // Focus b2 in toolbar
    b2.focus();
    fireEvent.focusIn(b2);
    expect(document.activeElement).toBe(b2);

    // Remove b2 while it had focus
    fireEvent.click(screen.getByTestId("remove-b2"));
    // Since b2 was removed, focus recovery moves focus to the clamped button (b3)
    const b3 = screen.getByTestId("b3");
    expect(document.activeElement).toBe(b3);

    unmount();

    // Now test that focus outside the toolbar is not stolen
    render(<DynamicHarness />);
    const outsideBtn = screen.getByTestId("outside-btn");
    outsideBtn.focus();
    fireEvent.focusIn(outsideBtn);
    expect(document.activeElement).toBe(outsideBtn);

    // Trigger re-render of toolbar by clicking outside button to remove b3
    fireEvent.click(screen.getByTestId("remove-b3"));
    // Toolbar should NOT steal focus from outside element
    expect(document.activeElement).toBe(outsideBtn);
    expect(document.activeElement).not.toBe(screen.getByTestId("b1"));
    expect(document.activeElement).not.toBe(screen.getByTestId("b2"));
  });
});
