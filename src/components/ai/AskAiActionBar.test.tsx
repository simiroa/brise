import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AskAiActionBar, type AskAiActionBarProps } from "./AskAiActionBar";
import type { WhereOption } from "./askAiDispatch";

const options: WhereOption[] = [
  { value: "section", label: "New section" },
  { value: "note", label: "New note" },
  { value: "replace", label: "Replace selection", disabled: true, hint: "Selection gone" },
];

function setup(over: Partial<AskAiActionBarProps> = {}) {
  const props: AskAiActionBarProps = {
    where: "section",
    options,
    onWhere: vi.fn(),
    folderId: "f-1",
    folders: [
      { id: "f-1", name: "Inbox" },
      { id: "f-2", name: "Work" },
    ],
    onFolder: vi.fn(),
    attachedCount: 0,
    onAttach: vi.fn(),
    canSend: true,
    sendLabel: "Send",
    onSend: vi.fn(),
    ...over,
  };
  render(<AskAiActionBar {...props} />);
  return props;
}

describe("AskAiActionBar", () => {
  it("renders the where options; a disabled option carries its hint as title", () => {
    setup();
    expect(screen.getByTestId("askai-where").textContent).toBe("New section");
    fireEvent.click(screen.getByTestId("askai-where"));
    const rows = screen.getAllByRole("option");
    expect(rows.map((r) => r.textContent)).toEqual(["New section", "New note", "Replace selection"]);
    const disabled = rows[2];
    expect(disabled.getAttribute("aria-disabled")).toBe("true");
    expect(disabled.getAttribute("title")).toBe("Selection gone");
  });

  it("choosing an option fires onWhere; the folder select appears only for where=note", () => {
    const p = setup();
    expect(screen.queryByTestId("askai-folder")).toBeNull();
    fireEvent.click(screen.getByTestId("askai-where"));
    fireEvent.click(screen.getByText("New note"));
    expect(p.onWhere).toHaveBeenCalledWith("note");
  });

  it("where=note shows the folder select and onFolder fires", () => {
    const p = setup({ where: "note" });
    const folder = screen.getByTestId("askai-folder");
    expect(folder.textContent).toBe("Inbox");
    fireEvent.click(folder);
    fireEvent.click(screen.getByText("Work"));
    expect(p.onFolder).toHaveBeenCalledWith("f-2");
  });

  it("fixedLabel replaces the dropdown with a dashed pill", () => {
    setup({ fixedLabel: "Suggest tags" });
    expect(screen.queryByTestId("askai-where")).toBeNull();
    const pill = screen.getByTestId("askai-fixed-where");
    expect(pill.textContent).toContain("Review before applying");
    expect(pill.getAttribute("title")).toBe("Suggest tags");
  });

  it("send button: disabled when !canSend, fires onSend otherwise; attach fires onAttach", () => {
    const p = setup({ canSend: false });
    const send = screen.getByText("Send").closest("button")!;
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    expect(p.onSend).not.toHaveBeenCalled();
  });

  it("send + attach + history callbacks", () => {
    const onHistory = vi.fn();
    const p = setup({ attachedCount: 2, onHistory });
    fireEvent.click(screen.getByText("Send").closest("button")!);
    expect(p.onSend).toHaveBeenCalled();
    const attach = screen.getByLabelText("Attach files");
    expect(attach.textContent).toContain("2");
    fireEvent.click(attach);
    expect(p.onAttach).toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Open full history"));
    expect(onHistory).toHaveBeenCalled();
  });
});
