-- Routine completions (docs/PLAN-2026-08-16-space-widgets.md §4, §4.2).
-- Tracks completion history for recurring notes and habits on individual occurrence dates.
--
-- Why a dedicated table:
-- 1. activity_log has a 7-day / 2000-row retention and is device-local (excluded from export).
-- 2. todo_toggle flips markdown checklists without timestamps or occurrence awareness.
-- 3. rrule occurrences are calculated dynamically on demand (rrule::expand).
--
-- note_id CASCADE: A completion has no meaning if the note itself is deleted.
-- occur_on: Local occurrence date string 'YYYY-MM-DD'.
-- done_at: ISO8601 UTC timestamp when the user completed the routine.

CREATE TABLE routine_completions (
  note_id  TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  occur_on TEXT NOT NULL,
  done_at  TEXT NOT NULL,
  PRIMARY KEY (note_id, occur_on)
);

CREATE INDEX idx_routine_completions_day ON routine_completions(occur_on);
