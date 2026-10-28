/**
 * 날짜 상세 패널의 **데이터 조회 계층** 특성화 테스트 — 리팩터(useDayDetailData 추출) 전에
 * 먼저 쓴 것이다. DayDetailPanel.test.tsx(172개)는 두 토글의 **성공** 경로(todo_toggle 이
 * 올바른 인자로 불린다)만 덮고 있고, 실패 시 **되돌리기**(CLAUDE.md 함정 9 — 낙관적 갱신엔
 * 롤백이 짝이다)는 한 줄도 덮지 않았다. 옮기면서 그 짝이 조용히 빠져도 아무도 못 잡는다.
 *
 * 훅을 직접 렌더하지 않고 `DayDetailBody` 를 통해 본다 — 이 값들이 실제로 쓰이는 자리가
 * 화면이고, 훅만 떼어 렌더하면 "화면이 그 값을 정말 그렇게 쓰는가"를 못 본다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor, fireEvent } from "@testing-library/react";
import type { CalendarItem } from "../../../lib/commands.gen";
import { DayDetailBody } from "./DayDetailPanel";

const callMock = vi.fn();

vi.mock("../../../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  registerFlush: () => () => {},
  flushAll: async () => {},
  emitNotice: () => {},
}));

const DAY = "2026-08-09";

function item(p: Partial<CalendarItem> & Pick<CalendarItem, "note_id" | "kind">): CalendarItem {
  return {
    folder_id: "f",
    title: p.note_id,
    span_start: DAY,
    span_end: DAY,
    year: 2026,
    month: 8,
    day: 9,
    end_year: null,
    end_month: null,
    end_day: null,
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

/** note_get_many 한 번에 본문을 돌려주고, todo_toggle 은 `toggleFails` 에 따라 성공/실패한다. */
function mockNote(bodyMd: string, toggleFails: boolean) {
  callMock.mockImplementation(async (cmd: string) => {
    if (cmd === "note_get_many") {
      return {
        notes: [
          {
            note: { id: "n1", title: "회의" },
            sections: [{ id: "s1", name: "", body_md: bodyMd, position: 0, kind: "text" }],
            sources: [],
            attachments: [],
          },
        ],
      };
    }
    if (cmd === "note_dates_list") return { dates: [] };
    if (cmd === "todo_toggle") {
      if (toggleFails) throw { code: "IO", message: "test" };
      return { checked: true };
    }
    throw { code: "IO", message: "test" };
  });
}

function renderBody(items: CalendarItem[]) {
  return render(
    <DayDetailBody
      selectedDay={DAY}
      monthLabel="2026년 8월"
      detailNotes={items}
      onOpen={() => {}}
      focusedNoteId={null}
      forecast={null}
      holidayName={null}
    />,
  );
}

beforeEach(() => {
  callMock.mockReset();
});

describe("DayDetailBody 데이터 계층 — 인라인 할 일(전역 집계) 토글", () => {
  // 노트를 직접 읽어 온 경우(propInlineTasks 없음)의 로컬 토글. 부모가 inlineTasks 를 내려주면
  // 토글은 부모의 것이고 이 경로 자체가 없다.
  it("실패하면 체크가 원래대로 돌아온다", async () => {
    mockNote("- [ ] 2026-08-09 할 일 A", true);
    const view = renderBody([item({ note_id: "n1", kind: "event" })]);

    const checkbox = (await view.findByTestId(
      "cal-inline-task-checkbox-n1:s1:0",
    )) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("todo_toggle", {
        note_id: "n1",
        section_id: "s1",
        line_index: 0,
        expected_checked: false,
      }),
    );
    // 낙관적으로 켰다가 실패 → 되돌아온다(함정 9).
    await waitFor(() => expect(checkbox.checked).toBe(false));
  });

  it("성공하면 켠 채로 남는다", async () => {
    mockNote("- [ ] 2026-08-09 할 일 A", false);
    const view = renderBody([item({ note_id: "n1", kind: "event" })]);

    const checkbox = (await view.findByTestId(
      "cal-inline-task-checkbox-n1:s1:0",
    )) as HTMLInputElement;
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox.checked).toBe(true));
  });
});

