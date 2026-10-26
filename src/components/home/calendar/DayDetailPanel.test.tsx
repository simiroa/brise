/**
 * Day detail panel — schedule W5-5 time axis (docs/PLAN-schedule-system.md §6.2).
 *
 * The acceptance criterion the owner fixed on 2026-08-09 is a WIDTH: the aside stays a fixed
 * width so the month grid never gets narrower. That, the vertical-stacking overlap treatment it
 * forces (owner revision, same day — QA), and the "the axis scrolls inside itself, not the page"
 * rule are what this file pins — the packing math itself lives in calendarLayout.test.ts.
 *
 * Owner consistency fix: the width is now the shared `--dashboard-side-panel-w` token
 * (src/styles/dashboardList.css), same as the graph/map right panels, instead of a locally
 * hardcoded 280 — see that file for the measured value.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, fireEvent, act } from "@testing-library/react";
import type { CalendarItem, NoteDate } from "../../../lib/commands.gen";
import type { DailyForecast } from "../../../lib/weather";
import { DayDetailPanel, DayDetailBody } from "./DayDetailPanel";
import { useUiStore } from "../../../stores/ui";
import {
  DAY_AXIS_H,
  TIME_LABEL_W,
  STACK_GAP_PX,
  HOUR_ROW_H,
  PX_PER_MIN,
  MIN_HOUR_ROW_H,
  MAX_HOUR_ROW_H,
} from "../calendarLayout";

const callMock = vi.fn();
const bumpMock = vi.fn();
/** W9 ①: 되돌리기 토스트. 실물 undo.ts 의 나머지(Ctrl+Z 슬롯·지연 삭제)는 그대로 두고
 *  showUndoToast 하나만 가로챈다 — 이 트리의 다른 모듈도 같은 파일을 쓴다. */
const undoToastMock = vi.fn();

vi.mock("../../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  registerFlush: () => () => {},
  flushAll: async () => {},
  emitNotice: () => {},
}));

// PLAN-2026-09-10 D5: 카드에서의 "+ 이 날짜 추가"도 달력이 구독하는 축을 무효화해야 한다
// (NoteDatesList 가 안 지나는 경로). 실물은 250ms 코얼레싱 타이머라 불렸는지만 본다.
vi.mock("../../../lib/noteQuery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/noteQuery")>()),
  bumpNoteQueryVersion: (...args: unknown[]) => bumpMock(...args),
}));

vi.mock("../../../lib/undo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/undo")>()),
  showUndoToast: (...args: unknown[]) => undoToastMock(...args),
}));

beforeEach(() => {
  callMock.mockReset();
  // 포커스된 카드가 NoteDatesList 를 마운트한다 — 그 목록의 note_dates_list 는 어느
  // 테스트에서든 불릴 수 있으므로 기본 목에 응답을 둔다.
  callMock.mockImplementation(async (cmd: string) => {
    if (cmd === "note_dates_list") return { dates: [] };
    throw { code: "IO", message: "test" };
  });
  bumpMock.mockReset();
  undoToastMock.mockReset();
});

const DAY = "2026-08-09";

function item(p: Partial<CalendarItem> & Pick<CalendarItem, "note_id" | "kind">): CalendarItem {
  // 행 트리플 기본값은 span 에서 유도한다 — 서버 모양 그대로(시작 트리플 = span_start, 여러 날이면
  // 종료 트리플 = span_end). 축·손잡이 판정이 span 이 아니라 이 트리플(startsOnDay·rowIsSameDay)을
  // 읽으므로, 여러 날 span 인데 종료 트리플이 비어 있으면 실데이터에 없는 "하루짜리"가 된다.
  const spanStart = p.span_start ?? DAY;
  const spanEnd = p.span_end ?? spanStart;
  const [sy, sm, sd] = spanStart.split("-").map(Number);
  const [ey, em, ed] = spanEnd.split("-").map(Number);
  const multi = spanEnd !== spanStart;
  return {
    folder_id: "f",
    title: p.note_id,
    span_start: spanStart,
    span_end: spanEnd,
    year: sy,
    month: sm,
    day: sd,
    end_year: multi ? ey : null,
    end_month: multi ? em : null,
    end_day: multi ? ed : null,
    start_time: null,
    end_time: null,
    is_occurrence: null,
    remind: false,
    date_id: `d-${p.note_id}`,
    position: 0,
    remind_offset_min: null,
    rrule: null,
    ...p,
  };
}

function renderPanel(
  items: CalendarItem[],
  day: string | null = DAY,
  focusedNoteId?: string,
  extra?: { forecast?: DailyForecast | null; holidayName?: string | null },
) {
  return render(
    <DayDetailPanel
      selectedDay={day}
      monthLabel="2026년 8월"
      detailNotes={items}
      onOpen={() => {}}
      focusedNoteId={focusedNoteId ?? null}
      forecast={extra?.forecast ?? null}
      holidayName={extra?.holidayName ?? null}
    />,
  );
}

describe("DayDetailPanel time axis", () => {
  it("keeps the aside at the shared dashboard side-panel width (month grid must not get narrower)", () => {
    const { getByTestId } = renderPanel([item({ note_id: "a", kind: "event", start_time: "09:00" })]);
    expect((getByTestId("cal-detail") as HTMLElement).style.width).toBe("var(--dashboard-side-panel-w)");
  });

  // 오너 결정 2026-09-10: 날짜가 선택되면 헤더가 그날의 **일정 수**(축에 그려지는 시각 있는 항목)를
  // 노트 수와 나란히 말한다. 월 모드엔 축이 없으니 노트 수만.
  it("헤더 요약: 날짜를 고르면 일정 수 · 노트 수, 월 모드에선 노트 수만", () => {
    const items = [
      item({ note_id: "meeting", kind: "event", start_time: "09:00" }),
      item({ note_id: "trip", kind: "span", span_start: "2026-08-01", span_end: "2026-08-12" }),
    ];
    // 테스트 스토어의 uiLang 은 en — 문구는 en/home.json 것이다.
    const day = renderPanel(items, DAY);
    expect(day.getByTestId("cal-detail").textContent).toContain("1 events · 2 notes");
    day.unmount();

    const month = renderPanel(items, null);
    const header = month.getByTestId("cal-detail").textContent ?? "";
    expect(header).toContain("2 notes");
    expect(header).not.toContain("1 events");
  });

  it("splits timed items onto the axis and time-less ones into the all-day strip", () => {
    const { getByTestId, queryByTestId } = renderPanel([
      item({ note_id: "meeting", kind: "event", start_time: "09:00", end_time: "10:00" }),
      item({ note_id: "trip", kind: "span", span_start: "2026-08-01", span_end: "2026-08-12" }),
    ]);
    expect(getByTestId("cal-time-axis")).toBeDefined();
    expect(getByTestId("cal-time-event-meeting")).toBeDefined();
    expect(getByTestId("cal-detail-allday").textContent).toContain("trip");
    // The timed note is NOT duplicated as a card in the all-day strip.
    expect(queryByTestId("cal-detail-note-meeting")).toBeNull();
    // queryBy* 는 못 찾으면 null 을 반환하는데 expect(null).toBeDefined() 는 통과한다 —
    // "있어야 한다" 는 반드시 not.toBeNull() 로 써야 실제로 검증된다.
    expect(queryByTestId("cal-detail-note-trip")).not.toBeNull();
  });

  it("stacks near-time overlaps vertically — full width is never split into columns", () => {
    const { getByTestId } = renderPanel([
      item({ note_id: "a", kind: "event", start_time: "09:00", end_time: "11:00" }),
      item({ note_id: "b", kind: "event", start_time: "09:30", end_time: "10:00" }),
    ]);
    const a = getByTestId("cal-time-event-a") as HTMLElement;
    const b = getByTestId("cal-time-event-b") as HTMLElement;
    // Both chips keep the SAME left/right — width is shared by stacking, not by division.
    expect(a.style.left).toBe(`${TIME_LABEL_W}px`);
    expect(b.style.left).toBe(`${TIME_LABEL_W}px`);
    expect(a.style.right).toBe("0px");
    expect(b.style.right).toBe("0px");
    // a sits exactly on its 09:00 time coordinate (672px/24h axis)...
    const topA = (540 / 1440) * DAY_AXIS_H;
    expect(a.style.top).toBe(`${topA}px`);
    // ...b overlaps a's time span, so it's pushed to sit right below a instead of on top of it.
    const heightA = (120 / 1440) * DAY_AXIS_H;
    expect(a.style.height).toBe(`${heightA}px`);
    expect(b.style.top).toBe(`${topA + heightA + STACK_GAP_PX}px`);
  });

  it("scrolls the axis to the first event — inside its own container, not the aside", () => {
    const { getByTestId } = renderPanel([item({ note_id: "a", kind: "event", start_time: "13:00" })]);
    const axis = getByTestId("cal-time-axis") as HTMLElement;
    expect(axis.style.overflowY).toBe("auto");
    expect(axis.scrollTop).toBe((780 / 1440) * DAY_AXIS_H);
    // The aside itself must not scroll the 672px axis (that would scroll the whole page).
    expect((getByTestId("cal-detail") as HTMLElement).style.overflowY).toBe("hidden");
  });

  // 오너 요청(2026-09-16) — 마우스를 가만히 올리면 Ctrl+휠 확대/축소를 알려주는 네이티브 툴팁.
  it("축 스크롤러에 Ctrl+휠 확대 안내가 title 로 붙는다", () => {
    const { getByTestId } = renderPanel([]);
    expect(getByTestId("cal-time-axis").getAttribute("title")).toBe(
      "Ctrl + scroll to zoom the timeline", // 테스트 스토어의 uiLang 은 en
    );
  });

  // 오너 요청(2026-09-16) — 사이드바 축은 보이는 창이 좁아 계속 스크롤해야 한다는 피드백.
  // "하루 전체 보기"는 그 창 높이에 24시간을 다 넣는 배율로 한 번 바꾸고, 다시 누르면 원래
  // 배율 + 원래 스크롤 규칙(첫 일정/지금 시각/08:00)으로 되돌아간다.
  it("하루 전체 보기 — 누르면 컨테이너 높이에 24시간을 맞추고, 다시 누르면 되돌아간다", () => {
    const { getByTestId } = renderPanel([item({ note_id: "a", kind: "event", start_time: "13:00" })]);
    const axis = getByTestId("cal-time-axis") as HTMLElement;
    const fitBtn = getByTestId("cal-axis-fit-day");
    expect(fitBtn.getAttribute("aria-pressed")).toBe("false");

    vi.spyOn(axis, "getBoundingClientRect").mockReturnValue({
      top: 0,
      height: 240, // 240 / 24 = 10px/시간 — MIN_HOUR_ROW_H(28)보다 낮게 눌러 담아야 뜻이 있다.
      bottom: 240,
      left: 0,
      right: 200,
      width: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    fireEvent.click(fitBtn);
    expect(fitBtn.getAttribute("aria-pressed")).toBe("true");
    expect(axis.scrollTop).toBe(0);
    // 24시간이 컨테이너 높이(240px)에 정확히 들어가는 배율로 바뀌었다 — 눈금 한 시간이 10px.
    expect(getByTestId("cal-hour-label-1").parentElement?.style.top).toBe("10px");

    fireEvent.click(fitBtn);
    expect(fitBtn.getAttribute("aria-pressed")).toBe("false");
    // 기본 배율(HOUR_ROW_H)로 돌아가 이 날의 첫 일정(13:00) 자리로 다시 스크롤한다.
    expect(getByTestId("cal-hour-label-1").parentElement?.style.top).toBe(`${HOUR_ROW_H}px`);
    expect(axis.scrollTop).toBe((780 / 1440) * DAY_AXIS_H);
  });

  it("stacks any number of same-time events with no track cap — no '+n' badge anymore", () => {
    const { getByTestId, queryByTestId } = renderPanel(
      ["a", "b", "c", "d"].map((id) => item({ note_id: id, kind: "event", start_time: "09:00" })),
    );
    expect(queryByTestId("cal-time-overflow")).toBeNull();
    for (const id of ["a", "b", "c", "d"]) {
      expect(getByTestId(`cal-time-event-${id}`)).toBeDefined();
    }
  });

  // W4 ①: 축은 날짜가 선택돼 있으면 **항상** 그려진다 — 0건이어도 눈금은 뜬다(그 자체가 답이고,
  // 칩을 끌어다 넣을 바탕이기도 하다). 월 모드에는 그릴 날이 없으니 예전의 평평한 목록 그대로.
  it("시각 있는 항목이 0건이어도 축은 그려진다 — 안내 한 줄이 눈금 위에 붙는다 (W4 ①)", () => {
    const { getByTestId } = renderPanel([item({ note_id: "a", kind: "event" })]);
    expect(getByTestId("cal-time-axis")).toBeDefined();
    expect(getByTestId("cal-time-axis-empty")).toBeDefined();
    // 축이 생겼으므로 스크롤은 축 자신이 갖는다 — aside 가 아니라.
    expect((getByTestId("cal-detail") as HTMLElement).style.overflowY).toBe("hidden");
  });

  it("노트가 아예 없는 날도 축은 있다 — 빈 문구는 한 줄뿐이다", () => {
    const { getByTestId, queryByTestId } = renderPanel([]);
    expect(getByTestId("cal-time-axis")).toBeDefined();
    // 헤더 요약이 "0 events · 0 notes" 를 이미 말하므로 축 안내까지 겹치지 않는다.
    expect(queryByTestId("cal-time-axis-empty")).toBeNull();
  });

  it("월 모드에는 축이 없다 — 시각 있는 항목도 카드다", () => {
    const monthView = renderPanel([item({ note_id: "a", kind: "event", start_time: "09:00" })], null);
    expect(monthView.queryByTestId("cal-time-axis")).toBeNull();
    expect(monthView.queryByTestId("cal-time-axis-empty")).toBeNull();
    expect(monthView.getByTestId("cal-detail-note-a")).toBeDefined();
    expect((monthView.getByTestId("cal-detail") as HTMLElement).style.overflowY).toBe("auto");
  });

  it("collapses overlapping occurrences of one repeat row to one, preferring the one starting that day", () => {
    // Q11: 같은 날짜 행의 회차가 그 날 여럿 겹치면 하나만 남기고 그 날 시작하는 회차 우선
    const { getAllByTestId } = renderPanel([
      item({
        note_id: "n",
        kind: "span",
        span_start: "2026-08-07",
        span_end: "2026-08-09",
        is_occurrence: true,
      }),
      item({
        note_id: "n",
        kind: "span",
        span_start: "2026-08-09",
        span_end: "2026-08-11",
        is_occurrence: true,
      }),
    ]);
    expect(getAllByTestId("cal-detail-note-n")).toHaveLength(1);
  });

  // 2026-09-07 오너 결정(specs/commands/notes.yaml::note_date_add): 라벨 제거 — 관련 날짜도
  // 다른 항목과 마찬가지로 노트 제목으로만 표시된다("라벨 — 제목"이 아니다). 2026-09-10 (§D4):
  // 관련 날짜는 더 이상 자기 kind 를 갖지 않는다 — position !== 0 이 그 사실을 말한다.
  it("shows a related date (position != 0) by its note title alone, with no label prefix", () => {
    const { getByTestId } = renderPanel([
      item({ note_id: "launch", kind: "event", position: 1, title: "발표" }),
    ]);
    expect(getByTestId("cal-detail-note-launch").textContent).toContain("발표");
    expect(getByTestId("cal-detail-note-launch").textContent).not.toContain("—");
  });

  describe("inline checklist tasks", () => {
    it("renders inline tasks for the selected day", () => {
      const inlineTasks = [
        {
          id: "task-1",
          noteId: "note-a",
          noteTitle: "Note A",
          lineIndex: 0,
          text: "2026-08-09 할 일 A",
          rawText: "- [ ] 2026-08-09 할 일 A",
          completed: false,
          date: DAY,
        },
        {
          id: "task-2",
          noteId: "note-b",
          noteTitle: "Note B",
          lineIndex: 1,
          text: "2026-08-10 다른 날짜 일",
          rawText: "- [ ] 2026-08-10 다른 날짜 일",
          completed: false,
          date: "2026-08-10",
        },
      ];

      const { getByTestId, queryByTestId } = render(
        <DayDetailPanel
              selectedDay={DAY}
          monthLabel="2026년 8월"
          detailNotes={[]}
          onOpen={() => {}}
          inlineTasks={inlineTasks}
        />,
      );

      expect(getByTestId("cal-inline-tasks")).toBeDefined();
      expect(getByTestId("cal-inline-task-task-1")).toBeDefined();
      expect(queryByTestId("cal-inline-task-task-2")).toBeNull();
    });

    it("triggers onToggleInlineTask when task checkbox is clicked", () => {
      const onToggle = vi.fn();
      const task = {
        id: "task-1",
        noteId: "note-a",
        noteTitle: "Note A",
        lineIndex: 0,
        text: "할 일",
        rawText: "- [ ] @2026-08-09 할 일",
        completed: false,
        date: DAY,
      };

      const { getByTestId } = render(
        <DayDetailPanel
              selectedDay={DAY}
          monthLabel="2026년 8월"
          detailNotes={[]}
          onOpen={() => {}}
          inlineTasks={[task]}
          onToggleInlineTask={onToggle}
        />,
      );

      const checkbox = getByTestId("cal-inline-task-checkbox-task-1") as HTMLInputElement;
      checkbox.click();
      expect(onToggle).toHaveBeenCalledWith(task);
    });

    it("opens note on double clicking inline task", () => {
      const onOpen = vi.fn();
      const task = {
        id: "task-1",
        noteId: "note-a",
        noteTitle: "Note A",
        lineIndex: 0,
        text: "할 일",
        rawText: "- [ ] 2026-08-09 할 일",
        completed: false,
        date: DAY,
      };

      const { getByText } = render(
        <DayDetailPanel
              selectedDay={DAY}
          monthLabel="2026년 8월"
          detailNotes={[]}
          onOpen={onOpen}
          inlineTasks={[task]}
        />,
      );

      const taskEl = getByText("할 일");
      taskEl.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      expect(onOpen).toHaveBeenCalledWith("note-a");
    });
  });
});


/**
 * PLAN-2026-09-10-calendar-reminders.md D5 — 카드에서 노트로 가지 않고 알림을 끝낸다.
 * 접힘은 일정 요약 한 줄, 펼침(포커스된 카드)은 행 목록 + 이 날짜 추가 + 본문 발췌.
 */
describe("DetailNoteCard — 일정 요약과 펼침(D5)", () => {
  // 2026-09-10 아침엔 알림이 켜진 카드를 항상 펼쳐 뒀으나 같은 날 오너가 번복했다 —
  // 시각은 시간축이 이미 말하므로 접힘이 다시 기본이다. 접힘 = 메타 줄 + 벨 배지.
  it("알림이 켜져 있어도 포커스 전엔 접힘 — 메타 줄과 벨 배지가 그대로다", () => {
    const { getByTestId, queryByTestId } = renderPanel(
      [
        item({
          note_id: "a",
          kind: "event",
          span_start: "2026-08-01",
          span_end: "2026-08-12",
          start_time: "09:00",
          remind: true,
          remind_offset_min: 10,
        }),
      ],
      null,
    );
    const card = getByTestId("cal-detail-note-a");
    expect(card.textContent ?? "").toContain("09:00");
    expect(card.querySelector('[data-testid="cal-remind-badge-a"]')).not.toBeNull();
    expect(queryByTestId("cal-detail-expand-a")).toBeNull();
  });

  it("벨 꺼짐이고 포커스도 아니면 메타 줄이 그대로 — 벨 없이 시각만", () => {
    const { getByTestId } = renderPanel(
      [item({ note_id: "a", kind: "event", span_start: "2026-08-01", span_end: "2026-08-12", start_time: "09:00" })],
      null,
    );
    const card = getByTestId("cal-detail-note-a");
    expect(card.textContent ?? "").toContain("09:00");
    expect(card.querySelector('[data-testid="cal-remind-badge-a"]')).toBeNull();
  });

  // 월 모드에서만 둘째 줄이 남는다 — 헤더가 "2026년 8월"까지만 말하므로 항목별 날짜가 유일한 단서.
  it("월 모드에서는 둘째 줄(날짜/일정 메타)이 남는다 — 요약이 빈 줄이면 안 된다", () => {
    const { getByTestId } = renderPanel([item({ note_id: "a", kind: "event" })], null);
    expect(getByTestId("cal-detail-note-a").textContent).toContain("2026.08.09");
  });

  // 오너 결정 2026-09-10: 날짜가 선택되면 헤더가 이미 그 날을 말한다 → 카드는 한 줄.
  it("날짜가 선택되면 카드는 한 줄 — 둘째 줄의 날짜 메타가 사라진다", () => {
    const { getByTestId } = renderPanel([item({ note_id: "a", kind: "event" })], DAY);
    const card = getByTestId("cal-detail-note-a");
    expect(card.textContent).toContain("a");
    expect(card.textContent ?? "").not.toContain("2026.08.09");
  });

  // W14 ③ — 포커스는 이제 펼치지 않는다(동작 변화). 옛 단정("포커스된 카드만 목록이 있다")은
  // 그 결정 자체와 모순되므로 남길 수 없다 — 대신 "포커스로는 안 열리고, 설정 아이콘으로 열린다"
  // 를 단정한다. 열린 패널의 내용(목록 + 추가 버튼)은 그대로다.
  it("포커스만으로는 펼침 패널이 열리지 않는다 — 설정 아이콘이 연다 (W14 ③)", async () => {
    const { getByTestId, queryByTestId } = renderPanel(
      [item({ note_id: "on", kind: "event", remind: true }), item({ note_id: "f", kind: "event" })],
      DAY,
      "f",
    );
    expect(queryByTestId("cal-detail-expand-f")).toBeNull();
    fireEvent.click(getByTestId("cal-detail-settings-f"));
    await waitFor(() => expect(getByTestId("cal-detail-expand-f")).toBeDefined());
    expect(queryByTestId("cal-detail-expand-on")).toBeNull();
    // 펼침은 목록 + 추가 버튼 + 발췌 전부(extras).
    expect(getByTestId("cal-detail-add-date-f")).toBeDefined();
  });

  // 같은 노트의 칸이 그날 둘(대표 + 관련)이어도 목록은 하나만 마운트돼야 한다 — W14 부터는 그걸
  // 첫 칸 규칙(isFirstOfNote)이 아니라 **패널이 스트립에 하나뿐**이라는 구조가 보장한다.
  it("같은 노트의 칸이 둘이어도 마운트되는 목록은 하나뿐", async () => {
    const { getAllByTestId, queryAllByTestId } = renderPanel(
      [
        item({ note_id: "n", date_id: "d-n-0", kind: "span", span_start: "2026-08-07", span_end: "2026-08-09", is_occurrence: true, remind: true }),
        item({ note_id: "n", date_id: "d-n-1", position: 1, kind: "span", span_start: "2026-08-09", span_end: "2026-08-11", is_occurrence: true, remind: true }),
      ],
      DAY,
      "n",
    );
    expect(getAllByTestId("cal-detail-note-n")).toHaveLength(2);
    fireEvent.click(getAllByTestId("cal-detail-settings-n")[0]);
    await waitFor(() => expect(getAllByTestId("cal-detail-expand-n")).toHaveLength(1));
    expect(queryAllByTestId("note-dates-list")).toHaveLength(1);
  });

  // 오너 결정 2026-09-10: 링은 박스 안쪽. 밖으로 나간 링(offset 2 + 2px)이 우측 스크롤 경계에서
  // 잘렸다 — W14 의 가로 스트립은 자기가 가로 스크롤러라 첫 칸/마지막 칸에서 같은 일이 난다.
  it("선택 링은 칸 안쪽에 그린다 (outlineOffset -2) — 필과 카드 둘 다", () => {
    const pill = renderPanel([item({ note_id: "a", kind: "event" })], DAY, "a");
    const p = pill.getByTestId("cal-detail-card-a") as HTMLElement;
    expect(p.style.outlineOffset).toBe("-2px");
    // 필의 시각적 박스(테두리·호버)는 인라인이 아니라 `.chip-btn` 클래스가 갖는다.
    expect(p.className).toContain("chip-btn");
    pill.unmount();

    // 월 모드는 여전히 카드다 — 박스가 wrapper 에 있어 알림 줄이 테두리 밖에 뜨지 않는다.
    const card = renderPanel([item({ note_id: "a", kind: "event" })], null, "a");
    const c = card.getByTestId("cal-detail-card-a") as HTMLElement;
    expect(c.style.outlineOffset).toBe("-2px");
    // 카드의 시각적 박스(테두리·호버)도 필과 같은 원칙 — 인라인이 아니라 `.cal-month-card`
    // 클래스가 갖는다.
    expect(c.className).toContain("cal-month-card");
  });

  it("시간축 칩의 선택 링도 안쪽이다 (같은 잘림)", () => {
    const { getByTestId } = renderPanel(
      [item({ note_id: "a", kind: "event", start_time: "09:00" })],
      DAY,
      "a",
    );
    expect((getByTestId("cal-time-event-a") as HTMLElement).style.outlineOffset).toBe("-2px");
  });

  it("'+ 이 날짜 추가'가 선택된 날로 note_date_add 를 부르고 달력 축을 bump 한다", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_dates_list") return { dates: [] };
      if (cmd === "note_date_add") return { id: "new1" };
      throw { code: "IO", message: "test" };
    });
    const { getByTestId } = renderPanel([item({ note_id: "a", kind: "event" })], DAY, "a");
    // W14 ③ — 펼침은 설정 아이콘이 연다(포커스가 아니라).
    fireEvent.click(getByTestId("cal-detail-settings-a"));
    await waitFor(() => expect(getByTestId("cal-detail-add-date-a")).toBeDefined());
    getByTestId("cal-detail-add-date-a").click();
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("note_date_add", {
        note_id: "a",
        year: 2026,
        month: 8,
        day: 9,
      }),
    );
    expect(bumpMock).toHaveBeenCalled();
  });

  it("발췌는 첫 text 섹션 본문의 앞 두 줄 — 추가 IPC 없이 인라인 할 일과 같은 note_get_many 에서 온다", async () => {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_get_many") {
        return {
          notes: [
            {
              note: { id: "a", title: "치과" },
              sections: [
                { id: "s0", name: "", body_md: "무시", position: 0, kind: "diagram" },
                { id: "s1", name: "", body_md: "다음 주 스케일링 예약\n\n둘째 줄\n셋째 줄", position: 1, kind: "text" },
              ],
              sources: [],
              attachments: [],
            },
          ],
        };
      }
      if (cmd === "note_dates_list") return { dates: [] };
      throw { code: "IO", message: "test" };
    });
    const { getByTestId } = renderPanel([item({ note_id: "a", kind: "event" })], DAY, "a");
    fireEvent.click(getByTestId("cal-detail-settings-a"));
    await waitFor(() =>
      expect(getByTestId("cal-detail-excerpt-a").textContent).toBe("다음 주 스케일링 예약\n둘째 줄"),
    );
  });
});

