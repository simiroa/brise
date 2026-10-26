import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PromptDialog } from "./PromptDialog";

// Safety-bug regression (owner-approved fix): mode="confirm"'s global Enter listener used to fire
// onSubmit no matter what had focus. A keyboard user who tabbed to Cancel and pressed Enter got
// the native button click (onCancel) AND the listener's onSubmit — onSubmit winning the race is
// the exact bug. Enter must CANCEL when Cancel is focused, and still SUBMIT everywhere else
// (default open focus, or the Confirm button focused).
describe("PromptDialog — mode=confirm Enter-key safety", () => {
  it("Enter with Cancel focused calls onCancel, not onSubmit", async () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <PromptDialog title="Delete?" mode="confirm" onSubmit={onSubmit} onCancel={onCancel} />
    );

    // userEvent (unlike fireEvent) synthesizes the browser's native Enter-triggers-click on a
    // focused button — the same path the real bug raced against, so this exercises the fix
    // end-to-end rather than just checking the guard didn't fire.
    screen.getByRole("button", { name: "Cancel" }).focus();
    await userEvent.keyboard("{Enter}");

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("Enter with default focus (nothing explicitly focused) calls onSubmit", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <PromptDialog title="Delete?" mode="confirm" onSubmit={onSubmit} onCancel={onCancel} />
    );

    fireEvent.keyDown(window, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith("");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("Enter with Confirm focused calls onSubmit", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <PromptDialog title="Delete?" mode="confirm" onSubmit={onSubmit} onCancel={onCancel} />
    );

    screen.getByRole("button", { name: "Apply" }).focus();
    fireEvent.keyDown(window, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith("");
    expect(onCancel).not.toHaveBeenCalled();
  });
});

// 2026-09-12 안전 회귀: 위 가드는 "Cancel 이 포커스일 때만" Enter 를 넘기는데, ModalShell 이 열릴
// 때 포커스를 **카드**에 주므로 기본 상태에서는 아무 조작 없이 Enter 한 번이 곧 확인이었다.
// 네이티브 파일 다이얼로그를 Enter 로 닫은 직후 그 키의 후속 입력만으로 백업 복원(DB 통째
// 덮어쓰기)과 노트북 교체가 실행되는 것이 실제로 재현됐다. 파괴적 확인은 취소에 포커스를 두고
// 연다 — 위험하지 않은 확인은 Enter 로 넘기는 편의가 더 크므로 danger 일 때만이다.
describe("PromptDialog — danger 확인은 취소에 포커스를 두고 연다", () => {
  it("danger 확인은 열자마자 취소에 포커스가 있어, 맨 Enter 가 확인하지 않는다", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <PromptDialog title="Restore?" mode="confirm" danger onSubmit={onSubmit} onCancel={onCancel} />
    );

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));

    // 창 레벨 리스너가 붙어 있으므로 window 로 쏜다 — 실제 사고 경로와 같다.
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("위험하지 않은 확인은 종전대로 Enter 로 넘어간다", () => {
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    render(
      <PromptDialog title="Continue?" mode="confirm" onSubmit={onSubmit} onCancel={onCancel} />
    );

    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
