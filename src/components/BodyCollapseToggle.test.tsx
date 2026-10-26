import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useUiStore } from "../stores/ui";
import { BodyCollapseToggle } from "./BodyCollapseToggle";

// A2: 접는 대상(어시스트·첨부)이 집중 모드에선 이미 숨어 있으므로 토글 자체를 숨긴다.
afterEach(() => {
  cleanup();
  useUiStore.setState({ focusMode: false, previewCollapsed: false, attachmentsCollapsed: false });
});

describe("BodyCollapseToggle", () => {
  it("focusMode 일 때는 렌더하지 않는다", () => {
    useUiStore.setState({ focusMode: true });
    const { container } = render(<BodyCollapseToggle />);
    expect(container.firstChild).toBeNull();
  });

  it("focusMode 가 아니면 버튼을 렌더한다", () => {
    useUiStore.setState({ focusMode: false });
    render(<BodyCollapseToggle />);
    expect(screen.getByTestId("body-collapse-toggle")).not.toBeNull();
  });
});
