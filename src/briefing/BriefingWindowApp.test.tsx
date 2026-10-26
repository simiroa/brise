import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const silentMock = vi.fn();
vi.mock("../lib/invoke", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/invoke")>()),
  call: vi.fn(() => Promise.resolve({})),
  callSilent: (...a: unknown[]) => silentMock(...a),
}));
vi.mock("../lib/diag", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/diag")>()),
  reportFallback: vi.fn(),
}));
vi.mock("../lib/openNoteInMain", () => ({ requestOpenNoteInMain: vi.fn(() => Promise.resolve()) }));
// 창 크롬(설정 로드·아크릴·Esc 닫기)은 이 테스트의 관심이 아니다.
vi.mock("../components/AuxWindowChrome", () => ({
  AuxWindowChrome: ({ children }: { children: ReactNode }) => <div data-testid="chrome">{children}</div>,
}));
// 축은 "지금 어느 날을 그리나"만 드러내는 껍데기 — 축 동작은 DayDetailPanel.test.tsx 가 지킨다.
vi.mock("../components/home/calendar/DayAxis", () => ({
  TimeAxis: (p: { day: string | null }) => <div data-testid="axis-stub" data-day={p.day ?? ""} />,
}));

// listenMany 가 거는 Tauri 이벤트 구독을 붙잡아 테스트가 직접 쏜다.
const handlers: Record<string, (e: { payload: unknown }) => void> = {};
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, h: (e: { payload: unknown }) => void) => {
    handlers[name] = h;
    return Promise.resolve(() => {});
  },
  emit: vi.fn(() => Promise.resolve()),
}));

import { useSettingsStore } from "../stores/settings";
import { bumpNoteQueryVersion } from "../lib/noteQuery";
import { toIsoDateLocal } from "../components/home/dateFmt";
import { dayAfter, heatmapRange } from "./hooks/useBriefingData";
import { call } from "../lib/invoke";
import { invalidate } from "./requestCache";
import { resetScheduleVersion } from "./scheduleVersion";
import { BriefingWindowApp, NARROW_QUERY } from "./BriefingWindowApp";

const today = () => toIsoDateLocal(new Date());
const axisDay = () => screen.getByTestId("axis-stub").dataset.day;

const habitWeek = (day: string) => ({
  from: day,
  to: day,
  today: day,
  rows: [
    {
      habit: { id: "h1", workspace_id: "w1", title: "물 마시기", icon: null, hue: null, weekday_mask: 127, position: 0, archived_at: null, created_at: "", time_of_day: "any" },
      days: [{ day, scheduled: true, done: false }],
      streak: 3,
      done_count: 0,
      scheduled_count: 1,
      rate: 0,
    },
  ],
  done_count: 0,
  scheduled_count: 1,
  rate: 0,
});