/**
 * PLAN-2026-09-10 달력 W3 — 시간축 칩을 위아래로 끌어 시각을 바꾼다.
 *
 * 이 블록이 지키는 두 가지가 이 웨이브의 안전장치다:
 *  ⓐ 새 시각은 화면 `top`(스태킹 스윕을 거친 값)이 아니라 `startMin` + 픽셀델타로 센다.
 *  ⓑ `note_date_update` 는 전체 행 교체이므로 페이로드의 날짜는 화면 항목이 아니라 **DB 행**의 값.
 */
describe("TimeAxis — 칩 드래그로 시각 옮기기 (W3)", () => {
  function dbRow(p: Partial<NoteDate> & Pick<NoteDate, "id">): NoteDate {
    return {
      note_id: "m",
      position: 0,
      year: 2026,
      month: 8,
      day: 9,
      end_year: null,
      end_month: null,
      end_day: null,
      remind: false,
      created_at: "2026-08-01T00:00:00Z",
      start_time: "09:00",
      end_time: null,
      remind_offset_min: null,
      rrule: null,
      label: null,
      ...p,
    };
  }

  /** note_dates_list 는 주어진 행을, note_date_update 는 받은 페이로드를 그대로 돌려주는 목. */
  function mockRows(rows: NoteDate[], updateFails = false) {
    callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "note_dates_list") return { dates: rows };
      if (cmd === "note_date_update") {
        if (updateFails) throw { code: "IO", message: "test" };
        return { ...rows[0], ...args };
      }
      throw { code: "IO", message: "test" };
    });
  }

  function drag(el: HTMLElement, dy: number) {
    fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientY: 100 });
    fireEvent.pointerMove(el, { pointerId: 1, clientY: 100 + dy });
    fireEvent.pointerUp(el, { pointerId: 1, clientY: 100 + dy });
  }

  const updatePayload = () =>
    (callMock.mock.calls.find((c) => c[0] === "note_date_update") ?? [])[1] as
      | Record<string, unknown>
      | undefined;

  it("아래로 한 시간 끌면 DB 행을 거쳐 새 start_time/end_time 으로 저장된다 (길이 유지)", async () => {
    mockRows([dbRow({ id: "d-m", start_time: "09:00", end_time: "10:00" })]);
    const { getByTestId } = renderPanel([
      item({ note_id: "m", kind: "event", start_time: "09:00", end_time: "10:00" }),
    ]);
    drag(getByTestId("cal-time-event-m"), HOUR_ROW_H); // 28px = 1시간

    await waitFor(() => expect(updatePayload()).toBeDefined());
    expect(updatePayload()).toMatchObject({
      id: "d-m",
      start_time: "10:00",
      end_time: "11:00", // 길이 60분 그대로
    });
    // 저장 뒤 달력 축을 무효화한다(NoteDatesList.syncStores 와 같은 두 줄).
    await waitFor(() => expect(bumpMock).toHaveBeenCalled());
  });

  // ⓑ 회귀 — 가장 중요한 테스트. 화면 항목은 반복 회차라 날짜가 씨앗과 다르다.
  it("반복 회차를 끌어도 페이로드의 year/month/day 는 DB 행의 값이다", async () => {
    // 씨앗 행은 7월 5일. 화면에 뜬 회차는 8월 9일(월 클리핑까지 거친 값).
    mockRows([
      dbRow({
        id: "d-rep",
        note_id: "rep",
        year: 2026,
        month: 7,
        day: 5,
        start_time: "09:00",
        rrule: "FREQ=WEEKLY;INTERVAL=1",
      }),
    ]);
    const { getByTestId } = renderPanel([
      item({
        note_id: "rep",
        kind: "event",
        date_id: "d-rep",
        start_time: "09:00",
        is_occurrence: true,
        year: 2026,
        month: 8,
        day: 9,
        rrule: "FREQ=WEEKLY;INTERVAL=1",
      }),
    ]);
    drag(getByTestId("cal-time-event-rep"), 7); // 15분

    await waitFor(() => expect(updatePayload()).toBeDefined());
    expect(updatePayload()).toMatchObject({
      id: "d-rep",
      year: 2026,
      month: 7,
      day: 5,
      start_time: "09:15",
      rrule: "FREQ=WEEKLY;INTERVAL=1",
    });
  });

  it("date_id 와 일치하는 행이 없으면 아무것도 쓰지 않고 되돌린다", async () => {
    mockRows([dbRow({ id: "다른행", note_id: "m" })]);
    const { getByTestId } = renderPanel([
      item({ note_id: "m", kind: "event", start_time: "09:00" }),
    ]);
    const chip = getByTestId("cal-time-event-m");
    drag(chip, HOUR_ROW_H);
    await waitFor(() =>
      expect(callMock.mock.calls.some((c) => c[0] === "note_dates_list")).toBe(true),
    );
    expect(updatePayload()).toBeUndefined();
    await waitFor(() => expect(chip.style.transform).toBe(""));
  });

  it("임계(3px) 미만은 드래그가 아니다 — 클릭(포커스)이 그대로 산다", async () => {
    mockRows([dbRow({ id: "d-m" })]);
    const onFocus = vi.fn();
    const { getByTestId } = render(
      <DayDetailPanel
          selectedDay={DAY}
        monthLabel="2026년 8월"
        detailNotes={[item({ note_id: "m", kind: "event", start_time: "09:00" })]}
        onOpen={() => {}}
        onFocus={onFocus}
      />,
    );
    const chip = getByTestId("cal-time-event-m");
    drag(chip, 2);
    fireEvent.click(chip);
    expect(onFocus).toHaveBeenCalledWith("m");
    expect(updatePayload()).toBeUndefined();
  });

  it("진짜 드래그 뒤에 따라오는 click 은 포커스로 새지 않는다", async () => {
    mockRows([dbRow({ id: "d-m" })]);
    const onFocus = vi.fn();
    const { getByTestId } = render(
      <DayDetailPanel
          selectedDay={DAY}
        monthLabel="2026년 8월"
        detailNotes={[item({ note_id: "m", kind: "event", start_time: "09:00" })]}
        onOpen={() => {}}
        onFocus={onFocus}
      />,
    );
    const chip = getByTestId("cal-time-event-m");
    drag(chip, HOUR_ROW_H);
    fireEvent.click(chip);
    expect(onFocus).not.toHaveBeenCalled();
  });

  it("저장이 실패하면 칩이 원위치로 돌아간다 (§9 롤백)", async () => {
    mockRows([dbRow({ id: "d-m" })], true);
    const { getByTestId } = renderPanel([
      item({ note_id: "m", kind: "event", start_time: "09:00" }),
    ]);
    const chip = getByTestId("cal-time-event-m");
    drag(chip, HOUR_ROW_H);
    // 드롭 직후엔 낙관적으로 이미 밀려 있고...
    expect(chip.style.transform).toBe(`translateY(${HOUR_ROW_H}px)`);
    // ...실패가 돌아오면 원위치.
    await waitFor(() => expect(chip.style.transform).toBe(""));
    expect(chip.textContent).toContain("09:00");
  });

  it("드래그 중에는 칩의 시각 라벨이 드래그 값으로 바뀐다", () => {
    mockRows([dbRow({ id: "d-m" })]);
    const { getByTestId } = renderPanel([
      item({ note_id: "m", kind: "event", start_time: "09:00" }),
    ]);
    const chip = getByTestId("cal-time-event-m");
    fireEvent.pointerDown(chip, { button: 0, pointerId: 1, clientY: 100 });
    fireEvent.pointerMove(chip, { pointerId: 1, clientY: 100 + 7 });
    expect(chip.textContent).toContain("09:15");
    expect(chip.getAttribute("data-moving")).toBe("true");
  });

  it("키보드 ↑/↓ 도 같은 저장 경로를 탄다 (Shift 는 1시간)", async () => {
    mockRows([dbRow({ id: "d-m", start_time: "09:00" })]);
    const { getByTestId } = renderPanel([
      item({ note_id: "m", kind: "event", start_time: "09:00" }),
    ]);
    const chip = getByTestId("cal-time-event-m");
    fireEvent.keyDown(chip, { key: "ArrowDown" });
    await waitFor(() => expect(updatePayload()).toMatchObject({ start_time: "09:15" }));

    callMock.mockClear();
    fireEvent.keyDown(chip, { key: "ArrowUp", shiftKey: true });
    await waitFor(() => expect(updatePayload()).toMatchObject({ start_time: "08:15" }));
  });

  it("Enter/Space 는 여전히 노트를 연다 — 화살표가 그 경로를 가리지 않는다", () => {
    mockRows([dbRow({ id: "d-m" })]);
    const onOpen = vi.fn();
    const { getByTestId } = render(
      <DayDetailPanel
          selectedDay={DAY}
        monthLabel="2026년 8월"
        detailNotes={[item({ note_id: "m", kind: "event", start_time: "09:00" })]}
        onOpen={onOpen}
      />,
    );
    fireEvent.keyDown(getByTestId("cal-time-event-m"), { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith("m");
  });
});

/**
 * PLAN-2026-09-10 달력 W5 — 손잡이로 시작·끝 따로 조정(①), 빈 곳 드래그로 추가(②),
 * 오늘의 현재 시각 눈금(③).
 *
 * ① 이 조용히 남의 날짜를 망칠 수 있는 유일한 경로는 **여러 날 span 의 끝 손잡이**다 —
 * 그 `end_time` 은 마지막 날의 시각이라 이 날의 끝이 아니다. 그래서 손잡이를 아예 주지 않는다.
 */
