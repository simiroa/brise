import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const callMock = vi.fn();
vi.mock("../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
  flushAll: vi.fn(async () => {}),
  registerFlush: () => () => {},
}));

import { AiActionEditor } from "./AiActionEditor";
import { useAiPresetsStore } from "../../stores/aiPresets";
import { useSettingsStore } from "../../stores/settings";

function fourBuiltins() {
  return [
    { id: "list", name: "리스트로 만들기", prompt: "P1", kind: "text" as const, isBuiltin: true, hidden: false },
    // 편집기는 타일(요청 문장)을 다룬다 — organize 는 타일이 없는 바로 실행 액션이라 이 자리엔 실제 타일 id 를 쓴다.
    { id: "translate", name: "내용 정리하기", prompt: "P2", kind: "text" as const, isBuiltin: true, hidden: false },
    { id: "summarize", name: "요약하기", prompt: "P3", kind: "text" as const, isBuiltin: true, hidden: false },
    { id: "metadata", name: "데이터 자동 채우기", prompt: "P4", kind: "metadata" as const, isBuiltin: true, hidden: false },
  ];
}

/** The single-column layout's picker: one trigger button, options only exist while it is open. */
const picker = () => screen.getByTestId("ai-action-select") as HTMLButtonElement;
/** fireEvent (not userEvent) — a real click would blur the editor first, and the onBlur save would
 *  hide a missing commit-on-switch in the tests that care about it. */
const openPicker = () => fireEvent.click(picker());
const options = () =>
  Array.from(screen.getByTestId("ai-action-select-list").querySelectorAll('[role="option"]')) as HTMLElement[];
const promptBox = () => screen.getByLabelText("Prompt") as HTMLTextAreaElement;
const nameBox = () => screen.getByLabelText("Preset name") as HTMLInputElement;

/** The list as it was last actually written to disk — NOT the in-memory store. Two overlapping
 *  settings_set calls both "succeed" in-memory; only the final payload shows who won. */
function lastPersisted() {
  const writes = callMock.mock.calls.filter((c) => c[0] === "settings_set");
  return writes[writes.length - 1][1].entries.ai_action_presets as { id: string; name: string; prompt: string }[];
}

