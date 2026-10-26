/**
 * buildMonthReminders — 미니 달력 "월간 일정" 탭 목록 조립의 입력→출력 단위 테스트.
 * PLAN-2026-09-13-separation-of-concerns 트랙 D1 ③ 으로 CalendarExpanded 의 useMemo 에서
 * 떼어낸 순수 함수라, 여기서는 React 를 마운트하지 않는다.
 */
import { describe, it, expect } from "vitest";
import type { CalendarItem, NoteSummary } from "../../../lib/commands.gen";
import { buildMonthReminders } from "./monthReminders";

function item(partial: Partial<CalendarItem> & { note_id: string }): CalendarItem {
  return {
    folder_id: "f1",
    title: `제목 ${partial.note_id}`,
    kind: "event",
    span_start: "2026-08-01",
    span_end: "2026-08-01",
    year: 2026,
    month: 8,
    day: null,
    end_year: null,
    end_month: null,
    end_day: null,
    start_time: null,
    end_time: null,
    is_occurrence: null,
    remind: true,
    date_id: `d-${partial.note_id}`,
    position: 0,
    remind_offset_min: null,
    rrule: null,
    ...partial,
  };
}

function note(partial: Partial<NoteSummary> & { id: string }): NoteSummary {
  return {
    folder_id: "cached-folder",
    title: `캐시 ${partial.id}`,
    year: 2026,
    month: null,
    day: null,
    start_time: null,
    end_time: null,
    end_year: null,
    end_month: null,
    end_day: null,
    remind: false,
    is_favorite: true,
    exported_at: null,
    has_image: false,
    tag_names: [],
    region: null,
    status: null,
    icon: null,
    lat: null,
    lng: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    ...partial,
  };
}

const NO_FILTER = { selectedTags: [] as string[], tagMode: "and" as const, statusFilter: [] as string[] };

describe("buildMonthReminders", () => {
  it("remind 가 아닌 항목은 빠진다", () => {
    const out = buildMonthReminders([item({ note_id: "a", remind: false })], new Map(), NO_FILTER);
    expect(out).toHaveLength(0);
  });

  it("캐시 히트: 트리 캐시 행을 쓰되 날짜·시각·remind 는 달력 항목이 이긴다", () => {
    const index = new Map([["a", note({ id: "a", title: "캐시 제목", day: 1, start_time: "01:00" })]]);
    const [only] = buildMonthReminders([item({ note_id: "a", day: 20, start_time: "10:00" })], index, NO_FILTER);
    expect(only.title).toBe("캐시 제목");
    expect(only.folder_id).toBe("cached-folder");
    expect(only.is_favorite).toBe(true);
    expect(only.day).toBe(20);
    expect(only.month).toBe(8);
    expect(only.start_time).toBe("10:00");
    expect(only.remind).toBe(true);
  });

  it("캐시 히트인데 달력 쪽이 비었으면 캐시 값이 남는다", () => {
    const index = new Map([["a", note({ id: "a", day: 7, month: 7, start_time: "09:30" })]]);
    const [only] = buildMonthReminders(
      [item({ note_id: "a", day: null, month: null, start_time: null })],
      index,
      NO_FILTER
    );
    expect(only.day).toBe(7);
    expect(only.month).toBe(7);
    expect(only.start_time).toBe("09:30");
  });

  it("캐시 미스: 달력 항목만으로 폴백 행을 만든다(태그 없음·즐겨찾기 아님)", () => {
    const [only] = buildMonthReminders(
      [item({ note_id: "b", title: "달력 제목", day: 3, end_day: 5, end_time: "12:00" })],
      new Map(),
      NO_FILTER
    );
    expect(only.id).toBe("b");
    expect(only.title).toBe("달력 제목");
    expect(only.day).toBe(3);
    expect(only.end_day).toBe(5);
    expect(only.end_time).toBe("12:00");
    expect(only.remind).toBe(true);
    expect(only.is_favorite).toBe(false);
    expect(only.tag_names).toEqual([]);
    expect(only.created_at).toBe("");
  });

  it("날짜 오름차순, 같은 날이면 start_time 순 — day 없는 항목은 맨 뒤(99)", () => {
    const out = buildMonthReminders(
      [
        item({ note_id: "late", day: 20, start_time: "09:00" }),
        item({ note_id: "noday", day: null }),
        item({ note_id: "early-pm", day: 3, start_time: "18:00" }),
        item({ note_id: "early-am", day: 3, start_time: "08:00" }),
      ],
      new Map(),
      NO_FILTER
    );
    expect(out.map((n) => n.id)).toEqual(["early-am", "early-pm", "late", "noday"]);
  });

  it("같은 노트가 여러 번 오면 정렬 후 첫 항목만 남는다", () => {
    const out = buildMonthReminders(
      [item({ note_id: "a", day: 20, date_id: "d2" }), item({ note_id: "a", day: 5, date_id: "d1" })],
      new Map(),
      NO_FILTER
    );
    expect(out).toHaveLength(1);
    expect(out[0].day).toBe(5);
  });

  it("태그 and/or — 캐시 행의 tag_names 로 거른다", () => {
    const index = new Map([
      ["both", note({ id: "both", tag_names: ["여행", "사진"] })],
      ["one", note({ id: "one", tag_names: ["여행"] })],
    ]);
    const items = [item({ note_id: "both", day: 1 }), item({ note_id: "one", day: 2 })];

    const and = buildMonthReminders(items, index, { ...NO_FILTER, selectedTags: ["여행", "사진"], tagMode: "and" });
    expect(and.map((n) => n.id)).toEqual(["both"]);

    const or = buildMonthReminders(items, index, { ...NO_FILTER, selectedTags: ["여행", "사진"], tagMode: "or" });
    expect(or.map((n) => n.id)).toEqual(["both", "one"]);
  });

  it("상태 필터 — status 가 없는 행(캐시 미스 폴백 포함)은 걸러진다", () => {
    const index = new Map([
      ["done", note({ id: "done", status: "done" })],
      ["todo", note({ id: "todo", status: "todo" })],
    ]);
    const out = buildMonthReminders(
      [item({ note_id: "done", day: 1 }), item({ note_id: "todo", day: 2 }), item({ note_id: "orphan", day: 3 })],
      index,
      { ...NO_FILTER, statusFilter: ["done"] }
    );
    expect(out.map((n) => n.id)).toEqual(["done"]);
  });

  it("입력 배열을 제자리에서 건드리지 않는다", () => {
    const items = [item({ note_id: "b", day: 9 }), item({ note_id: "a", day: 1 })];
    buildMonthReminders(items, new Map(), NO_FILTER);
    expect(items.map((i) => i.note_id)).toEqual(["b", "a"]);
  });
});