describe("TimeAxis — 손잡이 · 빈 곳 드래그 · 현재 시각 (W5)", () => {
  function dbRow(p: Partial<NoteDate> & Pick<NoteDate, "id">): NoteDate {
    return {
      note_id: "m",
      position: 0,
      year: 2026,
      month: 8,
      day: 9,
      end_year: null,
      end_month: null,
      end_day: null,
      remind: false,
      created_at: "2026-08-01T00:00:00Z",
      start_time: "09:00",
      end_time: null,
      remind_offset_min: null,
      rrule: null,
      label: null,
      ...p,
    };
  }

  function mockRows(rows: NoteDate[]) {
    callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "note_dates_list") return { dates: rows };
      if (cmd === "note_date_update") return { ...rows[0], ...args };
      throw { code: "IO", message: "test" };
    });
  }

  const updatePayload = () =>
    (callMock.mock.calls.find((c) => c[0] === "note_date_update") ?? [])[1] as
      | Record<string, unknown>
      | undefined;

  /** 잡은 요소를 dy 만큼 세로로 끈다. 오너 요청(2026-09-16) 이후 리사이즈는 칩 자신이 아니라
   *  캔버스 절대좌표에 앉은 전용 손잡이(cal-time-handle-start/end-*)가 맡으므로, 어느 모드인지는
   *  **어느 요소를 넘겼는지**가 이미 정한다 — chipDragMode 로 되짚을 rect 도 필요 없다(그 판정
   *  자체가 없어졌다). 칩 자신에 쓰면 항상 이동이다. */
  function dragEl(el: HTMLElement, dy: number) {
    fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientY: 100 });
    fireEvent.pointerMove(el, { pointerId: 1, clientY: 100 + dy });
    fireEvent.pointerUp(el, { pointerId: 1, clientY: 100 + dy });
  }

  it("위 손잡이를 끌면 start_time 만 바뀐다 — 끝은 행 값 그대로", async () => {
    mockRows([dbRow({ id: "d-m", start_time: "09:00", end_time: "10:00" })]);
    const { getByTestId } = renderPanel([
      item({ note_id: "m", kind: "event", start_time: "09:00", end_time: "10:00" }),
    ]);
    dragEl(getByTestId("cal-time-handle-start-m"), -7); // 15분 위로

    await waitFor(() => expect(updatePayload()).toBeDefined());
    // 이동이었다면 end_time 이 09:45 가 됐을 자리다.
    expect(updatePayload()).toMatchObject({ start_time: "08:45", end_time: "10:00" });
  });

  it("아래 손잡이를 끌면 end_time 만 바뀐다 — 시작은 행 값 그대로", async () => {
    mockRows([dbRow({ id: "d-m", start_time: "09:00", end_time: "10:00" })]);
    const { getByTestId } = renderPanel([
      item({ note_id: "m", kind: "event", start_time: "09:00", end_time: "10:00" }),
    ]);
    dragEl(getByTestId("cal-time-handle-end-m"), 7);

    await waitFor(() => expect(updatePayload()).toBeDefined());
    expect(updatePayload()).toMatchObject({ start_time: "09:00", end_time: "10:15" });
  });

  it("칩 본문을 끌면 이동 그대로 — 둘 다 바뀐다", async () => {
    mockRows([dbRow({ id: "d-m", start_time: "09:00", end_time: "10:00" })]);
    const { getByTestId } = renderPanel([
      item({ note_id: "m", kind: "event", start_time: "09:00", end_time: "10:00" }),
    ]);
    dragEl(getByTestId("cal-time-event-m"), HOUR_ROW_H);

    await waitFor(() => expect(updatePayload()).toBeDefined());
    expect(updatePayload()).toMatchObject({ start_time: "10:00", end_time: "11:00" });
  });

  it("최소 길이 30분 아래로는 못 줄인다", async () => {
    mockRows([dbRow({ id: "d-m", start_time: "09:00", end_time: "10:00" })]);
    const { getByTestId } = renderPanel([
      item({ note_id: "m", kind: "event", start_time: "09:00", end_time: "10:00" }),
    ]);
    dragEl(getByTestId("cal-time-handle-end-m"), -1000); // 끝을 시작 위로

    await waitFor(() => expect(updatePayload()).toBeDefined());
    expect(updatePayload()).toMatchObject({ start_time: "09:00", end_time: "09:30" });
  });

  // 이 웨이브에서 조용히 남의 날짜를 망칠 수 있는 유일한 경로.
  it("여러 날 span 에는 손잡이 자체가 없다 — 몸통을 끌어도 이동이다", async () => {
    mockRows([
      dbRow({ id: "d-trip", note_id: "trip", start_time: "09:00", end_time: null, end_day: 11 }),
    ]);
    const { getByTestId, queryByTestId } = renderPanel([
      item({
        note_id: "trip",
        kind: "span",
        date_id: "d-trip",
        span_start: DAY,
        span_end: "2026-08-11",
        start_time: "09:00",
      }),
    ]);
    expect(queryByTestId("cal-time-handle-start-trip")).toBeNull();
    expect(queryByTestId("cal-time-handle-end-trip")).toBeNull();

    dragEl(getByTestId("cal-time-event-trip"), 7);
    await waitFor(() => expect(updatePayload()).toBeDefined());
    // 이동이므로 시작만 밀린다 — 끝 손잡이였다면 end_time 이 생겨 마지막 날의 시각을 바꿨다.
    expect(updatePayload()).toMatchObject({ start_time: "09:15", end_time: null });
  });

  // 2026-10-18 회귀 — 10/31→11/02 행은 10월 조회에서 [10/31, 10/31] 로 잘려 온다. 화면 조각의
  // span_start === span_end 로 판정하면 하루짜리로 오판해 손잡이가 생기고, 11/02 의 끝 시각을
  // 이 날의 끝으로 라벨에 찍었다. 판정은 행 모양(rowIsSameDay)이다.
  it("월 말로 잘려 하루처럼 보이는 여러 날 행도 손잡이·끝 라벨이 없다", () => {
    const view = renderPanel(
      [
        item({ note_id: "m", kind: "event", span_start: "2026-10-31", start_time: "07:00", end_time: "08:00" }),
        item({
          note_id: "ov",
          kind: "span",
          span_start: "2026-10-31",
          span_end: "2026-10-31", // 잘린 조각
          end_year: 2026,
          end_month: 11,
          end_day: 2,
          start_time: "09:00",
          end_time: "18:00", // 11/02 의 시각
        }),
      ],
      "2026-10-31",
    );
    // 대조군: 진짜 하루짜리는 손잡이가 있다.
    expect(view.queryByTestId("cal-time-handle-end-m")).not.toBeNull();
    expect(view.queryByTestId("cal-time-handle-start-ov")).toBeNull();
    expect(view.queryByTestId("cal-time-handle-end-ov")).toBeNull();
    expect(view.getByTestId("cal-chip-meta-ov").textContent).toBe("09:00");
  });

  // ⓑ 회귀 — 끝 손잡이에도 같은 장치가 걸려 있어야 한다.
  it("반복 회차의 끝을 끌어도 페이로드의 year/month/day 는 DB 행의 값이다", async () => {
    mockRows([
      dbRow({
        id: "d-rep",
        note_id: "rep",
        year: 2026,
        month: 7,
        day: 5,
        start_time: "09:00",
        end_time: "10:00",
        rrule: "FREQ=WEEKLY;INTERVAL=1",
      }),
    ]);
    const { getByTestId } = renderPanel([
      item({
        note_id: "rep",
        kind: "event",
        date_id: "d-rep",
        start_time: "09:00",
        end_time: "10:00",
        is_occurrence: true,
        year: 2026,
        month: 8,
        day: 9,
        rrule: "FREQ=WEEKLY;INTERVAL=1",
      }),
    ]);
    dragEl(getByTestId("cal-time-handle-end-rep"), 7);

    await waitFor(() => expect(updatePayload()).toBeDefined());
    expect(updatePayload()).toMatchObject({
      id: "d-rep",
      year: 2026,
      month: 7,
      day: 5,
      start_time: "09:00",
      end_time: "10:15",
    });
  });

  // 오너 요청(2026-09-16) — 커서는 이제 요소가 정한다(계산 없음): 칩은 항상 grab, 전용 손잡이는
  // 항상 ns-resize. 예전의 "칩 안 어디를 잡았는지로 되짚는" onMouseMove 판정은 없앴다 — 그 판정이
  // 보던 칩의 렌더 박스가 CHIP_MIN_H·스태킹으로 진짜 경계와 어긋날 수 있었다(위 HANDLE_HIT_PAD
  // 주석 참고).
  it("칩은 항상 grab, 손잡이는 항상 ns-resize", () => {
    mockRows([dbRow({ id: "d-m", start_time: "09:00", end_time: "10:00" })]);
    const { getByTestId } = renderPanel([
      item({ note_id: "m", kind: "event", start_time: "09:00", end_time: "10:00" }),
    ]);
    expect(getByTestId("cal-time-event-m").style.cursor).toBe("grab");
    expect(getByTestId("cal-time-handle-start-m").style.cursor).toBe("ns-resize");
    expect(getByTestId("cal-time-handle-end-m").style.cursor).toBe("ns-resize");
  });

  // ② 빈 곳 드래그 → 그 자리에서 노트를 만든다(만드는 일은 CalendarTab 이 한다).
  describe("빈 곳 드래그로 추가", () => {
    function renderWithCreate(
      items: CalendarItem[],
      onCreate: (day: string, startMin: number, endMin: number) => void,
    ) {
      return render(
        <DayDetailPanel
          selectedDay={DAY}
          monthLabel="2026년 8월"
          detailNotes={items}
          onOpen={() => {}}
          onCreateTimedNote={onCreate}
        />,
      );
    }

    function dragAxis(el: HTMLElement, y0: number, y1: number) {
      fireEvent.pointerDown(el, { button: 0, pointerId: 9, clientY: y0 });
      fireEvent.pointerMove(el, { pointerId: 9, clientY: y1 });
      fireEvent.pointerUp(el, { pointerId: 9, clientY: y1 });
    }

    it("빈 곳을 끌면 (날짜, 시작분, 끝분) 으로 한 번만 불린다", () => {
      const onCreate = vi.fn();
      const { getByTestId } = renderWithCreate([], onCreate);
      dragAxis(getByTestId("cal-time-axis-canvas"), 9 * HOUR_ROW_H, 11 * HOUR_ROW_H);
      expect(onCreate).toHaveBeenCalledTimes(1);
      expect(onCreate).toHaveBeenCalledWith(DAY, 540, 660);
    });

    it("드래그 중에는 범위 미리보기가 보인다", () => {
      const onCreate = vi.fn();
      const { getByTestId, queryByTestId } = renderWithCreate([], onCreate);
      const canvas = getByTestId("cal-time-axis-canvas");
      fireEvent.pointerDown(canvas, { button: 0, pointerId: 9, clientY: 9 * HOUR_ROW_H });
      fireEvent.pointerMove(canvas, { pointerId: 9, clientY: 10 * HOUR_ROW_H });
      expect(getByTestId("cal-time-new-range").textContent).toBe("09:00–10:00");
      fireEvent.pointerUp(canvas, { pointerId: 9, clientY: 10 * HOUR_ROW_H });
      expect(queryByTestId("cal-time-new-range")).toBeNull();
    });

    it("임계 미만(그냥 클릭)이면 아무것도 만들지 않는다", () => {
      const onCreate = vi.fn();
      const { getByTestId } = renderWithCreate([], onCreate);
      dragAxis(getByTestId("cal-time-axis-canvas"), 252, 254);
      expect(onCreate).not.toHaveBeenCalled();
    });

    it("칩 위에서 시작한 드래그는 ① 이지 생성이 아니다", async () => {
      mockRows([dbRow({ id: "d-m", start_time: "09:00" })]);
      const onCreate = vi.fn();
      const { getByTestId } = renderWithCreate(
        [item({ note_id: "m", kind: "event", start_time: "09:00" })],
        onCreate,
      );
      dragEl(getByTestId("cal-time-event-m"), HOUR_ROW_H);
      await waitFor(() => expect(updatePayload()).toBeDefined());
      expect(onCreate).not.toHaveBeenCalled();
    });
  });

  // ③ 오늘일 때만 현재 시각 눈금. 시각 계산은 calendarLayout::nowLineTop 의 단위 테스트가
  // 지키고, 여기서는 "오늘인가"만 시계를 고정해 본다.
  describe("현재 시각 눈금", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("오늘이 아니면 눈금도 라벨도 없다", () => {
      const { queryByTestId } = renderPanel([]);
      expect(queryByTestId("cal-time-now")).toBeNull();
      expect(queryByTestId("cal-time-now-label")).toBeNull();
    });

    // W10 ①: 1px 실선이 안 보인다는 오너 실기 — 굵기·발광·라벨이 붙었다.
    it("오늘이면 현재 분 자리에 accent 선, 그리고 그 위에 현재 시각 라벨", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 7, 9, 10, 30, 0)); // 2026-08-09 10:30 로컬
      const { getByTestId } = renderPanel([]);
      const line = getByTestId("cal-time-now") as HTMLElement;
      expect(line.style.top).toBe(`${630 * PX_PER_MIN}px`);
      expect(line.style.borderTop).toBe("2px solid var(--accent)");
      // 맥동은 CSS 클래스가 갖는다(tokens.css .cal-now-line — reduced-motion 에서 멈춘다).
      expect(line.className).toContain("cal-now-line");
      expect(getByTestId("cal-time-now-label").textContent).toBe("10:30");
    });

    it("눈금은 여전히 pointerEvents: none — 드래그를 가로막지 않는다", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 7, 9, 10, 30, 0));
      const { getByTestId } = renderPanel([]);
      expect((getByTestId("cal-time-now") as HTMLElement).style.pointerEvents).toBe("none");
    });

    // 2026-09-12 사이드바 QA: 오늘 일정이 없으면 축이 08:00 으로 고정 스크롤됐다 — 사이드바처럼
    // 보이는 창이 좁으면(≈6시간) 지금이 08:00~14:00 밖일 때 현재 시각 눈금이 스크롤 밖으로
    // 밀려 "안 보인다"는 사고로 이어졌다(대시보드는 축이 넓어 덜 드러났을 뿐 같은 결함). 08:00
    // 근처가 아닌 시각으로 고정해 그 갈래를 잡는다.
    it("오늘 일정이 없으면 08:00 이 아니라 지금 시각으로 스크롤한다", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 7, 9, 20, 0, 0)); // 2026-08-09 20:00 — 08:00 창 밖
      const { getByTestId } = renderPanel([]);
      const axis = getByTestId("cal-time-axis") as HTMLElement;
      // jsdom 은 실제 레이아웃이 없어 clientHeight 가 0 이다 — 뷰포트 절반만큼 위로 당기는 항이
      // 사라지므로 지금 분 자리에 정확히 top-align 된다.
      expect(axis.scrollTop).toBe((1200 / 1440) * DAY_AXIS_H);
    });
  });
});

/**
 * PLAN-2026-09-10 달력 W4 ② — 상단이 그 날의 브리핑 리포트다(연월 · 일 · 요일 · 공휴일 ·
 * 날씨 · 요약). 테스트 스토어의 uiLang 은 en 이라 문구는 en/home.json 것이다.
 */
describe("DayBriefing — 그 날의 브리핑 (W4 ②)", () => {
  const forecast: DailyForecast = {
    time: ["2026-08-08", DAY],
    weatherCode: [3, 0],
    tempMaxC: [28, 31.4],
    tempMinC: [20, 22.6],
    fetchedAt: 0,
  };

  it("연월 · 일 · 요일 · 요약을 함께 낸다", () => {
    const { getByTestId } = renderPanel([item({ note_id: "a", kind: "event", start_time: "09:00" })]);
    const brief = getByTestId("cal-day-briefing");
    expect(brief.textContent).toContain("August 2026");
    expect(getByTestId("cal-briefing-day").textContent).toBe("9");
    expect(brief.textContent).toContain("Sunday");
    expect(brief.textContent).toContain("1 events · 1 notes");
  });

  it("히어로는 굵기가 아니라 크기다 — 일 숫자만 --text-clock", () => {
    const { getByTestId } = renderPanel([]);
    const day = getByTestId("cal-briefing-day") as HTMLElement;
    expect(day.style.fontSize).toBe("var(--text-clock)");
    // 굵기 사다리는 400/600 두 단뿐이라 위계를 굵기로 주지 않는다(docs/DESIGN.md).
    // 날씨가 히어로 줄 오른쪽으로 올라오면서(2026-09-10) 날짜는 한 겹 더 안쪽에 있다 —
    // 굵기를 들고 있는 건 여전히 줄 자체(h3)다.
    expect((day.closest("h3") as HTMLElement).style.fontWeight).toBe("400");
  });

  // 2026-09-10 오너 실기: 날씨는 히어로 줄 **오른쪽**으로 올라갔고, 글자 라벨("맑음")은 그 줄에서
  // 빠져 title 툴팁으로 갔다 — 아이콘이 이미 그 말을 하고 있어 한 줄에 조각이 여섯이 됐다.
  // 월 그리드가 이미 같은 규칙이다(MonthGrid 의 weatherTitle).
  it("날씨: 아이콘 · 최고/최저는 그 날 항목에서, 라벨은 툴팁에서 온다", () => {
    const { getByTestId } = renderPanel([], DAY, undefined, { forecast });
    const w = getByTestId("cal-briefing-weather");
    expect(w.querySelector("svg")).not.toBeNull();
    expect(w.textContent).toContain("31°");
    expect(w.textContent).toContain("23°");
    expect(w.textContent).not.toContain("Clear");
    expect(w.getAttribute("title")).toContain("Clear"); // WMO 0 → home.weather_clear
    // 날짜와 같은 줄에 산다 — 날씨만 따로 한 줄을 쓰지 않는다.
    expect(w.closest("h3")).not.toBeNull();
  });

  it("forecast 가 없으면 날씨 자리만 조용히 빈다 — 나머지는 그대로", () => {
    const { getByTestId, queryByTestId } = renderPanel([], DAY, undefined, { forecast: null });
    expect(queryByTestId("cal-briefing-weather")).toBeNull();
    expect(getByTestId("cal-briefing-day").textContent).toBe("9");
  });

  it("예보 창 밖의 날(그 날짜가 forecast.time 에 없음)도 같은 방식으로 빈다", () => {
    const { queryByTestId } = renderPanel([], "2026-08-20", undefined, { forecast });
    expect(queryByTestId("cal-briefing-weather")).toBeNull();
  });

  it("공휴일 이름이 있으면 낸다", () => {
    const withHoliday = renderPanel([], DAY, undefined, { holidayName: "광복절" });
    expect(withHoliday.getByTestId("cal-briefing-holiday").textContent).toBe("광복절");
    withHoliday.unmount();

    const plain = renderPanel([], DAY);
    expect(plain.queryByTestId("cal-briefing-holiday")).toBeNull();
    expect(plain.queryByTestId("cal-day-briefing")).not.toBeNull();
  });

  it("월 모드에는 브리핑이 없다 — 기존 월 헤더 그대로", () => {
    const { queryByTestId, getByTestId } = renderPanel([item({ note_id: "a", kind: "event" })], null);
    expect(queryByTestId("cal-day-briefing")).toBeNull();
    expect(getByTestId("cal-detail").textContent).toContain("2026년 8월");
  });
});

/**
 * 그릴 2026-09-13 W3 + 후속 — 축 배경 루틴("출퇴근" 등, 노트에 안 묶임). 요일이 맞으면 축에
 * 배경 띠로 그려지고, skip_holidays 를 켠 루틴은 그 날이 공휴일이면(holidayName prop, 부모의
 * useHolidayMap 기준) 빠진다. weekday_mask 는 127(전 요일)을 써서 DAY 상수의 실제 요일과
 * 무관하게 항상 걸리게 한다.
 */
describe("DayDetailPanel — 축 배경 루틴", () => {
  function mockRoutines(routines: unknown[]) {
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === "note_dates_list") return { dates: [] };
      if (cmd === "timeline_routine_list") return { routines };
      throw { code: "IO", message: "test" };
    });
  }

  it("요일이 맞는 루틴을 배경 띠로 그린다", async () => {
    mockRoutines([
      {
        id: "tr1",
        workspace_id: "w",
        title: "출근",
        weekday_mask: 127,
        start_time: "09:00",
        end_time: "18:00",
        color_hue: 200,
        skip_holidays: false,
        position: 0,
        created_at: "",
        updated_at: "",
      },
    ]);
    const { findByTestId, getByTestId } = renderPanel([], DAY);
    const band = await findByTestId("cal-timeline-routine-tr1");
    expect(band.getAttribute("title")).toBe("출근 09:00–18:00");
    // 배경 장식이라 클릭·포인터 이벤트를 받지 않는다(v1 범위).
    expect(getByTestId("cal-timeline-routine-tr1").style.pointerEvents).toBe("none");
  });

  it("skip_holidays 를 켠 루틴은 공휴일엔 숨고, 평일엔 그대로 보인다", async () => {
    mockRoutines([
      {
        id: "tr2",
        workspace_id: "w",
        title: "헬스",
        weekday_mask: 127,
        start_time: "19:00",
        end_time: "20:00",
        color_hue: null,
        skip_holidays: true,
        position: 0,
        created_at: "",
        updated_at: "",
      },
    ]);
    const holiday = renderPanel([], DAY, undefined, { holidayName: "광복절" });
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("timeline_routine_list", {}));
    expect(holiday.queryByTestId("cal-timeline-routine-tr2")).toBeNull();
    holiday.unmount();

    const plain = renderPanel([], DAY);
    expect(await plain.findByTestId("cal-timeline-routine-tr2")).toBeTruthy();
  });

  it("skip_holidays 를 끈 루틴은 공휴일에도 그대로 보인다", async () => {
    mockRoutines([
      {
        id: "tr3",
        workspace_id: "w",
        title: "출근",
        weekday_mask: 127,
        start_time: "09:00",
        end_time: "18:00",
        color_hue: null,
        skip_holidays: false,
        position: 0,
        created_at: "",
        updated_at: "",
      },
    ]);
    const { findByTestId } = renderPanel([], DAY, undefined, { holidayName: "광복절" });
    expect(await findByTestId("cal-timeline-routine-tr3")).toBeTruthy();
  });
});

/**
 * PLAN-2026-09-10 달력 W14 — 종일 목록이 **가로 스트립**이다(오너 실기 번복 2026-09-11).
 *
 * 옛 W4 ③/W8 ③(3개 이상이면 접힘, 펼치면 목록이 축의 자리를 먹음)을 검증하던 이 블록은 통째로
 * 바뀌었다: 그 접힘 자체가 사라졌기 때문이다. 이제 지키는 것은 셋이다 — ⓐ **아무것도 자르지
 * 않는다**(몇 개든 전부 DOM 에 있다 = 원래 버그의 뿌리), ⓑ 그릇이 가로 스크롤 한 줄이다,
 * ⓒ 축은 목록 상태와 무관하게 항상 있다.
 */
describe("종일 가로 스트립 (W14)", () => {
  const five = ["a", "b", "c", "d", "e"].map((id) => item({ note_id: id, kind: "event" }));

  it("노트 5개도 전부 그린다 — 2개로 자르던 접힘이 없어졌다", () => {
    const { getByTestId, queryByTestId } = renderPanel(five);
    for (const id of ["a", "b", "c", "d", "e"]) {
      expect(queryByTestId(`cal-detail-note-${id}`)).not.toBeNull();
    }
    // 토글은 이제 없다 — 접을 것이 없다.
    expect(queryByTestId("cal-detail-notes-toggle")).toBeNull();
    // 목록이 몇 개든 축은 그대로 있다(예전엔 펼치면 사라졌다).
    expect(getByTestId("cal-time-axis")).toBeDefined();
  });

  it("그릇이 가로 한 줄이다 — row · nowrap · overflowX auto", () => {
    const strip = renderPanel(five).getByTestId("cal-detail-allday") as HTMLElement;
    expect(strip.style.flexDirection).toBe("row");
    expect(strip.style.flexWrap).toBe("nowrap");
    expect(strip.style.overflowX).toBe("auto");
  });

  it("둘째 줄(일정 메타)은 화면 글자가 아니라 title 툴팁이다 (W14 ②)", () => {
    const { getByTestId } = renderPanel([item({ note_id: "a", kind: "event" })]);
    const body = getByTestId("cal-detail-note-a") as HTMLElement;
    expect(body.getAttribute("title")).toContain("2026.08.09");
    expect(body.textContent ?? "").not.toContain("2026.08.09");
  });

  it("월 모드는 그대로 세로 카드 목록이다 (W14 ④)", () => {
    const { getByTestId } = renderPanel(five, null);
    const list = getByTestId("cal-detail-allday") as HTMLElement;
    expect(list.style.flexDirection).toBe("column");
    expect(list.style.overflowX).toBe("");
    // 월 모드에서는 항목별 날짜가 유일한 단서라 둘째 줄이 화면에 남는다.
    expect(getByTestId("cal-detail-note-a").textContent).toContain("2026.08.09");
  });

  describe("③ 펼침 — 설정 아이콘이 여는 떠 있는 패널", () => {
    const open = () => {
      const view = renderPanel(five);
      fireEvent.click(view.getByTestId("cal-detail-settings-a"));
      return view;
    };

    it("카드 클릭은 포커스만 — 패널을 열지 않는다", () => {
      const focusMock = vi.fn();
      const view = render(
        <DayDetailPanel
          selectedDay={DAY}
          monthLabel="2026년 8월"
          detailNotes={five}
          onOpen={() => {}}
          onFocus={focusMock}
        />,
      );
      fireEvent.click(view.getByTestId("cal-detail-note-a"));
      expect(focusMock).toHaveBeenCalledWith("a");
      expect(view.queryByTestId("cal-detail-menu-a")).toBeNull();
    });

    it("설정 아이콘을 누르면 그 칸의 펼침이 뜨고, 옛 내용이 그 안에 있다", async () => {
      const view = open();
      const menu = view.getByTestId("cal-detail-menu-a") as HTMLElement;
      // 축 칩의 메뉴와 같은 모양 — 흐름에 끼어들지 않고 떠 있다.
      expect(menu.style.position).toBe("absolute");
      expect(menu.style.top).toBe("100%");
      expect(menu.style.zIndex).toBe("3");
      // 날짜 행 목록 · "이 날짜 추가" 는 FocusedDetails 그대로.
      await waitFor(() => expect(menu.querySelector('[data-testid="cal-detail-expand-a"]')).not.toBeNull());
      expect(view.getByTestId("cal-detail-add-date-a")).toBeDefined();
    });

    it("스트립에 하나뿐이다 — 다른 칸을 열면 먼저 열린 것이 닫힌다", () => {
      const view = open();
      fireEvent.click(view.getByTestId("cal-detail-settings-b"));
      expect(view.queryByTestId("cal-detail-menu-a")).toBeNull();
      expect(view.getByTestId("cal-detail-menu-b")).toBeDefined();
    });

    it("바깥 클릭 · Escape 로 닫힌다 (축 칩과 같은 dismiss)", () => {
      const outside = open();
      fireEvent.mouseDown(document.body);
      expect(outside.queryByTestId("cal-detail-menu-a")).toBeNull();
      outside.unmount();

      const esc = open();
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(esc.queryByTestId("cal-detail-menu-a")).toBeNull();
      esc.unmount();

      // 패널 안에서 누른 Escape 도 닫는다(React 루트에서 전파가 끊기는 환경 대비).
      const inner = open();
      fireEvent.keyDown(inner.getByTestId("cal-detail-menu-a"), { key: "Escape" });
      expect(inner.queryByTestId("cal-detail-menu-a")).toBeNull();
    });

    it("패널 안을 누르는 것은 바깥이 아니다", () => {
      const view = open();
      fireEvent.mouseDown(view.getByTestId("cal-detail-menu-a"));
      expect(view.getByTestId("cal-detail-menu-a")).toBeDefined();
    });

    it("날짜가 바뀌면 닫힌다 — 다른 날의 펼침을 물려받지 않는다", () => {
      const view = render(
        <DayDetailPanel selectedDay={DAY} monthLabel="2026년 8월" detailNotes={five} onOpen={() => {}} />,
      );
      fireEvent.click(view.getByTestId("cal-detail-settings-a"));
      expect(view.getByTestId("cal-detail-menu-a")).toBeDefined();
      view.rerender(
        <DayDetailPanel
          selectedDay="2026-08-10"
          monthLabel="2026년 8월"
          detailNotes={five.map((it) => ({ ...it, span_start: "2026-08-10", span_end: "2026-08-10" }))}
          onOpen={() => {}}
        />,
      );
      expect(view.queryByTestId("cal-detail-menu-a")).toBeNull();
    });
  });
});