// PLAN-2026-08-30 §3 W4: moved from src/components/settings/AiActionsSection.tsx (설정 > AI) to
// src/components/presets/AiActionEditor.tsx (프리셋 관리 모달의 "AI 액션" 탭). Logic + tests carried
// over unchanged — only the render target changed (no groupCardStyle/SectionHeader card chrome).
describe("AiActionEditor — single-column preset editor (프리셋 관리 모달의 AI 액션 탭)", () => {
  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({ ok: true, settings: {} });
    useSettingsStore.setState({ uiLang: "en" } as never);
    useAiPresetsStore.setState({ list: fourBuiltins(), loaded: true });
  });

  it("offers every visible preset in the dropdown and selects the first one by default", () => {
    render(<AiActionEditor />);

    expect(picker().textContent).toBe("리스트로 만들기");
    expect(nameBox().value).toBe("리스트로 만들기");
    expect(promptBox().value).toBe("P1");
    // Only ONE name field + ONE prompt textarea exist — the whole point of the single column.
    expect(screen.getAllByLabelText("Prompt")).toHaveLength(1);

    openPicker();
    expect(options().map((o) => o.textContent)).toEqual([
      "리스트로 만들기",
      "내용 정리하기",
      "요약하기",
      "데이터 자동 채우기",
    ]);
  });

  it("picking another preset swaps the editor", async () => {
    render(<AiActionEditor />);

    await userEvent.click(picker());
    await userEvent.click(screen.getByRole("option", { name: "요약하기" }));

    expect(picker().textContent).toBe("요약하기");
    expect(nameBox().value).toBe("요약하기");
    expect(promptBox().value).toBe("P3");
  });

  it("commit-on-switch: an edit that never blurred is saved when the selection changes", () => {
    render(<AiActionEditor />);

    fireEvent.change(promptBox(), { target: { value: "half-typed" } });
    openPicker();
    fireEvent.click(options()[1]);

    expect(useAiPresetsStore.getState().list.find((p) => p.id === "list")?.prompt).toBe("half-typed");
    expect(callMock).toHaveBeenCalledWith("settings_set", { entries: { ai_action_presets: expect.any(Array) } });
    // …and the editor really did move on.
    expect(promptBox().value).toBe("P2");
  });

  it("commit-on-switch also covers the name field, and the picker shows the in-progress name", () => {
    render(<AiActionEditor />);

    fireEvent.change(nameBox(), { target: { value: "짧은 목록" } });
    expect(picker().textContent).toBe("짧은 목록"); // the trigger tracks the draft, not the store
    openPicker();
    fireEvent.click(options()[3]);

    expect(useAiPresetsStore.getState().list.find((p) => p.id === "list")?.name).toBe("짧은 목록");
  });

  it("editing and blurring still persists (the pre-existing save-on-blur path)", async () => {
    render(<AiActionEditor />);

    await userEvent.clear(promptBox());
    await userEvent.type(promptBox(), "새 프롬프트");
    await userEvent.tab();

    expect(useAiPresetsStore.getState().list.find((p) => p.id === "list")?.prompt).toBe("새 프롬프트");
  });

  it("add creates a custom action, selects it, and puts focus in the name field", async () => {
    render(<AiActionEditor />);

    await userEvent.click(screen.getByRole("button", { name: "Add preset" }));

    const created = useAiPresetsStore.getState().list.find((p) => !p.isBuiltin)!;
    expect(created.name).toBe("New preset");
    expect(nameBox().value).toBe("New preset");
    expect(document.activeElement).toBe(nameBox());
    // Built-in vs custom stays visible: only the custom entry carries the badge.
    expect(picker().textContent).toContain("Custom");
    openPicker();
    expect(options()).toHaveLength(5);
    expect(options().filter((o) => o.textContent?.includes("Custom"))).toHaveLength(1);
  });

  it("add awaits the pending commit — the two whole-list writes are never in flight at once", async () => {
    // commit() and addCustom() BOTH persist the entire list under the same ai_action_presets key.
    // Overlapping them is a lost update: the backend writes whichever settles last, so the other's
    // change vanishes from disk while the UI still shows it. Neither the in-memory store nor the
    // final payload can show that (both calls are issued with correct payloads) — what discriminates
    // is whether the second call is issued while the first is still pending. So the first write is
    // held open here, and the second must not appear until it is released.
    let writes = 0;
    let releaseFirst = () => {};
    callMock.mockImplementation((cmd: string) => {
      if (cmd !== "settings_set") return Promise.resolve({ settings: {} });
      writes += 1;
      if (writes > 1) return Promise.resolve({});
      return new Promise((resolve) => {
        releaseFirst = () => resolve({});
      });
    });

    render(<AiActionEditor />);
    fireEvent.change(promptBox(), { target: { value: "half-typed" } });
    fireEvent.click(screen.getByRole("button", { name: "Add preset" }));

    await waitFor(() => expect(writes).toBeGreaterThan(0));
    expect(writes).toBe(1); // addCustom's write must still be queued behind the commit

    releaseFirst();
    await waitFor(() => expect(writes).toBe(2));
    const persisted = lastPersisted();
    expect(persisted.find((p) => p.id === "list")?.prompt).toBe("half-typed");
    expect(persisted.some((p) => p.name === "New preset")).toBe(true);
  });

  it("deleting the selected preset selects the next neighbour, and the one above when deleting the last", async () => {
    render(<AiActionEditor />);

    await userEvent.click(picker());
    await userEvent.click(screen.getByRole("option", { name: "내용 정리하기" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(useAiPresetsStore.getState().list.find((p) => p.id === "translate")?.hidden).toBe(true);
    expect(picker().textContent).toBe("요약하기"); // the next one down, not a reset to the first

    // Now delete the last one — the neighbour above takes over.
    await userEvent.click(picker());
    await userEvent.click(screen.getByRole("option", { name: "데이터 자동 채우기" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(picker().textContent).toBe("요약하기");
  });

  // 단일 목록 관리(PLAN-2026-09-27 §7-1): 내장 항목을 지우면 목록에서 사라지지 않고 숨김으로 남아, 설정에서 다시 켤 수
  // 있다(눈 아이콘·기본 항목 복원). 사용자 프리셋만 정말 지워지고, 그것까지 없으면 빈 편집기 대신 설명이 뜬다.
  it("deleting a built-in hides it in place (still manageable); an empty list explains itself", async () => {
    useAiPresetsStore.setState({ list: [fourBuiltins()[0]] });
    const { unmount } = render(<AiActionEditor />);

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(useAiPresetsStore.getState().list[0].hidden).toBe(true);
    expect(screen.getByRole("button", { name: "Restore default items" })).toBeTruthy();
    unmount();

    useAiPresetsStore.setState({ list: [] });
    render(<AiActionEditor />);
    expect(picker().disabled).toBe(true);
    expect(screen.queryByLabelText("Prompt")).toBeNull();
    expect(screen.getByText(/No AI presets left/i)).toBeTruthy();
  });

  it("action slots (built-ins without a tile) never show in the editor", async () => {
    useAiPresetsStore.setState({
      list: [
        ...fourBuiltins(),
        { id: "organize", name: "정리 액션 자리", prompt: "", kind: "text" as const, isBuiltin: true, hidden: false },
      ],
    });
    render(<AiActionEditor />);
    await userEvent.click(picker());
    const names = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(names.some((n) => n.includes("리스트로 만들기"))).toBe(true);
    expect(names.some((n) => n.includes("정리 액션 자리"))).toBe(false);
  });

  it("the metadata preset keeps its guidance hint and stays editable (Wave EDITABLE METADATA PROMPT)", async () => {
    render(<AiActionEditor />);
    expect(screen.queryByText(/output format/i)).toBeNull(); // not shown for a text-kind preset

    await userEvent.click(picker());
    await userEvent.click(screen.getByRole("option", { name: "데이터 자동 채우기" }));

    expect(screen.getByText(/only adjusts guidance/i)).toBeTruthy();
    expect(promptBox().readOnly).toBe(false);
    await userEvent.clear(promptBox());
    await userEvent.type(promptBox(), "새 메타데이터 지침");
    await userEvent.tab();
    expect(useAiPresetsStore.getState().list.find((p) => p.id === "metadata")?.prompt).toBe("새 메타데이터 지침");
  });

  it("per-item reset restores the selected built-in's name+prompt and refreshes the fields", async () => {
    useAiPresetsStore.setState({
      list: fourBuiltins().map((p) => (p.id === "summarize" ? { ...p, name: "changed", prompt: "changed" } : p)),
    });
    render(<AiActionEditor />);

    await userEvent.click(picker());
    await userEvent.click(screen.getByRole("option", { name: "changed" }));
    await userEvent.click(screen.getByRole("button", { name: "Reset to default" }));

    const item = useAiPresetsStore.getState().list.find((p) => p.id === "summarize")!;
    expect(item.name).not.toBe("changed");
    expect(item.prompt).not.toBe("changed");
    expect(nameBox().value).toBe(item.name);
  });

  it("a custom action has no reset button (nothing to reset to)", async () => {
    render(<AiActionEditor />);
    await userEvent.click(screen.getByRole("button", { name: "Add preset" }));

    expect(screen.queryByRole("button", { name: "Reset to default" })).toBeNull();
  });

  it("delete hides a built-in and the global restore button un-hides it", async () => {
    render(<AiActionEditor />);

    await userEvent.click(screen.getByRole("button", { name: "Delete" })); // the first entry is selected
    expect(useAiPresetsStore.getState().list.find((p) => p.id === "list")?.hidden).toBe(true);
    openPicker();
    expect(options().map((o) => o.textContent)).not.toContain("리스트로 만들기");
    fireEvent.keyDown(screen.getByTestId("ai-action-select-list"), { key: "Escape" });

    await userEvent.click(screen.getByRole("button", { name: "Restore default items" }));
    expect(useAiPresetsStore.getState().list.find((p) => p.id === "list")?.hidden).toBe(false);
  });

  it("reorder moves the selected preset and the selection follows it", async () => {
    render(<AiActionEditor />);

    await userEvent.click(picker());
    await userEvent.click(screen.getByRole("option", { name: "내용 정리하기" }));
    await userEvent.click(screen.getByRole("button", { name: "Move up" }));

    expect(useAiPresetsStore.getState().list.map((p) => p.id)).toEqual(["translate", "list", "summarize", "metadata"]);
    expect(picker().textContent).toBe("내용 정리하기");
    openPicker();
    expect(options()[0].textContent).toBe("내용 정리하기");
  });

  // PLAN-2026-08-30 §3 W2/W4 교차 반영 — AiCapabilityCatalog(설정 > AI 기능)의 온디맨드 토글은
  // useAiPresetsStore.setHidden(presetId, hidden) 을 부른다
  // (AiCapabilityCatalog.tsx: `onPresetToggle={(presetId, nextVisible) => void setPresetHidden(presetId, !nextVisible)}`),
  // 이 탭의 delete/restore 도 정확히 같은 필드(ai_action_presets[].hidden)를 정확히 같은 스토어
  // (useAiPresetsStore, 단일 인스턴스)로 쓴다. 새 상태를 만들지 않았다는 사실을 여기서 못박는다:
  // 카탈로그가 쓴 hidden 을 이 편집기가 즉시 읽고, 이 편집기가 복원한 hidden 을 카탈로그가 즉시
  // 읽을 것이다(둘 다 같은 selector 패턴 — visiblePresets()/isPresetVisible() 은 둘 다 `!hidden`).
  it("카탈로그 쪽 온디맨드 토글(setHidden)이 끈 항목은 이 탭에서도 즉시 사라지고, 여기서 복원하면 카탈로그도 다시 보게 될 필드가 원상복구된다", async () => {
    render(<AiActionEditor />);
    openPicker();
    expect(options().map((o) => o.textContent)).toContain("리스트로 만들기");
    fireEvent.keyDown(screen.getByTestId("ai-action-select-list"), { key: "Escape" });

    // AiCapabilityCatalog의 Toggle onChange 가 정확히 이 액션을 부른다 — UI가 아니라 그 계약만 본다.
    await act(async () => {
      await useAiPresetsStore.getState().setHidden("list", true);
    });

    openPicker();
    expect(options().map((o) => o.textContent)).not.toContain("리스트로 만들기");
    // 카탈로그의 isPresetVisible(presetId) = `!preset?.hidden` 이 읽는 것과 같은 필드.
    expect(useAiPresetsStore.getState().list.find((p) => p.id === "list")?.hidden).toBe(true);
    fireEvent.keyDown(screen.getByTestId("ai-action-select-list"), { key: "Escape" });

    // 이 탭의 "기본 항목 복원" — 카탈로그가 다시 렌더될 때 같은 필드에서 다시 켜진 것으로 본다.
    await userEvent.click(screen.getByRole("button", { name: "Restore default items" }));
    expect(useAiPresetsStore.getState().list.find((p) => p.id === "list")?.hidden).toBe(false);
    openPicker();
    expect(options().map((o) => o.textContent)).toContain("리스트로 만들기");
  });
});

// AI 모달의 "+추가" 타일(2026-09-27) — 편집기가 열리자마자 그 대상에 맞는 새 프리셋 하나.
describe("AiActionEditor — autoAdd (AI 모달의 「추가」)", () => {
  beforeEach(() => {
    callMock.mockReset().mockResolvedValue({ ok: true, settings: {} });
    useSettingsStore.setState({ uiLang: "en" } as never);
  });

  it("creates exactly one preset of the given kind/targets, selects it and focuses its name", async () => {
    useAiPresetsStore.setState({ list: fourBuiltins(), loaded: true });
    const { rerender } = render(<AiActionEditor autoAdd={{ kind: "diagram", targets: ["diagram"] }} />);
    await waitFor(() => expect(nameBox().value).toBe("New preset"));
    rerender(<AiActionEditor autoAdd={{ kind: "diagram", targets: ["diagram"] }} />);
    const custom = useAiPresetsStore.getState().list.filter((p) => !p.isBuiltin);
    expect(custom).toHaveLength(1);
    expect(custom[0]).toMatchObject({ kind: "diagram", targets: ["diagram"] });
    expect(document.activeElement).toBe(nameBox());
    expect(lastPersisted()).toHaveLength(5);
  });

  it("waits for the stored list to load — never saves builtinDefaults() over the user's presets", async () => {
    const load = vi.fn(async () => {});
    useAiPresetsStore.setState({ list: [], loaded: false, load } as never);
    render(<AiActionEditor autoAdd={{ kind: "text" }} />);
    await act(async () => {});
    expect(callMock.mock.calls.some((c) => c[0] === "settings_set")).toBe(false);

    await act(async () => {
      useAiPresetsStore.setState({ list: fourBuiltins(), loaded: true });
    });
    await waitFor(() => expect(callMock.mock.calls.some((c) => c[0] === "settings_set")).toBe(true));
    // 저장된 네 개 + 새 하나 — 로드 전 목록(빈 배열/기본값)으로 덮지 않았다.
    expect(lastPersisted().map((p) => p.id).slice(0, 4)).toEqual(["list", "translate", "summarize", "metadata"]);
    expect(lastPersisted()).toHaveLength(5);
  });
});
