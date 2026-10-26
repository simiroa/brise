import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useWorkspacesStore } from "../stores/workspaces";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

// jsdom has no matchMedia — some shared hooks/CSS paths read it on mount.
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

vi.mock("../lib/workspaceBgBase", () => ({
  useWorkspaceBgBase: () => ({
    baseDir: "C:/fake/workspace_bg",
    convert: (p: string) => `asset://localhost/${p.replace(/\\/g, "/")}`,
  }),
}));

describe("WorkspaceSwitcher trigger background image", () => {
  beforeEach(() => {
    useWorkspacesStore.setState({
      workspaces: [
        {
          id: "w1",
          name: "My Notebook",
          note_count: 2,
          folder_count: 0,
          created_at: "2026-01-01T00:00:00Z",
          bg_image_path: "covers/a.jpg",
          icon: null,
        },
      ],
      activeId: "w1",
      loaded: true,
      load: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(),
      switchTo: vi.fn(),
      setBgImage: vi.fn(),
      clearBgImage: vi.fn(),
    } as any);
  });

  it("sets only inline backgroundImage (size/position stay on CSS longhands)", () => {
    render(<WorkspaceSwitcher />);
    const trigger = screen.getByRole("button", { name: /My Notebook/i });
    expect(trigger.className).toContain("ws-trigger");
    // Component owns the image layer only — cover/center live in workspace-switcher.css so
    // hover background-color can change without animating size/position (task 1E).
    expect(trigger.style.backgroundImage).toMatch(/url\(/);
    expect(trigger.style.backgroundSize).toBe("");
    expect(trigger.style.backgroundPosition).toBe("");
  });

  it("omits inline backgroundImage when the notebook has no cover", () => {
    useWorkspacesStore.setState({
      workspaces: [
        {
          id: "w1",
          name: "Plain",
          note_count: 0,
          folder_count: 0,
          created_at: "2026-01-01T00:00:00Z",
          bg_image_path: null,
          icon: null,
        },
      ],
      activeId: "w1",
    } as any);
    render(<WorkspaceSwitcher />);
    const trigger = screen.getByRole("button", { name: /Plain/i });
    expect(trigger.style.backgroundImage).toBe("");
  });
});

// 복제 버튼: IPC 왕복 중 두 번째 클릭이 두 번째 notebook_duplicate 를 쏘지 않아야 한다(리그레션,
// 2026-09-19 리뷰) — pickBgImage/removeBgImage 와 NewNotebookModal 의 busy 가드 관례를 새 버튼만
// 놓쳤었다.
describe("WorkspaceSwitcher duplicate button", () => {
  let duplicateMock: ReturnType<typeof vi.fn>;
  let resolveDuplicate: (v: unknown) => void;

  beforeEach(() => {
    duplicateMock = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveDuplicate = resolve;
        }),
    );
    useWorkspacesStore.setState({
      workspaces: [
        {
          id: "w1",
          name: "My Notebook",
          note_count: 2,
          folder_count: 0,
          created_at: "2026-01-01T00:00:00Z",
          bg_image_path: null,
          icon: null,
        },
      ],
      activeId: "w1",
      loaded: true,
      load: vi.fn(),
      create: vi.fn(),
      remove: vi.fn(),
      switchTo: vi.fn(),
      setBgImage: vi.fn(),
      clearBgImage: vi.fn(),
      duplicate: duplicateMock,
    } as any);
  });

  it("does not fire a second workspace_duplicate while the first is still in flight", async () => {
    render(<WorkspaceSwitcher />);
    fireEvent.click(screen.getByRole("button", { name: /My Notebook/i }));
    const dupBtn = screen.getByTestId("workspace-duplicate-w1");
    fireEvent.click(dupBtn);
    fireEvent.click(dupBtn);
    expect(duplicateMock).toHaveBeenCalledTimes(1);
    // 재진입 차단은 네이티브 disabled 가 아니라 상태 체크다(중첩 버튼이라 disabled 클릭은 바깥
    // 행 onClick 으로 버블돼 드롭다운을 닫혀버린다) — 그래서 드롭다운이 여전히 열려 있어야 한다.
    expect(screen.getByTestId("workspace-duplicate-w1").getAttribute("aria-disabled")).toBe("true");
    resolveDuplicate({ id: "w2", name: "My Notebook copy" });
    await waitFor(() =>
      expect(screen.getByTestId("workspace-duplicate-w1").getAttribute("aria-disabled")).toBe("false"),
    );
    // 왕복이 끝난 뒤엔 다시 눌러 새 사본을 만들 수 있어야 한다 — 계속 막혀있지 않은지 확인.
    fireEvent.click(screen.getByTestId("workspace-duplicate-w1"));
    expect(duplicateMock).toHaveBeenCalledTimes(2);
  });
});
