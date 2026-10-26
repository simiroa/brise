import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CalendarControlHeader } from "./CalendarControlHeader";

describe("CalendarControlHeader", () => {
  it("renders month label and fires prev/next navigation callbacks", () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const onToday = vi.fn();

    render(
      <CalendarControlHeader
        monthLabel="2026년 8월"
        onPrevMonth={onPrev}
        onNextMonth={onNext}
        onToday={onToday}
      />,
    );

    expect(screen.getByText("2026년 8월")).toBeTruthy();

    fireEvent.click(screen.getByTestId("cal-prev-month"));
    expect(onPrev).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("cal-next-month"));
    expect(onNext).toHaveBeenCalledTimes(1);

    expect(screen.queryByTestId("cal-today")).toBeNull();
  });

  it("shows today button when showToday is true and handles click", () => {
    const onToday = vi.fn();

    render(
      <CalendarControlHeader
        monthLabel="2026년 7월"
        onPrevMonth={vi.fn()}
        onNextMonth={vi.fn()}
        showToday={true}
        onToday={onToday}
      />,
    );

    const todayBtn = screen.getByTestId("cal-today");
    expect(todayBtn).toBeTruthy();

    fireEvent.click(todayBtn);
    expect(onToday).toHaveBeenCalledTimes(1);
  });

  it("shows loading indicator when loading is true", () => {
    render(
      <CalendarControlHeader
        monthLabel="2026년 8월"
        onPrevMonth={vi.fn()}
        onNextMonth={vi.fn()}
        onToday={vi.fn()}
        loading={true}
      />,
    );

    expect(screen.getByTestId("cal-loading-indicator")).toBeTruthy();
  });

  it("supports year navigators and new event button when provided", () => {
    const onPrevYear = vi.fn();
    const onNextYear = vi.fn();
    const onNewEvent = vi.fn();

    render(
      <CalendarControlHeader
        monthLabel="2026년 8월"
        onPrevMonth={vi.fn()}
        onNextMonth={vi.fn()}
        onPrevYear={onPrevYear}
        onNextYear={onNextYear}
        onNewEvent={onNewEvent}
        onToday={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("cal-prev-year"));
    expect(onPrevYear).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("cal-next-year"));
    expect(onNextYear).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("cal-new-event-btn"));
    expect(onNewEvent).toHaveBeenCalledTimes(1);
  });
});
