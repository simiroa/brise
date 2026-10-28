import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsHeader } from "./SettingsHeader";
import { useSettingsStore } from "../../stores/settings";
import { t } from "../../i18n/t";
import { searchSettings } from "./searchSettings";
import { IconCrown, IconWorkspace } from "../icons";
import { isOverlayOpen } from "../../lib/overlayStack";
import { SETTINGS_SEARCH_INDEX } from "./settingsSearchIndex";

const callSilentMock = vi.fn();
const noticeMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: vi.fn(),
  callSilent: (...args: unknown[]) => callSilentMock(...args),
  emitNotice: (m: string) => noticeMock(m),
}));
const emitMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/event", () => ({ emit: (...a: unknown[]) => emitMock(...a) }));

const LIST = {
  workspaces: [
    { id: "ws-1", name: "첫 노트북" },
    { id: "ws-2", name: "둘째 노트북" },
  ],
  active_id: "ws-1",
};

describe("SettingsHeader (PLAN-2026-10-24 D1·D5)", () => {
  beforeEach(() => {
    useSettingsStore.setState({ uiLang: "ko", activeWorkspaceId: null } as never);
    callSilentMock.mockReset().mockResolvedValue(LIST);
  });

  it("노트북별 페이지에서는 범위 칩이 활성 노트북 이름이다", async () => {
    render(<SettingsHeader scope="notebook" busy={false} onClose={() => {}} />);
    const chip = await screen.findByTestId("settings-scope-chip");
    expect(chip.textContent).toBe("첫 노트북");
    expect(chip.getAttribute("data-scope")).toBe("notebook");
    expect(chip.getAttribute("aria-label")).toBe(t("workspace.scope_label", { name: "첫 노트북" }));
  });

  it("이름을 모르는 동안은 칩을 그리지 않는다", async () => {
    callSilentMock.mockResolvedValue({ workspaces: [], active_id: "" });
    render(<SettingsHeader scope="notebook" busy={false} onClose={() => {}} />);
    await waitFor(() => expect(callSilentMock).toHaveBeenCalled());
    expect(screen.queryByTestId("settings-scope-chip")).toBeNull();
  });

  it("앱 전체 페이지에서는 '앱 전체' 칩과 설명 title 이 선다", () => {
    render(<SettingsHeader scope="app" busy={false} onClose={() => {}} />);
    const chip = screen.getByTestId("settings-scope-chip");
    expect(chip.textContent).toBe(t("workspace.scope_app_label"));
    expect(chip.getAttribute("data-scope")).toBe("app");
    expect(chip.getAttribute("title")).toBe(t("workspace.scope_app_hint"));
  });

  it("활성 노트북이 바뀌면 이름을 다시 읽는다", async () => {
    render(<SettingsHeader scope="notebook" busy={false} onClose={() => {}} />);
    expect((await screen.findByTestId("settings-scope-chip")).textContent).toBe("첫 노트북");
    act(() => {
      useSettingsStore.setState({ activeWorkspaceId: "ws-2" } as never);
    });
    await waitFor(() => expect(screen.getByTestId("settings-scope-chip").textContent).toBe("둘째 노트북"));
  });

  it("긴 이름은 말줄임으로 자르고 칩이 줄어들 수 있다", async () => {
    callSilentMock.mockResolvedValue({ workspaces: [{ id: "ws-1", name: "아주 ".repeat(40) }], active_id: "ws-1" });
    render(<SettingsHeader scope="notebook" busy={false} onClose={() => {}} />);
    const chip = await screen.findByTestId("settings-scope-chip");
    // 말줄임은 메인 창 칩과 같은 CSS(.ws-trigger-name)가 맡는다 — 여기선 그 클래스와 폭 상한만 본다.
    expect(chip.querySelector(".ws-trigger-name")).not.toBeNull();
    expect(chip.style.width).toBe("100%"); // 레일 칸을 채운다 — 폭 상한은 레일(--settings-rail-w)이 쥔다
  });

  it("칩을 눌러 다른 노트북을 고르면 본 창에 전환을 요청하고 알림을 한 번 띄운다", async () => {
    useSettingsStore.setState({ activeWorkspaceId: "ws-1" } as never);
    emitMock.mockClear();
    noticeMock.mockClear();
    render(<SettingsHeader scope="notebook" busy={false} onClose={() => {}} />);
    await userEvent.click(await screen.findByTestId("settings-scope-chip"));
    await userEvent.click(await screen.findByTestId("settings-notebook-option-ws-2"));
    expect(emitMock).toHaveBeenCalledWith("workspaces-changed", { activate: "ws-2" });
    expect(noticeMock).toHaveBeenCalledTimes(1);
    // 이미 활성인 노트북을 다시 고르면 아무 일도 없다.
    await userEvent.click(screen.getByTestId("settings-scope-chip"));
    await userEvent.click(await screen.findByTestId("settings-notebook-option-ws-1"));
    expect(emitMock).toHaveBeenCalledTimes(1);
  });

  it("트리거 아이콘은 칩을 열기 전에도 활성 노트북의 아이콘이다(같은 workspace_list 한 번으로)", async () => {
    // 비교 기준 — 같은 크기로 직접 그린 두 아이콘의 svg 안쪽.
    const innerOf = (el: ReactElement) => {
      const r = render(el);
      const inner = r.container.querySelector("svg")!.innerHTML;
      r.unmount();
      return inner;
    };
    const crown = innerOf(<IconCrown size={16} strokeWidth={2} />);
    const fallback = innerOf(<IconWorkspace size={16} strokeWidth={2} />);
    expect(crown).not.toBe(fallback);

    callSilentMock.mockResolvedValue({
      workspaces: [
        { id: "ws-1", name: "첫 노트북", icon: "crown" },
        { id: "ws-2", name: "둘째 노트북", icon: null },
      ],
      active_id: "ws-1",
    });
    render(<SettingsHeader scope="notebook" busy={false} onClose={() => {}} />);
    const chip = await screen.findByTestId("settings-scope-chip");
    expect(chip.querySelector("svg")!.innerHTML).toBe(crown); // 열지 않았다 — 목록 재조회 없이
    expect(callSilentMock.mock.calls.filter((c) => c[0] === "workspace_list")).toHaveLength(1);

    // 아이콘이 없는 노트북이 활성이면 기본 아이콘.
    act(() => {
      useSettingsStore.setState({ activeWorkspaceId: "ws-2" } as never);
    });
    await waitFor(() => expect(screen.getByTestId("settings-scope-chip").textContent).toBe("둘째 노트북"));
    expect(screen.getByTestId("settings-scope-chip").querySelector("svg")!.innerHTML).toBe(fallback);
  });

  it("드롭다운은 바깥을 누르면 닫히고 칩 안을 누르면 닫히지 않는다", async () => {
    render(<SettingsHeader scope="notebook" busy={false} onClose={() => {}} />);
    await userEvent.click(await screen.findByTestId("settings-scope-chip"));
    const list = await screen.findByRole("listbox");
    fireEvent.mouseDown(list);
    expect(screen.queryByRole("listbox")).not.toBeNull();
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });

  it("Escape 로 닫히고, 열려 있는 동안 오버레이 스택에 올라 창 닫기보다 먼저 이 드롭다운이 닫힌다", async () => {
    render(<SettingsHeader scope="notebook" busy={false} onClose={() => {}} />);
    expect(isOverlayOpen()).toBe(false);
    await userEvent.click(await screen.findByTestId("settings-scope-chip"));
    await screen.findByRole("listbox");
    expect(isOverlayOpen()).toBe(true);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(isOverlayOpen()).toBe(false);
  });

  it("검색 입력은 자리표시·aria-label 을 갖는 combobox 이고 처음엔 닫혀 있다", () => {
    render(<SettingsHeader scope="app" busy={false} onClose={() => {}} />);
    const input = screen.getByTestId("settings-search-input") as HTMLInputElement;
    expect(input.type).toBe("search");
    expect(input.placeholder).toBe(t("settings.search_placeholder"));
    expect(input.getAttribute("aria-label")).toBe(t("settings.search_placeholder"));
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("높이는 --row-chrome, 드래그 속성은 빈 자리에만 있고 입력·닫기에는 없다", () => {
    render(<SettingsHeader scope="app" busy={false} onClose={() => {}} />);
    const header = screen.getByTestId("settings-header");
    expect(header.style.height).toBe("var(--row-chrome)");
    expect(header.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(screen.getByTestId("settings-search-input").hasAttribute("data-tauri-drag-region")).toBe(false);
    expect(screen.getByTestId("settings-window-close").hasAttribute("data-tauri-drag-region")).toBe(false);
  });

  it("닫기를 누르면 onClose, 바쁠 땐 비활성이고 이유를 말한다", () => {
    const onClose = vi.fn();
    const { rerender } = render(<SettingsHeader scope="app" busy={false} onClose={onClose} />);
    (screen.getByTestId("settings-window-close") as HTMLButtonElement).click();
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(<SettingsHeader scope="app" busy={true} onClose={onClose} />);
    const x = screen.getByTestId("settings-window-close") as HTMLButtonElement;
    expect(x.disabled).toBe(true);
    expect(x.getAttribute("title")).toBe(t("settings.close_blocked_busy"));
  });
});

describe("SettingsHeader 검색 (PLAN-2026-10-24 W4)", () => {
  const PAGES = [
    "general", "editor", "notifications", "appearance", "view", "dashboard", "collect", "connect",
    "ai", "ai_permissions", "ai_features", "ai_presets", "ai_chat", "data", "license", "pet", "briefing",
  ].map((id) => ({ id, label: t(`settings.page_${id}`) }));

  const setup = (extra: Partial<React.ComponentProps<typeof SettingsHeader>> = {}) => {
    const onPick = vi.fn();
    render(<SettingsHeader scope="app" busy={false} onClose={() => {}} pages={PAGES} aiEnabled onPick={onPick} {...extra} />);
    return { onPick, input: screen.getByTestId("settings-search-input") as HTMLInputElement };
  };
  const expected = (q: string) =>
    searchSettings(q, SETTINGS_SEARCH_INDEX, {
      pageIds: PAGES.map((p) => p.id),
      aiEnabled: true,
      pageLabel: (id) => PAGES.find((p) => p.id === id)?.label ?? id,
    });

  beforeEach(() => {
    useSettingsStore.setState({ uiLang: "ko" } as never);
  });

  it("'백업' 을 치면 데이터 페이지 결과가 listbox 로 뜨고 일치 구간이 강조된다", async () => {
    const { input } = setup();
    await userEvent.type(input, "백업");
    const list = screen.getByRole("listbox");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-controls")).toBe(list.id);
    expect(screen.getByTestId("settings-search-result-data-backup_auto")).toBeTruthy();
    expect(list.querySelector("mark")?.textContent).toBe("백업");
  });

  it("Enter 는 맨 위 결과를, ArrowDown+Enter 는 다음 결과를 (page, anchor) 로 고른다", async () => {
    const exp = expected("백업");
    expect(exp.length).toBeGreaterThan(1);
    const first = setup();
    await userEvent.type(first.input, "백업{Enter}");
    expect(first.onPick).toHaveBeenCalledWith(exp[0].entry.page, exp[0].anchor);
    expect(first.input.value).toBe("");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("ArrowDown 은 활성 옵션을 옮기고 aria-activedescendant 가 따라간다", async () => {
    const exp = expected("백업");
    const { onPick, input } = setup();
    await userEvent.type(input, "백업");
    const options = screen.getAllByRole("option");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0].id);
    await userEvent.keyboard("{ArrowDown}");
    expect(input.getAttribute("aria-activedescendant")).toBe(options[1].id);
    expect(options[1].getAttribute("aria-selected")).toBe("true");
    await userEvent.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledWith(exp[1].entry.page, exp[1].anchor);
  });

  it("마우스 클릭으로도 고른다", async () => {
    const { onPick } = setup();
    await userEvent.type(screen.getByTestId("settings-search-input"), "백업");
    await userEvent.click(screen.getByTestId("settings-search-result-data-backup_auto"));
    expect(onPick).toHaveBeenCalledWith("data", "backup_auto");
  });

  it("첫 Escape 는 비우고 닫고, 한 번 더 누르면 포커스가 빠진다", async () => {
    const { input } = setup();
    await userEvent.type(input, "백업");
    expect(screen.getByRole("listbox")).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(input.value).toBe("");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(input);
    await userEvent.keyboard("{Escape}");
    expect(document.activeElement).not.toBe(input);
  });

  it("바깥을 누르면 닫는다", async () => {
    const { input } = setup();
    await userEvent.type(input, "백업");
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(input.getAttribute("aria-expanded")).toBe("false");
  });

  it("결과가 없으면 한 줄 안내만 나온다", async () => {
    const { input } = setup();
    await userEvent.type(input, "zzzqqq");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByTestId("settings-search-empty").textContent).toBe(t("settings.search_no_results"));
  });

  it("영어 UI 에서도 영어 라벨로 찾는다", async () => {
    useSettingsStore.setState({ uiLang: "en" } as never);
    const { input } = setup();
    await userEvent.type(input, "backup");
    expect(screen.getByTestId("settings-search-result-data-backup_auto")).toBeTruthy();
  });

  it("AI 꺼짐이면 AI 본문 행은 앵커 없이 페이지만 연다", async () => {
    const { onPick } = setup({ aiEnabled: false });
    await userEvent.type(screen.getByTestId("settings-search-input"), t("settings.model_label"));
    await userEvent.click(screen.getByTestId("settings-search-result-ai-ai_model"));
    expect(onPick).toHaveBeenCalledWith("ai", undefined);
  });

  it("Ctrl+F 는 검색창을 포커스하고 기본 동작을 막는다", () => {
    const { input } = setup();
    const ev = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      document.body.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  it("Ctrl+F 는 에디터(ProseMirror) 안에서는 양보한다", () => {
    setup();
    const pm = document.createElement("div");
    pm.className = "ProseMirror";
    document.body.appendChild(pm);
    const ev = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => {
      pm.dispatchEvent(ev);
    });
    expect(ev.defaultPrevented).toBe(false);
    pm.remove();
  });
});
