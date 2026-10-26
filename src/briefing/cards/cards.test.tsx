import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("../../lib/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/invoke")>()),
  call: vi.fn(),
  callSilent: vi.fn(),
}));
vi.mock("../../lib/openNoteInMain", () => ({ requestOpenNoteInMain: vi.fn(() => Promise.resolve()) }));

import type { DueReminder, HabitWeek } from "../../lib/commands.gen";
import { HabitsCard, RemainingHabits } from "./HabitsCard";
import { OverdueCard } from "./OverdueCard";

const TODAY = "2026-10-19";
const week = (doneToday: boolean): HabitWeek => ({
  from: "2026-10-13",
  to: TODAY,
  today: TODAY,
  rows: [
    {
      habit: { id: "h1", workspace_id: "w", title: "물 마시기", icon: null, hue: null, weekday_mask: 127, position: 0, archived_at: null, created_at: "", time_of_day: "any" },
      days: [
        { day: "2026-10-18", scheduled: true, done: true },
        { day: TODAY, scheduled: true, done: doneToday },
      ],
      streak: 4,
      done_count: doneToday ? 2 : 1,
      scheduled_count: 2,
      rate: 0.5,
    },
  ],
  done_count: 1,
  scheduled_count: 2,
  rate: 0.5,
});

describe("HabitsCard — 한 모양", () => {
  it("오늘 칸 체크 = toggle(습관, 오늘, 반대값), 연속 기록이 보인다", () => {
    const toggle = vi.fn(() => Promise.resolve());
    render(<HabitsCard week={week(false)} status="ready" reload={() => {}} toggle={toggle} />);
    fireEvent.click(screen.getByTestId("brf-habit-today"));
    expect(toggle).toHaveBeenCalledWith("h1", TODAY, true);
    expect(screen.getByTestId("brf-habit-streak").textContent).toContain("4");
    expect(screen.getByTestId("brf-habits").textContent).toContain("0/1");
  });

  it("좁은 창에서는 접혀 있고 머리를 누르면 펼친다", () => {
    render(<HabitsCard week={week(false)} status="ready" reload={() => {}} toggle={vi.fn()} collapsible />);
    expect(screen.queryByTestId("brf-habit-row")).toBeNull();
    fireEvent.click(screen.getByTestId("brf-habits-toggle"));
    expect(screen.getByTestId("brf-habit-row")).toBeTruthy();
  });

  it("넓은 창에서는 히트맵을 체크리스트 아래에 그리고, 좁은 창(접힘 카드)에서는 숨긴다", () => {
    const history = { from: "2026-08-03", to: TODAY, days: [{ day: TODAY, scheduled: 1, done: 0 }] };
    const { unmount } = render(<HabitsCard week={week(false)} status="ready" reload={() => {}} toggle={vi.fn()} history={history} />);
    expect(screen.getByTestId("brf-heatmap")).toBeTruthy();
    unmount();
    render(<HabitsCard week={week(false)} status="ready" reload={() => {}} toggle={vi.fn()} history={history} collapsible />);
    fireEvent.click(screen.getByTestId("brf-habits-toggle"));
    expect(screen.queryByTestId("brf-heatmap")).toBeNull();
  });

  it("습관이 0개면 히트맵 없이 빈 문구 + 인라인 추가", () => {
    const empty = { ...week(false), rows: [] };
    const history = { from: "2026-08-03", to: TODAY, days: [] };
    render(<HabitsCard week={empty} status="ready" reload={() => {}} toggle={vi.fn()} history={history} create={vi.fn()} />);
    expect(screen.queryByTestId("brf-heatmap")).toBeNull();
    expect(screen.getByTestId("brf-habits-empty")).toBeTruthy();
    expect(screen.getByTestId("brf-habit-add")).toBeTruthy();
  });

  it("저녁 정리의 남은 습관은 오늘 안 한 것만", () => {
    const { rerender } = render(<RemainingHabits week={week(false)} toggle={vi.fn()} />);
    expect(screen.getByTestId("brf-recap-habits").textContent).toContain("물 마시기");
    rerender(<RemainingHabits week={week(true)} toggle={vi.fn()} />);
    expect(screen.queryByTestId("brf-recap-habits")).toBeNull();
  });
});

describe("OverdueCard", () => {
  const item: DueReminder = {
    note_id: "n1",
    title: "서류 제출",
    kind: "overdue",
    fire_at: "2026-10-18T09:00:00",
    related_date_id: null,
  };

  it("0건이면 칸 자체가 없다(로딩 중 포함)", () => {
    const { container } = render(<OverdueCard status="loading" items={[]} reload={() => {}} dismiss={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });

  it("✓ 는 그 알림을 끈다", () => {
    const dismiss = vi.fn(() => Promise.resolve());
    render(<OverdueCard status="ready" items={[item]} reload={() => {}} dismiss={dismiss} />);
    fireEvent.click(screen.getByTestId("brf-overdue-dismiss"));
    expect(dismiss).toHaveBeenCalledWith(item);
  });
});

describe("HabitsCard — 인라인 추가", () => {
  const open = (create: (title: string) => Promise<boolean>) => {
    render(<HabitsCard week={week(false)} status="ready" reload={() => {}} toggle={vi.fn()} create={create} />);
    fireEvent.click(screen.getByTestId("brf-habit-add"));
    return screen.getByTestId("brf-habit-add-input") as HTMLInputElement;
  };

  it("Enter = 앞뒤 공백을 뺀 제목으로 만들고, 성공하면 칸을 비운다", async () => {
    const create = vi.fn(() => Promise.resolve(true));
    const input = open(create);
    fireEvent.change(input, { target: { value: "  스트레칭 " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(create).toHaveBeenCalledWith("스트레칭");
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("IME 조합 중 Enter 는 글자 확정 — 만들지 않는다", () => {
    const create = vi.fn(() => Promise.resolve(true));
    const input = open(create);
    fireEvent.change(input, { target: { value: "물" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(create).not.toHaveBeenCalled();
  });

  it("빈 제목 Enter 는 아무것도 하지 않는다", () => {
    const create = vi.fn(() => Promise.resolve(true));
    const input = open(create);
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(create).not.toHaveBeenCalled();
  });

  it("Esc 는 입력을 접는다 — 창 닫기 전에 소비 체인이 먹는다", () => {
    const create = vi.fn(() => Promise.resolve(true));
    const input = open(create);
    fireEvent.change(input, { target: { value: "물" } });
    const notPrevented = fireEvent.keyDown(window, { key: "Escape" });
    expect(notPrevented).toBe(false); // 소비 체인이 preventDefault — AuxWindowChrome 은 isOverlayOpen 으로 이미 비켜 섰다
    expect(screen.queryByTestId("brf-habit-add-input")).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("실패하면 입력을 그대로 둔다", async () => {
    const create = vi.fn(() => Promise.resolve(false));
    const input = open(create);
    fireEvent.change(input, { target: { value: "물" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(input.disabled).toBe(false));
    await waitFor(() => expect(document.activeElement).toBe(input)); // Enter 로 바로 재시도할 수 있게 포커스가 돌아온다
    expect(screen.getByTestId("brf-habit-add-input")).toBeTruthy();
    expect(input.value).toBe("물");
  });
});
