import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { useSettingsStore } from "../../../stores/settings";
import { HabitsEditor } from "./HabitsEditor";
import { ScheduleWhenSection } from "./ScheduleWhenSection";
import { BriefingSection } from "../BriefingSection";
import * as phraseLib from "../../../lib/phrasePacks";

const callMock = vi.fn();
vi.mock("../../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: vi.fn(),
  registerFlush: vi.fn(),
  flushAll: vi.fn().mockResolvedValue(undefined),
}));

const habit = (id: string, title: string, mask = 127) => ({
  id, workspace_id: "w1", title, icon: null, hue: null, weekday_mask: mask, position: 0, archived_at: null, created_at: "", time_of_day: "any",
});

function mockHabits(habits: unknown[], overrides: Record<string, () => Promise<unknown>> = {}) {
  callMock.mockReset().mockImplementation((cmd: string) => {
    if (overrides[cmd]) return overrides[cmd]();
    if (cmd === "habit_list") return Promise.resolve({ habits });
    return Promise.resolve({ ok: true });
  });
}

describe("HabitsEditor", () => {
  beforeEach(() => useSettingsStore.setState({ uiLang: "en" } as any));

  it("rejects an empty title without calling habit_create", async () => {
    mockHabits([]);
    render(<HabitsEditor />);
    fireEvent.click(await screen.findByTestId("habit-add-btn"));
    fireEvent.click(screen.getByTestId("habit-form-save-btn"));
    expect(await screen.findByTestId("habit-form-error")).toBeTruthy();
    expect(callMock).not.toHaveBeenCalledWith("habit_create", expect.anything());
  });

  it("creates a habit with the chosen weekday mask", async () => {
    mockHabits([]);
    render(<HabitsEditor />);
    fireEvent.click(await screen.findByTestId("habit-add-btn"));
    fireEvent.change(screen.getByTestId("habit-title-input"), { target: { value: "운동" } });
    fireEvent.click(screen.getByTestId("habit-weekday-6")); // 일 해제
    fireEvent.click(screen.getByTestId("habit-form-save-btn"));
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("habit_create", { title: "운동", weekday_mask: 0b0111111, time_of_day: "any" }),
    );
  });

  it("sends the chosen time of day on create", async () => {
    mockHabits([]);
    render(<HabitsEditor />);
    fireEvent.click(await screen.findByTestId("habit-add-btn"));
    fireEvent.change(screen.getByTestId("habit-title-input"), { target: { value: "명상" } });
    // 설정 공용 Select(버튼 + 옵션 목록) — 네이티브 <select> 가 아니다.
    fireEvent.click(screen.getByTestId("habit-time-select"));
    fireEvent.click(screen.getByRole("option", { name: "Morning" }));
    fireEvent.click(screen.getByTestId("habit-form-save-btn"));
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("habit_create", { title: "명상", weekday_mask: 127, time_of_day: "morning" }),
    );
  });

  it("rolls the row back when habit_delete fails", async () => {
    mockHabits([habit("h1", "독서")], { habit_delete: () => Promise.reject(new Error("boom")) });
    render(<HabitsEditor />);
    fireEvent.click(await screen.findByTestId("habit-delete-h1"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("habit_delete", { id: "h1" }));
    expect(await screen.findByTestId("habit-row-h1")).toBeTruthy();
  });

  it("a failed save keeps the form open and shows no raw backend text inline (call() already toasted)", async () => {
    mockHabits([], { habit_create: () => Promise.reject(new Error("VALIDATION: raw")) });
    render(<HabitsEditor />);
    fireEvent.click(await screen.findByTestId("habit-add-btn"));
    fireEvent.change(screen.getByTestId("habit-title-input"), { target: { value: "운동" } });
    fireEvent.click(screen.getByTestId("habit-form-save-btn"));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("habit_create", expect.anything()));
    await waitFor(() => expect((screen.getByTestId("habit-form-save-btn") as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByTestId("habit-title-input")).toBeTruthy();
    expect(screen.queryByTestId("habit-form-error")).toBeNull();
  });

  it("uses the shared anchor ids for deep links", async () => {
    mockHabits([]);
    const { container } = render(<HabitsEditor />);
    await screen.findByTestId("habit-add-btn");
    expect(container.querySelector("#settings-anchor-habits")).toBeTruthy();
    expect(screen.getByTestId("habit-add-btn").id).toBe("settings-anchor-habits_add");
  });

  it("rolls the order back when habit_reorder fails", async () => {
    mockHabits([habit("h1", "A"), habit("h2", "B")], { habit_reorder: () => Promise.reject(new Error("boom")) });
    render(<HabitsEditor />);
    fireEvent.click(await screen.findByTestId("habit-down-h1"));
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("habit_reorder", { ids: ["h2", "h1"] }));
    await waitFor(() => {
      const ids = Array.from(screen.getByTestId("habit-list").children).map((n) => n.getAttribute("data-testid"));
      expect(ids).toEqual(["habit-row-h1", "habit-row-h2"]);
    });
  });
});

