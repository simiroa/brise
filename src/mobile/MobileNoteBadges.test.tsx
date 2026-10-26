import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { MobileNoteBadges, type MobileNoteBadgesProps } from "./MobileNoteBadges";

interface GeocodeSearchResponse {
  results: { label: string; lat: number; lng: number }[];
}
const callMock = vi.fn(async (..._args: unknown[]): Promise<GeocodeSearchResponse> => ({ results: [] }));
vi.mock("../lib/invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
}));

function baseProps(overrides: Partial<MobileNoteBadgesProps> = {}): MobileNoteBadgesProps {
  return {
    year: 2026,
    month: 7,
    day: 30,
    status: null,
    region: null,
    customStatuses: [],
    uiLang: "en",
    setYear: vi.fn(),
    setEventPrecision: vi.fn(),
    setStatus: vi.fn(),
    setRegion: vi.fn(),
    setLocation: vi.fn(),
    remind: false,
    startTime: null,
    endTime: null,
    remindOffsetMin: null,
    rrule: null,
    notificationsEnabled: true,
    onEnableNotifications: vi.fn(),
    setRemind: vi.fn(),
    setSchedule: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  callMock.mockClear();
});

describe("MobileNoteBadges", () => {
  it("renders today's date for a draft and muted placeholders for unset status/region", () => {
    render(<MobileNoteBadges {...baseProps()} />);
    expect(screen.getByText("2026.07.30")).toBeTruthy();
    expect(screen.getByText("No status")).toBeTruthy();
    expect(screen.getByText("Region")).toBeTruthy();
  });

  it("renders set status/region values instead of the placeholders", () => {
    render(<MobileNoteBadges {...baseProps({ status: "done", region: "Seoul" })} />);
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.getByText("Seoul")).toBeTruthy();
    expect(screen.queryByText("No status")).toBeNull();
  });

  it("the invisible date <input> reports year/month/day back through setYear + setEventPrecision", () => {
    const setYear = vi.fn();
    const setEventPrecision = vi.fn();
    const { container } = render(<MobileNoteBadges {...baseProps({ setYear, setEventPrecision })} />);
    const input = container.querySelector('input[type="date"]')!;
    fireEvent.change(input, { target: { value: "2020-01-15" } });
    expect(setYear).toHaveBeenCalledWith(2020);
    expect(setEventPrecision).toHaveBeenCalledWith(1, 15);
  });

  it("status sheet: picking a row calls setStatus with that status's key and closes the sheet", () => {
    const setStatus = vi.fn();
    render(<MobileNoteBadges {...baseProps({ setStatus })} />);
    fireEvent.click(screen.getByText("No status"));
    const dialog = screen.getByRole("dialog", { name: "Status" });
    fireEvent.click(within(dialog).getByText("Done"));
    expect(setStatus).toHaveBeenCalledWith("done");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("status sheet: the leading row clears the status (key null)", () => {
    const setStatus = vi.fn();
    render(<MobileNoteBadges {...baseProps({ status: "done", setStatus })} />);
    fireEvent.click(screen.getByText("Done"));
    const dialog = screen.getByRole("dialog", { name: "Status" });
    fireEvent.click(within(dialog).getByText("No status"));
    expect(setStatus).toHaveBeenCalledWith(null);
  });

  it("region sheet: typing calls geocode_search (debounced) with the right command name", async () => {
    render(<MobileNoteBadges {...baseProps()} />);
    fireEvent.click(screen.getByText("Region"));
    const dialog = screen.getByRole("dialog", { name: "Select Region" });
    fireEvent.change(within(dialog).getByPlaceholderText("Search address or place..."), {
      target: { value: "Seoul" },
    });
    await waitFor(() => expect(callMock).toHaveBeenCalledWith("geocode_search", { query: "Seoul", lang: "en" }), {
      timeout: 2000,
    });
  });

  it("region sheet: picking a result calls setRegion + setLocation and closes the sheet", async () => {
    callMock.mockResolvedValueOnce({ results: [{ label: "Seoul, South Korea", lat: 37.5, lng: 127.0 }] });
    const setRegion = vi.fn();
    const setLocation = vi.fn();
    render(<MobileNoteBadges {...baseProps({ setRegion, setLocation })} />);
    fireEvent.click(screen.getByText("Region"));
    const dialog = screen.getByRole("dialog", { name: "Select Region" });
    fireEvent.change(within(dialog).getByPlaceholderText("Search address or place..."), {
      target: { value: "Seoul" },
    });
    const result = await within(dialog).findByText("Seoul, South Korea", undefined, { timeout: 2000 });
    fireEvent.click(result);
    expect(setRegion).toHaveBeenCalledWith("Seoul");
    expect(setLocation).toHaveBeenCalledWith(37.5, 127.0);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // docs/PLAN-schedule-system.md §7.7/W5-6 — bell badge + reminder sheet.
  describe("reminder bell", () => {
    it("shows the muted unset badge with the reminder label when remind is off", () => {
      render(<MobileNoteBadges {...baseProps()} />);
      const badge = screen.getByTestId("mobile-reminder-badge");
      expect(badge.className).toContain("mobile-badge--unset");
      expect(badge.textContent).toContain("Reminder");
    });

    it("shows the plain badge with the start time text when remind is on", () => {
      render(<MobileNoteBadges {...baseProps({ remind: true, startTime: "09:00" })} />);
      const badge = screen.getByTestId("mobile-reminder-badge");
      expect(badge.className).not.toContain("mobile-badge--unset");
      expect(badge.textContent).toContain("09:00");
    });

    it("opens the reminder sheet on tap and shows the app-off banner when notifications are disabled", () => {
      render(<MobileNoteBadges {...baseProps({ notificationsEnabled: false })} />);
      fireEvent.click(screen.getByTestId("mobile-reminder-badge"));
      expect(screen.getByRole("dialog", { name: "Reminder" })).toBeTruthy();
      const banner = screen.getByTestId("mobile-reminder-app-off-banner");
      fireEvent.click(within(banner).getByTestId("mobile-reminder-enable-app"));
      // No sheet-close side effect expected — same as desktop's inline "turn on app notifications".
    });

    it("does not show the app-off banner when notifications are already enabled", () => {
      render(<MobileNoteBadges {...baseProps({ notificationsEnabled: true })} />);
      fireEvent.click(screen.getByTestId("mobile-reminder-badge"));
      expect(screen.queryByTestId("mobile-reminder-app-off-banner")).toBeNull();
    });

    it("has no end-time or repeat-until controls (§7.7 scope: mobile excludes both)", () => {
      render(<MobileNoteBadges {...baseProps({ rrule: "FREQ=WEEKLY;UNTIL=20261231" })} />);
      fireEvent.click(screen.getByTestId("mobile-reminder-badge"));
      expect(screen.queryByTestId("reminder-end-time")).toBeNull();
      expect(screen.queryByTestId("reminder-until")).toBeNull();
      expect(screen.queryByText("End time")).toBeNull();
    });

    it("turning on + picking a start time + saving calls setSchedule and setRemind, then closes", () => {
      const setSchedule = vi.fn();
      const setRemind = vi.fn();
      render(<MobileNoteBadges {...baseProps({ setSchedule, setRemind })} />);
      fireEvent.click(screen.getByTestId("mobile-reminder-badge"));
      fireEvent.click(screen.getByTestId("mobile-reminder-on-toggle"));
      fireEvent.change(screen.getByTestId("mobile-reminder-start-time"), { target: { value: "10:30" } });
      fireEvent.click(screen.getByTestId("mobile-reminder-save"));
      expect(setSchedule).toHaveBeenCalledWith({
        start_time: "10:30",
        end_time: null,
        remind_offset_min: null,
        rrule: null,
      });
      expect(setRemind).toHaveBeenCalledWith(true);
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("preserves an existing end_time and repeat UNTIL untouched on save (no UI to clear them)", () => {
      const setSchedule = vi.fn();
      render(
        <MobileNoteBadges
          {...baseProps({
            remind: true,
            startTime: "09:00",
            endTime: "10:00",
            rrule: "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231",
            setSchedule,
          })}
        />,
      );
      fireEvent.click(screen.getByTestId("mobile-reminder-badge"));
      fireEvent.click(screen.getByTestId("mobile-reminder-save"));
      expect(setSchedule).toHaveBeenCalledWith({
        start_time: "09:00",
        end_time: "10:00",
        remind_offset_min: null,
        rrule: "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261231",
      });
    });

    it("picking a repeat frequency reveals the interval field and, for weekly, the weekday chips", () => {
      render(<MobileNoteBadges {...baseProps()} />);
      fireEvent.click(screen.getByTestId("mobile-reminder-badge"));
      expect(screen.queryByTestId("mobile-reminder-interval")).toBeNull();
      fireEvent.click(screen.getByTestId("mobile-reminder-repeat-WEEKLY"));
      expect(screen.getByTestId("mobile-reminder-interval")).toBeTruthy();
      expect(screen.getByTestId("mobile-reminder-byday-MO")).toBeTruthy();
    });

    it("picking an offset preset and saving sends the matching minutes", () => {
      const setSchedule = vi.fn();
      render(<MobileNoteBadges {...baseProps({ month: 7, day: 30, setSchedule })} />);
      fireEvent.click(screen.getByTestId("mobile-reminder-badge"));
      fireEvent.click(screen.getByTestId("mobile-reminder-offset-15m"));
      fireEvent.click(screen.getByTestId("mobile-reminder-save"));
      expect(setSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ remind_offset_min: 15 }),
      );
    });

    it("turn off reminder calls setRemind(false) without touching the schedule, then closes", () => {
      const setRemind = vi.fn();
      const setSchedule = vi.fn();
      render(<MobileNoteBadges {...baseProps({ remind: true, setRemind, setSchedule })} />);
      fireEvent.click(screen.getByTestId("mobile-reminder-badge"));
      fireEvent.click(screen.getByTestId("mobile-reminder-turn-off"));
      expect(setRemind).toHaveBeenCalledWith(false);
      expect(setSchedule).not.toHaveBeenCalled();
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("shows the 'pick a date first' hint instead of a time input when the note has no full date precision", () => {
      render(<MobileNoteBadges {...baseProps({ month: null, day: null })} />);
      fireEvent.click(screen.getByTestId("mobile-reminder-badge"));
      expect(screen.getByTestId("mobile-reminder-needs-date")).toBeTruthy();
      expect(screen.queryByTestId("mobile-reminder-start-time")).toBeNull();
    });
  });
});