/**
 * PLAN-2026-09-10 달력 W7 — 위쪽 종일 카드를 아래 축으로 끌어다 놓으면 그 시각으로 등록된다.
 *
 * 이 블록이 지키는 것은 **무엇을 쓰는가**다. 판정도 페이로드도 화면 항목이 아니라
 * `note_dates_list` 로 읽은 진짜 행 기준이고(함정 ⓑ), 행의 모양에 따라 셋으로 갈린다 —
 * 정밀도 낮음(날짜 확정 + 종료 트리플 비움) · 하루짜리(시각만) · 여러 날 span(시작 시각만).
 */
describe("TimeAxis — 종일 카드를 축으로 끌어다 놓기 (W7)", () => {
  function dbRow(p: Partial<NoteDate> & Pick<NoteDate, "id">): NoteDate {
    return {
      note_id: "a",
      position: 0,
      year: 2026,
      month: 8,
      day: 9,
      end_year: null,
      end_month: null,
      end_day: null,
      remind: false,
      created_at: "2026-08-01T00:00:00Z",
      start_time: null,
      end_time: null,
      remind_offset_min: null,
      rrule: null,
      label: null,
      ...p,
    };
  }

  function mockRows(rows: NoteDate[], updateFails = false) {
    callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "note_dates_list") return { dates: rows };
      if (cmd === "note_date_update") {
        if (updateFails) throw { code: "IO", message: "test" };
        return { ...rows[0], ...args };
      }
      throw { code: "IO", message: "test" };
    });
  }

  const updateCalls = () => callMock.mock.calls.filter((c) => c[0] === "note_date_update");
  const updatePayload = () => updateCalls()[0]?.[1] as Record<string, unknown> | undefined;

  /** jsdom 의 rect 는 전부 0 이라 "축 안인가" 판정을 할 수 없다 — 실제 레이아웃을 세워 준다.
   *  스크롤러는 보이는 창(히트 판정), 캔버스는 672px 전체(픽셀→분 계산). */
  function stubAxis(view: ReturnType<typeof renderPanel>) {
    for (const id of ["cal-time-axis", "cal-time-axis-canvas"]) {
      const el = view.getByTestId(id) as HTMLElement;
      vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
        top: 0,
        height: DAY_AXIS_H,
        bottom: DAY_AXIS_H,
        left: 0,
        right: 200,
        width: 200,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect);
    }
  }

  /** W9 ② 이후 끌 수 있는 곳은 카드 왼쪽 **그립**뿐이다 — 본체는 클릭/더블클릭만 맡는다. */
  const grip = (view: ReturnType<typeof renderPanel>, noteId: string) =>
    view.getByTestId(`cal-detail-grip-${noteId}`) as HTMLElement;

  /** clientY 는 축 컨테이너 기준 픽셀 — 10 * HOUR_ROW_H 가 10:00 이다. */
  function dragCard(el: HTMLElement, toY: number, fromY = 500) {
    fireEvent.pointerDown(el, { button: 0, pointerId: 7, clientX: 50, clientY: fromY });
    fireEvent.pointerMove(el, { pointerId: 7, clientX: 50, clientY: toY });
    fireEvent.pointerUp(el, { pointerId: 7, clientX: 50, clientY: toY });
  }

  it("하루짜리 행 → 시각만 얹는다. update 는 딱 한 번이고 길이는 30분", async () => {
    mockRows([dbRow({ id: "d-a" })]);
    const view = renderPanel([item({ note_id: "a", kind: "event" })]);
    stubAxis(view);
    dragCard(grip(view, "a"), 10 * HOUR_ROW_H);

    await waitFor(() => expect(updatePayload()).toBeDefined());
    expect(updateCalls()).toHaveLength(1);
    expect(updatePayload()).toMatchObject({
      id: "d-a",
      year: 2026,
      month: 8,
      day: 9,
      end_year: null,
      end_month: null,
      end_day: null,
      start_time: "10:00",
      end_time: "10:30",
    });
    // 등록 뒤 달력 축을 무효화한다 — 그 재조회에서 이 항목이 종일 목록을 떠나 칩이 된다.
    await waitFor(() => expect(bumpMock).toHaveBeenCalled());
  });

  it("정밀도 낮은 행 → 놓은 날로 날짜가 확정되고 종료 트리플이 비워진다", async () => {
    // 화면 항목은 8/9 로 뜨지만 행은 연 정밀도(2024) + 연 범위다. 판정은 **행**이 한다.
    mockRows([dbRow({ id: "d-a", year: 2024, month: null, day: null, end_year: 2025 })]);
    const view = renderPanel([item({ note_id: "a", kind: "event" })]);
    stubAxis(view);
    dragCard(grip(view, "a"), 10 * HOUR_ROW_H);

    await waitFor(() => expect(updatePayload()).toBeDefined());
    expect(updatePayload()).toMatchObject({
      id: "d-a",
      year: 2026,
      month: 8,
      day: 9,
      end_year: null,
      end_month: null,
      end_day: null,
      start_time: "10:00",
    });
  });

  /**
   * D2(그릴 2026-09-11) — 이 describe 가 원래 "여러 날 span → 시작 시각만"이라 부르던 갈래가
   * 지금은 다이얼로그 뒤로 옮겨갔다: 첫날이 아닌 곳에 놓으면 planAllDayDrop 을 바로 쓰지 않고
   * 먼저 묻는다. 아래 네 테스트가 이 이름을 물려받아 D2 의 갈래 넷(첫날 무통보 · 다이얼로그 ·
   * ⓐ · ⓑ · 취소)을 나눠 갖는다.
   */
  describe("D2 — 여러 날 span 을 첫날 아닌 곳에 놓으면 묻는다", () => {
    function tripRow(p: Partial<NoteDate> = {}): NoteDate {
      return dbRow({
        id: "d-trip",
        note_id: "trip",
        month: 8,
        day: 1,
        end_year: 2026,
        end_month: 8,
        end_day: 20,
        start_time: "09:00",
        end_time: "18:00",
        ...p,
      });
    }
    const tripItem = (extra?: Partial<CalendarItem>) =>
      item({
        note_id: "trip",
        kind: "span",
        date_id: "d-trip",
        span_start: "2026-08-01",
        span_end: "2026-08-20",
        start_time: "09:00",
        end_time: "18:00",
        ...extra,
      });

    it("첫날(8/1)에 놓으면 D1 의 '시각만' — 묻지 않고 그대로 저장된다", async () => {
      mockRows([tripRow()]);
      // 아직 시각이 없는 span 카드로 — 그래야 자기 첫날에도 종일 카드로 뜬다(끌 그립이 있다).
      // start_time 이 이미 있으면 planTimedDay 가 첫날은 곧장 축의 칩으로 그려 그립 자체가 없다.
      const view = renderPanel(
        [tripItem({ start_time: null, end_time: null })],
        "2026-08-01",
      );
      stubAxis(view);
      dragCard(grip(view, "trip"), 10 * HOUR_ROW_H);
      await waitFor(() => expect(updatePayload()).toBeDefined());
      expect(view.queryByTestId("modal-shell")).toBeNull();
      expect(updatePayload()).toMatchObject({ id: "d-trip", month: 8, day: 1, start_time: "10:00" });
    });

    it("중간 날(8/9)에 놓으면 즉시 쓰지 않고 다이얼로그로 고르게 한다", async () => {
      mockRows([tripRow()]);
      const view = renderPanel([tripItem()]);
      stubAxis(view);
      dragCard(grip(view, "trip"), 10 * HOUR_ROW_H);
      await waitFor(() => expect(view.getByTestId("modal-shell")).toBeDefined());
      // 아직 아무것도 쓰지 않았다.
      expect(updateCalls()).toHaveLength(0);
      expect(callMock.mock.calls.some((c) => c[0] === "note_date_add")).toBe(false);
    });

    it("ⓐ '8/1 시작 시각으로 저장' 선택 — 범위도 end_time 도 그대로, 시작 시각만", async () => {
      mockRows([tripRow()]);
      const view = renderPanel([tripItem()]);
      stubAxis(view);
      dragCard(grip(view, "trip"), 10 * HOUR_ROW_H);
      await waitFor(() => expect(view.getByTestId("modal-shell")).toBeDefined());
      fireEvent.click(view.getByText("Save as 08.01 start time"));

      await waitFor(() => expect(updatePayload()).toBeDefined());
      expect(updatePayload()).toMatchObject({
        id: "d-trip",
        year: 2026,
        month: 8,
        day: 1,
        end_year: 2026,
        end_month: 8,
        end_day: 20,
        start_time: "10:00",
        end_time: "18:00",
      });
    });

    it("ⓑ '8/9 에 따로 두기' 선택 — note_date_add 로 그 날의 새 관련 행을 만든다(시각 포함)", async () => {
      mockRows([tripRow()]);
      const view = renderPanel([tripItem()]);
      stubAxis(view);
      dragCard(grip(view, "trip"), 10 * HOUR_ROW_H);
      await waitFor(() => expect(view.getByTestId("modal-shell")).toBeDefined());
      fireEvent.click(view.getByText("Keep separately on 08.09"));

      await waitFor(() =>
        expect(callMock.mock.calls.some((c) => c[0] === "note_date_add")).toBe(true),
      );
      const addCall = callMock.mock.calls.find((c) => c[0] === "note_date_add")!;
      expect(addCall[1]).toMatchObject({
        note_id: "trip",
        year: 2026,
        month: 8,
        day: 9,
        end_year: null,
        end_month: null,
        end_day: null,
        start_time: "10:00",
        end_time: "10:30",
      });
      // span 행 자신은 건드리지 않는다 — 관련 행을 새로 만든 것뿐이다.
      expect(updateCalls()).toHaveLength(0);
    });

    it("취소 — 아무것도 쓰지 않고 카드가 종일 목록으로 돌아온다", async () => {
      mockRows([tripRow()]);
      const view = renderPanel([tripItem()]);
      stubAxis(view);
      dragCard(grip(view, "trip"), 10 * HOUR_ROW_H);
      // 결정 전엔 낙관적으로 이미 빠져 있다가(§9 낙관적 표시), 행을 읽어 다이얼로그가 필요하다고
      // 판명되면 되돌아온다 — 최종 상태만 본다(중간의 빠진 프레임은 단언하지 않는다).
      await waitFor(() => expect(view.getByTestId("modal-shell")).toBeDefined());
      expect(view.queryByTestId("cal-detail-note-trip")).not.toBeNull();
      fireEvent.click(view.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(view.queryByTestId("modal-shell")).toBeNull());
      expect(view.queryByTestId("cal-detail-note-trip")).not.toBeNull();
      expect(updateCalls()).toHaveLength(0);
      expect(callMock.mock.calls.some((c) => c[0] === "note_date_add")).toBe(false);
    });

    // 회귀 — 판정은 DB 행(firstDay) 기준이지 화면 항목의 span_start(월 클리핑된 값)가 아니다.
    // 여기서는 그 둘이 **같은 값**으로 우연히 맞아떨어지면 이 판정이 실은 화면 값을 보고 있어도
    // 통과해 버리므로, 일부러 클리핑된 화면 span_start(8/1, = 놓은 날)와 행의 진짜 첫날(7/25,
    // 클리핑으로 화면엔 아예 안 보이는 값)을 다르게 둔다.
    it("판정은 DB 행 기준 — 화면 span_start 가 놓은 날과 우연히 같아도 행의 진짜 첫날로 판정한다", async () => {
      mockRows([tripRow({ month: 7, day: 25, start_time: null, end_time: null })]);
      const view = renderPanel(
        [tripItem({ start_time: null, end_time: null })],
        "2026-08-01",
      );
      stubAxis(view);
      dragCard(grip(view, "trip"), 10 * HOUR_ROW_H);
      // 화면 span_start(8/1) == 놓은 날(8/1) 이지만 행의 진짜 첫날은 7/25 — 물어야 한다.
      await waitFor(() => expect(view.getByTestId("modal-shell")).toBeDefined());
      expect(updateCalls()).toHaveLength(0);
    });
  });

  // ⓑ 회귀 — W3/W5 가 같은 테스트를 갖고 있다. 화면 항목은 회차라 날짜가 씨앗과 다르다.
  it("반복 회차 카드를 놓아도 페이로드의 year/month/day 는 DB 행의 값이다", async () => {
    mockRows([
      dbRow({
        id: "d-rep",
        note_id: "rep",
        year: 2026,
        month: 7,
        day: 5,
        rrule: "FREQ=WEEKLY;INTERVAL=1",
      }),
    ]);
    const view = renderPanel([
      item({
        note_id: "rep",
        kind: "event",
        date_id: "d-rep",
        is_occurrence: true,
        year: 2026,
        month: 8,
        day: 9,
        rrule: "FREQ=WEEKLY;INTERVAL=1",
      }),
    ]);
    stubAxis(view);
    dragCard(grip(view, "rep"), 10 * HOUR_ROW_H);

    await waitFor(() => expect(updatePayload()).toBeDefined());
    expect(updatePayload()).toMatchObject({
      id: "d-rep",
      year: 2026,
      month: 7,
      day: 5,
      start_time: "10:00",
      rrule: "FREQ=WEEKLY;INTERVAL=1",
    });
  });

  it("드래그 중에는 그 시각의 미리보기가 축을 따라다닌다", () => {
    mockRows([dbRow({ id: "d-a" })]);
    const view = renderPanel([item({ note_id: "a", kind: "event" })]);
    stubAxis(view);
    const el = grip(view, "a");
    fireEvent.pointerDown(el, { button: 0, pointerId: 7, clientX: 10, clientY: 500 });
    fireEvent.pointerMove(el, { pointerId: 7, clientX: 50, clientY: 10 * HOUR_ROW_H });
    const ghost = view.getByTestId("cal-time-drop") as HTMLElement;
    expect(ghost.textContent).toBe("10:00 a");
    expect(ghost.style.top).toBe(`${600 * PX_PER_MIN}px`);
  });

  it("임계(3px) 미만은 드래그가 아니다 — 클릭(포커스)이 그대로 산다", () => {
    mockRows([dbRow({ id: "d-a" })]);
    const onFocus = vi.fn();
    const view = render(
      <DayDetailPanel
        selectedDay={DAY}
        monthLabel="2026년 8월"
        detailNotes={[item({ note_id: "a", kind: "event" })]}
        onOpen={() => {}}
        onFocus={onFocus}
      />,
    );
    stubAxis(view);
    const el = grip(view, "a");
    dragCard(el, 502, 500); // 2px
    fireEvent.click(view.getByTestId("cal-detail-note-a"));
    expect(onFocus).toHaveBeenCalledWith("a");
    expect(updateCalls()).toHaveLength(0);
  });

  it("진짜 드래그 뒤에 따라오는 click 은 포커스로 새지 않는다", () => {
    mockRows([dbRow({ id: "d-a" })]);
    const onFocus = vi.fn();
    const view = render(
      <DayDetailPanel
        selectedDay={DAY}
        monthLabel="2026년 8월"
        detailNotes={[item({ note_id: "a", kind: "event" })]}
        onOpen={() => {}}
        onFocus={onFocus}
      />,
    );
    stubAxis(view);
    // 축 밖에서 뗀 진짜 드래그 — 저장은 없지만 카드가 남아 있어 click 이 실제로 온다.
    dragCard(grip(view, "a"), DAY_AXIS_H + 200);
    fireEvent.click(view.getByTestId("cal-detail-note-a"));
    expect(onFocus).not.toHaveBeenCalled();
  });

  it("축 밖에 놓으면 아무것도 쓰지 않는다 — 행을 읽지도 않는다", () => {
    mockRows([dbRow({ id: "d-a" })]);
    const view = renderPanel([item({ note_id: "a", kind: "event" })]);
    stubAxis(view);
    dragCard(grip(view, "a"), DAY_AXIS_H + 200); // 축 아래
    expect(callMock.mock.calls.some((c) => c[0] === "note_dates_list")).toBe(false);
    expect(updateCalls()).toHaveLength(0);
    expect(view.queryByTestId("cal-detail-note-a")).not.toBeNull();
  });

  it("저장이 실패하면 카드가 종일 목록으로 돌아온다 (§9 롤백)", async () => {
    mockRows([dbRow({ id: "d-a" })], true);
    const view = renderPanel([item({ note_id: "a", kind: "event" })]);
    stubAxis(view);
    dragCard(grip(view, "a"), 10 * HOUR_ROW_H);
    // 드롭 직후엔 낙관적으로 이미 축으로 옮겨간 것으로 그린다 — 카드가 목록에서 빠진다.
    expect(view.queryByTestId("cal-detail-note-a")).toBeNull();
    // ...실패가 돌아오면 카드가 돌아온다.
    await waitFor(() => expect(view.queryByTestId("cal-detail-note-a")).not.toBeNull());
    expect(view.queryByTestId("cal-time-drop")).toBeNull();
  });

  // 이 웨이브(W14)의 **핵심 증거**. 노트가 많은 날엔 어느 상태로도 3번째 이후를 끌 수 없었다:
  // 접히면 그 카드가 DOM 에 없고, 펼치면 놓을 축이 사라졌다(오너 실기 2026-09-11). 가로 스트립은
  // 아무것도 자르지 않고 축도 그대로 두므로 3번째·5번째 칸도 축까지 닿는다.
  it("노트 5개인 날: 3번째 칸의 그립에서 시작한 드래그가 축까지 닿는다 (W14 ①)", async () => {
    mockRows([dbRow({ id: "d-c" })]);
    const five = ["a", "b", "c", "d", "e"].map((id) => item({ note_id: id, kind: "event" }));
    const view = renderPanel(five);
    expect(view.getByTestId("cal-detail-note-c")).toBeDefined();
    expect(view.getByTestId("cal-time-axis")).toBeDefined();

    stubAxis(view);
    dragCard(grip(view, "c"), 10 * HOUR_ROW_H);
    await waitFor(() => expect(updatePayload()).toBeDefined());
    expect(updatePayload()).toMatchObject({ id: "d-c", start_time: "10:00", end_time: "10:30" });
  });

  // W14 ③ — 펼쳐진 칸은 끌리지 않는다(축 칩의 같은 규칙과 같은 이유: 패널 안에 캐럿을 놓을
  // 입력이 있고, 드래그가 포인터를 캡처하면 그 입력이 포커스를 못 받는다). 닫으면 돌아온다.
  it("펼쳐진 칸은 끌리지 않는다 — 닫으면 드래그가 그대로 돌아온다", async () => {
    mockRows([dbRow({ id: "d-a" })]);
    const view = renderPanel([item({ note_id: "a", kind: "event" })]);
    stubAxis(view);
    fireEvent.click(view.getByTestId("cal-detail-settings-a"));
    dragCard(grip(view, "a"), 10 * HOUR_ROW_H);
    expect(updateCalls()).toHaveLength(0);
    expect(view.queryByTestId("cal-time-drop")).toBeNull();

    fireEvent.click(view.getByTestId("cal-detail-settings-a"));
    dragCard(grip(view, "a"), 10 * HOUR_ROW_H);
    await waitFor(() => expect(updatePayload()).toBeDefined());
  });

  it("date_id 와 일치하는 행이 없으면 아무것도 쓰지 않고 되돌린다", async () => {
    mockRows([dbRow({ id: "다른행" })]);
    const view = renderPanel([item({ note_id: "a", kind: "event" })]);
    stubAxis(view);
    dragCard(grip(view, "a"), 10 * HOUR_ROW_H);
    await waitFor(() =>
      expect(callMock.mock.calls.some((c) => c[0] === "note_dates_list")).toBe(true),
    );
    expect(updateCalls()).toHaveLength(0);
    await waitFor(() => expect(view.queryByTestId("cal-detail-note-a")).not.toBeNull());
  });
});

/**
 * PLAN-2026-09-10 달력 W9 — 드래그의 **안전망과 손맛**.
 *
 * ① 되돌리기: 시각을 바꾸는 다섯 경로(칩 이동 · 시작 손잡이 · 끝 손잡이 · 키보드 ↑/↓ ·
 *    종일 카드 드롭)가 전부 commitDateRow 한 지점을 지나므로 토스트도 거기 하나뿐이다.
 *    되돌리기는 **새 쓰기 경로를 만들지 않고** 같은 함수를 한 번 더 지난다(함정 ⓑ 유지).
 * ② 그립: 끌 수 있는 곳은 카드 왼쪽 그립뿐, 본체는 클릭/더블클릭만.
 */
