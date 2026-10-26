import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewFolderDialog } from "./NewFolderDialog";

describe("NewFolderDialog", () => {
  it("submits name, picked icon, and color together (ai off → null rules)", async () => {
    const onSubmit = vi.fn();
    render(<NewFolderDialog aiEnabled={false} onCancel={() => {}} onSubmit={onSubmit} />);

    await userEvent.type(screen.getByTestId("new-folder-name"), "여행");
    await userEvent.click(screen.getByTestId("new-folder-icon-toggle"));
    await userEvent.click(screen.getByRole("button", { name: "map" }));
    await userEvent.click(screen.getByRole("button", { name: "90°" }));
    await userEvent.click(screen.getByTestId("new-folder-submit"));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "여행",
      icon: "map",
      colorHue: 90,
      rules: null,
    });
  });

  it("does not submit an empty name", async () => {
    const onSubmit = vi.fn();
    render(<NewFolderDialog onCancel={() => {}} onSubmit={onSubmit} />);
    expect((screen.getByTestId("new-folder-submit") as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByTestId("new-folder-submit"));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("hides rules field when ai is disabled", () => {
    render(<NewFolderDialog aiEnabled={false} onCancel={() => {}} onSubmit={() => {}} />);
    expect(screen.queryByTestId("new-folder-rules")).toBeNull();
  });

  it("shows rules field when ai is enabled and submits trimmed rules", async () => {
    const onSubmit = vi.fn();
    render(<NewFolderDialog aiEnabled onCancel={() => {}} onSubmit={onSubmit} />);

    const rules = screen.getByTestId("new-folder-rules") as HTMLTextAreaElement;
    expect(rules).toBeTruthy();
    await userEvent.type(screen.getByTestId("new-folder-name"), "레시피");
    await userEvent.type(
      rules,
      "   레시피 관련은 한국어로만 정리. 분량은 200자 내외.   "
    );
    await userEvent.click(screen.getByTestId("new-folder-submit"));

    expect(onSubmit).toHaveBeenCalledWith({
      name: "레시피",
      icon: null,
      colorHue: null,
      rules: "레시피 관련은 한국어로만 정리. 분량은 200자 내외.",
    });
  });

  it("disables submit when rules exceed the 4096-char cap", async () => {
    const onSubmit = vi.fn();
    render(<NewFolderDialog aiEnabled onCancel={() => {}} onSubmit={onSubmit} />);

    await userEvent.type(screen.getByTestId("new-folder-name"), "x");
    fireEvent.change(screen.getByTestId("new-folder-rules"), {
      target: { value: "a".repeat(4097) },
    });
    expect((screen.getByTestId("new-folder-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("toggles the icon picker popover on click", async () => {
    render(<NewFolderDialog onCancel={() => {}} onSubmit={() => {}} />);
    expect(screen.queryByRole("button", { name: "map" })).toBeNull();
    await userEvent.click(screen.getByTestId("new-folder-icon-toggle"));
    expect(screen.getByRole("button", { name: "map" })).toBeTruthy();
    await userEvent.click(screen.getByTestId("new-folder-icon-toggle"));
    expect(screen.queryByRole("button", { name: "map" })).toBeNull();
  });

  it("dismisses the popover on outside click", async () => {
    render(<NewFolderDialog onCancel={() => {}} onSubmit={() => {}} />);
    await userEvent.click(screen.getByTestId("new-folder-icon-toggle"));
    expect(screen.getByRole("button", { name: "map" })).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("button", { name: "map" })).toBeNull();
  });
});