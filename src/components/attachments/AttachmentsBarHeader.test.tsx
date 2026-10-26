import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AttachmentsBarHeader } from "./AttachmentsBarHeader";

describe("AttachmentsBarHeader", () => {
  it("renders header with tabs, count, and triggers collapse toggle and tab change", async () => {
    const user = userEvent.setup();
    const onToggleCollapse = vi.fn();
    const onExpand = vi.fn();
    const onSelectTab = vi.fn();
    const onRestoreHidden = vi.fn();

    render(
      <AttachmentsBarHeader
        attachmentsCollapsed={false}
        attachmentsTab="attachments"
        busy={false}
        itemCount={5}
        hiddenCount={0}
        onToggleCollapse={onToggleCollapse}
        onExpand={onExpand}
        onSelectTab={onSelectTab}
        onRestoreHidden={onRestoreHidden}
      />
    );

    expect(screen.getByText("5 items")).toBeTruthy();

    const chevron = screen.getByRole("button", { name: /collapse/i });
    await user.click(chevron);
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);

    const relatedTab = screen.getByText("Related notes");
    await user.click(relatedTab);
    expect(onSelectTab).toHaveBeenCalledWith("related");
  });

  it("renders restore hidden button when on related tab and hiddenCount > 0", async () => {
    const user = userEvent.setup();
    const onRestoreHidden = vi.fn();

    render(
      <AttachmentsBarHeader
        attachmentsCollapsed={false}
        attachmentsTab="related"
        busy={false}
        itemCount={2}
        hiddenCount={3}
        onToggleCollapse={vi.fn()}
        onExpand={vi.fn()}
        onSelectTab={vi.fn()}
        onRestoreHidden={onRestoreHidden}
      />
    );

    const restoreBtn = screen.getByRole("button", { name: /Restore 3 hidden/i });
    expect(restoreBtn).toBeTruthy();
    await user.click(restoreBtn);
    expect(onRestoreHidden).toHaveBeenCalledTimes(1);
  });
});
