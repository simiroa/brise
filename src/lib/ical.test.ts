import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  notesToIcs,
  parseIcsToEvents,
  foldLine,
  unfoldIcs,
  escapeIcsText,
  unescapeIcsText,
  addOneDay,
  subOneDay,
  diffInDays,
  exportCalendarIcs,
  importIcsToDatabase,
  type IcsEventInput,
} from "./ical";
import { useNotesStore } from "../stores/notes";

const callMock = vi.fn();
const emitNoticeMock = vi.fn();

vi.mock("./invoke", () => ({
  call: (...args: unknown[]) => callMock(...args),
  callSilent: (...args: unknown[]) => callMock(...args),
  emitNotice: (...args: unknown[]) => emitNoticeMock(...args),
  flushAll: vi.fn().mockResolvedValue(undefined),
  registerFlush: vi.fn(),
}));

describe("RFC 5545 iCalendar (ical.ts)", () => {
  beforeEach(() => {
    callMock.mockReset();
    emitNoticeMock.mockReset();
    useNotesStore.setState({
      inboxId: "inbox1",
      loadTree: vi.fn().mockResolvedValue(undefined),
    } as any);
  });

  describe("Date math helpers", () => {
    it("adds one day across month and year boundaries", () => {
      expect(addOneDay(2026, 8, 24)).toEqual({ year: 2026, month: 8, day: 25 });
      expect(addOneDay(2026, 8, 31)).toEqual({ year: 2026, month: 9, day: 1 });
      expect(addOneDay(2026, 12, 31)).toEqual({ year: 2027, month: 1, day: 1 });
      expect(addOneDay(2024, 2, 28)).toEqual({ year: 2024, month: 2, day: 29 }); // Leap year
    });

    it("subtracts one day across month and year boundaries", () => {
      expect(subOneDay(2026, 8, 25)).toEqual({ year: 2026, month: 8, day: 24 });
      expect(subOneDay(2026, 9, 1)).toEqual({ year: 2026, month: 8, day: 31 });
      expect(subOneDay(2027, 1, 1)).toEqual({ year: 2026, month: 12, day: 31 });
    });

    it("calculates difference in days between dates", () => {
      expect(diffInDays(2026, 8, 24, 2026, 8, 25)).toBe(1);
      expect(diffInDays(2026, 8, 24, 2026, 8, 27)).toBe(3);
      expect(diffInDays(2026, 8, 24, 2026, 8, 24)).toBe(0);
    });
  });

  describe("Text escaping & line folding", () => {
    it("escapes backslashes, semicolons, commas, and newlines per RFC 5545", () => {
      const raw = "Line 1\nLine 2; with comma, and \\backslash";
      const escaped = escapeIcsText(raw);
      expect(escaped).toBe("Line 1\\nLine 2\\; with comma\\, and \\\\backslash");
      expect(unescapeIcsText(escaped)).toBe(raw);
    });

    it("folds lines longer than 75 UTF-8 octets with CRLF + space", () => {
      const shortLine = "SUMMARY:Short line";
      expect(foldLine(shortLine)).toBe(shortLine);

      // Long Korean line
      const longKorean = "DESCRIPTION:이 문장은 RFC 5545 표준에 따라 한 줄이 75바이트를 넘어가면 줄바꿈과 공백으로 폴딩되어야 하는 아주 긴 설명 텍스트입니다.";
      const folded = foldLine(longKorean);
      expect(folded).toContain("\r\n ");

      const lines = folded.split("\r\n");
      const encoder = new TextEncoder();
      for (const l of lines) {
        expect(encoder.encode(l).length).toBeLessThanOrEqual(75);
      }

      // Unfolding restores exact text
      const unfolded = unfoldIcs(folded);
      expect(unfolded[0]).toBe(longKorean);
    });
  });

  describe("notesToIcs: iCalendar serialization", () => {
    it("serializes an all-day single-day event with exclusive DTEND", () => {
      const events: IcsEventInput[] = [
        {
          id: "note-1",
          title: "디자인 리뷰",
          body: "상세 기획 및 와이어프레임 점검",
          year: 2026,
          month: 8,
          day: 24,
        },
      ];

      const ics = notesToIcs(events);
      expect(ics).toContain("BEGIN:VCALENDAR");
      expect(ics).toContain("VERSION:2.0");
      expect(ics).toContain("BEGIN:VEVENT");
      expect(ics).toContain("UID:note-1@brise");
      expect(ics).toContain("SUMMARY:디자인 리뷰");
      expect(ics).toContain("DESCRIPTION:상세 기획 및 와이어프레임 점검");
      expect(ics).toContain("DTSTART;VALUE=DATE:20260824");
      expect(ics).toContain("DTEND;VALUE=DATE:20260825"); // 1 day after for exclusive DTEND
      expect(ics).toContain("END:VEVENT");
      expect(ics).toContain("END:VCALENDAR");
      expect(ics.endsWith("\r\n")).toBe(true);
    });

    it("serializes a multi-day span event", () => {
      const events: IcsEventInput[] = [
        {
          id: "note-vacation",
          title: "여름 휴가",
          year: 2026,
          month: 8,
          day: 24,
          end_year: 2026,
          end_month: 8,
          end_day: 26,
        },
      ];

      const ics = notesToIcs(events);
      expect(ics).toContain("DTSTART;VALUE=DATE:20260824");
      expect(ics).toContain("DTEND;VALUE=DATE:20260827"); // 2026-08-26 + 1 day = 2026-08-27
    });

    it("serializes a timed event with start_time and end_time", () => {
      const events: IcsEventInput[] = [
        {
          id: "note-meeting",
          title: "주간 스프린트 회의",
          year: 2026,
          month: 8,
          day: 24,
          start_time: "09:30",
          end_time: "10:30",
        },
      ];

      const ics = notesToIcs(events);
      expect(ics).toContain("DTSTART:20260824T093000");
      expect(ics).toContain("DTEND:20260824T103000");
    });

    it("serializes a recurring event with RRULE", () => {
      const events: IcsEventInput[] = [
        {
          id: "note-repeat",
          title: "매주 회고",
          year: 2026,
          month: 8,
          day: 24,
          start_time: "17:00",
          end_time: "18:00",
          rrule: "FREQ=WEEKLY;BYDAY=FR;UNTIL=20261231",
        },
      ];

      const ics = notesToIcs(events);
      expect(ics).toContain("RRULE:FREQ=WEEKLY;BYDAY=FR;UNTIL=20261231");
    });
  });

  describe("parseIcsToEvents: iCalendar deserialization", () => {
    it("parses all-day events correctly", () => {
      const icsContent = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VEVENT",
        "UID:event-123@brise",
        "SUMMARY:프로젝트 마일스톤",
        "DESCRIPTION:1차 릴리즈 목표",
        "DTSTART;VALUE=DATE:20260824",
        "DTEND;VALUE=DATE:20260825",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");

      const events = parseIcsToEvents(icsContent);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        uid: "event-123",
        title: "프로젝트 마일스톤",
        body: "1차 릴리즈 목표",
        year: 2026,
        month: 8,
        day: 24,
        end_year: null,
        end_month: null,
        end_day: null,
        start_time: null,
        end_time: null,
      });
    });

    it("parses multi-day spans and calculates inclusive end date", () => {
      const icsContent = [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "SUMMARY:워크숍",
        "DTSTART;VALUE=DATE:20260824",
        "DTEND;VALUE=DATE:20260827",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");

      const events = parseIcsToEvents(icsContent);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        title: "워크숍",
        year: 2026,
        month: 8,
        day: 24,
        end_year: 2026,
        end_month: 8,
        end_day: 26,
      });
    });

    it("parses timed events with local floating DATE-TIME", () => {
      const icsContent = [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "SUMMARY:점심 미팅",
        "DTSTART:20260824T123000",
        "DTEND:20260824T133000",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");

      const events = parseIcsToEvents(icsContent);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        title: "점심 미팅",
        year: 2026,
        month: 8,
        day: 24,
        start_time: "12:30",
        end_time: "13:30",
      });
    });

    it("parses recurring events with RRULE", () => {
      const icsContent = [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "SUMMARY:데일리 스크럼",
        "DTSTART:20260824T100000",
        "DTEND:20260824T101500",
        "RRULE:FREQ=DAILY;INTERVAL=1",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");

      const events = parseIcsToEvents(icsContent);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        title: "데일리 스크럼",
        year: 2026,
        month: 8,
        day: 24,
        start_time: "10:00",
        end_time: "10:15",
        rrule: "FREQ=DAILY;INTERVAL=1",
      });
    });

    it("handles multiple VEVENT entries in one file", () => {
      const icsContent = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VEVENT",
        "SUMMARY:Event 1",
        "DTSTART;VALUE=DATE:20260824",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "SUMMARY:Event 2",
        "DTSTART:20260825T140000",
        "DTEND:20260825T150000",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");

      const events = parseIcsToEvents(icsContent);
      expect(events).toHaveLength(2);
      expect(events[0].title).toBe("Event 1");
      expect(events[1].title).toBe("Event 2");
    });
  });

  describe("Round-trip serialization & deserialization", () => {
    it("preserves event details across notesToIcs and parseIcsToEvents", () => {
      const original: IcsEventInput[] = [
        {
          id: "trip-1",
          title: "제주도 세미나; 컨퍼런스",
          body: "첫째 날: 키노트\n둘째 날: 워크숍",
          year: 2026,
          month: 9,
          day: 10,
          end_year: 2026,
          end_month: 9,
          end_day: 12,
        },
        {
          id: "meeting-2",
          title: "주간 싱크",
          year: 2026,
          month: 9,
          day: 14,
          start_time: "11:00",
          end_time: "12:00",
          rrule: "FREQ=WEEKLY;BYDAY=MO",
        },
      ];

      const ics = notesToIcs(original);
      const parsed = parseIcsToEvents(ics);

      expect(parsed).toHaveLength(2);

      expect(parsed[0]).toMatchObject({
        uid: "trip-1",
        title: "제주도 세미나; 컨퍼런스",
        body: "첫째 날: 키노트\n둘째 날: 워크숍",
        year: 2026,
        month: 9,
        day: 10,
        end_year: 2026,
        end_month: 9,
        end_day: 12,
        start_time: null,
        end_time: null,
      });

      expect(parsed[1]).toMatchObject({
        uid: "meeting-2",
        title: "주간 싱크",
        year: 2026,
        month: 9,
        day: 14,
        start_time: "11:00",
        end_time: "12:00",
        rrule: "FREQ=WEEKLY;BYDAY=MO",
      });
    });
  });

  describe("Database import / export operations", () => {
    it("imports parsed events into database as notes with schedule & body", async () => {
      const created: Record<string, unknown> = {};
      callMock.mockImplementation(async (cmd: string, args: any) => {
        if (cmd === "note_create") {
          const note = {
            id: `created-${args.title}`, folder_id: args.folder_id, title: args.title,
            year: args.year, month: args.month ?? null, day: args.day ?? null,
          };
          created[note.id] = note;
          return {
            note,
            sections: [{ id: `sec-${args.title}`, name: "Section 1", body_md: "", position: 0, kind: "text" }],
          };
        }
        // PLAN-2026-09-08-dates-rebuild.md W4: note_set_event_end/note_set_schedule were
        // deleted — importIcsToDatabase now goes through lib/primaryDate.ts::replacePrimaryDate,
        // which always fetches the just-created note's current state first.
        if (cmd === "note_get") return { note: created[args.id], sections: [], sources: [], attachments: [] };
        // W4b: 대표 편집은 note_date_update 한 번(옛 add+승격+삭제 컴포지트는 사라졌다).
        if (cmd === "note_dates_list") return { dates: [{ id: "primary-row", note_id: "n", position: 0, year: 2026, month: null, day: null, end_year: null, end_month: null, end_day: null, remind: false, created_at: "", start_time: null, end_time: null, remind_offset_min: null, rrule: null }] };
        if (cmd === "note_date_update") return { id: "primary-row", note_id: "n", position: 0, year: 2026, month: null, day: null, end_year: null, end_month: null, end_day: null, remind: false, created_at: "", start_time: null, end_time: null, remind_offset_min: null, rrule: null };
        return {};
      });

      const ics = [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "SUMMARY:스프린트 계획",
        "DESCRIPTION:백로그 정제",
        "DTSTART:20260824T100000",
        "DTEND:20260824T110000",
        "RRULE:FREQ=WEEKLY",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");

      const result = await importIcsToDatabase(ics, "folder-1");
      expect(result.importedCount).toBe(1);
      expect(callMock).toHaveBeenCalledWith("note_create", expect.objectContaining({
        folder_id: "folder-1",
        title: "스프린트 계획",
        year: 2026,
        month: 8,
        day: 24,
      }));
      // note_set_schedule was deleted — replacePrimaryDate's add+promote composite absorbs it.
      expect(callMock).not.toHaveBeenCalledWith("note_set_schedule", expect.anything());
      expect(callMock).toHaveBeenCalledWith("note_date_update", expect.objectContaining({
        start_time: "10:00",
        end_time: "11:00",
        rrule: "FREQ=WEEKLY",
      }));
      expect(callMock).toHaveBeenCalledWith("section_update", expect.objectContaining({
        body_md: "백로그 정제",
      }));
      expect(emitNoticeMock).toHaveBeenCalled();
    });

    it("exports notes from database query to .ics file", async () => {
      callMock.mockImplementation(async (cmd: string) => {
        if (cmd === "note_query") {
          return {
            notes: [
              {
                id: "n1",
                title: "발표 준비",
                year: 2026,
                month: 8,
                day: 24,
                start_time: "14:00",
                end_time: "15:00",
              },
            ],
          };
        }
        return {};
      });

      const count = await exportCalendarIcs();
      expect(count).toBe(1);
      expect(emitNoticeMock).toHaveBeenCalled();
    });
  });
});
