/**
 * RFC 5545 iCalendar (.ics) serialization and parsing.
 *
 * Supports:
 * - RFC 5545 standard VCALENDAR / VEVENT specification
 * - Line folding (<= 75 UTF-8 octets) with CRLF + space
 * - Unfolding and text escaping / unescaping (\, \;, \,, \n)
 * - All-day events (VALUE=DATE) with exclusive DTEND math
 * - Timed events (DATE-TIME) with start_time and end_time ("HH:MM")
 * - Recurrence rules (RRULE)
 * - UID, SUMMARY, DESCRIPTION serialization and parsing
 * - Import / export helpers for database and file interactions
 */

import { call, emitNotice } from "./invoke";
import { useNotesStore } from "../stores/notes";
import type { CalendarMarkImport, NoteDetail, NoteQueryOutput, NoteSummary } from "./commands.gen";
import { t } from "../i18n/t";
import { replacePrimaryDate } from "./primaryDate";

export interface IcsEventInput {
  id?: string;
  title: string;
  body?: string | null;
  year: number;
  month?: number | null; // 1-12
  day?: number | null; // 1-31
  end_year?: number | null;
  end_month?: number | null; // 1-12
  end_day?: number | null; // 1-31
  start_time?: string | null; // "HH:MM"
  end_time?: string | null; // "HH:MM"
  rrule?: string | null; // e.g. "FREQ=DAILY", "FREQ=WEEKLY;BYDAY=MO,TU"
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ParsedIcsEvent {
  uid?: string;
  title: string;
  body?: string;
  year: number;
  month: number | null;
  day: number | null;
  end_year?: number | null;
  end_month?: number | null;
  end_day?: number | null;
  start_time?: string | null;
  end_time?: string | null;
  rrule?: string | null;
}

const textEncoder = new TextEncoder();

/** 2-digit zero pad */
export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 4-digit zero pad */
export function pad4(n: number): string {
  return String(n).padStart(4, "0");
}

/** Add one day to a YMD triple (UTC) */
export function addOneDay(year: number, month: number, day: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

/** Subtract one day from a YMD triple (UTC) */
export function subOneDay(year: number, month: number, day: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day - 1));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

/** Difference in days between two YMD triples (d2 - d1) */
export function diffInDays(
  y1: number,
  m1: number,
  d1: number,
  y2: number,
  m2: number,
  d2: number
): number {
  const t1 = Date.UTC(y1, m1 - 1, d1);
  const t2 = Date.UTC(y2, m2 - 1, d2);
  return Math.round((t2 - t1) / (1000 * 60 * 60 * 24));
}

/**
 * Escapes characters per RFC 5545 Section 3.3.11
 * Backslash (\), Semicolon (;), Comma (,), and Newline (\n)
 */
export function escapeIcsText(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\n|\r/g, "\\n");
}

/**
 * Unescapes RFC 5545 escaped text.
 */
