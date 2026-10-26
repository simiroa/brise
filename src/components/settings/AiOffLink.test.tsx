import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useSettingsStore } from "../../stores/settings";
import { AiOffLink } from "./AiOffLink";

// PLAN-2026-10-24 D7: 켜기 버튼이 아니라 AI 제공자 페이지로 가는 링크 한 줄.
describe("AiOffLink", () => {
  beforeEach(() => {
    useSettingsStore.setState({ aiEnabled: false } as any);
  });

  it("AI 가 켜져 있으면 아무것도 그리지 않는다", () => {
    useSettingsStore.setState({ aiEnabled: true } as any);
    const { container } = render(<AiOffLink onNavigate={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("꺼져 있으면 한 줄과 링크를 그리고, 링크는 ai 페이지로 보낸다", () => {
    const onNavigate = vi.fn();
    render(<AiOffLink onNavigate={onNavigate} />);
    expect(screen.getByTestId("ai-off-link")).toBeTruthy();
    fireEvent.click(screen.getByTestId("ai-off-link-go"));
    expect(onNavigate).toHaveBeenCalledWith("ai");
  });

  it("onNavigate 가 없으면 문구만 그린다", () => {
    render(<AiOffLink />);
    expect(screen.getByTestId("ai-off-link")).toBeTruthy();
    expect(screen.queryByTestId("ai-off-link-go")).toBeNull();
  });
});
