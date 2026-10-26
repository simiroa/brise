import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FolderOrganizeModal } from "./FolderOrganizeModal";
import { useNotesStore } from "../stores/notes";
import { useUiStore } from "../stores/ui";
import { useSettingsStore } from "../stores/settings";

const callMock = vi.fn();

vi.mock("../lib/invoke", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/invoke")>();
  return {
    ...actual,
    call: (...args: unknown[]) => callMock(...args),
    callSilent: (...args: unknown[]) => callMock(...args),
    emitNotice: vi.fn(),
  };
});

describe("FolderOrganizeModal", () => {
  beforeEach(() => {
    callMock.mockReset();
    callMock.mockImplementation((cmd: string) => {
      if (cmd === "note_query") return Promise.resolve({ notes: [{ id: "n1", title: "Alpha" }], total: 1 });
      if (cmd === "folder_set_rules") return Promise.resolve({ id: "f1", rules: "use years" });
      if (cmd === "folder_rename") return Promise.resolve({ id: "f1", name: "Renamed" });
      if (cmd === "folder_set_exclusions") return Promise.resolve({ id: "f1", search_excluded: true, ai_excluded: false });
      return Promise.resolve({});
    });
    useUiStore.setState({ folderFilesOpen: "f1" });
    useSettingsStore.setState({ aiEnabled: true, uiLang: "ko" });
    useNotesStore.setState({
      folders: [{
        id: "f1",
        workspace_id: "ws",
        name: "Notes",
        position: 0,
        is_open: true,
        note_count: 1,
        color_hue: null,
        icon: null,
        rules: "keep titles short",
        search_excluded: false,
        ai_excluded: false,
      }],
      loadTree: vi.fn(),
    } as never);
  });

  it("edits name, color, and inherited rules and lists notes for batch work", async () => {
    render(<FolderOrganizeModal />);
    expect(screen.getByText("폴더 설정")).toBeTruthy();
    expect(await screen.findByText("Alpha")).toBeTruthy();

    const rules = screen.getByPlaceholderText(/상속/) as HTMLTextAreaElement;
    expect(rules.value).toBe("keep titles short");
    fireEvent.change(rules, { target: { value: "prefer the year in the title" } });
    fireEvent.blur(rules);
    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("folder_set_rules", {
        id: "f1",
        rules: "prefer the year in the title",
      });
    });

    // 노트 행은 체크박스가 아니라 앱의 다른 목록과 같은 행(아이콘 + 이름)이고, 눌리면 선택된다.
    const noteRow = screen.getByRole("button", { name: "Alpha" });
    expect(noteRow.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(noteRow);
    expect(screen.getByRole("button", { name: "Alpha" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Alpha" }).getAttribute("data-selected")).toBe("true");
    expect((screen.getByRole("button", { name: "선택 AI 정리" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("toggling one exclusion control sends both booleans via a single folder_set_exclusions call", async () => {
    render(<FolderOrganizeModal />);
    await screen.findByText("Alpha");

    // 설명은 지운 게 아니라 "?" 툴팁으로 옮겼다 — 사라지면 사용자는 두 스위치의 차이를 알 길이 없다.
    expect(
      screen.getByRole("img", { name: /전체 검색 결과에서 숨깁니다/ }).getAttribute("title")
    ).toMatch(/전체 검색 결과에서 숨깁니다/);
    expect(screen.getByRole("img", { name: /AI가 읽지 않습니다/ })).toBeTruthy();

    fireEvent.click(screen.getByTestId("folder-search-excluded-toggle"));

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("folder_set_exclusions", {
        id: "f1",
        search_excluded: true,
        ai_excluded: false,
      });
    });
  });

  // folder_set_icon had no caller at all before this — a folder icon could be chosen in
  // NewFolderDialog at creation and then never changed again.
  it("picking a folder icon persists it via folder_set_icon", async () => {
    render(<FolderOrganizeModal />);
    await screen.findByText("Alpha");

    fireEvent.click(screen.getByTestId("folder-icon-toggle"));
    // 노트 아이콘 메뉴와 같은 껍데기로 떠야 한다 — 인라인 확장이 아니라 portal 팝오버.
    expect(screen.getByTestId("icon-picker-popover")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "star" }));

    await waitFor(() => {
      expect(callMock).toHaveBeenCalledWith("folder_set_icon", { id: "f1", icon: "star" });
    });
  });

  it("handles inbox folder: disables name editing and displays inbox title", async () => {
    useUiStore.setState({ folderFilesOpen: "inbox-1" });
    useNotesStore.setState({
      inboxId: "inbox-1",
      folders: [{
        id: "inbox-1",
        workspace_id: "ws",
        name: "inbox",
        position: 0,
        is_open: true,
        note_count: 1,
        color_hue: null,
        icon: null,
        rules: null,
      }],
      loadTree: vi.fn(),
    } as never);

    render(<FolderOrganizeModal />);
    expect(screen.getByText(/미분류.*폴더 설정/)).toBeTruthy();
    expect(await screen.findByText("Alpha")).toBeTruthy();

    const nameInput = screen.getByDisplayValue("미분류") as HTMLInputElement;
    expect(nameInput.disabled).toBe(true);
  });

  // 규칙은 AI 만 읽는 지시문이라 "AI 읽기 금지" 가 켜지면 편집을 잠근다 — 다만 잠글 뿐 지우지
  // 않는다. 값을 비웠다면 금지를 껐을 때 규칙이 영영 사라졌을 것이다.
  it("an ai_excluded folder renders the rules editor disabled with its text intact", async () => {
    useNotesStore.setState({
      folders: [{
        id: "f1",
        workspace_id: "ws",
        name: "Notes",
        position: 0,
        is_open: true,
        note_count: 1,
        color_hue: null,
        icon: null,
        rules: "keep titles short",
        search_excluded: false,
        ai_excluded: true,
      }],
      loadTree: vi.fn(),
    } as never);

    render(<FolderOrganizeModal />);
    await screen.findByText("Alpha");

    const rules = screen.getByTestId("folder-rules") as HTMLTextAreaElement;
    expect(rules.disabled).toBe(true);
    expect(rules.value).toBe("keep titles short");
    expect(screen.getByText(/AI 읽기 금지가 켜져 있어 잠겼습니다/)).toBeTruthy();
  });

  it("flipping the switch on locks the editor right away and keeps the text", async () => {
    render(<FolderOrganizeModal />);
    await screen.findByText("Alpha");

    expect((screen.getByTestId("folder-rules") as HTMLTextAreaElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId("folder-ai-excluded-toggle"));

    await waitFor(() => {
      expect((screen.getByTestId("folder-rules") as HTMLTextAreaElement).disabled).toBe(true);
    });
    expect((screen.getByTestId("folder-rules") as HTMLTextAreaElement).value).toBe("keep titles short");
  });
});
