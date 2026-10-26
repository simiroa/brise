import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { NewNotebookModal } from "./NewNotebookModal";
import { t } from "../i18n/t";

describe("NewNotebookModal (PLAN-2026-09-19-notebook-settings §7 Q4)", () => {
  it("starts from defaults and says what follows the notebook vs. the app", async () => {
    const onCreate = vi.fn(async () => {});
    const onClose = vi.fn();
    render(<NewNotebookModal currentName="역사" onCreate={onCreate} onClose={onClose} />);

    expect((screen.getByTestId("new-notebook-defaults") as HTMLInputElement).checked).toBe(true);
    const scope = screen.getByTestId("new-notebook-scope");
    expect(scope.textContent).toContain(t("workspace.new_scope_appearance"));
    expect(scope.textContent).toContain(t("workspace.new_scope_ai_connection"));

    // 이름이 없으면 만들 수 없다.
    expect((screen.getByTestId("new-notebook-create") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("new-notebook-name"), { target: { value: "  여행  " } });
    fireEvent.click(screen.getByTestId("new-notebook-create"));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("여행", false));
    expect(onClose).toHaveBeenCalled();
  });

  it("copies the current notebook's settings when chosen", async () => {
    const onCreate = vi.fn(async () => {});
    render(<NewNotebookModal currentName="역사" onCreate={onCreate} onClose={() => {}} />);
    expect(screen.getByText(t("workspace.new_start_copy", { name: "역사" }))).toBeTruthy();
    fireEvent.click(screen.getByTestId("new-notebook-copy"));
    fireEvent.change(screen.getByTestId("new-notebook-name"), { target: { value: "여행" } });
    fireEvent.keyDown(screen.getByTestId("new-notebook-name"), { key: "Enter" });
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("여행", true));
  });

  it("stays open when creation fails so the user can retry", async () => {
    const onCreate = vi.fn(async () => {
      throw new Error("db");
    });
    const onClose = vi.fn();
    render(<NewNotebookModal currentName={null} onCreate={onCreate} onClose={onClose} />);
    expect(screen.queryByTestId("new-notebook-copy")).toBeNull();
    fireEvent.change(screen.getByTestId("new-notebook-name"), { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("new-notebook-create"));
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    // 실패 처리(바쁨 해제)는 onCreate 의 거절이 처리된 **뒤** 다 — 호출 직후 바로 보면 부하에서 아직 꺼져 있다
    // (2026-10-23 CI 에서 실패). 다시 켜질 때까지 기다린다.
    await waitFor(() => expect((screen.getByTestId("new-notebook-create") as HTMLButtonElement).disabled).toBe(false));
    expect(onClose).not.toHaveBeenCalled();
  });
});