describe("ScheduleWhenSection", () => {
  it("time input only in 'time' mode; changing 'when'/'time' calls the store setters", () => {
    const setBriefingWhen = vi.fn().mockResolvedValue(undefined);
    const setBriefingTime = vi.fn().mockResolvedValue(undefined);
    useSettingsStore.setState({
      briefingEnabled: true, briefingWhen: "time", briefingTime: "08:00", setBriefingWhen, setBriefingTime,
    } as any);
    render(<ScheduleWhenSection />);
    const input = screen.getByTestId("briefing-time-input") as HTMLInputElement;
    expect(input.getAttribute("aria-label")).toBe("Time");
    // 입력 중엔 저장하지 않고, 포커스가 떠날 때 한 번.
    fireEvent.change(input, { target: { value: "09:30" } });
    expect(setBriefingTime).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(setBriefingTime).toHaveBeenCalledWith("09:30");
    // 지운 값("")은 보내지 않고 원래 값으로 돌아간다.
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(setBriefingTime).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("08:00");
  });

  it("briefing off: every row is disabled with a reason", () => {
    useSettingsStore.setState({ briefingEnabled: false, briefingWhen: "time", briefingEveningEnabled: false } as any);
    render(<ScheduleWhenSection />);
    const row = screen.getByTestId("briefing-when-row");
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.getAttribute("data-disabled-reason")).toBe("Turn on the briefing to change this");
    expect(screen.getByTestId("briefing-notify-row").getAttribute("aria-disabled")).toBe("true");
  });

  it("hides the time input outside 'time' mode", () => {
    useSettingsStore.setState({ briefingEnabled: true, briefingWhen: "launch" } as any);
    render(<ScheduleWhenSection />);
    expect(screen.queryByTestId("briefing-time-input")).toBeNull();
  });
});

describe("BriefingSection (PLAN-2026-10-19-briefing-rewrite §8)", () => {
  beforeEach(() => {
    // PhrasePacksSection 은 마운트 시 팩 목록을 읽는다 — IPC 목(callMock)이 아니라 라이브러리 경계에서 막는다.
    vi.spyOn(phraseLib, "loadAllPhrasePacks").mockResolvedValue([]);
  });

  it("표시 시점 → 문구 → 습관 순서이고 반복 일정 표는 없으며, 옛 편집 안내 카드·편집 버튼은 없다", async () => {
    mockHabits([]);
    useSettingsStore.setState({ briefingEnabled: true, briefingWhen: "launch", phrasePackId: "off" } as any);
    render(<BriefingSection />);
    await waitFor(() => expect(phraseLib.loadAllPhrasePacks).toHaveBeenCalled());
    const order = ["briefing-schedule-card", "settings-phrase-packs", "briefing-habits-section"].map(
      (id) => screen.getByTestId(id),
    );
    for (let i = 1; i < order.length; i += 1) {
      // eslint-disable-next-line no-bitwise
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(screen.queryByTestId("settings-timeline-routine-section")).toBeNull();
    expect(screen.queryByTestId("briefing-edit-hint")).toBeNull();
    expect(screen.queryByTestId("briefing-open-edit")).toBeNull();
    expect(screen.queryByTestId("briefing-layout-radiogroup")).toBeNull();
    expect(callMock).not.toHaveBeenCalledWith("briefing_window_open", expect.anything());
  });

  // 문구 팩(phrase_pack_id)은 노트북 키 — 섞인 페이지라 "앱 전체" 칩을 붙이면 거짓이 된다(대시보드 페이지 선례).
  it("문구 팩이 노트북 키라 페이지 머리에 '앱 전체' 칩이 없다", async () => {
    mockHabits([]);
    useSettingsStore.setState({ briefingEnabled: true, briefingWhen: "launch", phrasePackId: "off" } as any);
    render(<BriefingSection />);
    await waitFor(() => expect(phraseLib.loadAllPhrasePacks).toHaveBeenCalled());
    expect(screen.queryByTestId("settings-app-scope")).toBeNull();
  });

  it("브리핑이 꺼지면 문구 팩 행도 이유와 함께 막힌다 — 습관 표는 막지 않는다", async () => {
    mockHabits([]);
    useSettingsStore.setState({ briefingEnabled: false, briefingWhen: "launch", phrasePackId: "off" } as any);
    render(<BriefingSection />);
    await waitFor(() => expect(phraseLib.loadAllPhrasePacks).toHaveBeenCalled());
    const packRow = screen.getByTestId("settings-phrase-packs").querySelector("[aria-disabled='true']");
    expect(packRow?.getAttribute("data-disabled-reason")).toBe("Turn on the briefing to change this");
    expect(screen.getByTestId("briefing-habits-section").querySelector("[aria-disabled='true']")).toBeNull();
    expect((screen.getByTestId("habit-add-btn") as HTMLButtonElement).disabled).toBe(false);
  });
});
