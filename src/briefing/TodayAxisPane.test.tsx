import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { ComponentProps } from "react";

const callMock = vi.fn();
const silentMock = vi.fn();
vi.mock("../lib/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/invoke")>()),
  call: (...a: unknown[]) => callMock(...a),
  callSilent: (...a: unknown[]) => silentMock(...a),
}));
const undoMock = vi.fn();
vi.mock("../lib/undo", () => ({ showUndoToast: (...a: unknown[]) => undoMock(...a) }));
vi.mock("../lib/openNoteInMain", () => ({ requestOpenNoteInMain: vi.fn(() => Promise.resolve()) }));
vi.mock("../lib/diag", () => ({ reportFallback: vi.fn() }));
// jsdom 의 rect 는 전부 0 이라 진짜 끌기로는 아무것도 만들어지지 않는다 — 축은 "빈 시간을 끌어 놓았다"는
// 콜백(onCreateTimedNote)만 내는 껍데기로 바꾼다. 축 자체의 동작은 DayDetailPanel.test.tsx 가 지킨다.
vi.mock("../components/home/calendar/DayAxis", () => ({
  TimeAxis: (p: { day: string | null; dropPreview?: { title: string } | null; onCreateTimedNote?: (d: string, s: number, e: number) => void }) => (
    <div data-testid="axis-stub" data-ghost={p.dropPreview?.title ?? ""}>
      <button type="button" data-testid="stub-drag-create" onClick={() => p.onCreateTimedNote?.(p.day!, 600, 690)} />
    </div>
  ),
}));

import { useSettingsStore } from "../stores/settings";
import { TodayAxisPane } from "./TodayAxisPane";
import { resetScheduleVersion } from "./scheduleVersion";

const DAY = "2026-10-20";
const TODAY = "2026-10-19";

function setup(over: Partial<ComponentProps<typeof TodayAxisPane>> = {}) {
  const onStep = vi.fn();
  const onToday = vi.fn();
  const ui = (day: string) => (
    <TodayAxisPane todayIso={TODAY} nowMin={8 * 60} onStep={onStep} onToday={onToday} {...over} day={day} />
  );
  const r = render(ui(over.day ?? DAY));
  return { onStep, onToday, rerender: (day: string) => r.rerender(ui(day)) };
}

const input = () => screen.getByTestId("brf-draft-input") as HTMLInputElement;

beforeEach(() => {
  callMock.mockReset();
  silentMock.mockReset();
  undoMock.mockReset();
  resetScheduleVersion();
  silentMock.mockImplementation((cmd: string) => {
    if (cmd === "dashboard_calendar") return Promise.resolve({ year: 2026, month: 10, items: [] });
    if (cmd === "timeline_routine_list") return Promise.resolve({ routines: [] });
    return Promise.resolve({});
  });
  useSettingsStore.setState({ activeWorkspaceId: "w1", regionEnabled: false, holidayRegion: "none" });
});

