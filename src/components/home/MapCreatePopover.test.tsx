import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MapCreatePopover } from "./MapCreatePopover";

describe("MapCreatePopover", () => {
  it("renders label and wires confirm/cancel", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { getByTestId } = render(
      <MapCreatePopover
        pin={{ lat: 33.5, lng: 126.5, clientX: 100, clientY: 100, label: "Jeju" }}
        creating={false}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );

    expect(getByTestId("home-map-create-popover").textContent).toContain("Jeju");
    fireEvent.click(getByTestId("home-map-create-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(getByTestId("home-map-create-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("Escape cancels", () => {
    const onCancel = vi.fn();
    render(
      <MapCreatePopover
        pin={{ lat: 1, lng: 2, clientX: 10, clientY: 10 }}
        creating={false}
        onConfirm={() => {}}
        onCancel={onCancel}
      />
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });
});