describe("달력 W9 — 되돌리기와 그립", () => {
  function dbRow(p: Partial<NoteDate> & Pick<NoteDate, "id">): NoteDate {
    return {
      note_id: "m",
      position: 0,
      year: 2026,
      month: 8,
      day: 9,
      end_year: null,
      end_month: null,
      end_day: null,
      remind: false,
      created_at: "2026-08-01T00:00:00Z",
      start_time: "09:00",
      end_time: "10:00",
      remind_offset_min: null,
      rrule: null,
      label: null,
      ...p,
    };
  }

  /** 행이 실제로 바뀌는 목 — 되돌리기가 "그때의 값"으로 다시 쓰는지 보려면 정적 목으론 안 된다. */
  function mockLiveRow(row: NoteDate, updateFails = false) {
    let cur = { ...row };
    callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "note_dates_list") return { dates: [cur] };
      if (cmd === "note_date_update") {
        if (updateFails) throw { code: "IO", message: "test" };
        cur = { ...cur, ...(args as Partial<NoteDate>) };
        return cur;
      }
      throw { code: "IO", message: "test" };
    });
  }

  const updates = () => callMock.mock.calls.filter((c) => c[0] === "note_date_update");
  const payloadAt = (i: number) => updates()[i]?.[1] as Record<string, unknown> | undefined;
  /** showUndoToast(label, onUndo) 의 n 번째 호출. */
  const undoAt = (i: number) => undoToastMock.mock.calls[i] as [string, () => void];

  /** 잡은 요소를 dy 만큼 세로로 끈다 — 오너 요청(2026-09-16) 이후 리사이즈는 칩 자신이 아니라
   *  캔버스 절대좌표에 앉은 전용 손잡이(cal-time-handle-start/end-*)가 맡으므로, 어느 모드인지는
   *  어느 요소를 넘겼는지가 이미 정한다(rect 불필요 — chipDragMode 되짚기 자체가 없어졌다). */
  function dragEl(el: HTMLElement, dy: number) {
    fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientY: 100 });
    fireEvent.pointerMove(el, { pointerId: 1, clientY: 100 + dy });
    fireEvent.pointerUp(el, { pointerId: 1, clientY: 100 + dy });
  }

  function stubAxis(view: ReturnType<typeof renderPanel>) {
    for (const id of ["cal-time-axis", "cal-time-axis-canvas"]) {
      const el = view.getByTestId(id) as HTMLElement;
      vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
        top: 0,
        height: DAY_AXIS_H,
        bottom: DAY_AXIS_H,
        left: 0,
        right: 200,
        width: 200,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect);
    }
  }

  const timedPanel = () =>
    renderPanel([item({ note_id: "m", kind: "event", start_time: "09:00", end_time: "10:00" })]);

  /** 되돌리기 하나를 눌렀을 때 **두 번째** 쓰기가 원래 시각으로 가는지.
   *  W15 ③ — 문구는 고정이 아니라 **실제 이전→이후 시각**이다(연속 드래그로 쌓인 토스트가 서로
   *  구분돼야 한다). 채울 값이 없는 경로(시각을 처음 얹는 종일 카드 드롭)만 옛 고정 문구다. */
  async function expectUndoRestores(
    expected: Record<string, unknown>,
    label = "Schedule time changed", // 테스트 스토어의 uiLang 은 en
  ) {
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(undoToastMock).toHaveBeenCalledTimes(1);
    const [actualLabel, onUndo] = undoAt(0);
    expect(actualLabel).toBe(label);
    onUndo();
    await waitFor(() => expect(updates()).toHaveLength(2));
    expect(payloadAt(1)).toMatchObject(expected);
    // 되돌리기 자신은 토스트를 띄우지 않는다 — 안 그러면 왕복이 끝나지 않는다.
    expect(undoToastMock).toHaveBeenCalledTimes(1);
  }

  it("① 칩 이동 — 되돌리면 원래 시작·끝으로 한 번 더 쓴다", async () => {
    mockLiveRow(dbRow({ id: "d-m" }));
    const view = timedPanel();
    dragEl(view.getByTestId("cal-time-event-m"), HOUR_ROW_H);
    await waitFor(() => expect(payloadAt(0)).toMatchObject({ start_time: "10:00" }));
    await expectUndoRestores(
      { start_time: "09:00", end_time: "10:00" },
      "Schedule time 09:00 → 10:00",
    );
  });

  it("① 시작 손잡이 — 되돌리면 원래 시작으로", async () => {
    mockLiveRow(dbRow({ id: "d-m" }));
    const view = timedPanel();
    dragEl(view.getByTestId("cal-time-handle-start-m"), -7); // 15분 위로
    await waitFor(() => expect(payloadAt(0)).toMatchObject({ start_time: "08:45" }));
    await expectUndoRestores(
      { start_time: "09:00", end_time: "10:00" },
      "Schedule time 09:00 → 08:45",
    );
  });

  it("① 끝 손잡이 — 되돌리면 원래 끝으로", async () => {
    mockLiveRow(dbRow({ id: "d-m" }));
    const view = timedPanel();
    dragEl(view.getByTestId("cal-time-handle-end-m"), 7);
    await waitFor(() => expect(payloadAt(0)).toMatchObject({ end_time: "10:15" }));
    // 끝 손잡이는 **끝 시각**이 바뀐 쪽이라 문구도 그 두 값이다.
    await expectUndoRestores(
      { start_time: "09:00", end_time: "10:00" },
      "Schedule time 10:00 → 10:15",
    );
  });

  it("① 키보드 ↑/↓ — 드래그와 같은 안전망을 갖는다", async () => {
    mockLiveRow(dbRow({ id: "d-m" }));
    const view = timedPanel();
    fireEvent.keyDown(view.getByTestId("cal-time-event-m"), { key: "ArrowDown" });
    await waitFor(() => expect(payloadAt(0)).toMatchObject({ start_time: "09:15" }));
    await expectUndoRestores(
      { start_time: "09:00", end_time: "10:00" },
      "Schedule time 09:00 → 09:15",
    );
  });

  it("① 종일 카드 드롭 — 되돌리면 시각이 없던 상태로 돌아간다", async () => {
    mockLiveRow(dbRow({ id: "d-a", note_id: "a", start_time: null, end_time: null }));
    const view = renderPanel([item({ note_id: "a", kind: "event" })]);
    stubAxis(view);
    const el = view.getByTestId("cal-detail-grip-a");
    fireEvent.pointerDown(el, { button: 0, pointerId: 7, clientX: 50, clientY: 500 });
    fireEvent.pointerMove(el, { pointerId: 7, clientX: 50, clientY: 10 * HOUR_ROW_H });
    fireEvent.pointerUp(el, { pointerId: 7, clientX: 50, clientY: 10 * HOUR_ROW_H });

    await waitFor(() => expect(payloadAt(0)).toMatchObject({ start_time: "10:00" }));
    // 드롭은 시각만이 아니라 날짜 확정/종료 트리플도 쓸 수 있다 — 되돌리기는 **이번에 쓴
    // 필드 전부**를 원래 값으로 돌린다.
    await expectUndoRestores({ start_time: null, end_time: null });
  });

  it("① 저장이 실패하면 토스트가 없다 — 되돌릴 것이 없다", async () => {
    mockLiveRow(dbRow({ id: "d-m" }), true);
    const view = timedPanel();
    dragEl(view.getByTestId("cal-time-event-m"), HOUR_ROW_H);
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(undoToastMock).not.toHaveBeenCalled();
  });

  it("① 행을 못 찾으면 쓰지도 띄우지도 않는다", async () => {
    mockLiveRow(dbRow({ id: "다른행" }));
    const view = timedPanel();
    dragEl(view.getByTestId("cal-time-event-m"), HOUR_ROW_H);
    await waitFor(() =>
      expect(callMock.mock.calls.some((c) => c[0] === "note_dates_list")).toBe(true),
    );
    expect(updates()).toHaveLength(0);
    expect(undoToastMock).not.toHaveBeenCalled();
  });

  // 결정: 토스트는 **쌓인다**. 각각이 자기 직전 상태를 들고 있어, 위에서부터 차례로 누르면
  // 원래 자리까지 걸어 나온다. 어느 토스트도 자기가 안 만든 상태로 데려가지 않는다.
  it("① 연속 드래그 — 토스트가 쌓이고 각각은 자기 직전 상태로 돌아간다", async () => {
    mockLiveRow(dbRow({ id: "d-m" }));
    const view = timedPanel();
    const chip = () => view.getByTestId("cal-time-event-m") as HTMLElement;
    for (const [i, hours] of [1, 2, 3].entries()) {
      dragEl(chip(), HOUR_ROW_H * hours);
      await waitFor(() => expect(updates()).toHaveLength(i + 1));
    }
    expect(updates().map((c) => (c[1] as Record<string, unknown>).start_time)).toEqual([
      "10:00",
      "11:00",
      "12:00",
    ]);
    expect(undoToastMock).toHaveBeenCalledTimes(3);

    // 마지막 토스트 = 마지막 변경 하나만 무른다(11:00).
    undoAt(2)[1]();
    await waitFor(() => expect(updates()).toHaveLength(4));
    expect(payloadAt(3)).toMatchObject({ start_time: "11:00" });

    // 첫 토스트 = 그 드래그가 시작되기 전, 즉 원래 자리(09:00).
    undoAt(0)[1]();
    await waitFor(() => expect(updates()).toHaveLength(5));
    expect(payloadAt(4)).toMatchObject({ start_time: "09:00" });
  });

  it("② 그립에서만 끌린다 — 카드 본체를 끌어도 아무 일이 없다", () => {
    mockLiveRow(dbRow({ id: "d-a", note_id: "a", start_time: null, end_time: null }));
    const view = renderPanel([item({ note_id: "a", kind: "event" })]);
    stubAxis(view);
    const body = view.getByTestId("cal-detail-note-a") as HTMLElement;
    fireEvent.pointerDown(body, { button: 0, pointerId: 7, clientX: 50, clientY: 500 });
    fireEvent.pointerMove(body, { pointerId: 7, clientX: 50, clientY: 10 * HOUR_ROW_H });
    fireEvent.pointerUp(body, { pointerId: 7, clientX: 50, clientY: 10 * HOUR_ROW_H });
    expect(view.queryByTestId("cal-time-drop")).toBeNull();
    expect(callMock.mock.calls.some((c) => c[0] === "note_dates_list")).toBe(false);
  });

  it("② 카드 본체의 클릭=포커스 / 더블클릭=열기는 그대로다", () => {
    mockLiveRow(dbRow({ id: "d-a", note_id: "a" }));
    const onFocus = vi.fn();
    const onOpen = vi.fn();
    const view = render(
      <DayDetailPanel
        selectedDay={DAY}
        monthLabel="2026년 8월"
        detailNotes={[item({ note_id: "a", kind: "event" })]}
        onOpen={onOpen}
        onFocus={onFocus}
      />,
    );
    fireEvent.click(view.getByTestId("cal-detail-note-a"));
    fireEvent.dblClick(view.getByTestId("cal-detail-note-a"));
    expect(onFocus).toHaveBeenCalledWith("a");
    expect(onOpen).toHaveBeenCalledWith("a");
  });

  it("② 축이 없으면(월 모드) 그립도 없다 — 놓을 곳이 없으면 끌 수도 없다", () => {
    const view = renderPanel([item({ note_id: "a", kind: "event" })], null);
    expect(view.queryByTestId("cal-detail-note-a")).not.toBeNull();
    expect(view.queryByTestId("cal-detail-grip-a")).toBeNull();
  });

  it("② 그립은 조작부다 — 라벨을 갖고, 탭 순서에는 들어가지 않는다", () => {
    mockLiveRow(dbRow({ id: "d-a", note_id: "a" }));
    const view = renderPanel([item({ note_id: "a", kind: "event" })]);
    const g = view.getByTestId("cal-detail-grip-a") as HTMLElement;
    expect(g.getAttribute("aria-label")).toBe("Drag onto the time axis");
    expect(g.getAttribute("tabindex")).toBe("-1");
  });
});

/**
 * 달력 W10 — 오너 실기 셋 중 ②(칩에서 Delete 로 제거)와 ③(상세 블록의 자리).
 *
 * ② 의 핵심은 **무엇을 지우는가**다: 노트가 아니라 그 칩이 가리키는 `note_dates` 행이고,
 * 대표 행(position 0)은 지우는 게 아니라 정밀도를 비운다 — NoteDatesList 가 이미 정한 두 갈래를
 * 그대로 따른다. 어느 갈래인지는 화면 항목이 아니라 **DB 행**이 말한다(함정 ⓑ).
 */
describe("달력 W10 — 칩에서 제거 · 상세 블록의 자리", () => {
  function dbRow(p: Partial<NoteDate> & Pick<NoteDate, "id">): NoteDate {
    return {
      note_id: "m",
      position: 0,
      year: 2026,
      month: 8,
      day: 9,
      end_year: null,
      end_month: null,
      end_day: null,
      remind: false,
      created_at: "2026-08-01T00:00:00Z",
      start_time: "09:00",
      end_time: "10:00",
      remind_offset_min: null,
      rrule: null,
      label: null,
      ...p,
    };
  }

  function mockRow(row: NoteDate) {
    callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "note_dates_list") return { dates: [row] };
      if (cmd === "note_date_update") return { ...row, ...args };
      if (cmd === "note_date_remove") return null;
      if (cmd === "note_date_add") return { id: "new" };
      throw { code: "IO", message: "test" };
    });
  }

  const callsOf = (cmd: string) => callMock.mock.calls.filter((c) => c[0] === cmd);
  const payloadOf = (cmd: string, i = 0) =>
    callsOf(cmd)[i]?.[1] as Record<string, unknown> | undefined;

  const timedChip = (start = "09:00", extra: Partial<CalendarItem> = {}) =>
    item({ note_id: "m", kind: "event", start_time: start, end_time: "10:00", ...extra });

  it("② 관련 행(position ≠ 0)의 칩에서 Delete → 확인 후 note_date_remove, 되돌리면 같은 값으로 되살아난다", async () => {
    mockRow(dbRow({ id: "d-m", position: 1 }));
    const view = renderPanel([timedChip("09:00", { position: 1 })]);
    fireEvent.keyDown(view.getByTestId("cal-time-event-m"), { key: "Delete" });
    // 오너 실기 2026-09-16 — 반복 없는 행도 이제 "삭제할거야?" 한 번을 거친다.
    expect(view.getByTestId("modal-shell")).toBeDefined();
    expect(callsOf("note_date_remove")).toHaveLength(0);
    fireEvent.click(view.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(callsOf("note_date_remove")).toHaveLength(1));
    expect(payloadOf("note_date_remove")).toMatchObject({ id: "d-m" });
    // 지우기는 대표 비우기와 달리 전량 교체를 쓰지 않는다.
    expect(callsOf("note_date_update")).toHaveLength(0);
    expect(bumpMock).toHaveBeenCalled();

    expect(undoToastMock).toHaveBeenCalledTimes(1);
    const [label, onUndo] = undoToastMock.mock.calls[0] as [string, () => void];
    expect(label).toBe("Schedule removed"); // 테스트 스토어의 uiLang 은 en
    onUndo();
    await waitFor(() => expect(callsOf("note_date_add")).toHaveLength(1));
    expect(payloadOf("note_date_add")).toMatchObject({
      note_id: "m",
      year: 2026,
      month: 8,
      day: 9,
      start_time: "09:00",
      end_time: "10:00",
    });
  });

  /** D5(그릴 2026-09-11) — rrule 있는 회차 칩의 Delete 는 확인을 거친다. 판정은 item.rrule 로
   *  한다(화면 값이지만 span_start/span_end 와 달리 클리핑되지 않는 그 행의 rrule 컬럼 원본 —
   *  specs/commands/dashboard.yaml::CalendarItem, DayDetailPanel.tsx TimeAxis 의 Delete 핸들러
   *  주석 참고). 오너 실기 2026-09-16부터 rrule 없는 행도 확인을 거친다(위 테스트) — 문구만
   *  다르고(cal_delete_* vs cal_repeat_delete_*) 확인 자체는 이제 예외가 없다. */
  it("D5 — 반복(rrule) 있는 칩의 Delete 는 확인 후에만 지운다", async () => {
    mockRow(dbRow({ id: "d-m", position: 1, rrule: "FREQ=WEEKLY" }));
    const view = renderPanel([timedChip("09:00", { position: 1, rrule: "FREQ=WEEKLY" })]);
    fireEvent.keyDown(view.getByTestId("cal-time-event-m"), { key: "Delete" });
    expect(view.getByTestId("modal-shell")).toBeDefined();
    expect(callsOf("note_date_remove")).toHaveLength(0);

    fireEvent.click(view.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(callsOf("note_date_remove")).toHaveLength(1));
    expect(payloadOf("note_date_remove")).toMatchObject({ id: "d-m" });
    expect(undoToastMock).toHaveBeenCalledTimes(1);
  });

  it("D5 — 확인 다이얼로그에서 취소하면 아무것도 지우지 않는다", () => {
    mockRow(dbRow({ id: "d-m", position: 1, rrule: "FREQ=WEEKLY" }));
    const view = renderPanel([timedChip("09:00", { position: 1, rrule: "FREQ=WEEKLY" })]);
    fireEvent.keyDown(view.getByTestId("cal-time-event-m"), { key: "Delete" });
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    expect(view.queryByTestId("modal-shell")).toBeNull();
    expect(callsOf("note_date_remove")).toHaveLength(0);
  });

  it("② 대표 행(position 0)은 지우지 않는다 — 정밀도만 비우고, 되돌리면 날짜가 돌아온다", async () => {
    mockRow(dbRow({ id: "d-m", position: 0 }));
    const view = renderPanel([timedChip()]);
    fireEvent.keyDown(view.getByTestId("cal-time-event-m"), { key: "Backspace" });
    fireEvent.click(view.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(callsOf("note_date_update")).toHaveLength(1));
    expect(callsOf("note_date_remove")).toHaveLength(0);
    expect(payloadOf("note_date_update")).toMatchObject({
      id: "d-m",
      year: 2026, // 연도는 DB CHECK 상 비울 수 없다
      month: null,
      day: null,
      end_year: null,
      end_month: null,
      end_day: null,
    });

    const [, onUndo] = undoToastMock.mock.calls[0] as [string, () => void];
    onUndo();
    await waitFor(() => expect(callsOf("note_date_update")).toHaveLength(2));
    expect(payloadOf("note_date_update", 1)).toMatchObject({ month: 8, day: 9 });
  });

  it("② 화면 항목이 아니라 DB 행이 갈래를 정한다 — 항목이 관련로 보여도 행이 대표면 비우기다", async () => {
    mockRow(dbRow({ id: "d-m", position: 0 }));
    const view = renderPanel([timedChip("09:00", { position: 3 })]);
    fireEvent.keyDown(view.getByTestId("cal-time-event-m"), { key: "Delete" });
    fireEvent.click(view.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(callsOf("note_date_update")).toHaveLength(1));
    expect(callsOf("note_date_remove")).toHaveLength(0);
  });

  it("② 포커스된 칩이 없으면 아무 일도 없다", () => {
    mockRow(dbRow({ id: "d-m", position: 1 }));
    const view = renderPanel([timedChip()]);
    fireEvent.keyDown(view.getByTestId("cal-detail"), { key: "Delete" });
    // note_get_many(발췌)는 이 패널이 늘 하는 조회다 — 쓰기 경로가 하나도 열리지 않았는지를 본다.
    expect(callsOf("note_dates_list")).toHaveLength(0);
    expect(callsOf("note_date_remove")).toHaveLength(0);
    expect(callsOf("note_date_update")).toHaveLength(0);
  });

  it("② 종일 카드에는 이 키가 걸리지 않는다 — 펼치면 이미 제거 버튼이 있다", () => {
    mockRow(dbRow({ id: "d-a", note_id: "a", position: 1, start_time: null, end_time: null }));
    const view = renderPanel([item({ note_id: "a", kind: "event" })]);
    fireEvent.keyDown(view.getByTestId("cal-detail-note-a"), { key: "Delete" });
    expect(callsOf("note_date_remove")).toHaveLength(0);
    expect(callsOf("note_date_update")).toHaveLength(0);
  });

  // ③ 은 **W12 ④ 에서 통째로 지워졌다**: "축에만 있는 항목"의 상단 상세 블록이 하던 일을
  // 칩의 설정 메뉴(W12 ③)와 칩 3행(W11 ③)이 이미 한다. 그래서 여기 있던 세 테스트(자리 ·
  // 제목 한 줄 · 높이 캡)는 지웠고, 그 자리에 "다시 생기지 않는다"는 회귀만 남긴다.
  describe("③ → W12 ④: 축 전용 상단 상세는 없다", () => {
    it("축에만 있는 항목이 포커스돼도 상단 상세 블록이 뜨지 않는다", () => {
      const view = renderPanel(
        [
          item({ note_id: "m", kind: "event", start_time: "09:00", end_time: "10:00" }),
          item({ note_id: "trip", kind: "span", span_start: "2026-08-01", span_end: "2026-08-12" }),
        ],
        DAY,
        "m",
      );
      // 칩은 그대로 있다 — 없어진 것은 위쪽 블록뿐이다.
      expect(view.getByTestId("cal-time-event-m")).toBeDefined();
      expect(view.queryByTestId("cal-focused-details")).toBeNull();
      expect(view.queryByTestId("cal-focused-details-title")).toBeNull();
      // 그 블록에 있던 "이 날짜 추가"도 이 자리에서는 사라졌다(축 항목에게는 거짓말이었다).
      expect(view.queryByTestId("cal-detail-add-date-m")).toBeNull();
    });

    it("종일 칸이 펼쳐질 때의 '이 날짜 추가'는 그대로다 — 회귀 확인", async () => {
      const view = renderPanel([item({ note_id: "a", kind: "event" })], DAY, "a");
      // W14 ③ — 펼침은 설정 아이콘이 연다(포커스가 아니라).
      fireEvent.click(view.getByTestId("cal-detail-settings-a"));
      await waitFor(() => expect(view.getByTestId("cal-detail-expand-a")).toBeDefined());
      expect(view.getByTestId("cal-detail-add-date-a")).toBeDefined();
    });
  });
});

/**
 * PLAN-2026-10-10 W-E (D5) — 사이드바 전용 compact 변형. 대시보드(compact 없음)는 그대로여야 한다.
 */
