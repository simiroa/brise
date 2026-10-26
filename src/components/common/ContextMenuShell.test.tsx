import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ContextMenuShell } from "./ContextMenuShell";

const rows = (
  <>
    <button className="menu-row">a</button>
    <button className="menu-row">b</button>
  </>
);

describe("ContextMenuShell autoFocusFirst", () => {
  it("첫 행에 포커스를 주고 ↓/↑ 로 순환한다", async () => {
    render(
      <ContextMenuShell anchor={{ x: 10, y: 10 }} onClose={() => {}} autoFocusFirst>
        {rows}
      </ContextMenuShell>
    );
    await act(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    expect(document.activeElement).toBe(screen.getByText("a"));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByText("b"));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByText("a"));
  });

  const three = (
    <>
      <button className="menu-row">Apple</button>
      <button className="menu-row">Banana</button>
      <button className="menu-row">Blueberry</button>
    </>
  );
  const open = async (on = true) => {
    render(
      <ContextMenuShell anchor={{ x: 10, y: 10 }} onClose={() => {}} autoFocusFirst={on}>
        {three}
      </ContextMenuShell>
    );
    await act(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    return screen.getByRole("menu");
  };

  it("Home/End 로 처음/끝 행", async () => {
    const m = await open();
    fireEvent.keyDown(m, { key: "End" });
    expect(document.activeElement).toBe(screen.getByText("Blueberry"));
    fireEvent.keyDown(m, { key: "Home" });
    expect(document.activeElement).toBe(screen.getByText("Apple"));
  });

  it("type-ahead: 글자·누적 접두사로 이동", async () => {
    const m = await open();
    fireEvent.keyDown(m, { key: "b" });
    expect(document.activeElement).toBe(screen.getByText("Banana"));
    fireEvent.keyDown(m, { key: "b" }); // 500ms 안 연속 -> "bb" 는 없음, 이동 없음
    expect(document.activeElement).toBe(screen.getByText("Banana"));
    fireEvent.keyDown(m, { key: "l" }); // "bbl" 도 없음
    expect(document.activeElement).toBe(screen.getByText("Banana"));
  });

  it("type-ahead: 접두사 누적으로 Blueberry", async () => {
    const m = await open();
    fireEvent.keyDown(m, { key: "b" });
    fireEvent.keyDown(m, { key: "l" });
    expect(document.activeElement).toBe(screen.getByText("Blueberry"));
  });

  it("IME 조합 중엔 무시", async () => {
    const m = await open();
    fireEvent.keyDown(m, { key: "End", isComposing: true });
    fireEvent.keyDown(m, { key: "b", isComposing: true });
    expect(document.activeElement).toBe(screen.getByText("Apple"));
  });

  it("꺼져 있으면 Home/글자 무동작", async () => {
    const m = await open(false);
    fireEvent.keyDown(m, { key: "End" });
    fireEvent.keyDown(m, { key: "b" });
    expect(document.activeElement).toBe(document.body);
  });

  it("기본은 꺼져 있다 — 포커스를 가져가지 않는다", async () => {
    render(
      <ContextMenuShell anchor={{ x: 10, y: 10 }} onClose={() => {}}>
        {rows}
      </ContextMenuShell>
    );
    await act(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    expect(document.activeElement).toBe(document.body);
  });
});
