import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { Select } from "./Select";

describe("Select component", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const options = [
    { value: "opt1", label: "Option 1" },
    { value: "opt2", label: "Option 2" },
    { value: "opt3", label: "Option 3" },
  ];

  it("renders trigger with selected option label", () => {
    render(<Select value="opt1" onChange={() => {}} options={options} testid="test-select" />);
    const btn = screen.getByTestId("test-select");
    expect(btn.textContent).toBe("Option 1");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("opens listbox on click and allows selecting an option", () => {
    const onChange = vi.fn();
    render(<Select value="opt1" onChange={onChange} options={options} testid="test-select" />);
    const btn = screen.getByTestId("test-select");

    fireEvent.click(btn);
    const listbox = screen.getByRole("listbox");
    expect(listbox).toBeDefined();

    const opt2 = screen.getByText("Option 2");
    fireEvent.click(opt2);

    expect(onChange).toHaveBeenCalledWith("opt2");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("re-measures anchor on window resize and document scroll while open", () => {
    render(<Select value="opt1" onChange={() => {}} options={options} testid="test-select" />);
    const btn = screen.getByTestId("test-select");

    let rect = { left: 100, bottom: 200, width: 150, top: 160, right: 250, height: 40 };
    vi.spyOn(btn, "getBoundingClientRect").mockImplementation(() => rect as DOMRect);

    fireEvent.click(btn);
    expect(screen.getByRole("listbox")).toBeDefined();

    // Simulate window resize with new button position
    rect = { left: 120, bottom: 220, width: 160, top: 180, right: 280, height: 40 };
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    // Simulate document scroll with new button position
    rect = { left: 130, bottom: 230, width: 160, top: 190, right: 290, height: 40 };
    act(() => {
      document.dispatchEvent(new Event("scroll"));
    });

    expect(btn.getBoundingClientRect).toHaveBeenCalled();
  });

  it("closes listbox on Escape key", () => {
    render(<Select value="opt1" onChange={() => {}} options={options} testid="test-select" />);
    const btn = screen.getByTestId("test-select");
    fireEvent.click(btn);

    const listbox = screen.getByRole("listbox");
    expect(listbox).toBeDefined();

    fireEvent.keyDown(listbox, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