export function unescapeIcsText(str: string): string {
  return str
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

/**
 * Folds a content line so no line exceeds maxBytes (default 75 octets per RFC 5545 Section 3.1).
 * Continuation lines start with a single space (' ').
 * Safe with multi-byte UTF-8 sequences.
 */
export function foldLine(line: string, maxBytes = 75): string {
  const totalBytes = textEncoder.encode(line).length;
  if (totalBytes <= maxBytes) {
    return line;
  }

  const chunks: string[] = [];
  let currentLine = "";
  let currentBytes = 0;
  let isFirstLine = true;

  for (const ch of line) {
    const chBytes = textEncoder.encode(ch).length;
    const limit = isFirstLine ? maxBytes : maxBytes - 1; // 1 byte for leading space

    if (currentBytes + chBytes > limit && currentLine.length > 0) {
      chunks.push(currentLine);
      currentLine = ch;
      currentBytes = chBytes;
      isFirstLine = false;
    } else {
      currentLine += ch;
      currentBytes += chBytes;
    }
  }

  if (currentLine.length > 0) {
    chunks.push(currentLine);
  }

  return chunks.join("\r\n ");
}

/**
 * Unfolds an iCalendar string by removing CRLF/LF + space/tab continuation breaks (RFC 5545 §3.1).
 */
export function unfoldIcs(raw: string): string[] {
  const unfolded = raw.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").replace(/\r[ \t]/g, "");
  return unfolded
    .split(/\r\n|\n|\r/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
}

/**
 * Normalizes "H:MM" or "HH:MM:SS" to "HH:MM"
 */
function normalizeTime(time: string | null | undefined): string | null {
  if (!time) return null;
  const trimmed = time.trim();
  const match = trimmed.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const h = pad2(parseInt(match[1], 10));
  const m = match[2];
  return `${h}:${m}`;
}

/**
 * Serializes a list of notes or event objects to RFC 5545 standard .ics string.
 */
export function notesToIcs(events: (IcsEventInput | NoteSummary | NoteDetail | Record<string, any>)[]): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Brise//Brise Calendar//KO",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];

  const nowIso = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

  for (const rawItem of events) {
    const item = "note" in rawItem && rawItem.note ? { ...rawItem.note, sections: (rawItem as NoteDetail).sections } : rawItem;

    const rawYear = Number(item.year);
    if (!Number.isFinite(rawYear)) continue;

    const year = rawYear;
    const month = item.month ? Number(item.month) : 1;
    const day = item.day ? Number(item.day) : 1;
    const title = item.title || "Untitled";

    let body = "";
    if (typeof item.body === "string") {
      body = item.body;
    } else if (Array.isArray(item.sections) && item.sections.length > 0) {
      body = item.sections.map((s: any) => s.body_md || "").filter(Boolean).join("\n\n");
    } else if (typeof item.snippet === "string") {
      body = item.snippet;
    }

    const uid = item.id
      ? `${item.id}@brise`
      : `event-${year}${pad2(month)}${pad2(day)}-${Math.random().toString(36).slice(2, 9)}@brise`;

    let dtstamp = nowIso;
    if (item.updated_at || item.created_at) {
      const dt = new Date(item.updated_at || item.created_at);
      if (!isNaN(dt.getTime())) {
        dtstamp = dt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
      }
    }

    const eventLines: string[] = [
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${dtstamp}`,
      `SUMMARY:${escapeIcsText(title)}`,
    ];

    if (body) {
      eventLines.push(`DESCRIPTION:${escapeIcsText(body)}`);
    }

    const startTime = normalizeTime(item.start_time);
    const endTime = normalizeTime(item.end_time);

    if (startTime) {
      // Timed event (DATE-TIME)
      const startDt = `${pad4(year)}${pad2(month)}${pad2(day)}T${startTime.replace(/:/g, "")}00`;
      eventLines.push(`DTSTART:${startDt}`);

      if (endTime) {
        const eYear = item.end_year ? Number(item.end_year) : year;
        const eMonth = item.end_month ? Number(item.end_month) : month;
        const eDay = item.end_day ? Number(item.end_day) : day;
        const endDt = `${pad4(eYear)}${pad2(eMonth)}${pad2(eDay)}T${endTime.replace(/:/g, "")}00`;
        eventLines.push(`DTEND:${endDt}`);
      }
    } else {
      // All-day event (VALUE=DATE)
      const startDayStr = `${pad4(year)}${pad2(month)}${pad2(day)}`;
      eventLines.push(`DTSTART;VALUE=DATE:${startDayStr}`);

      const eYear = item.end_year ? Number(item.end_year) : year;
      const eMonth = item.end_month ? Number(item.end_month) : month;
      const eDay = item.end_day ? Number(item.end_day) : day;

      // RFC 5545: DTEND for VALUE=DATE is non-inclusive (day after the event ends)
      const nextDay = addOneDay(eYear, eMonth, eDay);
      const endDayStr = `${pad4(nextDay.year)}${pad2(nextDay.month)}${pad2(nextDay.day)}`;
      eventLines.push(`DTEND;VALUE=DATE:${endDayStr}`);
    }

    if (item.rrule && typeof item.rrule === "string" && item.rrule.trim()) {
      eventLines.push(`RRULE:${item.rrule.trim()}`);
    }

    eventLines.push("END:VEVENT");

    for (const el of eventLines) {
      lines.push(foldLine(el));
    }
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

/**
 * Parses raw iCalendar string content into ParsedIcsEvent objects.
 */
export function parseIcsToEvents(icsContent: string): ParsedIcsEvent[] {
  const lines = unfoldIcs(icsContent);
  const events: ParsedIcsEvent[] = [];

  let inVEvent = false;
  let currentEvent: Partial<ParsedIcsEvent> | null = null;
  let rawDtStart: { raw: string; params: string[] } | null = null;
  let rawDtEnd: { raw: string; params: string[] } | null = null;

  for (const line of lines) {
    if (line.startsWith("#")) continue;

    const upper = line.toUpperCase();
    if (upper === "BEGIN:VEVENT") {
      inVEvent = true;
      currentEvent = {
        title: "",
      };
      rawDtStart = null;
      rawDtEnd = null;
      continue;
    }

    if (upper === "END:VEVENT") {
      if (currentEvent && inVEvent) {
        // Resolve date / time from rawDtStart and rawDtEnd
        if (rawDtStart) {
          const isDateOnly =
            rawDtStart.params.some((p) => p.toUpperCase() === "VALUE=DATE") ||
            !rawDtStart.raw.includes("T");

          if (isDateOnly) {
            // All-day
            const sMatch = rawDtStart.raw.match(/^(\d{4})(\d{2})(\d{2})/);
            if (sMatch) {
              const sY = parseInt(sMatch[1], 10);
              const sM = parseInt(sMatch[2], 10);
              const sD = parseInt(sMatch[3], 10);
              currentEvent.year = sY;
              currentEvent.month = sM;
              currentEvent.day = sD;
              currentEvent.start_time = null;

              if (rawDtEnd) {
                const eMatch = rawDtEnd.raw.match(/^(\d{4})(\d{2})(\d{2})/);
                if (eMatch) {
                  const eY = parseInt(eMatch[1], 10);
                  const eM = parseInt(eMatch[2], 10);
                  const eD = parseInt(eMatch[3], 10);
                  const diff = diffInDays(sY, sM, sD, eY, eM, eD);
                  if (diff > 1) {
                    // Multi-day: subtract 1 day from non-inclusive DTEND to get inclusive end date
                    const inclusiveEnd = subOneDay(eY, eM, eD);
                    currentEvent.end_year = inclusiveEnd.year;
                    currentEvent.end_month = inclusiveEnd.month;
                    currentEvent.end_day = inclusiveEnd.day;
                  }
                }
              }
            }
          } else {
            // Timed (DATE-TIME)
            const raw = rawDtStart.raw;
            if (raw.endsWith("Z")) {
              // UTC timestamp
              const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/);
              if (match) {
                const dt = new Date(
                  Date.UTC(
                    parseInt(match[1], 10),
                    parseInt(match[2], 10) - 1,
                    parseInt(match[3], 10),
                    parseInt(match[4], 10),
                    parseInt(match[5], 10)
                  )
                );
                currentEvent.year = dt.getUTCFullYear();
                currentEvent.month = dt.getUTCMonth() + 1;
                currentEvent.day = dt.getUTCDate();
                currentEvent.start_time = `${pad2(dt.getUTCHours())}:${pad2(dt.getUTCMinutes())}`;
              }
            } else {
              // Floating / local
              const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/);
              if (match) {
                currentEvent.year = parseInt(match[1], 10);
                currentEvent.month = parseInt(match[2], 10);
                currentEvent.day = parseInt(match[3], 10);
                currentEvent.start_time = `${match[4]}:${match[5]}`;
              }
            }

            if (rawDtEnd) {
              const eRaw = rawDtEnd.raw;
              const match = eRaw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/);
              if (match) {
                const eY = parseInt(match[1], 10);
                const eM = parseInt(match[2], 10);
                const eD = parseInt(match[3], 10);
                currentEvent.end_time = `${match[4]}:${match[5]}`;

                if (currentEvent.year && (eY !== currentEvent.year || eM !== currentEvent.month || eD !== currentEvent.day)) {
                  currentEvent.end_year = eY;
                  currentEvent.end_month = eM;
                  currentEvent.end_day = eD;
                }
              }
            }
          }
        }

        if (currentEvent.year != null) {
          events.push({
            uid: currentEvent.uid,
            title: currentEvent.title || "Untitled",
            body: currentEvent.body,
            year: currentEvent.year,
            month: currentEvent.month ?? null,
            day: currentEvent.day ?? null,
            end_year: currentEvent.end_year ?? null,
            end_month: currentEvent.end_month ?? null,
            end_day: currentEvent.end_day ?? null,
            start_time: currentEvent.start_time ?? null,
            end_time: currentEvent.end_time ?? null,
            rrule: currentEvent.rrule ?? null,
          });
        }
      }

      inVEvent = false;
      currentEvent = null;
      rawDtStart = null;
      rawDtEnd = null;
      continue;
    }

    if (!inVEvent || !currentEvent) continue;

    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;

    const header = line.slice(0, colonIdx);
    const rawVal = line.slice(colonIdx + 1);
    const propName = header.split(";")[0].toUpperCase();
    const params = header.split(";").slice(1);

    switch (propName) {
      case "UID":
        currentEvent.uid = rawVal.replace(/@brise$/, "");
        break;
      case "SUMMARY":
        currentEvent.title = unescapeIcsText(rawVal);
        break;
      case "DESCRIPTION":
        currentEvent.body = unescapeIcsText(rawVal);
        break;
      case "RRULE":
        currentEvent.rrule = rawVal;
        break;
      case "DTSTART":
        rawDtStart = { raw: rawVal, params };
        break;
      case "DTEND":
        rawDtEnd = { raw: rawVal, params };
        break;
    }
  }

  return events;
}

/** 기간 이벤트 하나가 펼칠 수 있는 날 수 상한 — 1년짜리 "방학" 이벤트까지는 받고, 잘못 든 수년짜리
 *  이벤트가 표를 채우지 않게 한다. */
export const ICS_MARK_SPAN_MAX_DAYS = 366;

interface Ymd {
  year: number;
  month: number;
  day: number;
}

/** start~end(포함) 사이 날짜를 하루씩 나열 — `once`/`yearly` 기간 이벤트가 같이 쓴다(상한 공유). */
function daySpan(start: Ymd, end: Ymd): Ymd[] {
  const span = Math.min(
    Math.max(diffInDays(start.year, start.month, start.day, end.year, end.month, end.day), 0) + 1,
    ICS_MARK_SPAN_MAX_DAYS,
  );
  const days: Ymd[] = [];
  let cur = start;
  for (let i = 0; i < span; i += 1) {
    days.push(cur);
    cur = addOneDay(cur.year, cur.month, cur.day);
  }
  return days;
}

/**
 * ics 이벤트 → 달력 표시일 행(docs/PLAN-2026-09-19-calendar-schedule.md §4). 순수 함수.
 *
 * - 종일 이벤트만 받는다. 시각 있는 이벤트는 `skippedTimed` 로 세어 돌려준다 — 그건 "일정을 노트로
 *   가져오기" 쪽 재료다.
 * - `RRULE` 은 정확히 `FREQ=YEARLY`(대소문자·끝 `;` 무시)만 `yearly` 로 받고, 첫해 = 이벤트의 해.
 *   그 밖의 규칙(BYDAY·INTERVAL·COUNT…)은 표시일 모양(월·일)으로 못 담으니 `skippedRule`.
 * - 기간 이벤트(파서가 이미 DTEND 를 포함 끝날로 바꿔 둔다)는 날마다 한 행 — `once` 든 `FREQ=YEARLY`
 *   든 같다. 매년 사흘짜리 연휴(RRULE:FREQ=YEARLY + 사흘짜리 DTSTART/DTEND)를 첫날만 담고 나머지
 *   이틀을 아무 카운터도 없이 버리던 자리였다 — `once` 분기가 이미 여러 날을 펼치는데 `yearly` 분기만
 *   `ev.month`/`ev.day`(시작일) 하나로 멈춰 있었다. 스키마가 "여러 날짜리 매년"을 못 담는 게 아니라
 *   그냥 하루하루를 `yearly` 행으로 나눠 담으면 된다(각 행의 `year` 는 이벤트 시작 해로 통일 —
 *   "N주년" 표시의 기준 해라 날짜마다 다를 이유가 없다).
 * - `day_off` 는 불러오기 대화상자에서 고른 값 하나로 전부 칠한다.
 * 이름 검증(빈 제목 등)은 Rust `validate` 가 행 단위로 건너뛰고 수를 돌려준다 — 여기서 겹쳐 하지 않는다.
 */
export function icsEventsToDayMarks(
  events: readonly ParsedIcsEvent[],
  dayOff: boolean,
): { marks: CalendarMarkImport[]; skippedTimed: number; skippedRule: number } {
  const marks: CalendarMarkImport[] = [];
  let skippedTimed = 0;
  let skippedRule = 0;
  for (const ev of events) {
    if (ev.start_time) {
      skippedTimed += 1;
      continue;
    }
    if (ev.month == null || ev.day == null) continue;
    const uid = ev.uid ?? null;
    const start = { year: ev.year, month: ev.month, day: ev.day };
    const end =
      ev.end_year != null && ev.end_month != null && ev.end_day != null
        ? { year: ev.end_year, month: ev.end_month, day: ev.end_day }
        : start;
    const rule = ev.rrule?.trim();
    if (rule) {
      if (rule.toUpperCase().replace(/;+$/, "") !== "FREQ=YEARLY") {
        skippedRule += 1;
        continue;
      }
      for (const d of daySpan(start, end)) {
        marks.push({ uid, title: ev.title, year: ev.year, month: d.month, day: d.day, repeat: "yearly", day_off: dayOff });
      }
      continue;
    }
    for (const d of daySpan(start, end)) {
      marks.push({ uid, title: ev.title, year: d.year, month: d.month, day: d.day, repeat: "once", day_off: dayOff });
    }
  }
  return { marks, skippedTimed, skippedRule };
}

/**
 * Triggers a browser/webview text download.
 */
export function downloadTextFile(filename: string, content: string, mimeType = "text/calendar;charset=utf-8"): void {
  if (typeof document === "undefined") return;
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

/**
 * Opens a file picker to choose an .ics file and read its text content.
 */
export async function pickAndReadIcsFile(): Promise<string | null> {
  return (await pickIcsFile())?.text ?? null;
}

/**
 * 파일 이름까지 돌려주는 .ics 선택기 — 표시일 불러오기가 출처 이름의 기본값으로 파일 이름을 쓴다
 * (docs/PLAN-2026-09-19-calendar-schedule.md §4). `pickAndReadIcsFile` 은 이것의 얇은 포장이다.
 */
export async function pickIcsFile(): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") {
      resolve(null);
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".ics,text/calendar";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (file) {
        try {
          const text = await file.text();
          resolve({ name: file.name, text });
        } catch {
          resolve(null);
        }
      } else {
        resolve(null);
      }
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/**
 * Exports notes/calendar items to an .ics file.
 */
export async function exportCalendarIcs(
  notes?: IcsEventInput[] | NoteSummary[] | NoteDetail[]
): Promise<number> {
  let itemsToExport: any[] = [];
  if (notes && notes.length > 0) {
    itemsToExport = notes;
  } else {
    try {
      const res = await call<NoteQueryOutput>("note_query", { limit: 5000 });
      itemsToExport = (res.notes || []).filter((n) => n.year != null);
    } catch {
      itemsToExport = [];
    }
  }

  const icsText = notesToIcs(itemsToExport);
  const todayStr = new Date().toISOString().slice(0, 10);
  const defaultFilename = `brise-calendar-${todayStr}.ics`;

  downloadTextFile(defaultFilename, icsText);
  emitNotice(t("settings.calendar_export_ics_done", { n: itemsToExport.length }));
  return itemsToExport.length;
}

/**
 * Imports parsed .ics events as notes into the database.
 */
export async function importIcsToDatabase(
  icsText: string,
  targetFolderId?: string
): Promise<{ importedCount: number; noteIds: string[] }> {
  const events = parseIcsToEvents(icsText);
  if (events.length === 0) {
    // Silent until 2026-09-08: picking a file the parser found nothing in looked identical to
    // nothing happening at all. Same notice as the success path, with n = 0.
    emitNotice(t("settings.calendar_import_ics_done", { n: 0 }));
    return { importedCount: 0, noteIds: [] };
  }

  const folderId = targetFolderId || (await useNotesStore.getState().ensureInboxId());
  const noteIds: string[] = [];

  for (const ev of events) {
    const detail = await call<NoteDetail>("note_create", {
      folder_id: folderId,
      title: ev.title || "Untitled",
      year: ev.year,
      ...(ev.month != null ? { month: ev.month } : {}),
      ...(ev.day != null ? { day: ev.day } : {}),
    });

    const noteId = detail.note.id;
    noteIds.push(noteId);

    // PLAN-2026-09-08-dates-rebuild.md W4: note_set_event_end/note_set_schedule were deleted —
    // replacePrimaryDate (one call, note is freshly created above so this is safe/cheap: no
    // pre-existing related dates to collide with) absorbs both.
    const hasEnd = ev.end_year != null || ev.end_month != null || ev.end_day != null;
    const hasSchedule = ev.start_time || ev.end_time || ev.rrule;
    if (hasEnd || hasSchedule) {
      await replacePrimaryDate(noteId, {
        ...(hasEnd
          ? { end_year: ev.end_year ?? null, end_month: ev.end_month ?? null, end_day: ev.end_day ?? null }
          : {}),
        ...(hasSchedule
          ? { start_time: ev.start_time ?? null, end_time: ev.end_time ?? null, rrule: ev.rrule ?? null }
          : {}),
      });
    }

    if (ev.body && detail.sections && detail.sections[0]) {
      // 방금 만든 노트의 섹션에 1회 쓰기 — note_create 응답 토큰(D2②). replacePrimaryDate 는 섹션을 안 건드린다.
      const first = detail.sections[0];
      await call("section_update", {
        id: first.id,
        body_md: ev.body,
        ...(first.updated_at ? { expected_updated_at: first.updated_at } : {}),
      });
    }
  }

  await useNotesStore.getState().loadTree();
  emitNotice(t("settings.calendar_import_ics_done", { n: noteIds.length }));
  return { importedCount: noteIds.length, noteIds };
}