describe("DayDetailBody compact (D5)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function renderCompact(items: CalendarItem[], extra?: { forecast?: DailyForecast | null; holidayName?: string | null }) {
    return render(
      <DayDetailBody
        selectedDay={DAY}
        monthLabel="2026년 8월"
        detailNotes={items}
        onOpen={() => {}}
        forecast={extra?.forecast ?? null}
        holidayName={extra?.holidayName ?? null}
        compact
      />,
    );
  }

  it("대시보드(compact 없음)는 큰 브리핑·구분선 그대로, 한 줄 시계는 없다", () => {
    const view = renderPanel([]);
    expect(view.getByTestId("cal-day-briefing").getAttribute("data-variant")).toBeNull();
    expect(view.getByTestId("cal-briefing-divider")).toBeTruthy();
    expect(view.queryByTestId("cal-briefing-now")).toBeNull();
  });

  it("compact: 날짜·날씨·현재 시각이 한 줄, 구분선과 안내 줄이 없고 안내는 축 도구 줄로", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 7, 9, 10, 30, 0));
    const forecast: DailyForecast = {
      time: [DAY],
      weatherCode: [0],
      tempMaxC: [26],
      tempMinC: [12],
      fetchedAt: 0,
    };
    const view = renderCompact([item({ note_id: "a", kind: "event" })], { forecast, holidayName: "광복절" });
    const header = view.getByTestId("cal-day-briefing");
    expect(header.getAttribute("data-variant")).toBe("compact");
    expect(view.getByTestId("cal-briefing-day").textContent).toBe("9");
    expect(header.contains(view.getByTestId("cal-briefing-weather"))).toBe(true);
    expect(view.getByTestId("cal-briefing-weather").textContent).toContain("26°");
    expect(header.contains(view.getByTestId("cal-briefing-holiday"))).toBe(true);
    expect(view.getByTestId("cal-briefing-now").textContent).toBe("10:30");
    expect(view.queryByTestId("cal-briefing-divider")).toBeNull();
    // 시각 있는 일정이 없다는 안내는 따로 한 줄이 아니라 "하루 전체 보기" 줄 안에 있다.
    const hint = view.getByTestId("cal-time-axis-empty");
    expect(hint.parentElement?.parentElement?.contains(view.getByTestId("cal-axis-fit-day"))).toBe(true);
  });

  it("U-8: 오늘이 아닌 날을 골랐으면 현재 시각을 붙이지 않는다", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 7, 10, 10, 30, 0)); // DAY 의 다음 날
    const view = renderCompact([]);
    expect(view.queryByTestId("cal-briefing-now")).toBeNull();
  });

  it("U-8: 대시보드 없이도 자정을 넘기면 1분 틱이 todayIso 를 올린다", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date(2026, 7, 9, 23, 59, 30));
    useUiStore.getState().setTodayIso("2026-08-09");
    renderCompact([]);
    act(() => {
      vi.setSystemTime(new Date(2026, 7, 10, 0, 0, 30));
      vi.advanceTimersByTime(60_000);
    });
    expect(useUiStore.getState().todayIso).toBe("2026-08-10");
  });
});

/**
 * PLAN-2026-09-10 달력 W11 — 오너 실기 넷: ① 요약 아래 구분선 · ② 시각 라벨의 대비와 틱 모양 ·
 * ③ 축 칩의 3줄 · ④ 설정을 눌러 펼치는 시각·반복 칩.
 */
describe("DayDetailPanel W11", () => {
  const before = (a: HTMLElement, b: HTMLElement) =>
    !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  // ── ① 구분선 ────────────────────────────────────────────────────────────────
  describe("① 요약 아래 구분선", () => {
    it("날짜를 고르면 브리핑 바로 아래·나머지 위에 선 하나", () => {
      const view = renderPanel([item({ note_id: "m", kind: "event", start_time: "09:00" })]);
      const line = view.getByTestId("cal-briefing-divider") as HTMLElement;
      expect(line.style.borderTop).toBe("1px solid var(--divider)");
      expect(before(view.getByTestId("cal-day-briefing"), line)).toBe(true);
      expect(before(line, view.getByTestId("cal-time-axis"))).toBe(true);
    });

    it("월 모드엔 요약이 없으니 선도 없다", () => {
      const view = renderPanel([item({ note_id: "m", kind: "event", start_time: "09:00" })], null);
      expect(view.queryByTestId("cal-briefing-divider")).toBeNull();
    });
  });

  // ── ② 시각 라벨 ─────────────────────────────────────────────────────────────
  describe("② 시각 라벨 — 대비 + 틱 모양", () => {
    it("24시간 눈금 라벨이 선을 끊는 배경 클래스를 쓰고 한 단 커졌다", () => {
      const view = renderPanel([]);
      const nine = view.getByTestId("cal-hour-label-9") as HTMLElement;
      expect(nine.className).toContain("cal-tick-label");
      expect(nine.style.fontSize).toBe("var(--text-xs)");
      // 선 위에 걸터앉는다 — 당기는 양은 토큰 곱이고 생 px 이 아니다(--fs 를 따라온다).
      expect(nine.style.marginTop).toBe("calc(var(--text-xs) * var(--lh-tight) * -0.5)");
      // 0시만 예외 — 그 선은 캔버스 맨 위라 당기면 라벨이 스크롤러 밖으로 잘린다.
      expect((view.getByTestId("cal-hour-label-0") as HTMLElement).style.marginTop).toBe("");
    });

    it("현재 시각 라벨은 눈금과 같은 클래스를 쓰고, 흰 글자 + accent 알약을 버렸다", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(2026, 7, 9, 10, 30, 0));
      const view = renderPanel([]);
      const label = view.getByTestId("cal-time-now-label") as HTMLElement;
      expect(label.className).toContain("cal-tick-label");
      expect(label.style.fontSize).toBe("var(--text-xs)");
      // 배경은 이제 클래스가 갖는다 — 인라인 accent 알약이 남아 있으면 대비 문제가 그대로다.
      expect(label.style.background).toBe("");
      expect(label.style.color).toBe("var(--text)");
      vi.useRealTimers();
    });
  });

  // ── ③ 칩의 3줄 ──────────────────────────────────────────────────────────────
  describe("③ 축 칩의 3줄", () => {
    const NOTE_GET = {
      note: { id: "m", title: "회의" },
      sections: [{ id: "s1", name: "", body_md: "본문 첫 줄\n둘째 줄", position: 0, kind: "text" }],
      sources: [],
      attachments: [],
    };

    function mockNoteGet() {
      callMock.mockImplementation(async (cmd: string) => {
        if (cmd === "note_get_many") return { notes: [NOTE_GET] };
        if (cmd === "note_dates_list") return { dates: [] };
        throw { code: "IO", message: "test" };
      });
    }

    it("시각·반복 / 제목 / 발췌 첫 줄이 각각 한 줄로 뜬다", async () => {
      mockNoteGet();
      const view = renderPanel([
        item({
          note_id: "m",
          kind: "event",
          start_time: "09:00",
          end_time: "10:00",
          rrule: "FREQ=WEEKLY",
        }),
      ]);
      const meta = view.getByTestId("cal-chip-meta-m") as HTMLElement;
      expect(meta.textContent).toBe("09:00–10:00 · Weekly");
      expect(view.getByTestId("cal-chip-title-m").textContent).toBe("m");
      // 발췌는 캐시의 **첫 줄만** — 두 줄을 칩에 넣지 않는다.
      await waitFor(() =>
        expect(view.getByTestId("cal-chip-excerpt-m").textContent).toBe("본문 첫 줄"),
      );
      // 각 줄이 독립적으로 말줄임한다.
      expect(meta.style.textOverflow).toBe("ellipsis");
    });

    it("끝 시각이 없으면 구간을 지어내지 않는다 — 시작만", () => {
      const view = renderPanel([item({ note_id: "m", kind: "event", start_time: "09:00" })]);
      expect(view.getByTestId("cal-chip-meta-m").textContent).toBe("09:00");
    });

    it("여러 날 span 도 끝 시각을 쓰지 않는다 — 그 값은 마지막 날의 것이다", () => {
      const view = renderPanel([
        item({
          note_id: "trip",
          kind: "span",
          span_start: DAY,
          span_end: "2026-08-12",
          start_time: "09:00",
          end_time: "18:00",
        }),
      ]);
      expect(view.getByTestId("cal-chip-meta-trip").textContent).toBe("09:00");
    });

    it("발췌가 없어도 레이아웃이 안 깨진다 — 3행이 빠지고 바닥 높이는 그대로", () => {
      const view = renderPanel([item({ note_id: "m", kind: "event", start_time: "09:00" })]);
      expect(view.queryByTestId("cal-chip-excerpt-m")).toBeNull();
      const chip = view.getByTestId("cal-time-event-m") as HTMLElement;
      // 30분 칩(14px)도 3줄이 다 보이는 바닥. 스냅샷이 아니라 유도식 그대로를 못 박는다.
      expect(chip.style.minHeight).toBe(
        "calc(var(--text-md) * var(--lh-ui) * 3 + var(--space-1) * 2)",
      );
      // height 는 스태킹이 쓰는 값이라 그대로다(바닥이 그것을 덮어쓰지 않는다).
      expect(chip.style.height).toBe(`${(30 / 1440) * DAY_AXIS_H}px`);
    });
  });

  // ── ③-b 발췌 안 체크리스트가 칩 하단 sub-list 로 분리된다 ────────────────────
  // 배경: 발췌(firstLines)는 마크다운을 걷어내지 않아 GFM 체크리스트 원문("- [ ] 할일")이
  // 그대로 섞여 보였다. 날짜 마커가 있어야만 잡히는 전역 "오늘의 할 일"(activeInlineTasks,
  // lib/inlineSchedule)과 무관하게, 이 칩이 보여주는 노트의 첫 text 섹션 안 체크리스트 줄은
  // 항상 발췌에서 빠지고 칩 안 별도 체크박스 목록으로 뜬다.
  describe("③-b 발췌 속 체크리스트가 칩 하단 sub-list로 분리된다", () => {
    function mockNoteGetWithBody(bodyMd: string) {
      callMock.mockImplementation(async (cmd: string) => {
        if (cmd === "note_get_many") {
          return {
            notes: [
              {
                note: { id: "m", title: "회의" },
                sections: [{ id: "s1", name: "", body_md: bodyMd, position: 0, kind: "text" }],
                sources: [],
                attachments: [],
              },
            ],
          };
        }
        if (cmd === "note_dates_list") return { dates: [] };
        throw { code: "IO", message: "test" };
      });
    }

    it("(a) 체크리스트 줄은 칩 하단 체크박스로 뜨고 발췌에는 안 보인다", async () => {
      mockNoteGetWithBody("본문 첫 줄\n- [ ] 할일 하나\n둘째 줄");
      const view = renderPanel([item({ note_id: "m", kind: "event", start_time: "09:00" })]);

      await waitFor(() =>
        expect(view.getByTestId("cal-chip-checklist-item-m-1")).toBeDefined(),
      );
      // 발췌는 체크리스트 줄을 뺀 나머지에서 앞 두 줄을 채운다.
      expect(view.getByTestId("cal-chip-excerpt-m").textContent).toBe("본문 첫 줄");
      const checkbox = view.getByTestId(
        "cal-chip-checklist-checkbox-m-1",
      ) as HTMLInputElement;
      expect(checkbox.checked).toBe(false);
      expect(view.getByTestId("cal-chip-checklist-item-m-1").textContent).toContain("할일 하나");
    });

    it("(b) 체크박스 클릭 시 todo_toggle이 올바른 section_id/line_index로 호출된다", async () => {
      mockNoteGetWithBody("본문 첫 줄\n- [ ] 할일 하나\n둘째 줄");
      const view = renderPanel([item({ note_id: "m", kind: "event", start_time: "09:00" })]);
      await waitFor(() =>
        expect(view.getByTestId("cal-chip-checklist-checkbox-m-1")).toBeDefined(),
      );

      fireEvent.click(view.getByTestId("cal-chip-checklist-checkbox-m-1"));

      await waitFor(() =>
        expect(callMock).toHaveBeenCalledWith("todo_toggle", {
          note_id: "m",
          section_id: "s1",
          line_index: 1,
          expected_checked: false,
        }),
      );
    });

    it("(c) 체크리스트가 없는 노트의 칩은 기존 동작 그대로다 — 발췌 2줄, sub-list 없음", async () => {
      mockNoteGetWithBody("본문 첫 줄\n둘째 줄");
      const view = renderPanel([item({ note_id: "m", kind: "event", start_time: "09:00" })]);

      await waitFor(() =>
        expect(view.getByTestId("cal-chip-excerpt-m").textContent).toBe("본문 첫 줄"),
      );
      expect(view.queryByTestId("cal-chip-checklist-m")).toBeNull();
      // 회귀 방지: 체크박스가 없는 칩은 바닥 높이가 그대로다(요구사항 ⑤).
      const chip = view.getByTestId("cal-time-event-m") as HTMLElement;
      expect(chip.style.minHeight).toBe(
        "calc(var(--text-md) * var(--lh-ui) * 3 + var(--space-1) * 2)",
      );
    });
  });

  // ── ④ 설정 → 인라인 시각·반복 칩 ────────────────────────────────────────────
  describe("④ 설정을 누르면 시각·반복 칩이 펼쳐진다", () => {
    function dbRow(p: Partial<NoteDate> & Pick<NoteDate, "id">): NoteDate {
      return {
        note_id: "m",
        position: 0,
        year: 2026,
        month: 8,
        day: 9,
        end_year: null,
        end_month: null,
        end_day: null,
        remind: false,
        created_at: "2026-08-01T00:00:00Z",
        start_time: "09:00",
        end_time: null,
        remind_offset_min: null,
        rrule: null,
        label: null,
        ...p,
      };
    }

    function mockRows(rows: NoteDate[]) {
      callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "note_dates_list") return { dates: rows };
        if (cmd === "note_date_update") return { ...rows[0], ...args };
        throw { code: "IO", message: "test" };
      });
    }

    const updates = () => callMock.mock.calls.filter((c) => c[0] === "note_date_update");
    const lastUpdate = () =>
      updates()[updates().length - 1]?.[1] as Record<string, unknown> | undefined;

    it("접혀 있다가 아이콘을 누르면 시각·반복 칩이 나온다 (팝오버가 아니라 칩 안)", () => {
      mockRows([dbRow({ id: "d-m" })]);
      const view = renderPanel([item({ note_id: "m", kind: "event", start_time: "09:00" })]);
      expect(view.queryByTestId("cal-chip-menu-m")).toBeNull();
      fireEvent.click(view.getByTestId("cal-chip-settings-m"));
      const menu = view.getByTestId("cal-chip-menu-m");
      // 펼침 영역은 칩 **안**에 있다(떠 있는 레이어가 아니다).
      expect(view.getByTestId("cal-time-event-m").contains(menu)).toBe(true);
      expect(view.getByTestId("cal-chip-time-m")).toBeDefined();
      expect(view.getByTestId("cal-chip-repeat-m")).toBeDefined();
      // 한 번 더 누르면 접힌다.
      fireEvent.click(view.getByTestId("cal-chip-settings-m"));
      expect(view.queryByTestId("cal-chip-menu-m")).toBeNull();
    });

    it("설정 클릭은 포커스·열기로 새지 않는다", () => {
      mockRows([dbRow({ id: "d-m" })]);
      const onFocus = vi.fn();
      const onOpen = vi.fn();
      const view = render(
        <DayDetailPanel
          selectedDay={DAY}
          monthLabel="2026년 8월"
          detailNotes={[item({ note_id: "m", kind: "event", start_time: "09:00" })]}
          onOpen={onOpen}
          onFocus={onFocus}
        />,
      );
      fireEvent.click(view.getByTestId("cal-chip-settings-m"));
      fireEvent.doubleClick(view.getByTestId("cal-chip-settings-m"));
      expect(onFocus).not.toHaveBeenCalled();
      expect(onOpen).not.toHaveBeenCalled();
    });

    it("시각 입력이 note_dates_list → note_date_update 한 길을 지난다 (DB 행 기준 페이로드)", async () => {
      // 씨앗 행은 7월 5일, 화면 항목은 8월 9일 회차 — 함정 ⓑ 가 여기서도 지켜져야 한다.
      mockRows([dbRow({ id: "d-m", month: 7, day: 5, rrule: "FREQ=WEEKLY" })]);
      const view = renderPanel([
        item({
          note_id: "m",
          kind: "event",
          start_time: "09:00",
          is_occurrence: true,
          rrule: "FREQ=WEEKLY",
        }),
      ]);
      fireEvent.click(view.getByTestId("cal-chip-settings-m"));
      fireEvent.click(view.getByTestId("cal-chip-time-m"));
      const input = view.getByTestId("cal-chip-start-time-m") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "1030" } });
      fireEvent.blur(input);
      await waitFor(() => expect(lastUpdate()).toBeDefined());
      expect(lastUpdate()).toMatchObject({
        id: "d-m",
        month: 7,
        day: 5,
        start_time: "10:30",
        rrule: "FREQ=WEEKLY",
      });
      // 시각을 바꾸는 경로이므로 되돌리기 토스트가 짝이다(드래그·키보드와 같은 한 지점).
      await waitFor(() => expect(undoToastMock).toHaveBeenCalled());
    });

    it("빈 입력은 해제, 파싱 실패는 되돌리기 — 오타가 저장된 시각을 지우지 않는다", async () => {
      mockRows([dbRow({ id: "d-m" })]);
      const view = renderPanel([item({ note_id: "m", kind: "event", start_time: "09:00" })]);
      fireEvent.click(view.getByTestId("cal-chip-settings-m"));
      fireEvent.click(view.getByTestId("cal-chip-time-m"));
      const input = view.getByTestId("cal-chip-start-time-m") as HTMLInputElement;

      fireEvent.change(input, { target: { value: "어제" } });
      fireEvent.blur(input);
      expect(input.value).toBe("09:00"); // 직전 값으로 되돌아왔다
      expect(updates()).toHaveLength(0); // 아무것도 쓰지 않았다

      fireEvent.change(input, { target: { value: "  " } });
      fireEvent.blur(input);
      await waitFor(() => expect(lastUpdate()).toMatchObject({ start_time: null }));
    });

    /**
     * D4(그릴 2026-09-11) — 이 테스트가 원래 지키던 "요일을 고르면 즉시 rrule 이 저장된다"는
     * 더 이상 맞지 않는다: 초안 → 적용 → 확인이 됐다. 아래 셋으로 나눠 갖는다.
     */
    it("반복 변경은 초안일 뿐 — 고르는 것만으로는 저장되지 않는다 (D4)", () => {
      mockRows([dbRow({ id: "d-m", rrule: "FREQ=WEEKLY" })]);
      const view = renderPanel([
        item({ note_id: "m", kind: "event", start_time: "09:00", rrule: "FREQ=WEEKLY" }),
      ]);
      fireEvent.click(view.getByTestId("cal-chip-settings-m"));
      fireEvent.click(view.getByTestId("cal-chip-repeat-m"));
      fireEvent.click(view.getByTestId("cal-chip-byday-TH-m"));
      expect(updates()).toHaveLength(0);
      expect(view.queryByTestId("modal-shell")).toBeNull();
    });

    it("적용 → 확인 → 저장, 오늘 목록에 그대로면 '바뀌었다' 되돌리기 토스트 (D4)", async () => {
      mockRows([dbRow({ id: "d-m", rrule: "FREQ=WEEKLY" })]);
      const view = renderPanel([
        item({ note_id: "m", kind: "event", start_time: "09:00", rrule: "FREQ=WEEKLY" }),
      ]);
      fireEvent.click(view.getByTestId("cal-chip-settings-m"));
      fireEvent.click(view.getByTestId("cal-chip-repeat-m"));
      fireEvent.click(view.getByTestId("cal-chip-byday-TH-m"));
      fireEvent.click(view.getByTestId("cal-chip-repeat-apply-m"));
      // 적용을 눌러도 아직은 확인 대기 — 포포버 위 모달을 만들지 않으려 메뉴부터 닫힌다.
      expect(view.getByTestId("modal-shell")).toBeDefined();
      expect(view.queryByTestId("cal-chip-menu-m")).toBeNull();
      expect(updates()).toHaveLength(0);

      fireEvent.click(view.getByRole("button", { name: "Apply" }));
      await waitFor(() => expect(lastUpdate()).toBeDefined());
      expect(lastUpdate()!.rrule).toBe("FREQ=WEEKLY;BYDAY=TH");
      // 저장 자체엔 아직 토스트가 없다 — 사후 판정(재조회 뒤) 전까지는 하나로 정해지지 않는다.
      expect(undoToastMock).not.toHaveBeenCalled();

      // 부모가 재조회한 새 detailNotes 를 내려준다 — 이 노트는 오늘 목록에 그대로 있다.
      view.rerender(
        <DayDetailPanel
          selectedDay={DAY}
          monthLabel="2026년 8월"
          detailNotes={[
            item({ note_id: "m", kind: "event", start_time: "09:00", rrule: "FREQ=WEEKLY;BYDAY=TH" }),
          ]}
          onOpen={() => {}}
        />,
      );
      await waitFor(() => expect(undoToastMock).toHaveBeenCalledTimes(1));
      expect(undoToastMock.mock.calls[0][0]).toBe("Repeat schedule changed");
    });

    it("적용 뒤 오늘 목록에서 빠지면 '빠졌다' 안내로 대체된다(토스트는 하나뿐) (D4)", async () => {
      mockRows([dbRow({ id: "d-m", rrule: "FREQ=WEEKLY" })]);
      const view = renderPanel([
        item({ note_id: "m", kind: "event", start_time: "09:00", rrule: "FREQ=WEEKLY" }),
      ]);
      fireEvent.click(view.getByTestId("cal-chip-settings-m"));
      fireEvent.click(view.getByTestId("cal-chip-repeat-m"));
      fireEvent.click(view.getByTestId("cal-chip-byday-TH-m"));
      fireEvent.click(view.getByTestId("cal-chip-repeat-apply-m"));
      fireEvent.click(view.getByRole("button", { name: "Apply" }));
      await waitFor(() => expect(lastUpdate()).toBeDefined());

      // 이번엔 재조회 결과에 이 노트가 없다 — 규칙이 바뀌어 오늘 회차가 빠진 경우.
      view.rerender(
        <DayDetailPanel selectedDay={DAY} monthLabel="2026년 8월" detailNotes={[]} onOpen={() => {}} />,
      );
      await waitFor(() => expect(undoToastMock).toHaveBeenCalledTimes(1));
      expect(undoToastMock.mock.calls[0][0]).toBe("Removed from today's list");
    });

    it("여러 날 span 에는 시각 칩이 없다 — 끝 시각이 남의 날짜 것이다", () => {
      mockRows([
        dbRow({ id: "d-trip", note_id: "trip", end_year: 2026, end_month: 8, end_day: 12 }),
      ]);
      const view = renderPanel([
        item({
          note_id: "trip",
          kind: "span",
          span_start: DAY,
          span_end: "2026-08-12",
          start_time: "09:00",
        }),
      ]);
      fireEvent.click(view.getByTestId("cal-chip-settings-trip"));
      expect(view.queryByTestId("cal-chip-time-trip")).toBeNull();
      expect(view.queryByTestId("cal-chip-repeat-trip")).not.toBeNull();
    });

    it("펼쳐진 칩은 끌리지 않는다 — 접으면 드래그가 그대로 돌아온다", async () => {
      mockRows([dbRow({ id: "d-m" })]);
      const view = renderPanel([item({ note_id: "m", kind: "event", start_time: "09:00" })]);
      const chip = view.getByTestId("cal-time-event-m");
      fireEvent.click(view.getByTestId("cal-chip-settings-m"));

      fireEvent.pointerDown(chip, { button: 0, pointerId: 1, clientY: 100 });
      fireEvent.pointerMove(chip, { pointerId: 1, clientY: 100 + HOUR_ROW_H });
      fireEvent.pointerUp(chip, { pointerId: 1, clientY: 100 + HOUR_ROW_H });
      expect(updates()).toHaveLength(0);
      expect(chip.style.transform).toBe("");

      // 접으면 같은 손짓이 예전처럼 저장까지 간다.
      fireEvent.click(view.getByTestId("cal-chip-settings-m"));
      fireEvent.pointerDown(chip, { button: 0, pointerId: 2, clientY: 100 });
      fireEvent.pointerMove(chip, { pointerId: 2, clientY: 100 + HOUR_ROW_H });
      fireEvent.pointerUp(chip, { pointerId: 2, clientY: 100 + HOUR_ROW_H });
      await waitFor(() => expect(lastUpdate()).toMatchObject({ start_time: "10:00" }));
    });

    it("펼친 영역 안에서 시작한 손짓은 칩으로 새지 않는다", () => {
      mockRows([dbRow({ id: "d-m" })]);
      const onOpen = vi.fn();
      const view = render(
        <DayDetailPanel
          selectedDay={DAY}
          monthLabel="2026년 8월"
          detailNotes={[item({ note_id: "m", kind: "event", start_time: "09:00" })]}
          onOpen={onOpen}
        />,
      );
      fireEvent.click(view.getByTestId("cal-chip-settings-m"));
      const menu = view.getByTestId("cal-chip-menu-m");
      fireEvent.doubleClick(menu);
      expect(onOpen).not.toHaveBeenCalled();
      // ↑/↓ 도 칩의 시각을 바꾸지 않는다(입력 안에서 캐럿을 움직이는 키다).
      fireEvent.keyDown(menu, { key: "ArrowDown" });
      expect(updates()).toHaveLength(0);
    });
  });
});

