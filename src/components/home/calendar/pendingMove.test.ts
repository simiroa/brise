import { describe, it, expect } from "vitest";
import type { CalendarItem } from "../../../lib/commands.gen";
import { planTimedDay, DAY_MIN, type TimedEvent } from "../calendarLayout";
import { previewRowId, reconcilePreviews, samePreview, tagPreviews, type MovePreview } from "./pendingMove";

const DAY = "2026-08-09";

function ev(noteId: string, start: string, end: string | null = null, day = DAY): TimedEvent {
  const [y, m, d] = day.split("-").map(Number);
  const item = {
    note_id: noteId,
    kind: "event",
    folder_id: "f",
    title: noteId,
    span_start: day,
    span_end: day,
    year: y,
    month: m,
    day: d,
    end_year: null,
    end_month: null,
    end_day: null,
    start_time: start,
    end_time: end,
    is_occurrence: null,
    remind: false,
    date_id: `d-${noteId}`,
    position: 0,
    remind_offset_min: null,
    rrule: null,
  } as CalendarItem;
  return planTimedDay([item], day).timed[0];
}

describe("pendingMove — 낙관적 자리의 꼬리표와 판정", () => {
  const a0 = ev("a", "09:00", "10:00"); // 540~600
  const target: MovePreview = { key: a0.key, startMin: 555, endMin: 615 };

  it("tagPreviews: 처음 나온 칩은 지금 자리를 출발점으로, 이미 있던 칩은 처음 꼬리표를 이어받는다", () => {
    const first = tagPreviews([target], [], [a0]);
    expect(first[0]).toMatchObject({ row: previewRowId(a0), from: { startMin: 540, endMin: 600 } });
    // 키보드를 연달아 누르면 목표가 움직여도 출발점은 그대로다.
    const second = tagPreviews([{ ...target, startMin: 570, endMin: 630 }], first, [a0]);
    expect(second[0].from).toEqual({ startMin: 540, endMin: 600 });
    // 데이터에 없는 칩은 꼬리표 없이 둔다.
    expect(tagPreviews([{ key: "nope", startMin: 1, endMin: 2 }], [], [a0])[0].row).toBeUndefined();
  });

  it("reconcilePreviews: 행이 옛 자리 그대로면 낡은 데이터라 남긴다", () => {
    const cur = tagPreviews([target], [], [a0]);
    expect(reconcilePreviews(cur, [a0])).toBe(cur); // 같은 배열 — 재렌더 없음
  });

  it("목표 자리에 왔으면 버린다(반영됨)", () => {
    const cur = tagPreviews([target], [], [a0]);
    expect(reconcilePreviews(cur, [ev("a", "09:15", "10:15")])).toEqual([]);
  });

  it("그 밖의 자리(이웃에 밀리거나 서버가 다듬음)·행이 사라짐이면 서버의 답이 이긴다 — 버린다", () => {
    const cur = tagPreviews([target], [], [a0]);
    expect(reconcilePreviews(cur, [ev("a", "09:30", "10:30")])).toEqual([]);
    expect(reconcilePreviews(cur, [])).toEqual([]);
  });

  it("날이 바뀐 이동(당일 → 익일 구간)은 옛 행이 사라지므로 버린다", () => {
    const cur = tagPreviews([target], [], [a0]);
    const movedToTail = { ...ev("a", "01:00", "02:00", "2026-08-10"), startMin: DAY_MIN + 60, endMin: DAY_MIN + 120 };
    expect(reconcilePreviews(cur, [movedToTail])).toEqual([]);
  });

  it("두 칩 중 한쪽만 반영돼도 반영된 쪽만 버린다", () => {
    const b0 = ev("b", "11:00", "12:00");
    const cur = tagPreviews(
      [target, { key: b0.key, startMin: 675, endMin: 735 }],
      [],
      [a0, b0],
    );
    const next = reconcilePreviews(cur, [ev("a", "09:15", "10:15"), b0]);
    expect(next.map((p) => p.key)).toEqual([b0.key]);
  });

  it("꼬리표 없는 미리보기는 버린다", () => {
    expect(reconcilePreviews([{ key: "x", startMin: 1, endMin: 2 }], [a0])).toEqual([]);
  });

  it("samePreview 는 key/시작/끝만 본다", () => {
    expect(samePreview([target], [{ ...target, row: "r" }])).toBe(true);
    expect(samePreview([target], [{ ...target, startMin: 1 }])).toBe(false);
  });
});