describe("DayDetailBody 데이터 계층 — 축 칩의 체크리스트 토글", () => {
  // 위와 같은 모양이지만 입력이 다르다(note_id/section_id/line_index 뿐) — 두 경로가 각자
  // 자기 state 를 되돌린다.
  it("실패하면 체크가 원래대로 돌아온다", async () => {
    mockNote("본문 첫 줄\n- [ ] 할일 하나", true);
    const view = renderBody([item({ note_id: "n1", kind: "event", start_time: "09:00", end_time: "12:00" })]);

    const checkbox = (await view.findByTestId(
      "cal-chip-checklist-checkbox-n1-1",
    )) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("todo_toggle", {
        note_id: "n1",
        section_id: "s1",
        line_index: 1,
        expected_checked: false,
      }),
    );
    await waitFor(() => expect(checkbox.checked).toBe(false));
  });

  it("성공하면 켠 채로 남는다", async () => {
    mockNote("본문 첫 줄\n- [ ] 할일 하나", false);
    const view = renderBody([item({ note_id: "n1", kind: "event", start_time: "09:00", end_time: "12:00" })]);

    const checkbox = (await view.findByTestId(
      "cal-chip-checklist-checkbox-n1-1",
    )) as HTMLInputElement;
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox.checked).toBe(true));
  });
});

describe("DayDetailBody 데이터 계층 — 발췌·체크리스트는 한 번의 note_get_many 부산물", () => {
  it("체크리스트 줄은 발췌에서 빠지고, 본문 조회는 한 번만 돈다", async () => {
    mockNote("본문 첫 줄\n- [ ] 할일 하나\n둘째 줄", false);
    const view = renderBody([item({ note_id: "n1", kind: "event", start_time: "09:00", end_time: "12:00" })]);

    await waitFor(() =>
      expect(view.getByTestId("cal-chip-excerpt-n1").textContent).toBe("본문 첫 줄"),
    );
    expect(view.getByTestId("cal-chip-checklist-item-n1-1")).toBeDefined();
    expect(callMock.mock.calls.filter((c) => c[0] === "note_get_many")).toHaveLength(1);
    expect(callMock.mock.calls.filter((c) => c[0] === "note_get")).toHaveLength(0);
  });
});

describe("DayDetailBody 데이터 계층 — 노트 N 개에 IPC 1 회 (달력 N+1 회귀 방지)", () => {
  /** 받은 ids 마다 본문을 지어 **받은 순서대로** 돌려준다 — 서버처럼. 휴지통/없는 노트는 빠진다. */
  function mockMany(gone: Set<string> = new Set()) {
    callMock.mockImplementation(async (cmd: string, args?: { ids?: string[] }) => {
      if (cmd === "note_get_many") {
        return {
          notes: (args?.ids ?? [])
            .filter((id) => !gone.has(id))
            .map((id) => ({
              note: { id, title: id },
              sections: [
                { id: `s-${id}`, name: "", body_md: `${id} 본문`, position: 0, kind: "text" },
              ],
              sources: [],
              attachments: [],
            })),
        };
      }
      if (cmd === "note_dates_list") return { dates: [] };
      throw { code: "IO", message: "test" };
    });
  }

  it("노트 3 개 → note_get_many 1 회(ids 정렬·중복 제거), note_get 0 회, 발췌는 셋 다", async () => {
    mockMany();
    const view = renderBody([
      item({ note_id: "n3", kind: "event", start_time: "11:00", end_time: "14:00" }),
      item({ note_id: "n1", kind: "event", start_time: "09:00", end_time: "12:00" }),
      item({ note_id: "n2", kind: "event", start_time: "10:00", end_time: "13:00" }),
      // 같은 노트의 다른 날짜 행 — 본문 조회는 노트 단위라 한 번만.
      item({ note_id: "n1", kind: "event", start_time: "15:00", end_time: "18:00", date_id: "d-n1-b", position: 1 }),
    ]);

    for (const id of ["n1", "n2", "n3"]) {
      await waitFor(() =>
        expect(view.getAllByTestId(`cal-chip-excerpt-${id}`)[0].textContent).toBe(`${id} 본문`),
      );
    }
    const many = callMock.mock.calls.filter((c) => c[0] === "note_get_many");
    expect(many).toHaveLength(1);
    expect(many[0][1]).toEqual({ ids: ["n1", "n2", "n3"] });
    expect(callMock.mock.calls.filter((c) => c[0] === "note_get")).toHaveLength(0);
  });

  it("서버가 뺀 노트(휴지통·없음)는 발췌 없이 넘어가고 나머지는 그대로 뜬다", async () => {
    mockMany(new Set(["n2"]));
    const view = renderBody([
      item({ note_id: "n1", kind: "event", start_time: "09:00", end_time: "12:00" }),
      item({ note_id: "n2", kind: "event", start_time: "10:00", end_time: "13:00" }),
    ]);
    await waitFor(() =>
      expect(view.getByTestId("cal-chip-excerpt-n1").textContent).toBe("n1 본문"),
    );
    expect(view.queryByTestId("cal-chip-excerpt-n2")).toBeNull();
  });
});