/**
 * PLAN-2026-09-10 달력 W12 — 오너 실기 넷: ① 칩 호버의 방향 · ② 그립의 조작 신호 ·
 * ③ 설정은 칩을 늘리지 않고 플로팅 메뉴로 뜬다 · ④ 축 전용 상단 상세 제거(위 W10 describe 참고).
 */
describe("DayDetailPanel W12", () => {
  // ── ① 칩 호버의 방향 ────────────────────────────────────────────────────────
  // D6(그릴 2026-09-11)이 이 관례에서 축 칩만 벗어난다 — 평소 반투명(--hover), 호버 또는
  // 포커스에서 불투명(--surface-base). "거꾸로"였던 옛 W12 ①(평소 투명 · 호버 --hover)은 축이
  // 아닌 표면(DetailNoteCard 등)에만 남는다.
  // 정정(그릴 2026-09-13): 불투명 값이 `--bg` 에서 `--surface-base` 로 바뀌었다 — 색 구조 C1
  // (64c1b269)이 `--bg` 를 캔버스 합성값(질감+글로우 레이어)으로 바꾼 뒤로 작은 칩에 얹으면
  // 배경과 섞여 오히려 더 투명해 보였다(DayDetailPanel.tsx 의 그 위치 주석 참고).
  it("① 축 칩은 평소 반투명(--hover), 호버·포커스에서 불투명(--surface-base) — D6", () => {
    const view = renderPanel([item({ note_id: "m", kind: "event", start_time: "09:00" })]);
    const chip = view.getByTestId("cal-time-event-m") as HTMLElement;
    expect(chip.style.background).toBe("var(--hover)");
    fireEvent.mouseEnter(chip);
    expect(chip.style.background).toBe("var(--surface-base)");
    fireEvent.mouseLeave(chip);
    expect(chip.style.background).toBe("var(--hover)");
  });

  it("① 포커스된 축 칩은 호버가 끝나도 불투명(--surface-base)을 유지한다 — D6", () => {
    const view = renderPanel([item({ note_id: "m", kind: "event", start_time: "09:00" })], DAY, "m");
    const chip = view.getByTestId("cal-time-event-m") as HTMLElement;
    // focusedNoteId="m" 이라 처음부터 포커스 상태 — 평소값도 불투명이다.
    expect(chip.style.background).toBe("var(--surface-base)");
    fireEvent.mouseEnter(chip);
    expect(chip.style.background).toBe("var(--surface-base)");
    fireEvent.mouseLeave(chip);
    expect(chip.style.background).toBe("var(--surface-base)"); // 포커스가 남아 있으니 --hover 로 안 돌아간다.
  });

  // ── ② 그립의 조작 신호 ──────────────────────────────────────────────────────
  it("② 그립이 .icon-btn 을 입는다(호버 신호) — 탭 순서에는 여전히 안 들어간다", () => {
    const view = renderPanel([item({ note_id: "a", kind: "event" })]);
    const g = view.getByTestId("cal-detail-grip-a") as HTMLElement;
    expect(g.className.split(" ")).toContain("icon-btn");
    expect(g.getAttribute("tabindex")).toBe("-1");
    // 클래스의 호버·색 규칙을 인라인이 다시 가리지 않는다(cursor 만 남는다).
    expect(g.style.background).toBe("");
    expect(g.style.color).toBe("");
    expect(g.style.cursor).toBe("grab");
  });

  // ── ③ 설정은 칩을 늘리지 않는다 ─────────────────────────────────────────────
  describe("③ 설정 메뉴는 떠 있고, 칩 크기는 안 바뀐다", () => {
    const open = () => {
      const view = renderPanel([item({ note_id: "m", kind: "event", start_time: "09:00" })]);
      const chip = view.getByTestId("cal-time-event-m") as HTMLElement;
      const heightBefore = chip.style.height;
      fireEvent.click(view.getByTestId("cal-chip-settings-m"));
      return { view, chip, heightBefore };
    };

    it("열어도 칩의 height 는 그 일정의 길이 그대로다 — 'auto' 가 아니다", () => {
      const { view, chip, heightBefore } = open();
      expect(view.getByTestId("cal-chip-menu-m")).toBeDefined();
      // 30분 = 그 일정의 길이. 늘어나면 "일정이 길어졌다"는 거짓 정보가 된다.
      expect(heightBefore).toBe(`${(30 / 1440) * DAY_AXIS_H}px`);
      expect(chip.style.height).toBe(heightBefore);
      expect(chip.style.minHeight).toBe(
        "calc(var(--text-md) * var(--lh-ui) * 3 + var(--space-1) * 2)",
      );
    });

    it("메뉴는 칩 아래에 **떠서** 뜬다(absolute) — 칩 흐름에 끼어들지 않는다", () => {
      const { view } = open();
      const menu = view.getByTestId("cal-chip-menu-m") as HTMLElement;
      expect(menu.style.position).toBe("absolute");
      expect(menu.style.top).toBe("100%");
      // 떠 있으니 불투명 배경 + 그림자, 그리고 칩·현재 시각 선(둘 다 1)보다 위.
      expect(menu.style.background).toBe("var(--surface-base)");
      expect(menu.style.boxShadow).toBe("var(--shadow-md)");
      expect(menu.style.zIndex).toBe("3");
    });

    it("메뉴 안에서 시작한 pointerdown 은 칩의 드래그 세션을 열지 않는다", () => {
      const { view, chip } = open();
      const menu = view.getByTestId("cal-chip-menu-m");
      fireEvent.pointerDown(menu, { button: 0, pointerId: 11, clientY: 100 });
      fireEvent.pointerMove(chip, { pointerId: 11, clientY: 100 + HOUR_ROW_H });
      fireEvent.pointerUp(chip, { pointerId: 11, clientY: 100 + HOUR_ROW_H });
      expect(chip.style.transform).toBe("");
      expect(chip.getAttribute("data-moving")).toBeNull();
    });

    it("바깥을 누르면 닫힌다", () => {
      const { view } = open();
      fireEvent.mouseDown(document.body);
      expect(view.queryByTestId("cal-chip-menu-m")).toBeNull();
    });

    it("메뉴 안을 누르는 것은 바깥이 아니다", () => {
      const { view } = open();
      fireEvent.mouseDown(view.getByTestId("cal-chip-menu-m"));
      expect(view.getByTestId("cal-chip-menu-m")).toBeDefined();
    });

    it("Escape 로 닫힌다 — 메뉴 안에서든 밖에서든", () => {
      const inside = open();
      fireEvent.keyDown(inside.view.getByTestId("cal-chip-menu-m"), { key: "Escape" });
      expect(inside.view.queryByTestId("cal-chip-menu-m")).toBeNull();
      inside.view.unmount();

      const outside = open();
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(outside.view.queryByTestId("cal-chip-menu-m")).toBeNull();
    });
  });
});

/**
 * PLAN-2026-09-10 달력 W15 — 축 드래그의 손맛(① Escape · ② 지속시간 · ③ 토스트 문구 ·
 * ④ 스냅 이징 · ⑤ 칩 텍스트)과 **붙어 있는 항목의 연동 이동**.
 *
 * 연동 이동이 이 웨이브의 위험한 쪽이다 — 한 손짓이 여러 DB 행을 쓴다. 그래서 이 블록이 지키는
 * 것은 셋이다: ⓐ 각 행이 자기 값으로 따로 저장된다(함정 ⓑ 그대로) · ⓑ 되돌리기 토스트는 **하나**
 * (여러 개면 하나만 눌러 붙어 있던 것이 도로 떨어진다) · ⓒ 시각을 함부로 못 바꾸는 이웃
 * (여러 날 span)은 연동에서 빠진다.
 */
describe("달력 W15 — 드래그 손맛과 연동 이동", () => {
  function dbRow(p: Partial<NoteDate> & Pick<NoteDate, "id">): NoteDate {
    return {
      note_id: "a",
      position: 0,
      year: 2026,
      month: 8,
      day: 9,
      end_year: null,
      end_month: null,
      end_day: null,
      remind: false,
      created_at: "2026-08-01T00:00:00Z",
      start_time: "09:00",
      end_time: "10:00",
      remind_offset_min: null,
      rrule: null,
      label: null,
      ...p,
    };
  }

  /** 여러 행이 살아 있는 목 — 연동 이동은 행마다 따로 읽고 따로 쓴다. */
  function mockRows(rows: NoteDate[], updateFails = false) {
    let cur = rows.map((r) => ({ ...r }));
    callMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "note_dates_list") return { dates: cur };
      if (cmd === "note_date_update") {
        if (updateFails) throw { code: "IO", message: "test" };
        cur = cur.map((r) => (r.id === args?.id ? { ...r, ...(args as Partial<NoteDate>) } : r));
        return cur.find((r) => r.id === args?.id);
      }
      throw { code: "IO", message: "test" };
    });
  }

  const updates = () =>
    callMock.mock.calls
      .filter((c) => c[0] === "note_date_update")
      .map((c) => c[1] as Record<string, unknown>);

  function stubRect(el: HTMLElement, top: number, height: number) {
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
      top,
      height,
      bottom: top + height,
      left: 0,
      right: 100,
      width: 100,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect);
  }

  /** grabAt = 칩 위쪽에서 몇 px 지점을 잡았나(0 = 위 손잡이, height = 아래 손잡이). */
  function dragChip(el: HTMLElement, grabAt: number, dy: number, height = 60) {
    stubRect(el, 100, height);
    const y = 100 + grabAt;
    fireEvent.pointerDown(el, { button: 0, pointerId: 1, clientY: y });
    fireEvent.pointerMove(el, { pointerId: 1, clientY: y + dy });
    fireEvent.pointerUp(el, { pointerId: 1, clientY: y + dy });
  }

  /** 09:00-10:00(a) 과 10:00-11:00(b) — 정확히 맞닿은 둘. */
  const touchingTwo = () => [
    item({ note_id: "a", kind: "event", start_time: "09:00", end_time: "10:00" }),
    item({ note_id: "b", kind: "event", start_time: "10:00", end_time: "11:00" }),
  ];
  const twoRows = () => [
    dbRow({ id: "d-a", note_id: "a", start_time: "09:00", end_time: "10:00" }),
    dbRow({ id: "d-b", note_id: "b", start_time: "10:00", end_time: "11:00" }),
  ];

  // ── ① Escape ────────────────────────────────────────────────────────────────
  it("① 드래그 중 Escape → 아무것도 안 쓰고 칩이 원위치로 돌아간다", () => {
    mockRows([dbRow({ id: "d-a" })]);
    const view = renderPanel([
      item({ note_id: "a", kind: "event", start_time: "09:00", end_time: "10:00" }),
    ]);
    const chip = view.getByTestId("cal-time-event-a") as HTMLElement;
    stubRect(chip, 100, 60);
    fireEvent.pointerDown(chip, { button: 0, pointerId: 1, clientY: 130 });
    fireEvent.pointerMove(chip, { pointerId: 1, clientY: 130 + HOUR_ROW_H });
    expect(chip.style.transform).toBe(`translateY(${HOUR_ROW_H}px)`);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(chip.style.transform).toBe("");
    expect(chip.textContent).toContain("09:00");
    // 손을 떼도 저장되지 않는다 — 세션 자체가 닫혔다.
    fireEvent.pointerUp(chip, { pointerId: 1, clientY: 130 + HOUR_ROW_H });
    expect(callMock.mock.calls.some((c) => c[0] === "note_dates_list")).toBe(false);
    expect(updates()).toHaveLength(0);
  });

  it("① 드래그 전(설정 메뉴만 열린 상태)의 Escape 는 그대로 메뉴만 닫는다 — 회귀", () => {
    mockRows([dbRow({ id: "d-a" })]);
    const view = renderPanel([item({ note_id: "a", kind: "event", start_time: "09:00" })]);
    fireEvent.click(view.getByTestId("cal-chip-settings-a"));
    expect(view.getByTestId("cal-chip-menu-a")).toBeDefined();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(view.queryByTestId("cal-chip-menu-a")).toBeNull();
  });

  // ── ② 지속시간 ──────────────────────────────────────────────────────────────
  it("② 드래그 중 미리보기에 시각과 지속시간이 같이 있다 (1행 · 툴팁)", () => {
    mockRows([dbRow({ id: "d-a" })]);
    const view = renderPanel([
      item({ note_id: "a", kind: "event", start_time: "09:00", end_time: "10:30" }),
    ]);
    const chip = view.getByTestId("cal-time-event-a") as HTMLElement;
    // 평소엔 툴팁만 — 1행은 시각(구간)과 반복의 자리다.
    expect(chip.getAttribute("title")).toContain("1h 30m");
    expect(view.getByTestId("cal-chip-meta-a").textContent).toBe("09:00–10:30");

    stubRect(chip, 100, 60);
    fireEvent.pointerDown(chip, { button: 0, pointerId: 1, clientY: 130 });
    fireEvent.pointerMove(chip, { pointerId: 1, clientY: 130 + 7 }); // 15분 아래
    expect(view.getByTestId("cal-chip-meta-a").textContent).toBe("09:15–10:45 · 1h 30m");
    expect(chip.getAttribute("title")).toContain("09:15 · 1h 30m");
  });

  it("② 끝이 없는 항목엔 지속시간도 없다 — 없는 끝을 지어내지 않는다", () => {
    mockRows([dbRow({ id: "d-a", end_time: null })]);
    const view = renderPanel([item({ note_id: "a", kind: "event", start_time: "09:00" })]);
    const chip = view.getByTestId("cal-time-event-a") as HTMLElement;
    expect(chip.getAttribute("title")).toBe("09:00 a");
    stubRect(chip, 100, 60);
    fireEvent.pointerDown(chip, { button: 0, pointerId: 1, clientY: 130 });
    fireEvent.pointerMove(chip, { pointerId: 1, clientY: 130 + 7 });
    expect(view.getByTestId("cal-chip-meta-a").textContent).toBe("09:15");
  });

  // ── ④ 스냅 이징 ─────────────────────────────────────────────────────────────
  it("④ 트랜지션은 드래그 중에만 걸린다 — 낙관적 자리를 버리는 순간엔 없다", async () => {
    mockRows([dbRow({ id: "d-a" })], true); // 저장 실패 = 미리보기를 버리는 순간
    const view = renderPanel([
      item({ note_id: "a", kind: "event", start_time: "09:00", end_time: "10:00" }),
    ]);
    const chip = view.getByTestId("cal-time-event-a") as HTMLElement;
    stubRect(chip, 100, 60);
    fireEvent.pointerDown(chip, { button: 0, pointerId: 1, clientY: 130 });
    fireEvent.pointerMove(chip, { pointerId: 1, clientY: 130 + HOUR_ROW_H });
    // 커브·지속시간은 `.chip-btn` 이 이미 쓰는 것과 같은 값이다(새 토큰 없음).
    expect(chip.style.transition).toBe("transform var(--dur-fast) cubic-bezier(0.2, 0, 0, 1)");
    fireEvent.pointerUp(chip, { pointerId: 1, clientY: 130 + HOUR_ROW_H });
    await waitFor(() => expect(chip.style.transform).toBe(""));
    expect(chip.style.transition).toBe("");
  });

  // ── ⑤ 칩 텍스트 ─────────────────────────────────────────────────────────────
  it("⑤ 칩 3줄은 좌상단 정렬 + 두 단 큰 글꼴이고, 바닥 높이 식도 같은 토큰이다", () => {
    const view = renderPanel([item({ note_id: "a", kind: "event", start_time: "09:00" })]);
    const chip = view.getByTestId("cal-time-event-a") as HTMLElement;
    expect(chip.style.justifyContent).toBe("flex-start");
    expect(chip.style.fontSize).toBe("var(--text-md)");
    // 글자를 키웠으면 3줄 바닥도 같이 커져야 한다 — 안 맞추면 커진 글자가 잘린다.
    expect(chip.style.minHeight).toBe(
      "calc(var(--text-md) * var(--lh-ui) * 3 + var(--space-1) * 2)",
    );
  });

  // ── ⑥ 연동 이동 ─────────────────────────────────────────────────────────────
  it("⑥ 맞닿은 둘을 이동하면 **둘 다** 각자 시각으로 저장되고, 토스트는 하나다", async () => {
    mockRows(twoRows());
    const view = renderPanel(touchingTwo());
    dragChip(view.getByTestId("cal-time-event-a"), 30, HOUR_ROW_H); // +1시간
    await waitFor(() => expect(updates()).toHaveLength(2));
    expect(updates()).toEqual([
      expect.objectContaining({ id: "d-a", start_time: "10:00", end_time: "11:00" }),
      expect.objectContaining({ id: "d-b", start_time: "11:00", end_time: "12:00" }),
    ]);
    expect(undoToastMock).toHaveBeenCalledTimes(1);
    expect(undoToastMock.mock.calls[0][0]).toBe("Schedule time 09:00 → 10:00");

    // 되돌리면 **둘 다** 원위치 — 붙어 있던 것이 반쪽만 돌아가지 않는다.
    (undoToastMock.mock.calls[0][1] as () => void)();
    await waitFor(() => expect(updates()).toHaveLength(4));
    expect(updates().slice(2)).toEqual([
      expect.objectContaining({ id: "d-a", start_time: "09:00", end_time: "10:00" }),
      expect.objectContaining({ id: "d-b", start_time: "10:00", end_time: "11:00" }),
    ]);
  });

  it("⑥ 드래그 중엔 이웃의 미리보기도 같이 움직인다", () => {
    mockRows(twoRows());
    const view = renderPanel(touchingTwo());
    const chip = view.getByTestId("cal-time-event-a") as HTMLElement;
    stubRect(chip, 100, 60);
    fireEvent.pointerDown(chip, { button: 0, pointerId: 1, clientY: 130 });
    fireEvent.pointerMove(chip, { pointerId: 1, clientY: 130 + HOUR_ROW_H });
    const neighbor = view.getByTestId("cal-time-event-b") as HTMLElement;
    expect(neighbor.style.transform).toBe(`translateY(${HOUR_ROW_H}px)`);
    expect(neighbor.getAttribute("data-moving")).toBe("true");
    expect(view.getByTestId("cal-chip-meta-b").textContent).toContain("11:00–12:00");
  });

  it("⑥ 체인 셋이 전부 맞닿아 있으면 셋 다 옮겨진다 — 토스트는 여전히 하나", async () => {
    mockRows([
      ...twoRows(),
      dbRow({ id: "d-c", note_id: "c", start_time: "11:00", end_time: "12:00" }),
    ]);
    const view = renderPanel([
      ...touchingTwo(),
      item({ note_id: "c", kind: "event", start_time: "11:00", end_time: "12:00" }),
    ]);
    dragChip(view.getByTestId("cal-time-event-a"), 30, 7); // +15분
    await waitFor(() => expect(updates()).toHaveLength(3));
    expect(updates().map((u) => [u.id, u.start_time])).toEqual([
      ["d-a", "09:15"],
      ["d-b", "10:15"],
      ["d-c", "11:15"],
    ]);
    expect(undoToastMock).toHaveBeenCalledTimes(1);
  });

  // 오너 요청(2026-09-16): "붙어 있는 이음새를 드래그하면 이전 일정의 마무리 시간, 이후 일정의
  // 시작 시간이 같이 반응해야 한다." 옛 ponytail(리사이즈는 연동 안 함)을 이 요청이 뒤집는다.
  it("⑥ 끝 손잡이로 이음새를 늘리면 뒤에 맞닿은 이웃의 시작도 같이 밀린다", async () => {
    mockRows(twoRows());
    const view = renderPanel(touchingTwo());
    dragChip(view.getByTestId("cal-time-handle-end-a"), 0, 7); // 끝만 늘린다(+15분)
    await waitFor(() => expect(updates()).toHaveLength(2));
    expect(updates()).toEqual([
      expect.objectContaining({ id: "d-a", end_time: "10:15" }),
      expect.objectContaining({ id: "d-b", start_time: "10:15" }),
    ]);
    // 이웃의 end_time 은 그대로다 — 이동이 아니라 한쪽 경계만 옮기는 리사이즈다.
    expect(updates()[1]).toMatchObject({ end_time: "11:00" });
    expect(undoToastMock).toHaveBeenCalledTimes(1);
  });

  it("⑥ 시작 손잡이로 이음새를 당기면 앞에 맞닿은 이웃의 끝도 같이 밀린다", async () => {
    mockRows(twoRows());
    const view = renderPanel(touchingTwo());
    dragChip(view.getByTestId("cal-time-handle-start-b"), 0, 7); // 시작만 당긴다(+15분)
    await waitFor(() => expect(updates()).toHaveLength(2));
    expect(updates()).toEqual([
      expect.objectContaining({ id: "d-b", start_time: "10:15" }),
      expect.objectContaining({ id: "d-a", end_time: "10:15" }),
    ]);
    expect(undoToastMock).toHaveBeenCalledTimes(1);
  });

  it("⑥ 이웃이 MIN_SLOT_MIN(30분) 아래로 줄지 않게 리사이즈 폭을 다시 죈다", async () => {
    // b 는 10:00-10:45(45분) — a 의 끝을 1시간 늘리려 해도 b 가 30분 밑으로는 못 준다.
    // b 가 밀릴 수 있는 한계는 15분(10:15)뿐이라 a 의 끝도 거기서 멈춰야 한다.
    mockRows([
      dbRow({ id: "d-a", note_id: "a", start_time: "09:00", end_time: "10:00" }),
      dbRow({ id: "d-b", note_id: "b", start_time: "10:00", end_time: "10:45" }),
    ]);
    const view = renderPanel([
      item({ note_id: "a", kind: "event", start_time: "09:00", end_time: "10:00" }),
      item({ note_id: "b", kind: "event", start_time: "10:00", end_time: "10:45" }),
    ]);
    dragChip(view.getByTestId("cal-time-handle-end-a"), 0, HOUR_ROW_H); // +1시간 늘리려 함
    await waitFor(() => expect(updates()).toHaveLength(2));
    expect(updates()).toEqual([
      expect.objectContaining({ id: "d-a", end_time: "10:15" }),
      expect.objectContaining({ id: "d-b", start_time: "10:15" }),
    ]);
    // b 의 끝은 그대로다 — 이동이 아니라 한쪽 경계만 옮기는 리사이즈다.
    expect(updates()[1]).toMatchObject({ end_time: "10:45" });
  });

  it("⑥ 끝이 없던 이웃은 시작 손잡이 연동에서 빠진다 — 없는 끝을 지어내지 않는다", async () => {
    // a 는 09:30 부터 끝 없이 — 화면엔 MIN_SLOT_MIN(30분)짜리로 그려져 09:30–10:00 으로
    // b 와 정확히 맞닿아 보이지만, DB 행엔 end_time 이 없다. b 의 시작 손잡이를 당겨도
    // a 의 end_time 을 새로 만들어 주지 않는다 — hasEnd 가드가 이 자리에서 이웃을 뺀다.
    mockRows([
      dbRow({ id: "d-a", note_id: "a", start_time: "09:30", end_time: null }),
      dbRow({ id: "d-b", note_id: "b", start_time: "10:00", end_time: "11:00" }),
    ]);
    const view = renderPanel([
      item({ note_id: "a", kind: "event", start_time: "09:30", end_time: null }),
      item({ note_id: "b", kind: "event", start_time: "10:00", end_time: "11:00" }),
    ]);
    dragChip(view.getByTestId("cal-time-handle-start-b"), 0, 7); // 시작만 당긴다
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]).toMatchObject({ id: "d-b", start_time: "10:15" });
  });

  it("⑥ 여러 날 span 이웃은 연동에서 빠지고, 잡은 칩만 옮겨진다", async () => {
    mockRows([
      dbRow({ id: "d-a", note_id: "a" }),
      dbRow({
        id: "d-trip",
        note_id: "trip",
        start_time: "10:00",
        end_time: "18:00",
        end_year: 2026,
        end_month: 8,
        end_day: 12,
      }),
    ]);
    const view = renderPanel([
      item({ note_id: "a", kind: "event", start_time: "09:00", end_time: "10:00" }),
      item({
        note_id: "trip",
        kind: "span",
        span_start: DAY,
        span_end: "2026-08-12",
        start_time: "10:00",
        end_time: "18:00",
      }),
    ]);
    dragChip(view.getByTestId("cal-time-event-a"), 30, 7);
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]).toMatchObject({ id: "d-a", start_time: "09:15" });
    expect(view.getByTestId("cal-time-event-trip").style.transform).toBe("");
  });

  it("⑥ 키보드 ↑/↓ 도 연동된다 — 같은 기능이 같은 경험이어야 한다", async () => {
    mockRows(twoRows());
    const view = renderPanel(touchingTwo());
    fireEvent.keyDown(view.getByTestId("cal-time-event-a"), { key: "ArrowDown" });
    await waitFor(() => expect(updates()).toHaveLength(2));
    expect(updates().map((u) => [u.id, u.start_time])).toEqual([
      ["d-a", "09:15"],
      ["d-b", "10:15"],
    ]);
    expect(undoToastMock).toHaveBeenCalledTimes(1);
  });

  it("⑥ 맞닿지 않은 이웃은 그대로 — 연동은 gap 0 에서만", async () => {
    mockRows([
      dbRow({ id: "d-a", note_id: "a" }),
      dbRow({ id: "d-b", note_id: "b", start_time: "11:00", end_time: "12:00" }),
    ]);
    const view = renderPanel([
      item({ note_id: "a", kind: "event", start_time: "09:00", end_time: "10:00" }),
      item({ note_id: "b", kind: "event", start_time: "11:00", end_time: "12:00" }),
    ]);
    dragChip(view.getByTestId("cal-time-event-a"), 30, 7);
    await waitFor(() => expect(updates()).toHaveLength(1));
    expect(updates()[0]).toMatchObject({ id: "d-a" });
  });
});