describe("TodayAxisPane — 축에서 일정 만들기", () => {
  it("빈 시간을 끌어 놓으면 제목칸이 뜨고, Enter 한 번 = briefing_block_create 한 번", async () => {
    let resolve!: (v: unknown) => void;
    callMock.mockImplementation(() => new Promise((r) => (resolve = r)));
    setup();
    fireEvent.click(screen.getByTestId("stub-drag-create"));
    expect(input()).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(input()));
    fireEvent.change(input(), { target: { value: "  주간 계획 " } });
    expect(screen.getByTestId("axis-stub").dataset.ghost).toBe("  주간 계획 ");
    fireEvent.keyDown(input(), { key: "Enter" });
    fireEvent.keyDown(input(), { key: "Enter" }); // 저장 중 연타 — 두 번째는 막힌다
    fireEvent.blur(input());
    expect(callMock).toHaveBeenCalledTimes(1);
    expect(callMock).toHaveBeenCalledWith("briefing_block_create", {
      workspace_id: "w1",
      day: DAY,
      start_time: "10:00",
      end_time: "11:30",
      title: "주간 계획",
    });
    await act(async () => resolve({ note_id: "n9", date_id: "d9" }));
    await waitFor(() => expect(screen.queryByTestId("brf-draft")).toBeNull());
    expect(undoMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("brf-live").textContent).toContain("주간 계획");
  });

  it("되돌리기 = 만든 노트를 휴지통으로(note_delete)", async () => {
    callMock.mockResolvedValue({ note_id: "n9", date_id: "d9" });
    setup();
    fireEvent.click(screen.getByTestId("stub-drag-create"));
    fireEvent.change(input(), { target: { value: "치과" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(undoMock).toHaveBeenCalled());
    const onUndo = undoMock.mock.calls[0][1] as () => void;
    onUndo();
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("note_delete", { id: "n9" }));
  });

  it("IME 조합 중 Enter 는 글자 확정이다 — 아무것도 쓰지 않는다", () => {
    setup();
    fireEvent.click(screen.getByTestId("stub-drag-create"));
    fireEvent.change(input(), { target: { value: "회의" } });
    fireEvent.keyDown(input(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 229 });
    expect(callMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("brf-draft")).toBeTruthy();
  });

  it("Esc 는 초안을 접는다 — 쓰기 0", () => {
    setup();
    fireEvent.click(screen.getByTestId("stub-drag-create"));
    fireEvent.change(input(), { target: { value: "회의" } });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("brf-draft")).toBeNull();
    expect(callMock).not.toHaveBeenCalled();
  });

  it("빈 제목: Enter 는 쓰지 않고, 빈 채 포커스가 나가면 취소", () => {
    setup();
    fireEvent.click(screen.getByTestId("stub-drag-create"));
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(callMock).not.toHaveBeenCalled();
    fireEvent.blur(input());
    expect(screen.queryByTestId("brf-draft")).toBeNull();
  });

  it("저장이 실패하면 초안이 남는다(아무것도 안 쓰였다 — call() 이 토스트)", async () => {
    callMock.mockRejectedValue(new Error("VALIDATION"));
    setup();
    fireEvent.click(screen.getByTestId("stub-drag-create"));
    fireEvent.change(input(), { target: { value: "회의" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(input().disabled).toBe(false));
    expect(screen.getByTestId("brf-draft")).toBeTruthy();
    expect(undoMock).not.toHaveBeenCalled();
    // 저장 중 disabled 로 빠졌던 포커스가 돌아온다 — 바로 Enter 로 다시 시도할 수 있다.
    await waitFor(() => expect(document.activeElement).toBe(input()));
  });

  it("초안이 떠 있는 채 빈 시간을 다시 끌면 범위가 바뀌고 제목칸으로 포커스가 돌아온다", async () => {
    setup();
    fireEvent.click(screen.getByTestId("stub-drag-create"));
    fireEvent.change(input(), { target: { value: "회의" } });
    fireEvent.keyDown(input(), { key: "ArrowDown" }); // 10:15–11:45
    input().blur(); // 축을 누르는 순간 칸이 포커스를 잃는다
    fireEvent.click(screen.getByTestId("stub-drag-create")); // 10:00–11:30 으로 다시
    expect(screen.getByTestId("brf-draft").textContent).toContain("10:00–11:30");
    expect(input().value).toBe("회의");
    await waitFor(() => expect(document.activeElement).toBe(input()));
  });

  it("축 칸은 포커스를 받는다(tabIndex -1) — 빈 곳을 눌러도 N 이 닿는다", () => {
    setup();
    const pane = screen.getByTestId("brf-today");
    expect(pane.tabIndex).toBe(-1);
    pane.focus();
    expect(document.activeElement).toBe(pane);
  });

  it("키보드로 만들기: N(한글 자판이어도 물리 키) → 다른 날이면 09:00–09:30, ↑/↓ 로 옮긴다", () => {
    setup();
    fireEvent.keyDown(screen.getByTestId("brf-today"), { key: "ㅜ", code: "KeyN" });
    expect(screen.getByTestId("brf-draft").textContent).toContain("09:00–09:30");
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(screen.getByTestId("brf-draft").textContent).toContain("09:15–09:45");
    fireEvent.keyDown(input(), { key: "ArrowDown", shiftKey: true });
    expect(screen.getByTestId("brf-draft").textContent).toContain("09:15–10:00");
  });

  it("자정 끝(24:00)은 23:59 로 눌러 보낸다(같은 날 start ≤ end)", async () => {
    callMock.mockResolvedValue({ note_id: "n1", date_id: "d1" });
    setup();
    fireEvent.keyDown(screen.getByTestId("brf-today"), { key: "n", code: "KeyN" });
    for (let i = 0; i < 70; i++) fireEvent.keyDown(input(), { key: "ArrowDown", shiftKey: true });
    fireEvent.change(input(), { target: { value: "야간" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(callMock).toHaveBeenCalled());
    expect(callMock.mock.calls[0][1]).toMatchObject({ start_time: "09:00", end_time: "23:59" });
  });
});

describe("TodayAxisPane — 날짜 이동", () => {
  it("‹ › 버튼과 오늘", () => {
    const { onStep, onToday } = setup();
    fireEvent.click(screen.getByTestId("brf-day-prev"));
    fireEvent.click(screen.getByTestId("brf-day-next"));
    fireEvent.click(screen.getByTestId("brf-day-today"));
    expect(onStep.mock.calls).toEqual([[-1], [1]]);
    expect(onToday).toHaveBeenCalledTimes(1);
  });

  it("오늘을 보고 있으면 '오늘' 버튼은 없다", () => {
    setup({ day: TODAY });
    expect(screen.queryByTestId("brf-day-today")).toBeNull();
    expect(screen.getByTestId("brf-day-label").textContent).toContain("Today");
  });

  it("가로 휠(트랙패드 쓸어넘기기)은 하루, 세로 휠은 축 스크롤 몫", () => {
    const { onStep } = setup();
    const pane = screen.getByTestId("brf-today");
    fireEvent.wheel(pane, { deltaX: 0, deltaY: 120 });
    expect(onStep).not.toHaveBeenCalled();
    fireEvent.wheel(pane, { deltaX: 120, deltaY: 4 });
    expect(onStep).toHaveBeenCalledWith(1);
  });

  it("터치 스와이프 — 오른쪽으로 밀면 이전 날", () => {
    const { onStep } = setup();
    const pane = screen.getByTestId("brf-today");
    fireEvent.touchStart(pane, { touches: [{ clientX: 100, clientY: 200 }] });
    fireEvent.touchEnd(pane, { changedTouches: [{ clientX: 220, clientY: 210 }] });
    expect(onStep).toHaveBeenCalledWith(-1);
  });

  it("다른 날로 넘어가면 초안은 버린다(쓰기 0)", () => {
    const { rerender } = setup();
    fireEvent.click(screen.getByTestId("stub-drag-create"));
    expect(screen.getByTestId("brf-draft")).toBeTruthy();
    rerender("2026-10-21");
    expect(screen.queryByTestId("brf-draft")).toBeNull();
    expect(callMock).not.toHaveBeenCalled();
  });
});