beforeEach(() => {
  resetScheduleVersion();
  silentMock.mockReset();
  silentMock.mockImplementation((cmd: string, args?: { day?: string; from?: string; to?: string }) => {
    switch (cmd) {
      case "dashboard_calendar":
        return Promise.resolve({ year: 2026, month: 10, items: [] });
      case "timeline_routine_list":
        return Promise.resolve({ routines: [] });
      case "habit_week":
        return Promise.resolve(habitWeek(args?.day ?? today()));
      case "schedule_today":
        return Promise.resolve({ items: [] });
      case "briefing_recent_collected":
        return Promise.resolve({ items: [], new_count: 0 });
      case "collect_source_list":
        return Promise.resolve({ sources: [] });
      case "briefing_note_quote":
        return Promise.resolve({ quote: null });
      case "briefing_recent_notes":
        return Promise.resolve({ items: [] });
      case "habit_history":
        return Promise.resolve({ from: args?.from, to: args?.to, days: [] });
      default:
        return Promise.resolve({});
    }
  });
  useSettingsStore.setState({
    activeWorkspaceId: "w1",
    loaded: true,
    regionEnabled: false,
    aiEnabled: false,
    phrasePackId: "off",
    holidayRegion: "none",
    weekStart: "monday",
  });
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

describe("BriefingWindowApp — 날짜 이동", () => {
  it("축은 오늘로 열리고, ] / [ 로 하루씩 넘긴다", async () => {
    render(<BriefingWindowApp />);
    expect(axisDay()).toBe(today());
    fireEvent.keyDown(window, { key: "]" });
    expect(axisDay()).toBe(dayAfter(today(), 1));
    fireEvent.keyDown(window, { key: "[" });
    fireEvent.keyDown(window, { key: "[" });
    expect(axisDay()).toBe(dayAfter(today(), -1));
    // 오늘 버튼이 되돌린다
    fireEvent.click(screen.getByTestId("brf-day-today"));
    expect(axisDay()).toBe(today());
  });

  it("글자를 치는 중이거나 수식키가 있으면 [ ] 는 날짜를 바꾸지 않는다", () => {
    render(<BriefingWindowApp />);
    fireEvent.keyDown(window, { key: "]", ctrlKey: true });
    const field = document.createElement("input");
    document.body.appendChild(field);
    fireEvent.keyDown(field, { key: "]" });
    field.remove();
    expect(axisDay()).toBe(today());
  });

  it("작은 월 달력에서 날짜를 누르면 왼쪽 축이 그 날로 간다", async () => {
    render(<BriefingWindowApp />);
    const t = today();
    const target = `${t.slice(0, 8)}${t.slice(8) === "15" ? "16" : "15"}`;
    fireEvent.click(await screen.findByTestId(`brf-cal-day-${target}`));
    expect(axisDay()).toBe(target);
  });

});

describe("BriefingWindowApp — 오른쪽 열 구성", () => {
  it("작은 달력이 맨 위, 그다음 오늘의 습관 — 내일 칸·[오늘|내일] 탭은 없다", async () => {
    render(<BriefingWindowApp />);
    const cal = await screen.findByTestId("brf-mini-cal");
    const habits = await screen.findByTestId("brf-habits");
    expect(cal.compareDocumentPosition(habits) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(cal.parentElement?.firstElementChild).toBe(cal);
    expect(screen.queryByTestId("brf-tomorrow")).toBeNull();
  });

  it("최근 작업 노트는 오늘의 습관 다음에 온다(빈 목록이면 빈 상태 문구)", async () => {
    render(<BriefingWindowApp />);
    const habits = await screen.findByTestId("brf-habits");
    const recent = await screen.findByTestId("brf-recent-notes");
    expect(habits.compareDocumentPosition(recent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(habits.parentElement).toBe(recent.parentElement);
    await waitFor(() => expect(recent.textContent).toContain("7"));
  });

  it("좁은 창(<640px)에서도 달력이 맨 위이고 [오늘|내일] 탭은 없다", async () => {
    const orig = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q === NARROW_QUERY,
      media: q,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      render(<BriefingWindowApp />);
      expect(screen.getByTestId("briefing-root").dataset.narrow).toBe("1");
      const cal = await screen.findByTestId("brf-mini-cal");
      expect(cal.parentElement?.firstElementChild).toBe(cal);
      expect(screen.queryByRole("tablist")).toBeNull();
    } finally {
      window.matchMedia = orig;
    }
  });
});

describe("BriefingWindowApp — 저녁 모드", () => {
  it("?mode=recap 이어도 축은 오늘이고, 오른쪽에 '오늘 정리'가 붙는다(남은 습관 체크 가능)", async () => {
    window.history.replaceState(null, "", "/?mode=recap");
    render(<BriefingWindowApp />);
    expect(axisDay()).toBe(today());
    const recap = await screen.findByTestId("brf-recap");
    await waitFor(() => expect(recap.textContent).toContain("물 마시기"));
    expect(screen.getByTestId("briefing-recap")).toBeTruthy();
  });

  it("아침에는 '오늘 정리'가 없다", async () => {
    render(<BriefingWindowApp />);
    await screen.findByTestId("brf-habits");
    expect(screen.queryByTestId("brf-recap")).toBeNull();
  });

  it("습관 주 기준은 설정의 주 시작 요일(week_start)이다", async () => {
    render(<BriefingWindowApp />);
    await waitFor(() =>
      expect(silentMock).toHaveBeenCalledWith("habit_week", expect.objectContaining({ week_start: "monday" })),
    );
  });
});

describe("BriefingWindowApp — 습관 히트맵·인라인 추가", () => {
  const histCalls = () => silentMock.mock.calls.filter((c) => c[0] === "habit_history").length;
  beforeEach(() => invalidate("")); // 창 단위 요청 캐시는 모듈 수명 — 앞 테스트의 응답을 재사용하지 않게

  it("12주 히스토리를 주 시작 요일 기준 범위(…~오늘)로 읽고 습관 카드 안에 그린다", async () => {
    render(<BriefingWindowApp />);
    const { from, to } = heatmapRange(today(), "monday");
    await waitFor(() => expect(silentMock).toHaveBeenCalledWith("habit_history", expect.objectContaining({ from, to })));
    expect(to).toBe(today());
    expect(new Date(`${from}T00:00:00Z`).getUTCDay()).toBe(1);
    const card = screen.getByTestId("brf-habits");
    await waitFor(() => expect(card.querySelector("[data-testid='brf-heatmap']")).toBeTruthy());
  });

  it("오늘 칸 체크 뒤 히스토리를 다시 읽는다", async () => {
    render(<BriefingWindowApp />);
    await screen.findByTestId("brf-heatmap");
    const before = histCalls();
    fireEvent.click(screen.getByTestId("brf-habit-today"));
    await waitFor(() => expect(histCalls()).toBeGreaterThan(before));
  });

  it("인라인 추가 Enter → habit_create, 성공 뒤 주간·히스토리를 다시 읽는다", async () => {
    render(<BriefingWindowApp />);
    await screen.findByTestId("brf-heatmap");
    const before = histCalls();
    fireEvent.click(screen.getByTestId("brf-habit-add"));
    const input = screen.getByTestId("brf-habit-add-input");
    fireEvent.change(input, { target: { value: "  스트레칭 " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(vi.mocked(call)).toHaveBeenCalledWith("habit_create", { workspace_id: "w1", title: "스트레칭" }));
    await waitFor(() => expect(histCalls()).toBeGreaterThan(before));
  });
});

describe("BriefingWindowApp — 쓰기 반영", () => {
  const calCalls = () => silentMock.mock.calls.filter((c) => c[0] === "dashboard_calendar").length;

  it("remote-note-write(출처 무관)가 오면 일정을 다시 읽는다", async () => {
    render(<BriefingWindowApp />);
    await waitFor(() => expect(calCalls()).toBeGreaterThan(0));
    await waitFor(() => expect(handlers["remote-note-write"]).toBeTruthy());
    const before = calCalls();
    handlers["remote-note-write"]({ payload: { note_id: "n1", created: false, origin: "local" } });
    await waitFor(() => expect(calCalls()).toBeGreaterThan(before), { timeout: 1500 });
  });

  it("이 창의 달력 쓰기(bumpNoteQueryVersion)도 같은 길로 다시 읽는다", async () => {
    render(<BriefingWindowApp />);
    await waitFor(() => expect(calCalls()).toBeGreaterThan(0));
    const before = calCalls();
    bumpNoteQueryVersion();
    await waitFor(() => expect(calCalls()).toBeGreaterThan(before), { timeout: 1500 });
  });

  it("remote-note-write 가 오면 최근 작업 노트도 다시 읽는다(캐시 우회)", async () => {
    const rnCalls = () => silentMock.mock.calls.filter((c) => c[0] === "briefing_recent_notes").length;
    render(<BriefingWindowApp />);
    await waitFor(() => expect(rnCalls()).toBeGreaterThan(0));
    await waitFor(() => expect(handlers["remote-note-write"]).toBeTruthy());
    const before = rnCalls();
    handlers["remote-note-write"]({ payload: { note_id: "n1", created: false, origin: "local" } });
    await waitFor(() => expect(rnCalls()).toBeGreaterThan(before), { timeout: 1500 });
  });
});