/**
 * W17 — 가장자리 자동 스크롤.
 *
 * 축은 24시간(DAY_AXIS_H = 672px)을 **보이는 창만큼씩만** 보여준다. 그래서 지금 화면에 없는
 * 시간대로는 한 번의 드래그로 옮길 수 없었다 — 칩을 아래 끝까지 끌어도 축이 따라오지 않았다.
 *
 * jsdom 에는 스크롤 물리도 레이아웃도 없으므로 ⓐ 스크롤러·캔버스의 rect 를 세워 주고
 * ⓑ `scrollTop` 을 **값으로** 읽고 쓰며 ⓒ 타이머를 가짜로 고정해 틱을 직접 돌린다. 구현이
 * requestAnimationFrame 이 아니라 setInterval 인 이유의 절반이 이것이다(나머지 절반은
 * trackAutoScroll 주석). **속도감 자체는 오너가 실기로 본다** — 여기서 지키는 것은 방향 · 멈춤 ·
 * 경계 clamp · 미리보기 동기화 넷이다.
 */
describe("달력 W17 — 가장자리 자동 스크롤", () => {
  /** 보이는 창 400px → 캔버스 672px 중 아래 272px 이 화면 밖(= scrollTop 최대치). */
  const VIEW_H = 400;
  const MAX_SCROLL = DAY_AXIS_H - VIEW_H;
  /** 구현의 상수와 같은 값. 틱 하나가 7px = **정확히 15분**이다(PX_PER_MIN = 28/60). */
  const TICK_MS = 16;
  const TICK_PX = 7;
  /** 하단 32px 안 / 상단 32px 안 — 그 밖이면 자동 스크롤이 안 걸린다. */
  const BOTTOM_EDGE = VIEW_H - 5;
  const TOP_EDGE = 5;

  beforeEach(() => {
    // Date 는 실물 그대로 둔다 — 현재 시각 눈금이 "오늘"을 보는 데 쓰고, 이 블록은 타이머만 민다.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function stubRect(el: HTMLElement, top: number, height: number) {
    vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
      top,
      height,
      bottom: top + height,
      left: 0,
      right: 200,
      width: 200,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect);
  }

  function setup(
    items: CalendarItem[],
    onCreate?: (day: string, startMin: number, endMin: number) => void,
  ) {
    const view = render(
      <DayDetailPanel
        selectedDay={DAY}
        monthLabel="2026년 8월"
        detailNotes={items}
        onOpen={() => {}}
        onCreateTimedNote={onCreate}
      />,
    );
    const axis = view.getByTestId("cal-time-axis") as HTMLElement;
    stubRect(axis, 0, VIEW_H);
    stubRect(view.getByTestId("cal-time-axis-canvas") as HTMLElement, 0, DAY_AXIS_H);
    // 마운트의 "첫 일정에 맞추기"가 이미 넣어 둔 값을 지운다 — 이 블록은 증감만 본다.
    axis.scrollTop = 0;
    return { view, axis };
  }

  const ticks = (n: number) =>
    act(() => {
      vi.advanceTimersByTime(TICK_MS * n);
    });

  /** 09:00–10:00 칩 하나를 가운데(= 이동 모드)로 잡고 clientY 로 옮긴다. 손을 떼지 않는다. */
  function grabChip(view: ReturnType<typeof setup>["view"], toY: number) {
    const chip = view.getByTestId("cal-time-event-m") as HTMLElement;
    stubRect(chip, 100, 60);
    fireEvent.pointerDown(chip, { button: 0, pointerId: 1, clientX: 50, clientY: 130 });
    fireEvent.pointerMove(chip, { pointerId: 1, clientX: 50, clientY: toY });
    return chip;
  }
  const timedItem = () => [item({ note_id: "m", kind: "event", start_time: "09:00", end_time: "10:00" })];

  it("칩을 하단 가장자리에 두면 축이 계속 흐르고, 손이 멈춰 있어도 미리보기가 같이 간다", () => {
    const { view, axis } = setup(timedItem());
    const chip = grabChip(view, BOTTOM_EDGE);
    // 265px 아래 = 약 9시간 30분 뒤. 아직 틱은 돌지 않았다.
    expect(axis.scrollTop).toBe(0);
    expect(chip.textContent).toContain("18:30");

    ticks(2); // 14px = 30분
    expect(axis.scrollTop).toBe(2 * TICK_PX);
    // 포인터는 그대로인데 축이 흘렀다 — 미리보기가 따라오지 않으면 칩이 커서를 놓친다.
    expect(chip.textContent).toContain("19:00");

    ticks(4);
    expect(axis.scrollTop).toBe(6 * TICK_PX);
    expect(chip.textContent).toContain("20:00");
    fireEvent.pointerCancel(chip, { pointerId: 1 });
  });

  it("상단 가장자리에서는 거꾸로 흐르고, 0 아래로는 안 나간다", () => {
    const { view, axis } = setup(timedItem());
    axis.scrollTop = 10;
    const chip = grabChip(view, TOP_EDGE);
    ticks(5); // 35px 어치를 밀지만 남은 것은 10px 뿐이다
    expect(axis.scrollTop).toBe(0);
    fireEvent.pointerCancel(chip, { pointerId: 1 });
  });

  it("바닥(캔버스 높이 − 보이는 높이)을 넘겨 밀지 않는다", () => {
    const { view, axis } = setup(timedItem());
    axis.scrollTop = MAX_SCROLL - 3;
    const chip = grabChip(view, BOTTOM_EDGE);
    ticks(10);
    expect(axis.scrollTop).toBe(MAX_SCROLL);
    fireEvent.pointerCancel(chip, { pointerId: 1 });
  });

  it("가장자리를 벗어나 가운데로 돌아오면 멈춘다", () => {
    const { view, axis } = setup(timedItem());
    const chip = grabChip(view, BOTTOM_EDGE);
    ticks(2);
    const stopped = axis.scrollTop;
    expect(stopped).toBeGreaterThan(0);

    fireEvent.pointerMove(chip, { pointerId: 1, clientX: 50, clientY: VIEW_H / 2 });
    ticks(10);
    expect(axis.scrollTop).toBe(stopped);
    fireEvent.pointerCancel(chip, { pointerId: 1 });
  });

  it("손을 떼면 루프가 끊긴다 — 그 뒤로는 시간이 지나도 안 흐른다", () => {
    const { view, axis } = setup(timedItem());
    const chip = grabChip(view, BOTTOM_EDGE);
    ticks(1);
    const stopped = axis.scrollTop;
    fireEvent.pointerUp(chip, { pointerId: 1, clientX: 50, clientY: BOTTOM_EDGE });
    ticks(20);
    expect(axis.scrollTop).toBe(stopped);
  });

  it("Escape 로 취소해도 루프가 끊긴다", () => {
    const { view, axis } = setup(timedItem());
    const chip = grabChip(view, BOTTOM_EDGE);
    ticks(1);
    const stopped = axis.scrollTop;
    fireEvent.keyDown(window, { key: "Escape" });
    ticks(20);
    expect(axis.scrollTop).toBe(stopped);
    // 미리보기도 걷혔다 — 칩은 행의 값(09:00)으로 돌아간다.
    expect(chip.textContent).toContain("09:00");
  });

  it("빈 곳 드래그(생성)도 흐르고, 그 사이 범위 미리보기가 커진다", () => {
    const { view, axis } = setup([], () => {});
    const canvas = view.getByTestId("cal-time-axis-canvas") as HTMLElement;
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 9, clientX: 50, clientY: 9 * HOUR_ROW_H });
    fireEvent.pointerMove(canvas, { pointerId: 9, clientX: 50, clientY: BOTTOM_EDGE });
    expect(view.getByTestId("cal-time-new-range").textContent).toBe("09:00–14:00");

    ticks(2); // 14px = 30분. 손은 그대로인데 축이 흘렀으니 끝이 30분 더 내려간다.
    expect(axis.scrollTop).toBe(2 * TICK_PX);
    expect(view.getByTestId("cal-time-new-range").textContent).toBe("09:00–14:30");
    fireEvent.pointerCancel(canvas, { pointerId: 9 });
  });

  it("종일 카드를 축의 가장자리로 끌어도 흐른다 (부모는 손잡이로만 부탁한다)", () => {
    const { view, axis } = setup([item({ note_id: "a", kind: "event" })]);
    const grip = view.getByTestId("cal-detail-grip-a") as HTMLElement;
    fireEvent.pointerDown(grip, { button: 0, pointerId: 7, clientX: 50, clientY: 300 });
    fireEvent.pointerMove(grip, { pointerId: 7, clientX: 50, clientY: BOTTOM_EDGE });
    expect(axis.scrollTop).toBe(0);

    ticks(3);
    expect(axis.scrollTop).toBe(3 * TICK_PX);
    fireEvent.pointerCancel(grip, { pointerId: 7 });
    ticks(10);
    expect(axis.scrollTop).toBe(3 * TICK_PX); // 취소로 루프가 끊겼다
  });
});

/**
 * PLAN-2026-09-13 달력 축 확대 — Ctrl/Cmd+wheel 로 축의 시간당 px(HOUR_ROW_H)을 바꾼다.
 * useMapPanZoom·useTimelineDrag 와 같은 관용구(네이티브 addEventListener, 일반 휠은 그대로 세로
 * 스크롤, Ctrl/Cmd+wheel 만 확대)를 다른 좌표계(24시간 고정 도메인의 밀도)에 적용한 것 —
 * WorldMap.wheel.test.tsx 와 같은 패턴(new WheelEvent + dispatchEvent)으로 검증한다.
 *
 * 배율(hourRowH)은 이 축의 로컬 state 라 DOM 에 직접 노출되지 않는다 — 그래서 파생값인 칩의
 * 렌더 높이(1시간짜리 이벤트의 style.height 는 정의상 항상 "지금 hourRowH" 와 같은 px)로
 * 간접 검증한다. 스케일이 바뀌었는데 옛 좌표로 그려지면 회귀이므로, 그 값이 곧 이 스위트의
 * 관찰 지점이다.
 */
describe("달력 축 확대 — Ctrl/Cmd+wheel", () => {
  function wheel(el: HTMLElement, deltaY: number, ctrlKey = true) {
    const evt = new WheelEvent("wheel", {
      deltaY,
      ctrlKey,
      cancelable: true,
      bubbles: true,
      clientX: 50,
      clientY: 50,
    });
    act(() => {
      el.dispatchEvent(evt);
    });
    return evt;
  }

  /** 1시간짜리 이벤트 하나 — 그 칩의 style.height(px) 는 정의상 정확히 지금 hourRowH 와 같다
   *  (60분/1440분 * hourRowH*24 = hourRowH), 그래서 배율의 직접적인 파생값으로 쓴다. */
  function setup() {
    const view = renderPanel([
      item({ note_id: "a", kind: "event", start_time: "09:00", end_time: "10:00" }),
    ]);
    const axis = view.getByTestId("cal-time-axis") as HTMLElement;
    const chip = () => view.getByTestId("cal-time-event-a") as HTMLElement;
    const chipHeight = () => Number.parseFloat(chip().style.height);
    return { view, axis, chip, chipHeight };
  }

  it("(a) Ctrl+wheel(위로)로 확대되면 칩 높이(=HOUR_ROW_H 상당)가 커진다", () => {
    const { axis, chipHeight } = setup();
    expect(chipHeight()).toBe(HOUR_ROW_H); // 28

    const evt = wheel(axis, -100, true);
    expect(evt.defaultPrevented).toBe(true);
    expect(chipHeight()).toBeGreaterThan(HOUR_ROW_H);
  });

  it("Ctrl+wheel(아래로)로는 축소된다", () => {
    const { axis, chipHeight } = setup();
    wheel(axis, -100, true); // 먼저 한 번 키워 둔다 — 하한에서 더 못 줄어드는 것과 구분하려고.
    const zoomedIn = chipHeight();
    wheel(axis, 100, true);
    expect(chipHeight()).toBeLessThan(zoomedIn);
  });

  it("(b) 일반 휠(Ctrl/Cmd 없이)은 확대하지 않는다 — 네이티브 스크롤 그대로", () => {
    const { axis, chipHeight } = setup();
    const before = chipHeight();
    const evt = wheel(axis, -100, false);
    expect(evt.defaultPrevented).toBe(false); // 막지 않는다 — 컨테이너의 세로 스크롤이 그대로 산다.
    expect(chipHeight()).toBe(before); // 스케일은 안 바뀌었다.
  });

  it("(c) 확대 상한 — 계속 키워도 MAX_HOUR_ROW_H 를 넘지 않는다", () => {
    const { axis, chipHeight } = setup();
    for (let i = 0; i < 40; i++) wheel(axis, -100, true);
    expect(chipHeight()).toBe(MAX_HOUR_ROW_H);
    wheel(axis, -100, true); // 이미 상한 — 한 번 더 줘도 그대로.
    expect(chipHeight()).toBe(MAX_HOUR_ROW_H);
  });

  it("(c) 축소 하한 — 계속 줄여도 MIN_HOUR_ROW_H(현재 기본값 28) 아래로는 안 내려간다", () => {
    const { axis, chipHeight } = setup();
    for (let i = 0; i < 40; i++) wheel(axis, 100, true);
    expect(chipHeight()).toBe(MIN_HOUR_ROW_H);
    expect(MIN_HOUR_ROW_H).toBe(HOUR_ROW_H); // 하한 = 지금의 기본값, 요구사항 그대로.
  });

  it("확대해도 30분 스냅(SNAP_MIN)·최소 칩 길이(MIN_SLOT_MIN)는 그대로다 — 저장 단위는 안 바뀐다", () => {
    // 이 스위트는 "보기"만 바뀐다는 요구사항 ⑤ 의 경계 확인 — 별도 드래그 스냅 회귀 테스트는
    // 기존 W3/W5 스위트가 이미 촘촘히 덮는다(calendarLayout.test.ts 의 snapStartMin/dragTimes
    // 유닛 테스트도 마찬가지). 여기서는 축 확대가 그 값 자체를 건드리지 않는다는 것만 본다.
    const { axis, chip } = setup();
    wheel(axis, -100, true);
    // 여전히 09:00 그대로 시작한다 — 확대가 시각을 바꾸지 않는다.
    expect(chip().textContent).toContain("09:00");
  });
});
