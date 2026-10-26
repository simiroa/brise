import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ModalShell } from "./ModalShell";
// 2026-08-14: <dialog>.showModal() 을 버려서 jsdom 폴리필이 더는 필요 없다(삭제됨) —
// 스크림도 카드도 평범한 div 라 jsdom 이 그대로 렌더한다.

describe("ModalShell", () => {
  it("renders children and title", () => {
    const handleClose = vi.fn();
    render(
      <ModalShell title="Test Modal" onClose={handleClose}>
        <div data-testid="test-child">Child Content</div>
      </ModalShell>
    );

    expect(screen.getByText("Test Modal")).toBeTruthy();
    expect(screen.getByTestId("test-child")).toBeTruthy();
    expect(screen.getByText("Child Content")).toBeTruthy();
  });

  it("closes on close button click", () => {
    const handleClose = vi.fn();
    render(
      <ModalShell title="Test Modal" onClose={handleClose}>
        <div>Content</div>
      </ModalShell>
    );

    fireEvent.click(screen.getByTestId("modal-close-btn"));
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it("closes on backdrop click", () => {
    const handleClose = vi.fn();
    render(
      <ModalShell title="Test Modal" onClose={handleClose}>
        <div>Content</div>
      </ModalShell>
    );

    // The <dialog> element itself IS the backdrop surface now (native ::backdrop is a pseudo
    // element with no DOM node of its own) — a click landing directly on it (not on the modal
    // sheet's inner div, which stops propagation) means "outside the card".
    fireEvent.click(screen.getByTestId("modal-backdrop"));
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it("does not close on shell click", () => {
    const handleClose = vi.fn();
    render(
      <ModalShell title="Test Modal" onClose={handleClose}>
        <div>Content</div>
      </ModalShell>
    );

    fireEvent.click(screen.getByTestId("modal-shell"));
    expect(handleClose).not.toHaveBeenCalled();
  });

  it("closes on Escape key press", () => {
    const handleClose = vi.fn();
    render(
      <ModalShell title="Test Modal" onClose={handleClose}>
        <div>Content</div>
      </ModalShell>
    );

    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  // 온보딩처럼 길게 입력하는 흐름 — 바깥 클릭·Escape 로 통째로 닫히면 안 된다. X 만 닫는다.
  it("dismissible={false}: backdrop click and Escape do not close, the X still does", () => {
    const handleClose = vi.fn();
    render(
      <ModalShell title="Test Modal" onClose={handleClose} dismissible={false}>
        <div>Content</div>
      </ModalShell>
    );

    fireEvent.click(screen.getByTestId("modal-backdrop"));
    const esc = fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    expect(handleClose).not.toHaveBeenCalled();
    // Escape 는 삼킨다 — 뒤의 앱(집중 모드 탈출 등)으로 새지 않게.
    expect(esc).toBe(false);

    fireEvent.click(screen.getByTestId("modal-close-btn"));
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it("busy: X·바깥 클릭·Escape 어느 길로도 닫히지 않고, 끝나면 다시 닫힌다", () => {
    const handleClose = vi.fn();
    const { rerender } = render(
      <ModalShell title="Test Modal" onClose={handleClose} busy>
        <div>Content</div>
      </ModalShell>
    );
    const x = screen.getByTestId("modal-close-btn") as HTMLButtonElement;
    expect(x.disabled).toBe(true);
    fireEvent.click(x);
    fireEvent.click(screen.getByTestId("modal-backdrop"));
    expect(fireEvent.keyDown(window, { key: "Escape", code: "Escape" })).toBe(false);
    // 두 번째 Escape 도 이 모달이 삼킨다 — 스택에서 빠져 아래 창으로 새지 않는다.
    expect(fireEvent.keyDown(window, { key: "Escape", code: "Escape" })).toBe(false);
    expect(handleClose).not.toHaveBeenCalled();

    rerender(
      <ModalShell title="Test Modal" onClose={handleClose} busy={false}>
        <div>Content</div>
      </ModalShell>
    );
    expect(x.disabled).toBe(false);
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  it("exposes dialog semantics for assistive tech", () => {
    render(
      <ModalShell title="Test Modal" onClose={vi.fn()}>
        <div>Content</div>
      </ModalShell>
    );
    // 2026-08-14: top layer 를 버리면서 role/aria-modal/aria-label 은 스크림이 아니라 **카드**가
    // 소유한다(대화상자 = 카드). 스크림은 배경·바깥클릭 담당 div 일 뿐이다.
    const dialog = screen.getByTestId("modal-shell");
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBe("Test Modal");
  });

  it("close control is a real button with an accessible label", () => {
    render(
      <ModalShell title="Test Modal" onClose={vi.fn()}>
        <div>Content</div>
      </ModalShell>
    );
    const closeBtn = screen.getByTestId("modal-close-btn");
    expect(closeBtn.tagName).toBe("BUTTON");
    expect(closeBtn.getAttribute("aria-label")).toBeTruthy();
  });

  it("moves focus into the dialog on open and restores it on close", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = render(
      <ModalShell title="Test Modal" onClose={vi.fn()}>
        <button data-testid="inner-btn">Inner</button>
      </ModalShell>
    );
    // focus moved into the dialog (first focusable — the close button)
    expect(document.body.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(trigger);
    expect(screen.getByTestId("modal-shell").contains(document.activeElement)).toBe(true);

    unmount();
    // focus restored to the trigger
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
  // 2026-09-09 회귀: 두 셸이 **같은 커밋**에서 마운트되면 예전 구현은 서로의 스크림에 inert 를
  // 걸어 두 장 다 죽였다 — 모달은 보이는데 아무것도 눌리지 않는 화면 전체 먹통(폴더 설정 +
  // AI 정리 제안 검토가 함께 뜬 실제 사고). 규칙은 언제나 "맨 위 한 장만 살아 있다"이다.
  it("keeps only the top shell interactive when two mount in one commit", () => {
    const Two = () => (
      <>
        <ModalShell title="outer" onClose={vi.fn()}>outer</ModalShell>
        <ModalShell title="inner" onClose={vi.fn()}>inner</ModalShell>
      </>
    );
    const { unmount } = render(<Two />);
    const scrims = Array.from(document.querySelectorAll(".modal-scrim"));
    expect(scrims).toHaveLength(2);
    expect(scrims[0].hasAttribute("inert")).toBe(true);
    expect(scrims[1].hasAttribute("inert")).toBe(false);
    unmount();
    // 전부 닫히면 바깥 트리의 inert 도 남지 않는다.
    expect(document.querySelectorAll("[inert]")).toHaveLength(0);
  });

  it("hands the top back to the outer shell when the inner closes", () => {
    const Nested = ({ inner }: { inner: boolean }) => (
      <>
        <ModalShell title="outer" onClose={vi.fn()}>outer</ModalShell>
        {inner ? <ModalShell title="inner" onClose={vi.fn()}>inner</ModalShell> : null}
      </>
    );
    const { rerender } = render(<Nested inner />);
    rerender(<Nested inner={false} />);
    const scrims = Array.from(document.querySelectorAll(".modal-scrim"));
    expect(scrims).toHaveLength(1);
    expect(scrims[0].hasAttribute("inert")).toBe(false);
  });
});
