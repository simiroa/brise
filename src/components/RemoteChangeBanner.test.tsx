import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";

const reloadActive = vi.fn(async () => {});
const resolveSaveConflict = vi.fn(async (_mode: "copy" | "overwrite") => true);
let activeId: string | undefined = "n1";
let saveConflict: { noteId: string; sectionId: string } | null = null;

vi.mock("../stores/notes", () => ({
  useNotesStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel({ activeNote: activeId ? { note: { id: activeId } } : null, saveConflict }),
    { getState: () => ({ reloadActive, resolveSaveConflict }) },
  ),
}));
vi.mock("../i18n/t", () => ({ t: (k: string) => k }));

import { RemoteChangeBanner, notifyDesktopRemoteChange } from "./RemoteChangeBanner";

describe("RemoteChangeBanner", () => {
  beforeEach(() => {
    cleanup();
    reloadActive.mockClear();
    resolveSaveConflict.mockClear();
    activeId = "n1";
    saveConflict = null;
  });

  it("renders nothing until a remote change is signalled for the open note", () => {
    const { container } = render(<RemoteChangeBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("shows for the open note, hides for another note, and reload calls reloadActive then dismisses", async () => {
    render(<RemoteChangeBanner />);
    act(() => notifyDesktopRemoteChange("other"));
    expect(screen.queryByText("editor.remote_changed")).toBeNull();
    act(() => notifyDesktopRemoteChange("n1"));
    expect(screen.getByText("editor.remote_changed")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText("editor.remote_changed_reload"));
    });
    expect(reloadActive).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("editor.remote_changed")).toBeNull();
  });

  // D2②: 충돌 모드 — 이 기기의 저장이 CONFLICT 로 거부되면 그냥 "다시 불러오기"(내 편집을 버림) 대신 두 버튼.
  it("conflict mode replaces plain reload with copy/overwrite that call resolveSaveConflict", async () => {
    saveConflict = { noteId: "n1", sectionId: "s1" };
    render(<RemoteChangeBanner />);
    act(() => notifyDesktopRemoteChange("n1"));
    expect(screen.getByTestId("save-conflict-banner")).toBeTruthy();
    expect(screen.getByText("editor.save_conflict")).toBeTruthy();
    expect(screen.queryByText("editor.remote_changed_reload")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText("editor.save_conflict_copy"));
    });
    expect(resolveSaveConflict).toHaveBeenLastCalledWith("copy");
    await act(async () => {
      fireEvent.click(screen.getByText("editor.save_conflict_overwrite"));
    });
    expect(resolveSaveConflict).toHaveBeenLastCalledWith("overwrite");
    expect(reloadActive).not.toHaveBeenCalled();
  });

  it("a conflict on another note does not take over this note's banner", () => {
    saveConflict = { noteId: "other", sectionId: "s1" };
    const { container } = render(<RemoteChangeBanner />);
    expect(container.firstChild).toBeNull();
  });
});
