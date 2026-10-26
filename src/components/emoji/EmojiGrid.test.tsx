import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { EmojiGrid } from "./EmojiGrid";

// 2026-08: 3d/animated 스타일 제거로 탭 스트립 자체가 없어졌다 — 남는 건 다운로드 배너 + 그리드뿐.
vi.mock("../../lib/invoke", () => ({
  call: vi.fn((cmd: string) => {
    if (cmd === "emoji_style_status") {
      return Promise.resolve({ color: { present: true, downloading: false, progress_pct: null } });
    }
    return Promise.resolve({});
  }),
  callSilent: vi.fn((cmd: string) => {
    if (cmd === "emoji_style_status") {
      return Promise.resolve({ color: { present: true, downloading: false, progress_pct: null } });
    }
    return Promise.resolve({});
  }),
}));

describe("EmojiGrid", () => {
  it("renders the grid and picks an emoji", async () => {
    const onPick = vi.fn();
    render(<EmojiGrid onPick={onPick} />);
    await waitFor(() => expect(screen.queryAllByRole("button").length).toBeGreaterThan(0));

    // No style tab strip left — just the group tabs + grid.
    expect(screen.queryByRole("tab", { name: /3D/ })).toBeNull();
    expect(screen.queryByRole("tab", { name: /Animated/ })).toBeNull();
  });

  it("keeps category tabs above the pick grid (no extra favorite/recent rows)", async () => {
    render(<EmojiGrid onPick={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("tablist")).toBeTruthy());

    const tablist = screen.getByRole("tablist");
    const grid = screen.getByTestId("emoji-pick-grid");
    expect(tablist.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.querySelector(".emoji-row")).toBeNull();
  });
});
