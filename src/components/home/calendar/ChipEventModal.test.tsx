import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarItem } from "../../../lib/commands.gen";

const renameNote = vi.fn(async () => {});
const commitDateRow = vi.fn(async (..._a: unknown[]) => true);
vi.mock("../../../lib/noteActions", () => ({ renameNote: (...a: unknown[]) => (renameNote as (...x: unknown[]) => unknown)(...a) }));
vi.mock("./dateWrite", async (orig) => ({
  ...(await orig<typeof import("./dateWrite")>()),
  commitDateRow: (...a: unknown[]) => commitDateRow(...a),
}));

import { ChipEventModal } from "./ChipEventModal";

const item = {
  note_id: "n1",
  date_id: "d1",
  title: "회의",
  span_start: "2026-10-27",
  span_end: "2026-10-27",
  start_time: "10:00",
  end_time: "11:00",
  rrule: null,
} as unknown as CalendarItem;

function setup() {
  const onClose = vi.fn();
  const onRepeatApply = vi.fn();
  const onDelete = vi.fn();
  const view = render(
    <ChipEventModal item={item} uiLang="ko" onClose={onClose} onRepeatApply={onRepeatApply} onDelete={onDelete} />,
  );
  return { ...view, onClose, onRepeatApply, onDelete };
}

describe("ChipEventModal", () => {
  beforeEach(() => {
    renameNote.mockClear();
    commitDateRow.mockClear();
  });

  it("시작을 바꾸면 끝이 길이를 지키며 따라가고, 저장은 제목·시각을 한 번씩 쓴다", async () => {
    const { getByTestId, onClose } = setup();
    fireEvent.change(getByTestId("cal-event-title"), { target: { value: "주간 회의" } });
    fireEvent.change(getByTestId("cal-event-start"), { target: { value: "13:00" } });
    expect((getByTestId("cal-event-end") as HTMLInputElement).value).toBe("14:00");
    fireEvent.click(getByTestId("cal-event-save"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(renameNote).toHaveBeenCalledWith("n1", "주간 회의");
    expect(commitDateRow).toHaveBeenCalledTimes(1);
    const patch = (commitDateRow.mock.calls[0][2] as (r: unknown) => Record<string, unknown>)({
      year: 2026, month: 10, day: 27, end_year: 2026, end_month: 10, end_day: 27, rrule: null,
    });
    expect(patch).toMatchObject({ start_time: "13:00", end_time: "14:00" });
  });

  it("commitDateRow 가 false(저장 실패·행 없음)면 모달을 열어 둔다 — 닫지도 반복 적용도 하지 않는다", async () => {
    commitDateRow.mockResolvedValueOnce(false);
    const { getByTestId, onClose, onRepeatApply } = setup();
    fireEvent.change(getByTestId("cal-event-start"), { target: { value: "13:00" } });
    fireEvent.click(getByTestId("cal-event-save"));
    await waitFor(() => expect(commitDateRow).toHaveBeenCalledTimes(1));
    // busy 가 풀려 다시 저장할 수 있다(입력도 그대로).
    await waitFor(() => expect((getByTestId("cal-event-save") as HTMLButtonElement).disabled).toBe(false));
    expect(onClose).not.toHaveBeenCalled();
    expect(onRepeatApply).not.toHaveBeenCalled();
    expect((getByTestId("cal-event-start") as HTMLInputElement).value).toBe("13:00");
  });

  it("종료 <= 시작이면 오류를 보이고 저장을 막는다", () => {
    const { getByTestId } = setup();
    fireEvent.change(getByTestId("cal-event-end"), { target: { value: "09:00" } });
    expect(getByTestId("cal-event-error")).toBeTruthy();
    expect((getByTestId("cal-event-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("삭제는 모달을 닫은 뒤 축의 확인 흐름을 부른다", () => {
    const { getByTestId, onClose, onDelete } = setup();
    fireEvent.click(getByTestId("cal-event-delete"));
    expect(onClose).toHaveBeenCalled();
    expect(onDelete).toHaveBeenCalled();
  });
});
