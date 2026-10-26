import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AskAiContextStrip, type CtxListItem } from "./AskAiContextStrip";
import type { CtxRef } from "./composer/types";

const describeRef = (ref: CtxRef) =>
  ref.k === "body"
    ? { label: "2022 중간 점검", size: "4 sections · 1,846 chars" }
    : ref.k === "folder"
      ? { label: "유럽", size: "3 notes" }
      : { label: ref.k };

const items: CtxListItem[] = [
  { ref: { k: "body" }, active: true },
  { ref: { k: "folder", id: "f1" }, active: false, removable: true },
];

function setup(over: Partial<React.ComponentProps<typeof AskAiContextStrip>> = {}) {
  const props = { items, describeRef, onToggle: vi.fn(), onRemove: vi.fn(), ...over };
  return { ...render(<AskAiContextStrip {...props} />), props };
}

describe("AskAiContextStrip", () => {
  it("renders label + size per item; the first one carries the note identity (D19)", () => {
    setup();
    const body = screen.getByTestId("askai-ctx-body-0");
    expect(body.textContent).toContain("2022 중간 점검");
    expect(body.querySelector("b")?.textContent).toContain("1,846 chars");
    expect(screen.getByTestId("askai-ctx-folder-1").textContent).toContain("유럽");
  });

  it("clicking an item toggles it; inactive items are marked, not removed (D14)", () => {
    const { props } = setup();
    fireEvent.click(screen.getByTestId("askai-ctx-body-0"));
    expect(props.onToggle).toHaveBeenCalledWith(0);
    expect(screen.getByTestId("askai-ctx-body-0").dataset.active).toBeUndefined();
    expect(screen.getByTestId("askai-ctx-body-0").getAttribute("aria-pressed")).toBe("true");
    const folder = screen.getByTestId("askai-ctx-folder-1");
    expect(folder.dataset.active).toBe("false");
    expect(folder.getAttribute("aria-pressed")).toBe("false");
  });

  it("only user-added items get the ✕", () => {
    const { props } = setup();
    expect(screen.getAllByRole("button", { name: /Remove/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Remove 유럽/ }));
    expect(props.onRemove).toHaveBeenCalledWith(1);
  });

  it("renders nothing when the list is empty (new-draft target)", () => {
    const { container } = setup({ items: [] });
    expect(container.querySelector(".askai-ctxstrip")).toBeNull();
  });
});
