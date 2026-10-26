-- Habits (PLAN-2026-09-30-briefing.md §3, D1): 브리핑의 "오늘의 습관". 시간 없이 날짜별로 체크한다.
--
-- timeline_routines(매주 같은 시각의 배경 블록)·routine_completions(노트-연결 반복 체크)와는 별개 —
-- 건드리지 않는다. workspace_id 는 = 노트북.
--
-- weekday_mask: 비트 0=월 .. 비트 6=일(timeline_routines 와 같은 ISO 순서). 127 = 매일.
-- habit_checks.day: 로컬일 'YYYY-MM-DD' (UTC 집계 금지). 행이 있으면 done, 없으면 미완 — 체크 해제는 행 삭제.
-- archived_at: 보관(목록·집계에서 제외, 체크 이력은 보존). 삭제는 CASCADE 로 체크까지 지운다.

CREATE TABLE habits (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  icon         TEXT NULL,
  hue          INTEGER NULL,
  weekday_mask INTEGER NOT NULL DEFAULT 127 CHECK (weekday_mask BETWEEN 1 AND 127),
  position     INTEGER NOT NULL DEFAULT 0,
  archived_at  TEXT NULL,
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_habits_workspace ON habits(workspace_id, position);

CREATE TABLE habit_checks (
  habit_id TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  day      TEXT NOT NULL,
  done_at  TEXT NOT NULL,
  PRIMARY KEY (habit_id, day)
);

-- 이후 ALTER (migrations.rs — CREATE TABLE 은 v89 그대로, notes.sql 과 같은 패턴):
--   v91: ALTER TABLE habits ADD COLUMN time_of_day TEXT NOT NULL DEFAULT 'any' CHECK (time_of_day IN ('any','morning','evening'));  -- 브리핑 시간대 그룹
