import type { EventDate, EventEnd } from "../components/titlebar/eventDate";

/**
 * PLAN-2026-09-18-nl-dates.md §W2 — bridge between the editor's "/날짜" slash command and
 * "일정으로 등록" selection-menu item (both live in editor/slashCommand.tsx and
 * editor/SelectionContextMenu.tsx) and `editor/DateEntryPopover.tsx`, which actually renders the
 * date-entry form. Same shape as `footnoteMark.ts`'s own comment describes: these are siblings
 * mounted separately in EditorPanel, not parent/child, so there's no prop path between them — a
 * module-level pub/sub bridge (same idiom as `lib/aiSectionBridge.ts` / `lib/presetBridge.ts`)
 * fills the gap instead of threading callbacks through EditorPanel.
 */

/**
 * Prefill for a fresh note_dates row. `start`/`end` reuse the exact `EventDate`/`EventEnd` types
 * `src/lib/nlDate` already returns (see nlDate/types.ts) and that `DatesPanel`'s own `seed` prop
 * expects (`DatesPanelSeed = EventEnd & { year, month, day }`) — so a caller holding an
 * `NlDateParseResult` can hand its `start`/`end` straight through with no reshaping.
 */
export interface DateEntryPrefill {
  start: EventDate;
  end: EventEnd;
  /** Seeds DatesPanel's "+" row label input. Undefined/empty = start blank (same as no prefill). */
  label?: string | null;
  /** 2026-09-19 후속 — nlDate(NlDateParseResult)의 startTime/endTime을 그대로 실어 DatesPanel의
   *  "+" 시각 입력을 채운다. 처음 §W2 구현이 시각을 안 실었던 공백(오너 원 예시 "내일 2시부터
   *  10시까지"의 시각 부분이 사라지던 문제)을 메운다. */
  startTime?: string | null;
  endTime?: string | null;
}

export interface DateEntryPayload {
  /** Target note — the caller resolves this itself (active note at open time; the popover trusts
   *  it as-is, the same way translateCtx/linkCtx in SelectionContextMenu trust their own captured
   *  from/to — the popover's full-viewport backdrop blocks other clicks while it's open, so the
   *  active note cannot change out from under it). */
  noteId: string;
  /** Popover anchor — screen coordinates (e.g. from `editor.view.coordsAtPos(range.from)`). */
  anchorX: number;
  anchorY: number;
  /** Doc range the caller wants touched on save — see `replaceRangeOnSave`. */
  range: { from: number; to: number };
  /** Undefined = open a blank form (the "/날짜" slash entry point, D5). Present = pre-fill the
   *  calendar/label from an already-parsed date (the "일정으로 등록" selection entry point). */
  prefill?: DateEntryPrefill;
  /** PLAN-2026-09-18-nl-dates.md §W3a — mutually exclusive with `prefill`. Present = a `DateMark`
   *  in the body was clicked: open the popover with that existing note_dates row selected (edit),
   *  instead of `prefill`'s "seed a blank draft toward this parsed guess" (new row). */
  editRowId?: string;
  /** true: on a successful "+" add, replace `range` in the live editor with a formatted plain-text
   *  line (slash flow — `range` is the "/날짜" trigger text itself, D6). false/undefined: leave the
   *  document untouched (selection-menu flow — the selected text already IS the plain-text line). */
  replaceRangeOnSave?: boolean;
}

type DateEntryListener = (payload: DateEntryPayload) => void;

let dateEntryListener: DateEntryListener = () => {};

export function subscribeDateEntry(fn: DateEntryListener): () => void {
  dateEntryListener = fn;
  return () => {
    if (dateEntryListener === fn) dateEntryListener = () => {};
  };
}

export function openDateEntry(payload: DateEntryPayload): void {
  dateEntryListener(payload);
}
