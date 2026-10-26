import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TreeRowBadges } from "./TreeRowBadges";

// 우측 배지 슬롯 계약: 상태 점은 항상 보이고, 내보내기/즐겨찾기는 hover 시에만 드러난다
// (실제 hover CSS 는 treeRow.css/tokens.css 소관이라 jsdom 에서 재현할 수 없다 — 여기서는
// 그 CSS 가 잡을 수 있도록 만든 구조 계약만 검증한다: 상태 점은 hover 래퍼(.treeact) 밖에,
// 나머지는 안에 있고, 슬롯 폭은 배지 조합과 무관하게 고정이다).
describe("TreeRowBadges", () => {
  it("renders nothing when status/export/favorite/image/tags are all absent", () => {
    const { container } = render(<TreeRowBadges />);
    expect(container.firstChild).toBeNull();
  });

  // hasImage/tagNames 는 넘어오지만 그리는 게 없다 — 폭 고정 슬롯이 된 뒤로는 이 둘만 있는
  // 노트가 영영 빈 여백을 차지하면 안 된다(예전엔 빈 프래그먼트라 자리를 안 먹었다).
  it("renders nothing for a note that only has tags or an image", () => {
    const { container } = render(<TreeRowBadges hasImage tagNames={["여행", "2024"]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the status dot always, outside the hover-reveal wrapper", () => {
    const { container } = render(<TreeRowBadges status="in_progress" />);
    const dot = screen.getByTestId("treerow-status-indicator");
    const hoverWrap = container.querySelector(".treeact");
    expect(hoverWrap).not.toBeNull();
    expect(hoverWrap!.contains(dot)).toBe(false);
    // status-only: nothing for the hover wrapper to reveal.
    expect(hoverWrap!.children.length).toBe(0);
  });

  it("puts the exported icon and favorite star inside the hover-reveal wrapper", () => {
    const { container } = render(
      <TreeRowBadges status="in_progress" exportedAt="2024-01-01T00:00:00Z" isFavorite />
    );
    const hoverWrap = container.querySelector(".treeact");
    expect(hoverWrap).not.toBeNull();
    // exported icon renders as a titled span, favorite star as an svg — both inside .treeact.
    expect(hoverWrap!.querySelector("[title]")).not.toBeNull();
    expect(hoverWrap!.querySelector("svg")).not.toBeNull();
  });

  it("keeps the slot width fixed whether one badge or all of them are showing", () => {
    const { unmount } = render(<TreeRowBadges status="in_progress" />);
    const widthStatusOnly = screen.getByTestId("tree-badges-slot").style.width;
    unmount();

    render(<TreeRowBadges status="in_progress" exportedAt="2024-01-01T00:00:00Z" isFavorite />);
    const widthAll = screen.getByTestId("tree-badges-slot").style.width;

    expect(widthStatusOnly).not.toBe("");
    expect(widthStatusOnly).toBe(widthAll);
  });

  it("renders only the favorite star when export/status/image/tags are absent (no status dot)", () => {
    render(<TreeRowBadges isFavorite />);
    expect(screen.queryByTestId("treerow-status-indicator")).toBeNull();
    expect(screen.getByTestId("tree-badges-slot").querySelector("svg")).not.toBeNull();
  });
});
