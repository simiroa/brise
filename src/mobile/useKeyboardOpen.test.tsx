import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useKeyboardOpen } from "./useKeyboardOpen";

// jsdom 에는 visualViewport 가 없다 — 높이와 이벤트만 흉내 내는 가짜를 심는다.
class FakeViewport extends EventTarget {
  height = 800;
  offsetTop = 0;
  resizeTo(h: number) {
    this.height = h;
    this.dispatchEvent(new Event("resize"));
  }
}

function Probe() {
  return <div data-testid="kbd">{useKeyboardOpen() ? "open" : "closed"}</div>;
}

describe("useKeyboardOpen — 입력 중 크롬을 숨길지 판단", () => {
  let vv: FakeViewport;
  const original = Object.getOwnPropertyDescriptor(window, "visualViewport");

  beforeEach(() => {
    vv = new FakeViewport();
    Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
  });
  afterEach(() => {
    if (original) Object.defineProperty(window, "visualViewport", original);
    else delete (window as { visualViewport?: unknown }).visualViewport;
    (document.activeElement as HTMLElement | null)?.blur?.();
    document.body.innerHTML = "";
  });

  it("편집 요소에 포커스가 있고 보이는 높이가 크게 줄면 열림, 높이가 돌아오면 닫힘", () => {
    render(<Probe />);
    const input = document.createElement("input");
    document.body.appendChild(input);
    act(() => input.focus());
    expect(screen.getByTestId("kbd").textContent).toBe("closed"); // 아직 높이 그대로

    act(() => vv.resizeTo(450)); // 키보드가 올라옴
    expect(screen.getByTestId("kbd").textContent).toBe("open");

    act(() => vv.resizeTo(800)); // 키보드가 내려감
    expect(screen.getByTestId("kbd").textContent).toBe("closed");
  });

  it("편집 요소에 포커스가 없으면 높이가 줄어도 열림이 아니다(주소창·분할 화면 오인 방지)", () => {
    render(<Probe />);
    act(() => vv.resizeTo(450));
    expect(screen.getByTestId("kbd").textContent).toBe("closed");
  });

  it("체크박스 포커스는 키보드를 띄우지 않으므로 열림이 아니다", () => {
    render(<Probe />);
    const box = document.createElement("input");
    box.type = "checkbox";
    document.body.appendChild(box);
    act(() => box.focus());
    act(() => vv.resizeTo(450));
    expect(screen.getByTestId("kbd").textContent).toBe("closed");
  });
});
