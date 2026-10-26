/**
 * `planRowTimes` 만의 단위 테스트 — 축 칩을 끌거나 손잡이로 늘렸을 때 **DB 행**에 쓸 시각.
 *
 * 이 함수는 TimeAxis 의 `commitTimes` 안에 인라인으로 있던 계산이라 지금까지 DayDetailPanel 을
 * 통째로 마운트해야만 검증할 수 있었다(판별 기준 2 — 순수 로직인데 마운트가 오버헤드). 같은
 * 자리의 이웃 둘(shiftRowTimes · resizeRowBoundary)이 이미 dateWrite.test.ts 에서 순수 함수로
 * 검증되고 있고, 이것이 그 셋째다.
 *
 * 별도 파일인 이유: 이 웨이브의 허용 범위가 dateWrite.ts 에 **함수를 더하는 것**까지라
 * dateWrite.test.ts 는 손대지 않는다.
 */
import { describe, it, expect } from "vitest";
import type { NoteDate } from "../../../lib/commands.gen";
import { planRowTimes } from "./dateWrite";
import { HOUR_ROW_H } from "../calendarLayout";

function row(overrides: Partial<NoteDate> = {}): NoteDate {
  return {
    id: "date-123",
    note_id: "note-abc",
    year: 2026,
    month: 9,
    day: 13,
    end_year: null,
    end_month: null,
    end_day: null,
    start_time: "09:00",
    end_time: "10:30",
    remind: false,
    remind_offset_min: null,
    rrule: null,
    position: 1,
    created_at: "2026-09-13T00:00:00Z",
    label: null,
    ...overrides,
  };
}

describe("planRowTimes", () => {
  it("mode start 는 시작만 쓰고 끝은 행 값 그대로 — 없던 끝을 지어내지 않는다", () => {
    expect(planRowTimes(row(), "start", { startMin: 570, endMin: 630 }, HOUR_ROW_H)).toEqual({
      start_time: "09:30",
      end_time: "10:30",
      startMin: null,
    });
    expect(
      planRowTimes(row({ end_time: null }), "start", { startMin: 570, endMin: 630 }, HOUR_ROW_H)
        .end_time,
    ).toBeNull();
  });

  it("mode end 는 끝만 쓰고 시작은 행 값 그대로", () => {
    expect(planRowTimes(row(), "end", { startMin: 540, endMin: 675 }, HOUR_ROW_H)).toEqual({
      start_time: "09:00",
      end_time: "11:15",
      startMin: null,
    });
  });

  it("mode move 는 **길이를 행에게 묻는다** — 화면이 준 endMin 이 아니라 행의 90분을 유지한다", () => {
    // 화면 항목은 월 클리핑/회차를 거쳐 30분처럼 보일 수 있다. 행은 09:00–10:30 = 90분.
    const out = planRowTimes(row(), "move", { startMin: 780, endMin: 810 }, HOUR_ROW_H);
    expect(out.start_time).toBe("13:00");
    expect(out.end_time).toBe("14:30");
    expect(out.startMin).toBe(780);
  });

  it("mode move 로 하루를 넘치면 행의 길이만큼 되죄고, 그 시작을 startMin 으로 알린다", () => {
    // 23:30 에 90분짜리를 놓으면 끝이 자정을 넘는다 → 시작이 22:30 으로 당겨진다.
    const out = planRowTimes(row(), "move", { startMin: 1410, endMin: 1440 }, HOUR_ROW_H);
    expect(out.startMin).toBe(1350);
    expect(out.start_time).toBe("22:30");
    // 현행 동작을 그대로 못 박는다 — 정확히 자정에 닿은 끝은 "00:00" 으로 쓰인다. 이웃 둘
    // (shiftRowTimes · resizeRowBoundary)은 같은 자리에서 clampStoredEndMin 으로 "23:59" 를
    // 쓰므로 셋이 어긋나 있다. 이번 웨이브는 **동작 변경 0** 이라 옮기기만 하고 그대로 뒀다.
    expect(out.end_time).toBe("00:00");
  });

  it("mode move 인데 끝이 없는 행은 끝을 만들지 않는다(길이 0)", () => {
    const out = planRowTimes(
      row({ end_time: null }),
      "move",
      { startMin: 780, endMin: 810 },
      HOUR_ROW_H,
    );
    expect(out.start_time).toBe("13:00");
    expect(out.end_time).toBeNull();
  });

  it("여러 날 span 의 end_time 은 길이로 쓰지 않는다 — 그 값은 마지막 날의 것이다", () => {
    const span = row({ end_year: 2026, end_month: 9, end_day: 15, end_time: "10:30" });
    const out = planRowTimes(span, "move", { startMin: 780, endMin: 810 }, HOUR_ROW_H);
    expect(out.start_time).toBe("13:00");
    // rowIsSameDay 가 false → keepDurationMin 이 길이를 안 주고, end_time 은 행 값 그대로다.
    expect(out.end_time).toBe("10:30");
  });
});
